/**
 * The filesystem of the computer the application is running on.
 *
 * It is presented through the same shapes as a remote host, so the interface does not need
 * to know which one it is looking at: a listing is a `DirectoryListing`, an entry is a
 * `FileEntry`, and the routes answer exactly as `/api/connections/:id/fs/*` does.
 *
 * Paths are virtual and always slash-separated, with the drive as the first segment:
 *
 *   `/`                the drives themselves — "My Computer"
 *   `/C:/`             the root of a drive
 *   `/C:/Users/Admin`  a directory
 *
 * Keeping them in that form means every existing helper on the interface side — parent,
 * basename, joining, breadcrumbs — works unchanged, and the drive list becomes a real
 * folder that can be navigated into and out of.
 */
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';
import { Readable, Writable } from 'node:stream';

import type {
  DirectoryListing,
  EntryKind,
  FileEntry,
  ReadResult,
} from '../types.js';
import { kindOf, modeText } from '../ssh/fsOps.js';
import { detectReadKind } from '../util/fileKind.js';
import { ApiError, badRequest, notFound } from '../errors.js';

/** The connection id the interface uses for this computer. */
export const LOCAL_CONNECTION_ID = 'local';

/** How the local filesystem answers for an error the caller caused (contract §1). */
function localError(err: unknown, target: string): ApiError {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') return notFound(`There is no such path: ${target}`, { path: target });
  if (code === 'EACCES' || code === 'EPERM') {
    return badRequest(`Permission denied: ${target}`, { path: target, code });
  }
  if (code === 'ENOTDIR') return badRequest(`Not a directory: ${target}`, { path: target });
  if (code === 'EEXIST') return badRequest(`Already exists: ${target}`, { path: target });
  const message = err instanceof Error ? err.message : String(err);
  return badRequest(message, { path: target });
}

const isWindows = process.platform === 'win32';

/** `/C:/Users/Admin` → `C:\Users\Admin`; everything stays as-is off Windows. */
export function toNativePath(virtual: string): string {
  if (!isWindows) return virtual;
  // `/` is the drive list, which has no native equivalent; callers never list it natively.
  const match = /^\/([A-Za-z]):(\/.*)?$/.exec(virtual);
  if (match === null) return virtual;
  const drive = `${(match[1] as string).toUpperCase()}:`;
  const rest = (match[2] ?? '/').replace(/\//g, '\\');
  return `${drive}${rest}`;
}

/** `C:\Users\Admin` → `/C:/Users/Admin`. */
export function toVirtualPath(native: string): string {
  if (!isWindows) return native;
  const match = /^([A-Za-z]):(.*)$/.exec(native);
  if (match === null) return native.replace(/\\/g, '/');
  const drive = (match[1] as string).toUpperCase();
  const rest = (match[2] as string).replace(/\\/g, '/');
  return `/${drive}:${rest === '' ? '/' : rest}`;
}

/** Collapses `.` and `..` and gives a drive-letter path its canonical spelling. */
export function normalizeLocalPath(input: string): string {
  const withSlashes = input.replace(/\\/g, '/');
  const parts = withSlashes.split('/');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      out.pop();
      continue;
    }
    out.push(part);
  }
  const first = out[0];
  if (isWindows && first !== undefined && /^[A-Za-z]:$/.test(first)) {
    out[0] = first.toUpperCase();
    // A drive root is spelled `/C:/`; everything below it has no trailing slash.
    return out.length === 1 ? `/${out.join('/')}/` : `/${out.join('/')}`;
  }
  if (isWindows) return `/${out.join('/')}`.replace(/^\/$/, '/');
  return `/${out.join('/')}`;
}

/** Native name of a drive letter, or null when the path is not a drive. */
function driveOf(virtual: string): string | null {
  const match = /^\/([A-Za-z]):($|\/)/.exec(virtual);
  return match === null ? null : `${(match[1] as string).toUpperCase()}:`;
}

/** The `FileEntry` shape, built by hand because local metadata is not SFTP attributes. */
function entryFor(virtual: string, name: string, stats: import('node:fs').Stats): FileEntry {
  const kind: EntryKind = stats.isDirectory()
    ? 'directory'
    : stats.isSymbolicLink()
      ? 'symlink'
      : stats.isFile()
        ? 'file'
        : 'other';
  // Windows reports 0o666 / 0o777 and does not implement the Unix bits; the numbers shown
  // are the closest honest equivalent, so a folder still reads as `drwx`.
  const mode = (stats.mode & 0o7777) | (kind === 'directory' ? 0o40000 : 0);
  return {
    name,
    path: virtual,
    kind,
    size: stats.isDirectory() ? 0 : stats.size,
    mtime: Math.round(stats.mtimeMs),
    atime: Math.round(stats.atimeMs),
    mode,
    modeText: modeText(mode),
    owner: os.userInfo().username,
    group: isWindows ? '' : String(stats.gid),
    uid: isWindows ? 0 : stats.uid,
    gid: isWindows ? 0 : stats.gid,
    hidden: name.startsWith('.') || (isWindows && name.startsWith('$')),
  };
}

