import { constants as fsConstants } from 'node:fs';
import type { Readable, Writable } from 'node:stream';

import { ApiError, badRequest, mapError, notFound } from '../errors.js';
import type { Logger } from '../logger.js';
import type { DirectoryListing, FileEntry, EntryKind, ReadResult } from '../types.js';
import {
  DEFAULT_MAX_READ_BYTES,
  MAX_MAX_READ_BYTES,
  countLines,
  detectReadKind,
  mimeTypeFor,
} from '../util/fileKind.js';
import {
  basename,
  isInsideRemotePath,
  joinRemotePath,
  normalizeRemotePath,
  parentRemotePath,
} from '../util/remotePath.js';
import { copyTreeSftp, type CopyTreeStats } from './fsCopy.js';
import type { SFTPWrapper, Stats } from 'ssh2';
import type { SshConnection } from './SshConnection.js';
import { UserDirectory } from './userDirectory.js';

export const DEFAULT_LIST_LIMIT = 5_000;
export const MAX_LIST_LIMIT = 20_000;
export const DEFAULT_SEARCH_LIMIT = 200;
export const MAX_SEARCH_LIMIT = 2_000;
/** Safety valve for the `search` walk so a huge tree cannot stall a request forever. */
export const DEFAULT_SEARCH_SCAN_CAP = 200_000;
const ACCOUNT_FILE_MAX_BYTES = 2 * 1024 * 1024;

/**
 * POSIX file-type bits.
 *
 * `node:fs.constants` leaves these `undefined` on Windows, which silently broke the type prefix
 * there, so the numeric values are pinned here. They are the same on every platform
 * (`S_IFREG` = 0o100000 and friends are part of POSIX).
 */
const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;
const S_IFCHR = 0o020000;
const S_IFBLK = 0o060000;
const S_IFIFO = 0o010000;
const S_IFSOCK = 0o140000;

const MODE_TEXT_PREFIX = '-';

/**
 * Renders raw POSIX mode bits as `-rw-r--r--` (contract §2 `modeText`).
 * The leading character is the type: `-` file, `d` directory, `l` symlink, `c`/`b`/`p`/`s`.
 */
export function modeText(mode: number): string {
  const type = mode & S_IFMT;
  let prefix = MODE_TEXT_PREFIX;
  if (type === S_IFDIR) prefix = 'd';
  else if (type === S_IFLNK) prefix = 'l';
  else if (type === S_IFCHR) prefix = 'c';
  else if (type === S_IFBLK) prefix = 'b';
  else if (type === S_IFIFO) prefix = 'p';
  else if (type === S_IFSOCK) prefix = 's';
  else if (type !== 0 && type !== S_IFREG) prefix = '?';

  const rwx = (bits: number): string => {
    const r = (bits & 0o4) !== 0 ? 'r' : '-';
    const w = (bits & 0o2) !== 0 ? 'w' : '-';
    const x = (bits & 0o1) !== 0 ? 'x' : '-';
    return `${r}${w}${x}`;
  };

  const user = (mode >> 6) & 0o7;
  const group = (mode >> 3) & 0o7;
  const other = mode & 0o7;

  let userText = rwx(user);
  let groupText = rwx(group);
  let otherText = rwx(other);

  // setuid / setgid / sticky replace the corresponding execute character.
  if ((mode & 0o4000) !== 0) userText = `${userText.slice(0, 2)}${userText[2] === 'x' ? 's' : 'S'}`;
  if ((mode & 0o2000) !== 0) groupText = `${groupText.slice(0, 2)}${groupText[2] === 'x' ? 's' : 'S'}`;
  if ((mode & 0o1000) !== 0) otherText = `${otherText.slice(0, 2)}${otherText[2] === 'x' ? 't' : 'T'}`;

  return `${prefix}${userText}${groupText}${otherText}`;
}

/** `EntryKind` from raw mode bits; unknown/absent bits become `other`. */
export function kindOf(mode: number | undefined): EntryKind {
  if (mode === undefined) return 'other';
  const type = mode & S_IFMT;
  if (type === S_IFDIR) return 'directory';
  if (type === S_IFLNK) return 'symlink';
  if (type === S_IFREG) return 'file';
  if (type === 0) return 'file';
  return 'other';
}

/** ssh2 reports timestamps in UNIX seconds; the contract wants epoch milliseconds. */
export function toEpochMs(value: number | Date | undefined): number {
  if (value === undefined) return 0;
  if (value instanceof Date) return value.getTime();
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 1000);
}

export interface EntryAttributes {
  mode?: number;
  uid?: number;
  gid?: number;
  size?: number;
  mtime?: number | Date;
  atime?: number | Date;
  /** Only present when the server returns the OpenSSH `link count` extension. */
  linkCount?: number;
}

