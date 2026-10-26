import { PassThrough, Readable, Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Client, FileInfo, FileType, FTPError } from 'basic-ftp';

import { ApiError, badRequest, notFound } from '../errors.js';
import type { Logger } from '../logger.js';
import type { DirectoryListing, FileEntry, EntryKind, ReadResult } from '../types.js';
import { DEFAULT_MAX_READ_BYTES, MAX_MAX_READ_BYTES, countLines, detectReadKind, mimeTypeFor } from '../util/fileKind.js';
import {
  basename,
  joinRemotePath,
  normalizeRemotePath,
  parentRemotePath,
} from '../util/remotePath.js';
import { modeText } from '../ssh/fsOps.js';
import type { FtpConnection } from './FtpConnection.js';

export const DEFAULT_LIST_LIMIT = 5_000;
export const MAX_LIST_LIMIT = 20_000;
export const DEFAULT_SEARCH_LIMIT = 200;
export const MAX_SEARCH_LIMIT = 2_000;
export const DEFAULT_SEARCH_SCAN_CAP = 200_000;

export interface ListOptions {
  path?: string;
  limit?: number;
}

export interface RemoveResult {
  deleted: string[];
  failed: { path: string; message: string }[];
}

export interface CopyMoveResult {
  copied: FileEntry[];
  failed: { path: string; message: string }[];
}

export interface SearchOptions {
  query: string;
  path?: string;
  limit?: number;
  scanCap?: number;
}

export interface UsageEntry {
  path: string;
  bytes: number;
  truncated: boolean;
}

export class FtpFs {
  constructor(
    private readonly connection: FtpConnection,
    private readonly logger: Logger,
  ) {}

  async resolve(input: string | undefined, baseDir?: string): Promise<string> {
    return this.connection.resolvePath(input, baseDir);
  }

  async normalize(input: string): Promise<string> {
    const raw = normalizeRemotePath(input);
    return raw === '' || raw === '.' ? this.connection.remoteHome() : raw;
  }

  private mapFileInfo(dir: string, info: FileInfo): FileEntry {
    const isDir = info.type === FileType.Directory;
    const isSymlink = info.type === FileType.SymbolicLink;
    const kind: EntryKind = isDir ? 'directory' : isSymlink ? 'symlink' : 'file';

    const u = info.permissions?.user ?? (isDir ? 7 : 6);
    const g = info.permissions?.group ?? (isDir ? 5 : 4);
    const o = info.permissions?.world ?? (isDir ? 5 : 4);
    const typeBits = isDir ? 0o040000 : isSymlink ? 0o120000 : 0o100000;
    const mode = typeBits | (u << 6) | (g << 3) | o;

    const fullPath = dir === '/' ? `/${info.name}` : `${dir}/${info.name}`;
    const mtime = info.modifiedAt ? info.modifiedAt.getTime() : Date.now();

    return {
      name: info.name,
      path: fullPath,
      kind,
      ...(info.link ? { target: info.link } : {}),
      size: isDir ? 0 : info.size,
      mtime,
      atime: mtime,
      mode,
      modeText: modeText(mode),
      owner: info.user ?? '',
      group: info.group ?? '',
      uid: 0,
      gid: 0,
      hidden: info.name.startsWith('.'),
      ...(info.hardLinkCount !== undefined ? { linkCount: info.hardLinkCount } : {}),
    };
  }