/** The drives visible to this computer, as entries under `/`. */
async function listDrives(): Promise<FileEntry[]> {
  if (!isWindows) {
    const stats = await fs.stat('/');
    return [entryFor('/', '/', stats)];
  }
  const letters: string[] = [];
  for (let code = 65; code <= 90; code += 1) {
    const letter = String.fromCharCode(code);
    try {
      await fs.access(`${letter}:\\`, constants.F_OK);
      letters.push(letter);
    } catch {
      /* not mounted */
    }
  }
  const entries: FileEntry[] = [];
  for (const letter of letters) {
    const root = `/${letter}:/`;
    const stats = await fs.stat(`${letter}:\\`);
    const entry = entryFor(root, `${letter}:`, stats);
    // A drive is always a directory, whatever `stat` says about the mount point.
    entry.kind = 'directory';
    entry.name = `${letter}:`;
    entries.push(entry);
  }
  return entries;
}

export class LocalFs {
  constructor(private readonly logger: import('../logger.js').Logger) {}

  /** The interface knows where a local tab starts; home is the useful answer. */
  async resolve(input: string | undefined): Promise<string> {
    if (input === undefined || input === '') return toVirtualPath(os.homedir());
    if (input === '~') return toVirtualPath(os.homedir());
    if (input.startsWith('~/')) return toVirtualPath(path.join(os.homedir(), input.slice(2)));
    return normalizeLocalPath(input);
  }

  async normalize(input: string): Promise<string> {
    return normalizeLocalPath(input);
  }

  async list(options: { path?: string; limit?: number } = {}): Promise<DirectoryListing> {
    const virtual = await this.resolve(options.path);
    if (virtual === '/' || (isWindows && driveOf(virtual) === null)) {
      const entries = await listDrives();
      return { path: '/', parent: null, entries, truncated: false };
    }
    const native = toNativePath(virtual);
    let names: string[];
    try {
      names = await fs.readdir(native);
    } catch (err) {
      throw localError(err, virtual);
    }

    const entries: FileEntry[] = [];
    for (const name of names) {
      try {
        const stats = await fs.lstat(path.join(native, name));
        entries.push(entryFor(virtual === '/' ? `/${name}` : `${virtual}/${name}`, name, stats));
      } catch {
        // A file can vanish between readdir and lstat; skipping it is the useful answer.
      }
    }
    const limit = options.limit ?? entries.length;
    // The drive root has no parent: `/` is the list of drives, not a folder above them.
    const drive = driveOf(virtual);
    const atDriveRoot = isWindows && drive !== null && virtual.replace(/\/$/, '') === `/${drive}`;
    return {
      path: virtual,
      parent: atDriveRoot ? '/' : virtual === '/' ? null : (virtual.slice(0, virtual.lastIndexOf('/')) || '/'),
      entries: entries.slice(0, limit),
      truncated: entries.length > limit,
    };
  }

  async stat(virtual: string, follow = false): Promise<FileEntry> {
    const target = normalizeLocalPath(await this.resolve(virtual));
    const native = toNativePath(target);
    if (target === '/') {
      return {
        name: '/',
        path: '/',
        kind: 'directory',
        size: 0,
        mtime: 0,
        atime: 0,
        mode: 0o40755,
        modeText: modeText(0o40755),
        owner: os.userInfo().username,
        group: '',
        uid: 0,
        gid: 0,
        hidden: false,
      };
    }
    try {
      const stats = follow ? await fs.stat(native) : await fs.lstat(native);
      const name = target.slice(target.lastIndexOf('/') + 1) || target;
      return entryFor(target, name, stats);
    } catch (err) {
      throw localError(err, target);
    }
  }