/** Pure `FileEntry` construction, so it can be unit tested without an SFTP session. */
export function mapAttributesToEntry(
  dir: string,
  name: string,
  attrs: EntryAttributes,
  users: UserDirectory,
): FileEntry {
  const mode = attrs.mode ?? 0;
  const uid = attrs.uid ?? 0;
  const gid = attrs.gid ?? 0;
  const path = dir === '/' ? `/${name}` : joinRemotePath(dir, name);

  const entry: FileEntry = {
    name,
    path,
    kind: kindOf(attrs.mode),
    size: typeof attrs.size === 'number' && Number.isFinite(attrs.size) ? attrs.size : 0,
    mtime: toEpochMs(attrs.mtime),
    atime: toEpochMs(attrs.atime),
    mode,
    modeText: modeText(mode),
    owner: users.owner(uid),
    group: users.group(gid),
    uid,
    gid,
    hidden: name.startsWith('.'),
  };
  if (typeof attrs.linkCount === 'number' && Number.isFinite(attrs.linkCount)) {
    entry.linkCount = attrs.linkCount;
  }
  return entry;
}

function statsToAttributes(stats: Stats | undefined): EntryAttributes {
  if (stats === undefined) return {};
  const extended = stats.extended as { linkCount?: number } | undefined;
  const attrs: EntryAttributes = {
    mode: stats.mode,
    uid: stats.uid,
    gid: stats.gid,
    size: stats.size,
    mtime: stats.mtime,
    atime: stats.atime,
  };
  if (extended !== undefined && typeof extended.linkCount === 'number') {
    attrs.linkCount = extended.linkCount;
  }
  return attrs;
}

export interface ListOptions {
  path?: string;
  limit?: number;
}

export interface SearchOptions {
  path?: string;
  query: string;
  limit?: number;
  scanCap?: number;
}

export interface RemoveResult {
  deleted: string[];
  failed: { path: string; message: string }[];
}

export interface UsageEntry {
  path: string;
  bytes: number;
  /** True when the SFTP walk hit its node cap, so `bytes` is a lower bound (§6). */
  truncated: boolean;
}

/** Copy/move result (contract §6): successes carry the new entry, failures the reason. */
export interface CopyMoveResult {
  copied: FileEntry[];
  failed: { path: string; message: string }[];
}

export interface CopyOptions {
  /** Replace an existing target. When false the entry lands in `failed` instead (§6). */
  overwrite?: boolean;
}

/** Node cap for the `usage` size walk; reaching it marks the entry `truncated`. */
export const DEFAULT_USAGE_NODE_CAP = 200_000;

/** Parses `du -sk` output (`<kib>\t<path>`), summing duplicate path lines. */
export function parseDuOutput(stdout: string): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    const match = /^(\d+)\s+(.+)$/.exec(line);
    if (match === null) continue;
    const kib = Number.parseInt(match[1] as string, 10);
    const path = (match[2] as string).replace(/\/+$/, '') || '/';
    if (!Number.isFinite(kib)) continue;
    sizes.set(path, (sizes.get(path) ?? 0) + kib * 1024);
  }
  return sizes;
}

/**
 * Every §6 filesystem operation, implemented over one {@link SshConnection}.
 *
 * Nothing here buffers whole files: reads used for detection are capped, and transfers are
 * streamed by {@link import('../transfers/TransferManager.js').TransferManager}.
 */
export class SftpFs {
  private users: UserDirectory | null = null;
  private usersPending: Promise<UserDirectory> | null = null;

  constructor(
    private readonly connection: SshConnection,
    private readonly logger: Logger,
  ) {}

  // -------------------------------------------------------------------- helpers

  /** Resolves user-typed paths through the connection (handles `~` and relative paths). */
  async resolve(input: string | undefined, baseDir?: string): Promise<string> {
    return this.connection.resolvePath(input, baseDir);
  }

  /** `realpath` normalisation used by `fs/list` and friends (contract §11.4). */
  async normalize(input: string): Promise<string> {
    const normalized = normalizeRemotePath(input);
    if (normalized === '.') return this.connection.remoteHome();
    try {
      return await this.connection.realpath(normalized);
    } catch (err) {
      throw this.mapPathError(err, normalized);
    }
  }

  private async sftp(): Promise<SFTPWrapper> {
    return this.connection.sftp();
  }

  private withSftp<T>(fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    return this.connection.withSftp(fn);
  }

  /** Reads `/etc/passwd` and `/etc/group` once per connection; never fatal. */
  async userDirectory(): Promise<UserDirectory> {
    if (this.users !== null) return this.users;
    if (this.usersPending !== null) return this.usersPending;

    this.usersPending = (async () => {
      const [passwd, group] = await Promise.all([this.readAccountFile('/etc/passwd'), this.readAccountFile('/etc/group')]);
      const directory = UserDirectory.fromContents(passwd, group);
      this.users = directory;
      this.logger.debug('resolved remote accounts', { entries: directory.size });
      return directory;
    })()
      .catch((err: unknown) => {
        this.logger.debug('could not read account databases', { error: err });
        const empty = UserDirectory.empty();
        this.users = empty;
        return empty;
      })
      .finally(() => {
        this.usersPending = null;
      });

    return this.usersPending;
  }