  async list(options: ListOptions = {}): Promise<DirectoryListing> {
    const targetPath = normalizeRemotePath(await this.resolve(options.path));
    const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT));

    return await this.connection.withClient(async (client) => {
      const current = await client.pwd().catch(() => '/');
      try {
        await client.cd(targetPath);
        const rawList = await client.list();
        // Exclude '.' and '..'
        const filtered = rawList.filter((item) => item.name !== '.' && item.name !== '..');
        const truncated = filtered.length > limit;
        const slice = truncated ? filtered.slice(0, limit) : filtered;

        const entries = slice.map((item) => this.mapFileInfo(targetPath, item));

        // Sort: directories first, then alphabetically
        entries.sort((a, b) => {
          if (a.kind === 'directory' && b.kind !== 'directory') return -1;
          if (a.kind !== 'directory' && b.kind === 'directory') return 1;
          return a.name.localeCompare(b.name);
        });

        return {
          path: targetPath,
          parent: parentRemotePath(targetPath),
          entries,
          truncated,
        };
      } catch (err) {
        if (err instanceof FTPError && err.code === 550) {
          throw notFound(`Directory not found: ${targetPath}`, { path: targetPath });
        }
        throw err;
      } finally {
        await client.cd(current).catch(() => undefined);
      }
    });
  }

  async stat(remotePath: string, follow = false): Promise<FileEntry> {
    const target = normalizeRemotePath(await this.resolve(remotePath));
    if (target === '/' || target === '') {
      return {
        name: '/',
        path: '/',
        kind: 'directory',
        size: 0,
        mtime: Date.now(),
        atime: Date.now(),
        mode: 0o040755,
        modeText: 'drwxr-xr-x',
        owner: '',
        group: '',
        uid: 0,
        gid: 0,
        hidden: false,
      };
    }

    const parent = parentRemotePath(target) ?? '/';
    const targetName = basename(target);

    return await this.connection.withClient(async (client) => {
      const current = await client.pwd().catch(() => '/');
      try {
        await client.cd(parent);
        const list = await client.list();
        const match = list.find((item) => item.name === targetName);
        if (!match) {
          throw notFound(`File not found: ${target}`, { path: target });
        }
        const entry = this.mapFileInfo(parent, match);
        if (follow && entry.kind === 'symlink' && entry.target) {
          return await this.stat(joinRemotePath(parent, entry.target), false);
        }
        return entry;
      } catch (err) {
        if (err instanceof ApiError) throw err;
        if (err instanceof FTPError && err.code === 550) {
          throw notFound(`File not found: ${target}`, { path: target });
        }
        throw err;
      } finally {
        await client.cd(current).catch(() => undefined);
      }
    });
  }

  async readlink(remotePath: string): Promise<string | null> {
    const entry = await this.stat(remotePath, false);
    return entry.target ?? null;
  }

  async read(remotePath: string, maxBytesRaw?: number): Promise<ReadResult> {
    const target = normalizeRemotePath(await this.resolve(remotePath));
    const entry = await this.stat(target, true);
    if (entry.kind === 'directory') {
      throw badRequest('Cannot read a directory', { path: target });
    }

    const maxBytes = Math.max(1, Math.min(maxBytesRaw ?? DEFAULT_MAX_READ_BYTES, MAX_MAX_READ_BYTES));
    const readLength = Math.max(maxBytes, 1);
    const sample = await this.readRange(target, 0, Math.min(entry.size - 1, readLength - 1));
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

  async readRange(remotePath: string, start: number, end: number): Promise<Buffer> {
    const stream = await this.openReadStream(remotePath, { start, end });
    const chunks: Buffer[] = [];
    return new Promise<Buffer>((resolve, reject) => {
      stream.on('data', (chunk: Buffer) => chunks.push(chunk));
      stream.once('end', () => resolve(Buffer.concat(chunks)));
      stream.once('error', reject);
    });
  }

  async openReadStream(remotePath: string, range?: { start: number; end?: number }): Promise<Readable> {
    const target = normalizeRemotePath(await this.resolve(remotePath));
    const parent = parentRemotePath(target) ?? '/';
    const filename = basename(target);
    const passThrough = new PassThrough();

    (async () => {
      let client: Client | null = null;
      try {
        client = await this.connection.createTransferClient(4_000);
      } catch {
        client = null;
      }

      if (client) {
        try {
          await client.cd(parent);
          await client.downloadTo(passThrough, filename, range?.start ?? 0);
          passThrough.end();
        } catch (err) {
          passThrough.destroy(err instanceof Error ? err : new Error(String(err)));
        } finally {
          client.close();
        }
      } else {
        await this.connection.withClient(async (ctrlClient) => {
          const currentDir = await ctrlClient.pwd().catch(() => '/');
          try {
            await ctrlClient.cd(parent);
            await ctrlClient.downloadTo(passThrough, filename, range?.start ?? 0);
            passThrough.end();
          } catch (err) {
            passThrough.destroy(err instanceof Error ? err : new Error(String(err)));
          } finally {
            await ctrlClient.cd(currentDir).catch(() => undefined);
          }
        }).catch((err) => {
          passThrough.destroy(err instanceof Error ? err : new Error(String(err)));
        });
      }
    })();

    if (range?.end !== undefined && range.start !== undefined) {
      const maxBytes = range.end - range.start + 1;
      let sent = 0;
      const limiter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          if (sent >= maxBytes) {
            cb(null, null);
            return;
          }
          const needed = maxBytes - sent;
          const slice = chunk.length > needed ? chunk.subarray(0, needed) : chunk;
          sent += slice.length;
          cb(null, slice);
          if (sent >= maxBytes) {
            this.push(null);
          }
        },
      });
      return passThrough.pipe(limiter);
    }

    return passThrough;
  }

  async openWriteStream(remotePath: string, _mode = 0o644): Promise<Writable> {
    const target = normalizeRemotePath(await this.resolve(remotePath));
    const parent = parentRemotePath(target) ?? '/';
    const filename = basename(target);

    const passThrough = new PassThrough();
    let uploadError: Error | null = null;

    const uploadPromise = (async () => {
      let client: Client | null = null;
      try {
        client = await this.connection.createTransferClient(4_000);
      } catch {
        client = null;
      }

      if (client) {
        try {
          await client.ensureDir(parent);
          await client.uploadFrom(passThrough, filename);
        } finally {
          client.close();
        }
      } else {
        await this.connection.withClient(async (ctrlClient) => {
          const currentDir = await ctrlClient.pwd().catch(() => '/');
          try {
            await ctrlClient.ensureDir(parent);
            await ctrlClient.uploadFrom(passThrough, filename);
          } finally {
            await ctrlClient.cd(currentDir).catch(() => undefined);
          }
        });
      }
    })().catch((err) => {
      uploadError = err instanceof Error ? err : new Error(String(err));
      passThrough.destroy(uploadError);
      throw uploadError;
    });

    const writable = new Writable({
      write(chunk, encoding, cb) {
        if (uploadError) return cb(uploadError);
        const ok = passThrough.write(chunk, encoding);
        if (ok) {
          cb();
        } else {
          passThrough.once('drain', () => cb());
        }
      },
      final(cb) {
        passThrough.end();
        uploadPromise
          .then(() => cb())
          .catch((err) => cb(err instanceof Error ? err : new Error(String(err))));
      },
      destroy(err, cb) {
        passThrough.destroy(err ?? undefined);
        cb(err);
      },
    });

    return writable;
  }

  async mkdir(remotePath: string): Promise<FileEntry> {
    const target = normalizeRemotePath(await this.resolve(remotePath));
    await this.connection.withClient(async (client) => {
      const current = await client.pwd().catch(() => '/');
      try {
        await client.ensureDir(target);
      } finally {
        await client.cd(current).catch(() => undefined);
      }
    });
    return await this.stat(target);
  }

  async mkdirRecursive(remotePath: string): Promise<void> {
    const target = normalizeRemotePath(await this.resolve(remotePath));
    await this.connection.withClient(async (client) => {
      const current = await client.pwd().catch(() => '/');
      try {
        await client.ensureDir(target);
      } finally {
        await client.cd(current).catch(() => undefined);
      }
    });
  }

  async rename(from: string, to: string): Promise<FileEntry> {
    const targetFrom = normalizeRemotePath(await this.resolve(from));
    const targetTo = normalizeRemotePath(await this.resolve(to));

    await this.connection.withClient(async (client) => {
      await client.rename(targetFrom, targetTo);
    });
    return await this.stat(targetTo);
  }

  async renameRaw(from: string, to: string): Promise<void> {
    const targetFrom = normalizeRemotePath(await this.resolve(from));
    const targetTo = normalizeRemotePath(await this.resolve(to));

    await this.connection.withClient(async (client) => {
      await client.rename(targetFrom, targetTo);
    });
  }

  async chmod(remotePath: string, mode: string | number): Promise<FileEntry> {
    const target = normalizeRemotePath(await this.resolve(remotePath));
    const modeNum = typeof mode === 'number' ? mode.toString(8) : mode;

    await this.connection.withClient(async (client) => {
      await client.sendIgnoringError(`SITE CHMOD ${modeNum} ${target}`);
    });
    return await this.stat(target);
  }

  async touch(remotePath: string, _mtimeMs?: number): Promise<FileEntry> {
    const target = normalizeRemotePath(await this.resolve(remotePath));
    const parent = parentRemotePath(target) ?? '/';
    const filename = basename(target);
    const alreadyExists = await this.exists(target);

    if (!alreadyExists) {
      await this.connection.withClient(async (client) => {
        const current = await client.pwd().catch(() => '/');
        try {
          await client.ensureDir(parent);
          await client.uploadFrom(Readable.from([]), filename);
        } finally {
          await client.cd(current).catch(() => undefined);
        }
      });
    }

    return await this.stat(target);
  }

  async exists(remotePath: string): Promise<boolean> {
    try {
      await this.stat(remotePath, false);
      return true;
    } catch {
      return false;
    }
  }

  async isDirectory(remotePath: string): Promise<boolean> {
    try {
      const entry = await this.stat(remotePath, false);
      return entry.kind === 'directory';
    } catch {
      return false;
    }
  }

  async remove(paths: string[], recursive: boolean): Promise<RemoveResult> {
    const deleted: string[] = [];
    const failed: { path: string; message: string }[] = [];

    for (const raw of paths) {
      try {
        const target = normalizeRemotePath(await this.resolve(raw));
        const isDir = await this.isDirectory(target);

        await this.connection.withClient(async (client) => {
          if (isDir) {
            if (recursive) {
              await client.removeDir(target);
            } else {
              await client.removeEmptyDir(target);
            }
          } else {
            await client.remove(target);
          }
        });
        deleted.push(target);
      } catch (err) {
        failed.push({
          path: raw,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { deleted, failed };
  }

  async symlink(_linkPath: string, _target: string): Promise<void> {
    throw new ApiError('NOT_SUPPORTED', 'FTP does not support creating symbolic links.');
  }

  async copy(
    sources: string[],
    destination: string,
    options: { overwrite?: boolean } = {},
  ): Promise<CopyMoveResult> {
    const destDir = normalizeRemotePath(await this.resolve(destination));
    const copied: FileEntry[] = [];
    const failed: { path: string; message: string }[] = [];

    for (const source of sources) {
      try {
        const srcPath = normalizeRemotePath(await this.resolve(source));
        const srcStat = await this.stat(srcPath, false);
        const targetPath = joinRemotePath(destDir, basename(srcPath));

        if (!options.overwrite && (await this.exists(targetPath))) {
          throw badRequest(`Destination already exists: ${targetPath}`);
        }

        if (srcStat.kind === 'directory') {
          await this.mkdirRecursive(targetPath);
          const children = await this.list({ path: srcPath });
          const childSources = children.entries.map((e) => e.path);
          if (childSources.length > 0) {
            const childResult = await this.copy(childSources, targetPath, options);
            failed.push(...childResult.failed);
          }
          copied.push(await this.stat(targetPath));
        } else {
          const readStream = await this.openReadStream(srcPath);
          const writeStream = await this.openWriteStream(targetPath);
          await pipeline(readStream, writeStream);
          copied.push(await this.stat(targetPath));
        }
      } catch (err) {
        failed.push({
          path: source,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { copied, failed };
  }

  async move(
    sources: string[],
    destination: string,
    options: { overwrite?: boolean } = {},
  ): Promise<CopyMoveResult> {
    const destDir = normalizeRemotePath(await this.resolve(destination));
    const copied: FileEntry[] = [];
    const failed: { path: string; message: string }[] = [];

    for (const source of sources) {
      try {
        const srcPath = normalizeRemotePath(await this.resolve(source));
        const targetPath = joinRemotePath(destDir, basename(srcPath));

        if (!options.overwrite && (await this.exists(targetPath))) {
          throw badRequest(`Destination already exists: ${targetPath}`);
        }

        // Try fast atomic rename first
        try {
          await this.renameRaw(srcPath, targetPath);
          copied.push(await this.stat(targetPath));
          continue;
        } catch {
          // Fall back to copy + delete
          const copyResult = await this.copy([srcPath], destDir, options);
          if (copyResult.failed.length > 0) {
            failed.push(...copyResult.failed);
          } else {
            await this.remove([srcPath], true);
            copied.push(...copyResult.copied);
          }
        }
      } catch (err) {
        failed.push({
          path: source,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { copied, failed };
  }

  async search(
    options: SearchOptions,
  ): Promise<{ results: FileEntry[]; truncated: boolean; scanned: number }> {
    const startPath = normalizeRemotePath(await this.resolve(options.path));
    const limit = Math.max(1, Math.min(options.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT));
    const scanCap = Math.max(limit, Math.min(options.scanCap ?? DEFAULT_SEARCH_SCAN_CAP, DEFAULT_SEARCH_SCAN_CAP * 10));

    const needle = options.query.toLowerCase();
    const results: FileEntry[] = [];
    const queue: string[] = [startPath];
    let scanned = 0;
    let truncated = false;

    while (queue.length > 0) {
      const current = queue.shift()!;
      scanned++;

      let listing: DirectoryListing;
      try {
        listing = await this.list({ path: current, limit: 1000 });
      } catch {
        continue;
      }

      for (const entry of listing.entries) {
        scanned++;
        if (entry.name.toLowerCase().includes(needle)) {
          results.push(entry);
          if (results.length >= limit) {
            truncated = true;
            return { results, truncated, scanned };
          }
        }
        if (entry.kind === 'directory') {
          queue.push(entry.path);
        }
        if (scanned >= scanCap) {
          truncated = true;
          return { results, truncated, scanned };
        }
      }
    }

    return { results, truncated, scanned };
  }

  async usage(paths: string[]): Promise<UsageEntry[]> {
    const results: UsageEntry[] = [];

    for (const raw of paths) {
      try {
        const target = normalizeRemotePath(await this.resolve(raw));
        const entry = await this.stat(target, false);

        if (entry.kind !== 'directory') {
          results.push({ path: target, bytes: entry.size, truncated: false });
          continue;
        }

        let total = 0;
        let truncated = false;
        let nodes = 0;
        const queue: string[] = [target];

        while (queue.length > 0) {
          const current = queue.shift()!;
          let listing: DirectoryListing;
          try {
            listing = await this.list({ path: current, limit: 5000 });
          } catch {
            continue;
          }

          for (const child of listing.entries) {
            nodes++;
            if (child.kind === 'directory') {
              queue.push(child.path);
            } else {
              total += child.size;
            }
            if (nodes >= 50_000) {
              truncated = true;
              break;
            }
          }
          if (truncated) break;
        }

        results.push({ path: target, bytes: total, truncated });
      } catch {
        results.push({ path: raw, bytes: 0, truncated: false });
      }
    }

    return results;
  }
}