  async read(virtual: string, maxBytes = 1024 * 1024): Promise<ReadResult> {
    const entry = await this.stat(virtual, true);
    if (entry.kind === 'directory') {
      throw badRequest('A directory cannot be read as a file.', { path: entry.path });
    }
    const native = toNativePath(entry.path);
    const handle = await fs.open(native, 'r');
    try {
      const size = Math.min(entry.size, maxBytes);
      const buffer = Buffer.alloc(size);
      await handle.read(buffer, 0, size, 0);
      const kind = detectReadKind(buffer, { name: entry.name, size: entry.size, maxBytes });
      if (kind === 'text') {
        const content = buffer.toString('utf8');
        return {
          kind,
          content,
          size: entry.size,
          truncated: entry.size > buffer.length,
          encoding: 'utf8',
          mimeType: 'text/plain; charset=utf-8',
          lines: content.split('\n').length,
        };
      }
      return {
        kind,
        size: entry.size,
        truncated: entry.size > buffer.length,
        encoding: '',
        mimeType: 'application/octet-stream',
      };
    } finally {
      await handle.close();
    }
  }

  async readRange(virtual: string, start: number, end: number): Promise<Buffer> {
    const native = toNativePath(await this.resolve(virtual));
    const handle = await fs.open(native, 'r');
    try {
      const length = Math.max(0, end - start + 1);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, start);
      return buffer;
    } finally {
      await handle.close();
    }
  }

  async openReadStream(virtual: string): Promise<Readable> {
    const entry = await this.stat(virtual, true);
    return createReadStream(toNativePath(entry.path));
  }

  async openWriteStream(virtual: string, _mode = 0o644): Promise<Writable> {
    return createWriteStream(toNativePath(await this.resolve(virtual)));
  }

  /** Where a symlink points, or null when the path is not one. */
  async readlink(virtual: string): Promise<string | null> {
    try {
      return await fs.readlink(toNativePath(await this.resolve(virtual)));
    } catch {
      return null;
    }
  }

  /**
   * Creates a symbolic link.
   *
   * Windows needs the type up front and refuses without the privilege; both are reported as
   * a normal operation failure so a relayed tree reports the entry rather than the batch.
   */
  async symlink(linkPath: string, target: string): Promise<void> {
    const nativeLink = toNativePath(await this.resolve(linkPath));
    const nativeTarget = toNativePath(target);
    try {
      await fs.symlink(nativeTarget, nativeLink, 'file');
    } catch (err) {
      throw localError(err, linkPath);
    }
  }

  async exists(virtual: string): Promise<boolean> {
    try {
      await fs.access(toNativePath(await this.resolve(virtual)));
      return true;
    } catch {
      return false;
    }
  }

  async isDirectory(virtual: string): Promise<boolean> {
    try {
      return (await fs.stat(toNativePath(await this.resolve(virtual)))).isDirectory();
    } catch {
      return false;
    }
  }

  async mkdir(virtual: string): Promise<FileEntry> {
    const target = normalizeLocalPath(await this.resolve(virtual));
    try {
      await fs.mkdir(toNativePath(target));
    } catch (err) {
      throw localError(err, target);
    }
    return this.stat(target);
  }

  async mkdirRecursive(virtual: string): Promise<void> {
    await fs.mkdir(toNativePath(await this.resolve(virtual)), { recursive: true });
  }

  async rename(from: string, to: string): Promise<FileEntry> {
    const source = normalizeLocalPath(await this.resolve(from));
    const target = normalizeLocalPath(await this.resolve(to));
    try {
      await fs.rename(toNativePath(source), toNativePath(target));
    } catch (err) {
      throw localError(err, source);
    }
    return this.stat(target);
  }

  async chmod(virtual: string, mode: string | number): Promise<FileEntry> {
    const target = normalizeLocalPath(await this.resolve(virtual));
    const numeric = typeof mode === 'number' ? mode : Number.parseInt(mode, 8);
    if (!Number.isFinite(numeric)) throw badRequest(`Not a permission mode: ${String(mode)}`);
    try {
      await fs.chmod(toNativePath(target), numeric & 0o7777);
    } catch (err) {
      // Windows has no Unix permission bits; refusing outright would make the dialog
      // unusable there, so the attempt is recorded and the entry re-read.
      this.logger.debug('local chmod is a no-op on this platform', { path: target, error: err });
    }
    return this.stat(target);
  }

  async touch(virtual: string, mtimeMs?: number): Promise<FileEntry> {
    const target = normalizeLocalPath(await this.resolve(virtual));
    const when = mtimeMs === undefined ? new Date() : new Date(mtimeMs);
    try {
      await fs.utimes(toNativePath(target), when, when);
    } catch (err) {
      throw localError(err, target);
    }
    return this.stat(target);
  }

  async remove(paths: string[], recursive: boolean): Promise<{ deleted: string[]; failed: { path: string; message: string }[] }> {
    const deleted: string[] = [];
    const failed: { path: string; message: string }[] = [];
    for (const input of paths) {
      const target = normalizeLocalPath(await this.resolve(input));
      try {
        await fs.rm(toNativePath(target), { recursive, force: false });
        deleted.push(target);
      } catch (err) {
        failed.push({ path: target, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return { deleted, failed };
  }

  async copy(sources: string[], destination: string, options: { overwrite?: boolean } = {}): Promise<{ copied: FileEntry[]; failed: { path: string; message: string }[] }> {
    const target = normalizeLocalPath(await this.resolve(destination));
    const copied: FileEntry[] = [];
    const failed: { path: string; message: string }[] = [];
    for (const input of sources) {
      const source = normalizeLocalPath(await this.resolve(input));
      const name = source.slice(source.lastIndexOf('/') + 1) || source;
      const into = target === '/' ? `/${name}` : `${target}/${name}`;
      try {
        await fs.cp(toNativePath(source), toNativePath(into), {
          recursive: true,
          force: options.overwrite === true,
          errorOnExist: options.overwrite !== true,
        });
        copied.push(await this.stat(into));
      } catch (err) {
        failed.push({ path: into, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return { copied, failed };
  }

  async move(sources: string[], destination: string, options: { overwrite?: boolean } = {}): Promise<{ copied: FileEntry[]; failed: { path: string; message: string }[] }> {
    const target = normalizeLocalPath(await this.resolve(destination));
    const copied: FileEntry[] = [];
    const failed: { path: string; message: string }[] = [];
    for (const input of sources) {
      const source = normalizeLocalPath(await this.resolve(input));
      const name = source.slice(source.lastIndexOf('/') + 1) || source;
      const into = target === '/' ? `/${name}` : `${target}/${name}`;
      try {
        if (options.overwrite === true && (await this.exists(into))) {
          await fs.rm(toNativePath(into), { recursive: true, force: true });
        }
        await fs.rename(toNativePath(source), toNativePath(into));
        copied.push(await this.stat(into));
      } catch (err) {
        failed.push({ path: into, message: err instanceof Error ? err.message : String(err) });
      }
    }
    return { copied, failed };
  }

  async search(options: { path?: string; query: string; limit?: number; scanCap?: number }): Promise<{ results: FileEntry[]; truncated: boolean; scanned: number }> {
    const start = normalizeLocalPath(await this.resolve(options.path));
    const limit = options.limit ?? 200;
    const cap = options.scanCap ?? 5_000;
    const needle = options.query.toLowerCase();
    const results: FileEntry[] = [];
    const queue: string[] = [start];
    let scanned = 0;
    let truncated = false;

    while (queue.length > 0) {
      if (scanned >= cap || results.length >= limit) {
        truncated = true;
        break;
      }
      const current = queue.shift() as string;
      let names: string[];
      try {
        names = await fs.readdir(toNativePath(current));
      } catch {
        continue;
      }
      for (const name of names) {
        scanned += 1;
        const virtual = current === '/' ? `/${name}` : `${current}/${name}`;
        let stats: import('node:fs').Stats;
        try {
          stats = await fs.lstat(toNativePath(virtual));
        } catch {
          continue;
        }
        if (name.toLowerCase().includes(needle)) {
          results.push(entryFor(virtual, name, stats));
          if (results.length >= limit) {
            truncated = true;
            break;
          }
        }
        if (stats.isDirectory()) queue.push(virtual);
      }
    }
    return { results, truncated, scanned };
  }

  async usage(paths: string[]): Promise<{ path: string; bytes: number; truncated: boolean }[]> {
    return Promise.all(
      paths.map(async (input) => {
        const target = normalizeLocalPath(await this.resolve(input));
        let bytes = 0;
        try {
          bytes = await directorySize(toNativePath(target));
        } catch {
          bytes = 0;
        }
        return { path: target, bytes, truncated: false };
      }),
    );
  }

  /** Runs a command on this computer; used by the archive and tree-size paths. */
  run(command: string, args: string[]): Promise<{ stdout: string; code: number }> {
    return new Promise((resolve) => {
      execFile(command, args, { maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
        resolve({ stdout: stdout ?? '', code: err === null ? 0 : 1 });
      });
    });
  }
}

/** Total apparent size of a local tree. Windows has no `du`, and this is cheap enough. */
async function directorySize(native: string): Promise<number> {
  const stats = await fs.lstat(native);
  if (!stats.isDirectory()) return stats.size;
  let total = 0;
  const names = await fs.readdir(native).catch(() => [] as string[]);
  for (const name of names) {
    try {
      total += await directorySize(path.join(native, name));
    } catch {
      /* a file that vanished, or a link we cannot follow */
    }
  }
  return total;
}