  private async readAccountFile(remotePath: string): Promise<string | null> {
    try {
      const sftp = await this.sftp();
      const stats = await new Promise<Stats | undefined>((resolve, reject) => {
        sftp.stat(remotePath, (err, value) => (err ? reject(err) : resolve(value)));
      });
      if (stats !== undefined && stats.size > ACCOUNT_FILE_MAX_BYTES) return null;
      const data = await new Promise<Buffer>((resolve, reject) => {
        sftp.readFile(remotePath, (err, value) => (err ? reject(err) : resolve(value ?? Buffer.alloc(0))));
      });
      return data.toString('utf8');
    } catch {
      // A server without /etc/passwd (Windows, chroot, permission denied) is perfectly normal.
      return null;
    }
  }

  // ----------------------------------------------------------------------- list

  async list(options: ListOptions): Promise<DirectoryListing> {
    const limit = clampLimit(options.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
    const requested = await this.resolve(options.path);
    const target = await this.normalize(requested);
    const users = await this.userDirectory();

    const raw = await this.withSftp(
      (sftp) =>
        new Promise<{ filename: string; attrs: Stats }[]>((resolve, reject) => {
          sftp.readdir(target, (err, list) => {
            if (err !== undefined && err !== null) reject(err);
            else {
              resolve(
                (list ?? []).map((item) => ({ filename: item.filename, attrs: item.attrs as Stats })),
              );
            }
          });
        }),
    ).catch((err: unknown) => {
      const api = mapError(err);
      if (api.code === 'SFTP_ERROR' && isDirectoryError(err)) {
        throw badRequest(`Not a directory: ${target}.`, { path: target });
      }
      throw this.mapPathError(err, target);
    });

    const truncated = raw.length > limit;
    const sliced = truncated ? raw.slice(0, limit) : raw;

    const entries = await Promise.all(
      sliced.map(async (item) => {
        let attrs = statsToAttributes(item.attrs);
        // A server may omit attributes in READDIR; fall back to a single LSTAT.
        if (attrs.mode === undefined || attrs.size === undefined) {
          try {
            const stats = await this.lstat(target === '/' ? `/${item.filename}` : joinRemotePath(target, item.filename));
            attrs = { ...statsToAttributes(stats), ...stripUndefined(attrs) };
          } catch {
            /* keep whatever READDIR gave us */
          }
        }
        const entry = mapAttributesToEntry(target, item.filename, attrs, users);
        if (entry.kind === 'symlink') {
          const linkTarget = await this.readlink(entry.path);
          if (linkTarget !== null) entry.target = linkTarget;
        }
        return entry;
      }),
    );

    // "." and ".." are never part of the contract's listing.
    const visible = entries.filter((entry) => entry.name !== '.' && entry.name !== '..');

    return {
      path: target,
      parent: parentRemotePath(target),
      entries: visible,
      truncated,
    };
  }

  // ----------------------------------------------------------------------- stat

  /** `lstat` semantics so a symlink stays visible as a symlink (contract §6: the client must be
   * able to rename, chmod and delete links). Pass `follow: true` to resolve the target instead,
   * which is what streaming a file needs.
   */
  async stat(remotePath: string, follow = false): Promise<FileEntry> {
    const requested = await this.resolve(remotePath);
    const target = normalizeRemotePath(requested);
    const users = await this.userDirectory();

    const stats = await this.withSftp(
      (sftp) =>
        new Promise<Stats>((resolve, reject) => {
          const handler = (err: Error | null | undefined, value?: Stats): void => {
            if (err !== undefined && err !== null) reject(err);
            else if (value === undefined) reject(new Error('no attributes returned'));
            else resolve(value);
          };
          if (follow) sftp.stat(target, handler);
          else sftp.lstat(target, handler);
        }),
    ).catch((err: unknown) => {
      throw this.mapPathError(err, target);
    });

    // The directory passed to the mapper must be the real parent so `path` and `hidden` are
    // both derived from the entry itself.
    const name = basename(target);
    const parent = parentRemotePath(target) ?? '/';
    const entry = mapAttributesToEntry(parent, name, statsToAttributes(stats), users);
    if (entry.kind === 'symlink') {
      const linkTarget = await this.readlink(entry.path);
      if (linkTarget !== null) entry.target = linkTarget;
    }
    return entry;
  }

  private lstat(remotePath: string): Promise<Stats> {
    return this.withSftp(
      (sftp) =>
        new Promise<Stats>((resolve, reject) => {
          sftp.lstat(remotePath, (err, value) => (err ? reject(err) : value === undefined ? reject(new Error('no attributes returned')) : resolve(value)));
        }),
    );
  }

  async readlink(remotePath: string): Promise<string | null> {
    try {
      const target = await this.withSftp(
        (sftp) =>
          new Promise<string>((resolve, reject) => {
            sftp.readlink(remotePath, (err, value) => (err ? reject(err) : resolve(value ?? '')));
          }),
      );
      return target === '' ? null : target;
    } catch {
      return null;
    }
  }

  // ----------------------------------------------------------------------- read

  /** Contract §6 `fs/read`: detects text/image/binary, respects `maxBytes` strictly. */
  async read(remotePath: string, maxBytesRaw?: number): Promise<ReadResult> {
    const maxBytes = clampLimit(maxBytesRaw, DEFAULT_MAX_READ_BYTES, MAX_MAX_READ_BYTES);
    const requested = await this.resolve(remotePath);
    const target = normalizeRemotePath(requested);

    const entry = await this.stat(target);

    // One bounded read serves both purposes: the first 8 KiB decide the kind, and the same
    // bytes are what a truncated text response returns. `maxBytes` is never exceeded.
    const readLength = Math.max(maxBytes, 1);
    const sample = await this.readRange(target, 0, readLength - 1);
    const kind = detectReadKind(sample, { name: entry.name, size: entry.size, maxBytes });
    const mimeType = mimeTypeFor(entry.name, kind);
    const truncated = entry.size > maxBytes;

    if (kind === 'binary' || kind === 'tooLarge') {
      return { kind, size: entry.size, truncated, encoding: 'utf8', mimeType };
    }

    if (kind === 'image') {
      return {
        kind,
        dataUrl: `data:${mimeType};base64,${sample.toString('base64')}`,
        size: entry.size,
        truncated,
        encoding: 'base64',
        mimeType,
      };
    }

    const text = sample.toString('utf8');
    return {
      kind: 'text',
      content: text,
      size: entry.size,
      truncated,
      encoding: 'utf8',
      mimeType,
      lines: countLines(text),
    };
  }

  /** Reads inclusive byte range `[start, end]` through a bounded SFTP read stream. */
  async readRange(remotePath: string, start: number, end: number): Promise<Buffer> {
    if (end < start) return Buffer.alloc(0);
    return this.withSftp(
      (sftp) =>
        new Promise<Buffer>((resolve, reject) => {
          const chunks: Buffer[] = [];
          const stream = sftp.createReadStream(remotePath, { start, end, autoClose: true });
          stream.on('data', (chunk: Buffer | string) => {
            chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
          });
          stream.on('error', (err: Error) => reject(this.mapPathError(err, remotePath)));
          stream.on('end', () => resolve(Buffer.concat(chunks)));
        }),
    );
  }

  // --------------------------------------------------------------------- streams

  /**
   * Opens a read stream for transfers. The caller owns it and must destroy it on cancellation;
   * an open failure is reported through the stream's own `error` event, which `pipeline()`
   * propagates.
   */
  async openReadStream(remotePath: string, range?: { start: number; end?: number }): Promise<Readable> {
    const target = normalizeRemotePath(remotePath);
    return this.withSftp(
      (sftp) =>
        new Promise<Readable>((resolve, reject) => {
          try {
            resolve(
              sftp.createReadStream(target, {
                autoClose: true,
                ...(range !== undefined ? { start: range.start, end: range.end } : {}),
              }),
            );
          } catch (err) {
            reject(this.mapPathError(err, target));
          }
        }),
    );
  }

  /** Opens a write stream for a transfer (used by `fs/upload`). */
  async openWriteStream(remotePath: string, mode = 0o644): Promise<Writable> {
    const target = normalizeRemotePath(remotePath);
    return this.withSftp(
      (sftp) =>
        new Promise<Writable>((resolve, reject) => {
          try {
            resolve(sftp.createWriteStream(target, { mode, autoClose: true }));
          } catch (err) {
            reject(this.mapPathError(err, target));
          }
        }),
    );
  }

  // ------------------------------------------------------------------ mutations

  async mkdir(remotePath: string): Promise<FileEntry> {
    const requested = await this.resolve(remotePath);
    const target = normalizeRemotePath(requested);
    if (target === '/') throw badRequest('The root directory already exists.', { path: target });

    await this.withSftp(
      (sftp) =>
        new Promise<void>((resolve, reject) => {
          sftp.mkdir(target, (err) => (err ? reject(err) : resolve()));
        }),
    ).catch((err: unknown) => {
      throw this.mapPathError(err, target);
    });

    return this.stat(target, false);
  }

  async rename(from: string, to: string): Promise<FileEntry> {
    const source = await this.normalize(await this.resolve(from));
    const destination = await this.resolve(to, parentRemotePath(source) ?? undefined);
    const destinationNormalized = normalizeRemotePath(destination);
    if (source === destinationNormalized) {
      throw badRequest('The source and destination are the same path.', { path: source });
    }

    await this.withSftp(
      (sftp) =>
        new Promise<void>((resolve, reject) => {
          sftp.rename(source, destinationNormalized, (err) => (err ? reject(err) : resolve()));
        }),
    ).catch((err: unknown) => {
      throw this.mapPathError(err, source);
    });

    return this.stat(destinationNormalized, false);
  }

  async chmod(remotePath: string, mode: string | number): Promise<FileEntry> {
    const target = await this.normalize(await this.resolve(remotePath));
    const bits = typeof mode === 'number' ? mode : parseModeString(mode);

    await this.withSftp(
      (sftp) =>
        new Promise<void>((resolve, reject) => {
          sftp.chmod(target, bits, (err) => (err ? reject(err) : resolve()));
        }),
    ).catch((err: unknown) => {
      throw this.mapPathError(err, target);
    });

    return this.stat(target, false);
  }

  async touch(remotePath: string, mtimeMs?: number): Promise<FileEntry> {
    const target = await this.normalize(await this.resolve(remotePath));
    const when = mtimeMs === undefined ? Date.now() : mtimeMs;
    if (!Number.isFinite(when)) throw badRequest('mtimeMs must be a finite number.');

    const exists = await this.exists(target);
    if (!exists) {
      await this.withSftp(
        (sftp) =>
          new Promise<void>((resolve, reject) => {
            sftp.writeFile(target, Buffer.alloc(0), (err) => (err ? reject(err) : resolve()));
          }),
      ).catch((err: unknown) => {
        throw this.mapPathError(err, target);
      });
    }

    await this.withSftp(
      (sftp) =>
        new Promise<void>((resolve, reject) => {
          sftp.utimes(target, new Date(when), new Date(when), (err) => (err ? reject(err) : resolve()));
        }),
    ).catch((err: unknown) => {
      throw this.mapPathError(err, target);
    });

    return this.stat(target, false);
  }

  async exists(remotePath: string): Promise<boolean> {
    try {
      await this.lstat(remotePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Removes each path. Directories need `recursive`; symlinks are unlinked, never followed
   * (contract §6). Failures are collected per path rather than aborting the batch.
   */
  async remove(paths: string[], recursive: boolean): Promise<RemoveResult> {
    const deleted: string[] = [];
    const failed: { path: string; message: string }[] = [];

    for (const input of paths) {
      try {
        const target = await this.resolve(input);
        const normalized = normalizeRemotePath(target);
        if (normalized === '/') throw badRequest('Refusing to delete the root directory.', { path: normalized });
        await this.removeOne(normalized, recursive);
        deleted.push(normalized);
      } catch (err) {
        failed.push({ path: input, message: describeError(err) });
      }
    }

    return { deleted, failed };
  }

  private async removeOne(target: string, recursive: boolean): Promise<void> {
    const stats = await this.lstat(target).catch((err: unknown) => {
      throw this.mapPathError(err, target);
    });

    if (!stats.isDirectory()) {
      // Files, symlinks, sockets and devices are all unlinked; a symlink is never followed.
      await this.withSftp(
        (sftp) =>
          new Promise<void>((resolve, reject) => {
            sftp.unlink(target, (err) => (err ? reject(err) : resolve()));
          }),
      ).catch((err: unknown) => {
        throw this.mapPathError(err, target);
      });
      return;
    }

    if (!recursive) {
      throw new ApiError('SFTP_ERROR', `${target} is a directory; pass recursive: true to delete it.`, {
        path: target,
        code: 4,
      });
    }

    const children = await this.withSftp(
      (sftp) =>
        new Promise<string[]>((resolve, reject) => {
          sftp.readdir(target, (err, list) => {
            if (err !== undefined && err !== null) reject(err);
            else {
              resolve(
                (list ?? [])
                  .map((item) => item.filename)
                  .filter((name) => name !== '.' && name !== '..'),
              );
            }
          });
        }),
    ).catch((err: unknown) => {
      throw this.mapPathError(err, target);
    });

    for (const child of children) {
      await this.removeOne(target === '/' ? `/${child}` : joinRemotePath(target, child), true);
    }

    await this.withSftp(
      (sftp) =>
        new Promise<void>((resolve, reject) => {
          sftp.rmdir(target, (err) => (err ? reject(err) : resolve()));
        }),
    ).catch((err: unknown) => {
      throw this.mapPathError(err, target);
    });
  }

  // -------------------------------------------------------------------- symlink

  /** Creates a symlink at `linkPath` pointing at `target`; the target is never resolved. */
  async symlink(linkPath: string, target: string): Promise<void> {
    const link = normalizeRemotePath(linkPath);
    if (target.includes('\0') || link.includes('\0')) {
      throw badRequest('A path must not contain NUL.', { path: link });
    }
    await this.withSftp(
      (sftp) =>
        new Promise<void>((resolve, reject) => {
          sftp.symlink(target, link, (err) => (err ? reject(err) : resolve()));
        }),
    ).catch((err: unknown) => {
      throw this.mapPathError(err, link);
    });
  }

  /**
   * `rename` without `realpath` on either side, so a symlink or a directory is moved as itself
   * (contract §6 `fs/move`). The regular `rename` route deliberately normalises through
   * `realpath`; that would follow a symlink and move its target instead.
   */
  async renameRaw(from: string, to: string): Promise<void> {
    const source = normalizeRemotePath(from);
    const target = normalizeRemotePath(to);
    await this.withSftp(
      (sftp) =>
        new Promise<void>((resolve, reject) => {
          sftp.rename(source, target, (err) => (err ? reject(err) : resolve()));
        }),
    ).catch((err: unknown) => {
      throw this.mapPathError(err, source);
    });
  }

  /** True when the path exists and resolves to a directory (symlinks are followed). */
  async isDirectory(remotePath: string): Promise<boolean> {
    try {
      const entry = await this.stat(remotePath, true);
      return entry.kind === 'directory';
    } catch {
      return false;
    }
  }

  /** `mkdir -p` over SFTP: creates every missing segment and tolerates existing directories. */
  async mkdirRecursive(remotePath: string): Promise<void> {
    const target = normalizeRemotePath(remotePath);
    if (target === '/' || target === '.') return;

    let current = '';
    for (const segment of target.split('/').filter((part) => part !== '')) {
      current = `${current}/${segment}`;
      try {
        await this.withSftp(
          (sftp) =>
            new Promise<void>((resolve, reject) => {
              sftp.mkdir(current, (err) => (err ? reject(err) : resolve()));
            }),
        );
      } catch (err) {
        if (!(await this.isDirectory(current))) throw this.mapPathError(err, current);
      }
    }
  }

  // ------------------------------------------------------------------ copy/move

  /** Contract §6 `fs/copy` — `cp -a` over `exec` when possible, SFTP otherwise. */
  async copy(sources: string[], destination: string, options: CopyOptions = {}): Promise<CopyMoveResult> {
    return this.copyOrMove(sources, destination, options, 'copy');
  }

  /** Contract §6 `fs/move` — `rename` inside one filesystem, copy + delete across. */
  async move(sources: string[], destination: string, options: CopyOptions = {}): Promise<CopyMoveResult> {
    return this.copyOrMove(sources, destination, options, 'move');
  }

  private async copyOrMove(
    sources: readonly string[],
    destination: string,
    options: CopyOptions,
    mode: 'copy' | 'move',
  ): Promise<CopyMoveResult> {
    const overwrite = options.overwrite === true;
    const copied: FileEntry[] = [];
    const failed: { path: string; message: string }[] = [];

    const destinationPath = normalizeRemotePath(await this.resolve(destination));
    const destinationIsDirectory = await this.isDirectory(destinationPath);
    if (!destinationIsDirectory && sources.length > 1) {
      throw badRequest('The destination must be an existing directory when several paths are given.', {
        path: destinationPath,
      });
    }

    interface Plan {
      input: string;
      source: string;
      target: string;
    }

    const plans: Plan[] = [];
    const claimed = new Set<string>();
    for (const input of sources) {
      if (input.includes('\0')) throw badRequest('A path must not contain NUL.', { path: input });
      const source = normalizeRemotePath(await this.resolve(input));
      let entry: FileEntry;
      try {
        // lstat semantics: a symlink is copied and moved as a symlink, never followed.
        entry = await this.stat(source, false);
      } catch (err) {
        failed.push({ path: input, message: describeError(err) });
        continue;
      }

      const target = destinationIsDirectory ? joinRemotePath(destinationPath, basename(source)) : destinationPath;
      if (source === target) {
        throw badRequest('The source and destination are the same path.', { path: source });
      }
      if (entry.kind === 'directory' && isInsideRemotePath(target, source)) {
        throw badRequest(`Refusing to ${mode} ${source} into its own subtree (${target}).`, {
          path: source,
          destination: target,
        });
      }
      if (claimed.has(target)) {
        failed.push({ path: input, message: `${target} is claimed by more than one source.` });
        continue;
      }
      claimed.add(target);
      plans.push({ input, source, target });
    }

    // `overwrite: false` never replaces anything; `overwrite: true` clears the target first so
    // both `cp`/`mv` and the SFTP fallback behave the same way for files and directories.
    const runnable: Plan[] = [];
    for (const plan of plans) {
      if (await this.exists(plan.target)) {
        if (!overwrite) {
          failed.push({ path: plan.input, message: `${plan.target} already exists.` });
          continue;
        }
        const removed = await this.remove([plan.target], true);
        if (removed.failed.length > 0 || !removed.deleted.includes(plan.target)) {
          failed.push({ path: plan.input, message: removed.failed[0]?.message ?? `Could not replace ${plan.target}.` });
          continue;
        }
      }
      runnable.push(plan);
    }

    // One `exec` for the whole batch when the tool is there; the per-plan verification below
    // also covers a partial failure, which then falls back to SFTP for that path only.
    let execAttempted = false;
    if (runnable.length > 0) {
      const command = buildCopyCommand(
        mode === 'copy' ? 'cp' : 'mv',
        runnable.map((plan) => plan.source),
        destinationIsDirectory ? destinationPath : (runnable[0] as Plan).target,
      );
      if (command === null) {
        this.logger.debug('a path cannot be quoted for exec; using the SFTP path', { mode });
      } else {
        try {
          const result = await this.connection.exec(command, { timeoutMs: EXEC_COPY_TIMEOUT_MS });
          execAttempted = !execToolUnavailable(result);
          if (!execAttempted) {
            this.logger.debug('remote copy tool is unavailable; falling back to SFTP', { mode });
          } else if (result.code !== 0) {
            this.logger.debug('remote copy tool reported a failure', { mode, code: result.code, stderr: result.stderr });
          }
        } catch (err) {
          this.logger.debug('remote copy command failed to start; falling back to SFTP', { mode, error: err });
        }
      }
    }

    for (const plan of runnable) {
      let entry: FileEntry | null = null;
      if (execAttempted) entry = await this.stat(plan.target, false).catch(() => null);

      if (entry === null) {
        try {
          if (mode === 'copy') {
            const stats: CopyTreeStats = await copyTreeSftp(this, plan.source, plan.target);
            this.logger.debug('copied over SFTP', { source: plan.source, target: plan.target, ...stats });
          } else {
            await this.moveOne(plan.source, plan.target);
          }
          entry = await this.stat(plan.target, false);
        } catch (err) {
          failed.push({ path: plan.input, message: describeError(err) });
          continue;
        }
      }
      copied.push(entry);
    }

    return { copied, failed };
  }

  /** `rename` when the two paths share a filesystem, otherwise copy + delete. */
  private async moveOne(source: string, target: string): Promise<void> {
    try {
      await this.renameRaw(source, target);
      return;
    } catch (err) {
      // Cross-device links (and servers that refuse a rename onto an existing name) land here.
      this.logger.debug('rename failed; falling back to copy + delete', { source, target, error: err });
    }

    await copyTreeSftp(this, source, target);
    const removed = await this.remove([source], true);
    if (removed.failed.length > 0 || !removed.deleted.includes(source)) {
      throw new ApiError('SFTP_ERROR', removed.failed[0]?.message ?? `Could not remove ${source} after copying it.`, {
        path: source,
      });
    }
  }

  // --------------------------------------------------------------------- search

  /** Breadth-first walk with an entry cap; `truncated` says whether the cap was reached. */
  async search(options: SearchOptions): Promise<{ results: FileEntry[]; truncated: boolean; scanned: number }> {
    const limit = clampLimit(options.limit, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);
    const scanCap = options.scanCap ?? DEFAULT_SEARCH_SCAN_CAP;
    const query = options.query.toLowerCase();
    const root = await this.normalize(await this.resolve(options.path));
    const users = await this.userDirectory();

    const results: FileEntry[] = [];
    let scanned = 0;
    let truncated = false;

    const queue: string[] = [root];
    while (queue.length > 0) {
      const directory = queue.shift() as string;
      let children: { filename: string; attrs: Stats }[];
      try {
        children = await this.withSftp(
          (sftp) =>
            new Promise<{ filename: string; attrs: Stats }[]>((resolve, reject) => {
              sftp.readdir(directory, (err, list) => {
                if (err !== undefined && err !== null) reject(err);
                else resolve((list ?? []).map((item) => ({ filename: item.filename, attrs: item.attrs as Stats })));
              });
            }),
        );
      } catch (err) {
        // An unreadable subdirectory is skipped, not fatal — `search` is best effort.
        this.logger.debug('search skipped a directory', { path: directory, error: err });
        continue;
      }

      for (const child of children) {
        if (child.filename === '.' || child.filename === '..') continue;
        scanned += 1;
        if (scanned > scanCap) {
          truncated = true;
          break;
        }

        const entry = mapAttributesToEntry(directory, child.filename, statsToAttributes(child.attrs), users);
        if (entry.name.toLowerCase().includes(query)) {
          results.push(entry);
          if (results.length >= limit) return { results, truncated: true, scanned };
        }
        if (entry.kind === 'directory') queue.push(entry.path);
      }

      if (truncated) break;
    }

    return { results, truncated, scanned };
  }

  // ---------------------------------------------------------------------- usage

  /**
   * `du -sk` when the remote command succeeds, otherwise a recursive SFTP size walk.
   * `du` reports allocated blocks, the fallback reports apparent file sizes.
   */
  async usage(paths: string[]): Promise<UsageEntry[]> {
    const resolved: string[] = [];
    for (const input of paths) {
      resolved.push(await this.normalize(await this.resolve(input)));
    }
    if (resolved.length === 0) return [];

    const fromDu = await this.usageViaDu(resolved);
    const results: UsageEntry[] = [];
    for (const target of resolved) {
      if (fromDu !== null) {
        const bytes = fromDu.get(target);
        if (bytes !== undefined) {
          // `du` reports exact blocks, so nothing was cut short.
          results.push({ path: target, bytes, truncated: false });
          continue;
        }
      }
      const state: SizeWalkState = { nodes: 0, truncated: false };
      const bytes = await this.recursiveSize(target, 0, state);
      results.push({ path: target, bytes, truncated: state.truncated });
    }
    return results;
  }

  private async usageViaDu(paths: string[]): Promise<Map<string, number> | null> {
    try {
      const command = `du -sk -- ${paths.map(shellQuote).join(' ')}`;
      const result = await this.connection.exec(command, { timeoutMs: 20_000 });
      if (result.code !== 0 && result.stdout.trim() === '') return null;
      const parsed = parseDuOutput(result.stdout);
      return parsed.size === 0 ? null : parsed;
    } catch (err) {
      this.logger.debug('du is unavailable, falling back to an SFTP walk', { error: err });
      return null;
    }
  }

  /** Recursive apparent-size walk. Symlinks contribute their own (tiny) size, not the target's. */
  async recursiveSize(target: string, depth: number, state: SizeWalkState = { nodes: 0, truncated: false }): Promise<number> {
    if (depth > 128) {
      state.truncated = true;
      return 0;
    }
    if (state.nodes >= DEFAULT_USAGE_NODE_CAP) {
      // §6: `truncated` marks a walk that hit the cap, so the number is a lower bound.
      state.truncated = true;
      return 0;
    }
    state.nodes += 1;

    let stats: Stats;
    try {
      stats = await this.lstat(target);
    } catch {
      return 0;
    }
    if (!stats.isDirectory()) return typeof stats.size === 'number' ? stats.size : 0;

    let total = 0;
    let children: string[];
    try {
      children = await this.withSftp(
        (sftp) =>
          new Promise<string[]>((resolve, reject) => {
            sftp.readdir(target, (err, list) => {
              if (err !== undefined && err !== null) reject(err);
              else resolve((list ?? []).map((item) => item.filename).filter((name) => name !== '.' && name !== '..'));
            });
          }),
      );
    } catch {
      return 0;
    }

    for (const child of children) {
      total += await this.recursiveSize(target === '/' ? `/${child}` : joinRemotePath(target, child), depth + 1, state);
    }
    return total;
  }

  // --------------------------------------------------------------------- errors

  /**
   * Maps a path-level SFTP failure (contract §6/§1). A missing or unreadable path inside a valid
   * connection is `400 SFTP_ERROR` with the SFTP status code in `details.code`; `NOT_FOUND` is
   * reserved for unknown connection/profile/transfer ids.
   */
  private mapPathError(err: unknown, path: string): ApiError {
    const api = mapError(err);
    if (api.code === 'SFTP_ERROR') {
      const code = sftpStatusCode(err);
      if (code === 2) {
        return new ApiError('SFTP_ERROR', `No such file or directory: ${path}.`, { code: 2, path });
      }
      if (code === 3) {
        return new ApiError('SFTP_ERROR', `Permission denied: ${path}.`, { code: 3, path });
      }
      if (api.details?.['path'] === undefined) api.details!['path'] = path;
    }
    return api;
  }
}

// -------------------------------------------------------------------- utilities

/** Mutable bookkeeping for the bounded `usage` size walk (contract §6 `truncated`). */
export interface SizeWalkState {
  nodes: number;
  truncated: boolean;
}

/** How long one `cp`/`mv` round trip may take before it is abandoned for the SFTP path. */
const EXEC_COPY_TIMEOUT_MS = 120_000;

export interface ExecToolOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * True when a remote `cp`/`mv` did not run at all — the binary is missing, not executable, or
 * the server's `cp` does not understand a flag we sent. Only then may the SFTP implementation
 * take over: retrying a genuine failure (a permission problem, a full disk) over SFTP would
 * hide the real error behind a slower one.
 */
export function execToolUnavailable(result: ExecToolOutcome): boolean {
  if (result.code === 126 || result.code === 127) return true;
  const text = `${result.stderr}\n${result.stdout}`;
  return /command not found|:\s*not found|not permitted|operation not permitted|illegal option|invalid option|unknown option|unrecognized option|usage: (?:cp|mv)\b/i.test(
    text,
  );
}

/**
 * Builds `cp -a -- …` / `mv -- …` for one copy/move request, quoting every path with the POSIX
 * single-quote escaping used elsewhere. Returns `null` when a path cannot be passed safely
 * (an empty argument or a NUL byte), which sends the caller down the SFTP path instead.
 */
export function buildCopyCommand(tool: 'cp' | 'mv', sources: readonly string[], destination: string): string | null {
  const paths = [...sources, destination];
  if (paths.length === 0) return null;
  for (const path of paths) {
    if (path === '' || path.includes('\0')) return null;
  }
  const flags = tool === 'cp' ? '-a ' : '';
  return `${tool} ${flags}-- ${paths.map(shellQuote).join(' ')}`;
}

export function clampLimit(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const int = Math.floor(value);
  if (int <= 0) return fallback;
  return Math.min(int, max);
}

/** Accepts `"644"`, `"0755"`, `"0o755"` and `"0x1ed"`. */
export function parseModeString(mode: string): number {
  const trimmed = mode.trim();
  if (trimmed === '') throw badRequest('Invalid mode: the mode must not be empty.', { mode });
  let parsed: number;
  if (/^0o[0-7]+$/i.test(trimmed)) parsed = Number.parseInt(trimmed.slice(2), 8);
  else if (/^0x[0-9a-f]+$/i.test(trimmed)) parsed = Number.parseInt(trimmed.slice(2), 16);
  else if (/^[0-7]{3,4}$/.test(trimmed)) parsed = Number.parseInt(trimmed, 8);
  else if (/^\d+$/.test(trimmed)) parsed = Number.parseInt(trimmed, 10);
  else throw badRequest(`Invalid mode: ${mode}.`, { mode });

  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 0o7777) {
    throw badRequest(`Invalid mode: ${mode}.`, { mode });
  }
  return parsed;
}

function isDirectoryError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : '';
  return /is a directory|not a directory/i.test(message);
}

function sftpStatusCode(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'number' ? code : undefined;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item;
  }
  return out as Partial<T>;
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  const api = mapError(err);
  if (api.code !== 'INTERNAL') return api.message;
  return err instanceof Error ? err.message : 'Unknown error.';
}

/** POSIX single-quote escaping for values interpolated into a remote command. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Convenience wrapper used by routes that only need the connection-scoped fs facade. */
export function createSftpFs(connection: SshConnection, logger: Logger): SftpFs {
  return new SftpFs(connection, logger);
}
