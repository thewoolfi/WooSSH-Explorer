import { once } from 'node:events';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import * as yazl from 'yazl';

import { ApiError, badRequest, mapError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { FileEntry } from '../types.js';
import { safeArchiveEntryPath, safeArchiveLinkTarget } from '../util/archivePath.js';
import { basename, isInsideRemotePath, joinRemotePath, normalizeRemotePath, parentRemotePath } from '../util/remotePath.js';
import { execToolUnavailable, shellQuote } from './fsOps.js';
import type { SftpFs } from './fsOps.js';
import type { SshConnection } from './SshConnection.js';
import {
  TAR_BLOCK_SIZE,
  gnuLongNameBlocks,
  looksLikeTarHeader,
  parseTarHeader,
  splitUstarName,
  tarHeaderBlock,
  tarPadding,
} from './tarFormat.js';
import type { TarReadEntry } from './tarFormat.js';
import { ZIP_METHOD_DEFLATE, ZIP_METHOD_STORE, looksLikeZip, parseZipLocalHeader, readZipDirectory } from './zipFormat.js';
import type { ZipEntryMeta } from './zipFormat.js';

/**
 * `fs/archive` and `fs/extract` (contract §6).
 *
 * Creation prefers the remote `tar`/`zip` (one round trip, no bytes over SFTP) and falls back to
 * a streaming writer built on `yazl` / {@link ./tarFormat.js}. Extraction always lists and
 * validates the archive through the readers in this module first — only then may the remote
 * `tar`/`unzip` do the writing — because an entry that escapes `destinationDir` must be refused
 * *before* anything touches the filesystem.
 */

export type ArchiveFormat = 'tar' | 'tar.gz' | 'zip';

/** Cap on the entries read from one archive; beyond it the response says `truncated`. */
export const MAX_ARCHIVE_ENTRIES = 50_000;
/** Cap on the top-level `FileEntry` objects an extract response returns. */
export const MAX_EXTRACT_RESPONSE_ENTRIES = 5_000;
/** A zip symlink stores its target in the entry body; anything longer than this is bogus. */
const MAX_ZIP_LINK_TARGET_BYTES = 4096;
/** Depth bound for the archive walk; a symlink loop cannot reach it because links are not followed. */
const MAX_WALK_DEPTH = 128;
/** A generous but finite budget: archiving a large tree is slower than a normal command. */
const ARCHIVE_EXEC_TIMEOUT_MS = 600_000;
/** Chunk size for streaming a file into an archive or out of one. */
const COPY_CHUNK_BYTES = 256 * 1024;

export interface ArchiveRequest {
  paths: string[];
  destination: string;
  format: ArchiveFormat;
}

export interface ArchiveResult {
  entry: FileEntry;
  bytes: number;
}

export interface ExtractRequest {
  path: string;
  destinationDir: string;
  overwrite: boolean;
}

export interface ExtractResult {
  entries: FileEntry[];
  truncated: boolean;
}

interface ArchiveItem {
  /** Absolute source path on the remote host. */
  source: string;
  /** Entry name inside the archive (relative, `/`-separated). */
  name: string;
  kind: 'file' | 'directory' | 'symlink';
  size: number;
  mode: number;
  mtimeMs: number;
  linkTarget?: string;
}

// ----------------------------------------------------------------- creation

export async function createArchive(
  connection: SshConnection,
  fs: SftpFs,
  logger: Logger,
  request: ArchiveRequest,
): Promise<ArchiveResult> {
  const sources: { path: string; entry: FileEntry }[] = [];
  const names = new Set<string>();
  for (const input of request.paths) {
    const resolved = normalizeRemotePath(await fs.resolve(input));
    const entry = await fs.stat(resolved, false);
    const name = basename(entry.path);
    if (names.has(name)) {
      throw badRequest(`Two sources would share the archive entry "${name}"; rename one of them first.`, {
        path: entry.path,
      });
    }
    names.add(name);
    sources.push({ path: entry.path, entry });
  }
  if (sources.length === 0) throw badRequest('At least one path is required.');

  const destination = normalizeRemotePath(await fs.resolve(request.destination));
  for (const source of sources) {
    if (destination === source.path) {
      throw badRequest('The archive cannot be written over one of its own sources.', { path: destination });
    }
    if (source.entry.kind === 'directory' && isInsideRemotePath(destination, source.path)) {
      // Otherwise tar would try to archive the archive it is still writing.
      throw badRequest(`The archive destination ${destination} is inside the source ${source.path}.`, {
        path: destination,
      });
    }
  }

  const parent = destination.slice(0, destination.lastIndexOf('/')) || '/';
  await fs.mkdirRecursive(parent);

  try {
    const viaExec = await archiveViaExec(connection, fs, logger, request.format, destination, sources);
    if (!viaExec) {
      const items = await collectArchiveItems(fs, sources);
      if (request.format === 'zip') await writeZipArchive(fs, destination, items, logger);
      else await writeTarArchive(fs, destination, items, request.format);
    }
  } catch (err) {
    // Never leave a half-written archive behind for the next attempt to trip over.
    await fs.remove([destination], true).catch(() => undefined);
    throw err instanceof ApiError ? err : mapError(err);
  }

  const entry = await fs.stat(destination, false);
  return { entry, bytes: entry.size };
}

/** Command for a tar archive whose entries are the sources' basenames. */
export function buildTarArchiveCommand(
  format: 'tar' | 'tar.gz',
  destination: string,
  items: { parent: string; base: string }[],
): string | null {
  if (items.some((item) => item.base.startsWith('-') || item.parent === '')) return null;
  const flags = format === 'tar.gz' ? '-czf' : '-cf';
  const parts = [`tar ${flags} ${shellQuote(destination)}`];
  // GNU and BSD tar both apply `-C` to the file names that follow it, which is what gives every
  // source its basename as the archive root entry.
  for (const item of items) parts.push(`-C ${shellQuote(item.parent)} ${shellQuote(item.base)}`);
  return parts.join(' ');
}

/** Command for a zip archive; only possible when every source shares one parent directory. */
export function buildZipArchiveCommand(
  destination: string,
  parent: string,
  bases: readonly string[],
): string | null {
  if (bases.length === 0 || bases.some((base) => base.startsWith('-'))) return null;
  return `cd ${shellQuote(parent)} && zip -r -q ${shellQuote(destination)} ${bases.map(shellQuote).join(' ')}`;
}

export function buildTarExtractCommand(format: 'tar' | 'tar.gz', archivePath: string, destinationDir: string): string {
  const flags = format === 'tar.gz' ? '-xzf' : '-xf';
  return `tar ${flags} ${shellQuote(archivePath)} -C ${shellQuote(destinationDir)}`;
}

export function buildUnzipCommand(archivePath: string, destinationDir: string, overwrite: boolean): string {
  return `unzip ${overwrite ? '-o' : '-n'} -q ${shellQuote(archivePath)} -d ${shellQuote(destinationDir)}`;
}

/** Runs the remote archiver; `false` means "not available, use the SFTP writer". */
async function archiveViaExec(
  connection: SshConnection,
  fs: SftpFs,
  logger: Logger,
  format: ArchiveFormat,
  destination: string,
  sources: { path: string }[],
): Promise<boolean> {
  const items = sources.map((source) => ({
    parent: source.path.slice(0, source.path.lastIndexOf('/')) || '/',
    base: basename(source.path),
  }));

  let command: string | null;
  if (format === 'zip') {
    const parents = new Set(items.map((item) => item.parent));
    command =
      parents.size === 1
        ? buildZipArchiveCommand(destination, [...parents][0] as string, items.map((item) => item.base))
        : null;
  } else {
    command = buildTarArchiveCommand(format, destination, items);
  }
  if (command === null) return false;

  try {
    const result = await connection.exec(command, { timeoutMs: ARCHIVE_EXEC_TIMEOUT_MS });
    if (execToolUnavailable(result)) {
      logger.debug('remote archive tool is unavailable; using the SFTP writer', { format });
      return false;
    }
    if (result.code !== 0) {
      throw new ApiError(
        'REMOTE_ERROR',
        `The remote archive command failed: ${firstLine(result.stderr) || `exit ${String(result.code)}`}`,
        { code: result.code },
      );
    }
    return await fs.exists(destination);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'REMOTE_ERROR') throw err;
    logger.debug('archive command could not be started; using the SFTP writer', { format, error: err });
    return false;
  }
}

/** Walks the sources into archive entries: directories recurse, symlinks stay symlinks. */
export async function collectArchiveItems(fs: SftpFs, sources: { path: string }[]): Promise<ArchiveItem[]> {
  const items: ArchiveItem[] = [];
  for (const source of sources) {
    await collectOne(fs, source.path, basename(source.path), items, 0);
  }
  return items;
}

async function collectOne(
  fs: SftpFs,
  remotePath: string,
  name: string,
  out: ArchiveItem[],
  depth: number,
): Promise<void> {
  if (depth > MAX_WALK_DEPTH) {
    throw badRequest(`Refusing to archive ${remotePath}: the tree is deeper than ${MAX_WALK_DEPTH} levels.`, {
      path: remotePath,
    });
  }
  if (out.length >= MAX_ARCHIVE_ENTRIES) {
    throw badRequest(`Refusing to archive ${remotePath}: more than ${MAX_ARCHIVE_ENTRIES} entries.`, {
      path: remotePath,
    });
  }

  const entry = await fs.stat(remotePath, false);
  if (entry.kind === 'directory') {
    out.push({
      source: entry.path,
      name: `${name}/`,
      kind: 'directory',
      size: 0,
      mode: entry.mode,
      mtimeMs: entry.mtime,
    });
    const listing = await fs.list({ path: entry.path, limit: 20_000 });
    for (const child of listing.entries) {
      await collectOne(fs, child.path, `${name}/${child.name}`, out, depth + 1);
    }
    return;
  }
  if (entry.kind === 'symlink') {
    const linkTarget = entry.target ?? (await fs.readlink(entry.path));
    if (linkTarget === null) {
      throw badRequest(`Could not read the symlink target of ${entry.path}.`, { path: entry.path });
    }
    out.push({
      source: entry.path,
      name,
      kind: 'symlink',
      size: 0,
      mode: entry.mode,
      mtimeMs: entry.mtime,
      linkTarget,
    });
    return;
  }
  if (entry.kind !== 'file') {
    throw badRequest(`Cannot archive ${entry.path}: only files, directories and symlinks are supported.`, {
      path: entry.path,
    });
  }
  out.push({ source: entry.path, name, kind: 'file', size: entry.size, mode: entry.mode, mtimeMs: entry.mtime });
}

/** Writes a tar/tar.gz through the SFTP session (no remote `tar` needed). */
async function writeTarArchive(
  fs: SftpFs,
  destination: string,
  items: ArchiveItem[],
  format: 'tar' | 'tar.gz',
): Promise<void> {
  const out = await fs.openWriteStream(destination, 0o644);
  const gzip = format === 'tar.gz' ? zlib.createGzip() : null;
  const sink: Writable = gzip ?? out;
  const drained = gzip !== null ? pipeline(gzip, out) : null;

  try {
    for (const item of items) {
      await writeTarEntry(fs, sink, item);
    }
    // Two zero blocks terminate a tar archive.
    await writeAll(sink, Buffer.alloc(TAR_BLOCK_SIZE * 2));
    if (gzip !== null) gzip.end();
    else sink.end();
    if (drained !== null) await drained;
  } catch (err) {
    gzip?.destroy();
    out.destroy();
    throw err;
  }
}

async function writeTarEntry(fs: SftpFs, sink: Writable, item: ArchiveItem): Promise<void> {
  if (Buffer.byteLength(item.name, 'utf8') > 100 && splitUstarName(item.name) === null) {
    const { header, data } = gnuLongNameBlocks(item.name);
    await writeAll(sink, header);
    await writeAll(sink, data);
  }

  await writeAll(
    sink,
    tarHeaderBlock({
      name: item.name,
      mode: item.mode,
      size: item.kind === 'file' ? item.size : 0,
      mtimeMs: item.mtimeMs,
      typeflag: item.kind === 'directory' ? '5' : item.kind === 'symlink' ? '2' : '0',
      ...(item.linkTarget !== undefined ? { linkname: item.linkTarget } : {}),
    }),
  );

  if (item.kind !== 'file') return;

  const source = await fs.openReadStream(item.source);
  // The data sink forwards into the tar stream without ending it.
  await pipeline(
    source,
    new Writable({
      write(chunk: Buffer, _encoding, callback): void {
        if (sink.write(chunk)) callback();
        else sink.once('drain', () => callback());
      },
    }),
  );
  const padding = tarPadding(item.size);
  if (padding > 0) await writeAll(sink, Buffer.alloc(padding));
}

/** Writes a zip through `yazl`; symlinks have no portable zip representation and are skipped. */
async function writeZipArchive(fs: SftpFs, destination: string, items: ArchiveItem[], logger: Logger): Promise<void> {
  const zip = new yazl.ZipFile();
  const output = zip.outputStream as unknown as Readable;
  const streams = new Set<Readable>();
  let failure: Error | null = null;
  zip.on('error', (err: Error) => {
    failure ??= err;
  });

  try {
    for (const item of items) {
      if (item.kind === 'directory') {
        zip.addEmptyDirectory(item.name, { mode: item.mode, mtime: new Date(item.mtimeMs) });
        continue;
      }
      if (item.kind === 'symlink') {
        logger.debug('zip cannot store a symlink; skipping it', { path: item.source });
        continue;
      }
      const source = await fs.openReadStream(item.source);
      streams.add(source);
      source.once('close', () => streams.delete(source));
      zip.addReadStream(source, item.name, {
        size: item.size,
        mode: item.mode,
        mtime: new Date(item.mtimeMs),
      });
    }

    zip.end();
    const out = await fs.openWriteStream(destination, 0o644);
    await pipeline(output, out);
    if (failure !== null) throw failure;
  } catch (err) {
    for (const stream of streams) stream.destroy();
    throw err;
  }
}

// --------------------------------------------------------------- extraction

/** One entry as read from an archive, before the §6 path rules are applied. */
export interface ArchiveRawEntry {
  name: string;
  kind: 'file' | 'directory' | 'symlink' | 'skip';
  size: number;
  mode: number;
  linkTarget?: string;
  zip?: ZipEntryMeta;
}

interface ExtractItem extends ArchiveRawEntry {
  /** Position of the entry in the archive (metadata headers excluded on both sides). */
  order: number;
  /** Raw entry name as stored. */
  rawName: string;
  /** Absolute destination path, already validated against the destination directory. */
  path: string;
  /** Normalised relative name. */
  relative: string;
}

interface ArchiveListing {
  items: ArchiveRawEntry[];
  truncated: boolean;
}

export async function extractArchive(
  connection: SshConnection,
  fs: SftpFs,
  logger: Logger,
  request: ExtractRequest,
): Promise<ExtractResult> {
  // Follow symlinks here: the client asked for the contents of the target.
  const archiveEntry = await fs.stat(request.path, true);
  if (archiveEntry.kind === 'directory') {
    throw badRequest('A directory cannot be extracted.', { path: archiveEntry.path });
  }
  if (archiveEntry.size <= 0) throw badRequest('The archive is empty.', { path: archiveEntry.path });

  const destinationDir = normalizeRemotePath(await fs.resolve(request.destinationDir));
  const format = await detectArchiveFormat(fs, archiveEntry.path, archiveEntry.size);
  if (format === null) {
    throw badRequest('The file is not a tar, tar.gz or zip archive.', { path: archiveEntry.path });
  }

  const listing =
    format === 'zip'
      ? await listZipEntries(fs, archiveEntry.path, archiveEntry.size, logger)
      : await listTarEntries(fs, archiveEntry.path, format);

  if (listing.items.length === 0) {
    throw badRequest('The archive contains no readable entries.', { path: archiveEntry.path });
  }

  // §6: validate every name (and every link target) before a single byte is written.
  const items = validateExtractItems(listing.items, destinationDir);

  await fs.mkdirRecursive(destinationDir);

  if (format === 'zip') {
    // `overwrite: false` needs per-entry skip semantics, which only the SFTP writer implements.
    const usedExec =
      request.overwrite &&
      (await extractViaExec(connection, logger, buildUnzipCommand(archiveEntry.path, destinationDir, true), 'unzip', format));
    if (!usedExec) {
      await extractZipEntries(fs, archiveEntry.path, items, request.overwrite, logger, new ExistingDirs(fs, destinationDir));
    }
  } else {
    const usedExec =
      request.overwrite &&
      (await extractViaExec(
        connection,
        logger,
        buildTarExtractCommand(format, archiveEntry.path, destinationDir),
        'tar',
        format,
      ));
    if (!usedExec) {
      await extractTarEntries(fs, archiveEntry.path, format, items, request.overwrite, new ExistingDirs(fs, destinationDir));
    }
  }

  const collected = await collectExtractedEntries(fs, destinationDir, items);
  return { entries: collected.entries, truncated: listing.truncated || collected.truncated };
}

/** Sniffs the format from the archive's own bytes, never from its name (contract §6). */
export async function detectArchiveFormat(fs: SftpFs, archivePath: string, size: number): Promise<ArchiveFormat | null> {
  const head = await fs.readRange(archivePath, 0, Math.min(TAR_BLOCK_SIZE - 1, size - 1));
  if (head.length >= 2 && head[0] === 0x1f && head[1] === 0x8b) return 'tar.gz';
  if (looksLikeZip(head)) return 'zip';
  if (head.length >= TAR_BLOCK_SIZE && looksLikeTarHeader(head.subarray(0, TAR_BLOCK_SIZE))) return 'tar';
  return null;
}

async function extractViaExec(
  connection: SshConnection,
  logger: Logger,
  command: string,
  tool: 'tar' | 'unzip',
  format: ArchiveFormat,
): Promise<boolean> {
  try {
    const result = await connection.exec(command, { timeoutMs: ARCHIVE_EXEC_TIMEOUT_MS });
    if (execToolUnavailable(result)) {
      logger.debug(`remote ${tool} is unavailable; extracting over SFTP`, { format });
      return false;
    }
    if (result.code !== 0) {
      throw new ApiError(
        'REMOTE_ERROR',
        `The remote ${tool} command failed: ${firstLine(result.stderr) || `exit ${String(result.code)}`}`,
        { code: result.code },
      );
    }
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.code === 'REMOTE_ERROR') throw err;
    logger.debug(`remote ${tool} could not be started; extracting over SFTP`, { format, error: err });
    return false;
  }
}

async function listTarEntries(fs: SftpFs, archivePath: string, format: 'tar' | 'tar.gz'): Promise<ArchiveListing> {
  const reader = await openArchiveReader(fs, archivePath, format === 'tar.gz');
  const items: ArchiveRawEntry[] = [];
  let truncated = false;
  let pendingLongName: string | null = null;

  try {
    for (;;) {
      const header = await reader.readExactly(TAR_BLOCK_SIZE);
      if (header === null) break;
      const parsed = parseTarHeader(header);
      if (parsed === null) break;

      if (parsed.typeflag === 'L') {
        const data = await reader.readExactly(parsed.size);
        await reader.skip(tarPadding(parsed.size));
        pendingLongName = (data ?? Buffer.alloc(0)).toString('utf8').replace(/\0.*$/s, '');
        continue;
      }
      if (parsed.typeflag === 'x' || parsed.typeflag === 'g' || parsed.typeflag === 'K') {
        await reader.skip(parsed.size + tarPadding(parsed.size));
        continue;
      }

      if (items.length >= MAX_ARCHIVE_ENTRIES) {
        truncated = true;
        break;
      }

      const name = pendingLongName ?? parsed.name;
      pendingLongName = null;
      items.push({
        name,
        kind: parsed.isDirectory ? 'directory' : parsed.isSymlink ? 'symlink' : parsed.isFile ? 'file' : 'skip',
        size: parsed.size,
        mode: parsed.mode,
        ...(parsed.linkname !== '' ? { linkTarget: parsed.linkname } : {}),
      });

      await reader.skip(parsed.size + tarPadding(parsed.size));
    }
  } finally {
    reader.destroy();
  }

  return { items, truncated };
}

async function listZipEntries(
  fs: SftpFs,
  archivePath: string,
  size: number,
  logger: Logger,
): Promise<ArchiveListing> {
  const directory = await readZipDirectory((start, end) => fs.readRange(archivePath, start, end), size, {
    maxEntries: MAX_ARCHIVE_ENTRIES,
  });

  const items: ArchiveRawEntry[] = [];
  for (const entry of directory.entries) {
    if (!entry.symlink) {
      items.push({
        name: entry.name,
        kind: entry.directory ? 'directory' : 'file',
        size: entry.uncompressedSize,
        mode: entry.mode,
        zip: entry,
      });
      continue;
    }

    // A zip symlink keeps its target in the entry body, so it has to be read to be validated.
    const linkTarget = await readZipLinkTarget(fs, archivePath, entry).catch((err: unknown) => {
      logger.debug('could not read a zip symlink target; skipping the entry', { entry: entry.name, error: err });
      return null;
    });
    items.push({
      name: entry.name,
      kind: linkTarget === null ? 'skip' : 'symlink',
      size: 0,
      mode: entry.mode,
      ...(linkTarget !== null ? { linkTarget } : {}),
      zip: entry,
    });
  }

  return { items, truncated: directory.truncated };
}

async function readZipLinkTarget(fs: SftpFs, archivePath: string, entry: ZipEntryMeta): Promise<string | null> {
  if (entry.uncompressedSize <= 0 || entry.uncompressedSize > MAX_ZIP_LINK_TARGET_BYTES) return null;
  const header = parseZipLocalHeader(
    await fs.readRange(archivePath, entry.localHeaderOffset, entry.localHeaderOffset + 29),
    entry.localHeaderOffset,
  );
  const start = header.dataOffset;
  const raw = await fs.readRange(archivePath, start, start + entry.compressedSize - 1);
  if (entry.method === ZIP_METHOD_STORE) return raw.toString('utf8');
  if (entry.method === ZIP_METHOD_DEFLATE) return zlib.inflateRawSync(raw).toString('utf8');
  return null;
}

/** Applies the §6 path rules; the first offending entry aborts the whole extraction. */
export function validateExtractItems(raw: ArchiveRawEntry[], destinationDir: string): ExtractItem[] {
  return raw.map((entry, order) => {
    const safe = safeArchiveEntryPath(destinationDir, entry.name);
    if (!safe.ok) {
      throw badRequest(`Refusing to extract "${entry.name}": ${safe.reason}.`, {
        entry: entry.name,
        reason: safe.reason,
      });
    }

    let linkTarget: string | undefined;
    if (entry.kind === 'symlink') {
      const target = entry.linkTarget ?? '';
      const safeLink = safeArchiveLinkTarget(destinationDir, safe.path, target);
      if (!safeLink.ok) {
        throw badRequest(`Refusing to extract "${entry.name}": ${safeLink.reason}.`, {
          entry: entry.name,
          reason: safeLink.reason,
        });
      }
      linkTarget = target;
    }

    return {
      order,
      name: entry.name,
      rawName: entry.name,
      path: safe.path,
      relative: safe.relative,
      kind: entry.kind,
      size: entry.size,
      mode: entry.mode,
      ...(linkTarget !== undefined ? { linkTarget } : {}),
      ...(entry.zip !== undefined ? { zip: entry.zip } : {}),
    };
  });
}

async function extractTarEntries(
  fs: SftpFs,
  archivePath: string,
  format: 'tar' | 'tar.gz',
  items: ExtractItem[],
  overwrite: boolean,
  dirs: ExistingDirs,
): Promise<void> {
  const reader = await openArchiveReader(fs, archivePath, format === 'tar.gz');
  const plan = new Map<number, ExtractItem>();
  for (const item of items) plan.set(item.order, item);

  let order = 0;

  try {
    for (;;) {
      const header = await reader.readExactly(TAR_BLOCK_SIZE);
      if (header === null) break;
      const parsed = parseTarHeader(header);
      if (parsed === null) break;

      if (parsed.typeflag === 'L') {
        // The long name belongs to the entry that follows; the plan is keyed by position.
        await reader.readExactly(parsed.size);
        await reader.skip(tarPadding(parsed.size));
        continue;
      }
      if (parsed.typeflag === 'x' || parsed.typeflag === 'g' || parsed.typeflag === 'K') {
        await reader.skip(parsed.size + tarPadding(parsed.size));
        continue;
      }

      const item = plan.get(order) ?? null;
      order += 1;

      if (item === null || item.kind === 'skip') {
        await reader.skip(parsed.size);
      } else {
        // Always consumes exactly `parsed.size` bytes of body, whether it writes them or not.
        await extractTarItem(fs, item, reader, parsed, overwrite, dirs);
      }
      await reader.skip(tarPadding(parsed.size));
    }
  } finally {
    reader.destroy();
  }
}

async function extractTarItem(
  fs: SftpFs,
  item: ExtractItem,
  reader: ArchiveReader,
  parsed: TarReadEntry,
  overwrite: boolean,
  dirs: ExistingDirs,
): Promise<void> {
  if (parsed.isDirectory || item.kind === 'directory') {
    await reader.skip(parsed.size);
    await dirs.ensure(item.path);
    return;
  }

  // The parent may not be listed as its own entry (many tools omit directories).
  const parent = parentRemotePath(item.path);
  if (parent !== null) await dirs.ensure(parent);

  if (item.kind === 'symlink') {
    await reader.skip(parsed.size);
    await replaceTarget(fs, item.path, overwrite);
    await fs.symlink(item.path, item.linkTarget ?? parsed.linkname);
    return;
  }

  const exists = await fs.exists(item.path);
  if (exists && !overwrite) {
    // Skipped: the body is still consumed to stay aligned with the archive.
    await reader.skip(parsed.size);
    return;
  }
  if (exists) await replaceTarget(fs, item.path, true);

  const target = await fs.openWriteStream(item.path, item.mode === 0 ? undefined : item.mode & 0o7777);
  try {
    let remaining = parsed.size;
    while (remaining > 0) {
      const chunk = await reader.readExactly(Math.min(remaining, COPY_CHUNK_BYTES));
      if (chunk === null) {
        throw badRequest(`The archive ends inside "${item.rawName}".`, { entry: item.rawName });
      }
      await writeAll(target, chunk);
      remaining -= chunk.length;
    }
    await pipeline(Readable.from([]), target);
  } catch (err) {
    target.destroy();
    throw err;
  }
}

async function extractZipEntries(
  fs: SftpFs,
  archivePath: string,
  items: ExtractItem[],
  overwrite: boolean,
  logger: Logger,
  dirs: ExistingDirs,
): Promise<void> {
  for (const item of items) {
    if (item.kind === 'skip' || item.zip === undefined) continue;
    const meta = item.zip;

    if (item.kind === 'directory') {
      await dirs.ensure(item.path);
      continue;
    }

    const parent = parentRemotePath(item.path);
    if (parent !== null) await dirs.ensure(parent);

    if (!overwrite && (await fs.exists(item.path))) {
      logger.debug('extract skipped an existing entry', { path: item.path });
      continue;
    }

    if (item.kind === 'symlink') {
      await replaceTarget(fs, item.path, overwrite);
      await fs.symlink(item.path, item.linkTarget ?? '');
      continue;
    }

    if (meta.method !== ZIP_METHOD_STORE && meta.method !== ZIP_METHOD_DEFLATE) {
      throw badRequest(`Unsupported ZIP compression method ${meta.method} for "${item.rawName}".`, {
        entry: item.rawName,
        method: meta.method,
      });
    }

    let dataOffset: number;
    try {
      dataOffset = parseZipLocalHeader(
        await fs.readRange(archivePath, meta.localHeaderOffset, meta.localHeaderOffset + 29),
        meta.localHeaderOffset,
      ).dataOffset;
    } catch {
      throw badRequest(`The ZIP entry "${item.rawName}" is unreadable.`, { entry: item.rawName });
    }

    await replaceTarget(fs, item.path, overwrite);
    const target = await fs.openWriteStream(item.path, item.mode === 0 ? undefined : item.mode & 0o7777);
    try {
      if (meta.compressedSize === 0) {
        await pipeline(Readable.from([]), target);
        continue;
      }
      const source = await fs.openReadStream(archivePath, {
        start: dataOffset,
        end: dataOffset + meta.compressedSize - 1,
      });
      if (meta.method === ZIP_METHOD_DEFLATE) await pipeline(source, zlib.createInflateRaw(), target);
      else await pipeline(source, target);
    } catch (err) {
      target.destroy();
      throw err instanceof ApiError ? err : mapError(err);
    }
  }
}

/**
 * Remembers which directories are known to exist during one extraction, and creates missing
 * parents on demand.
 *
 * An archive does not have to list its directories (many tools omit them), so a file entry can
 * arrive before the directory it lives in. Creating the parent on demand is what `tar` and
 * `unzip` do; the cache keeps that from costing two round trips per file.
 */
class ExistingDirs {
  private readonly known = new Set<string>(['/']);

  constructor(
    private readonly fs: SftpFs,
    root: string,
  ) {
    let current = normalizeRemotePath(root);
    while (current !== '/' && current !== '.') {
      this.known.add(current);
      const parent = parentRemotePath(current);
      if (parent === null) break;
      current = parent;
    }
  }

  async ensure(directory: string): Promise<void> {
    const target = normalizeRemotePath(directory);
    if (this.known.has(target)) return;
    await this.fs.mkdirRecursive(target);
    let current = target;
    for (;;) {
      this.known.add(current);
      const parent = parentRemotePath(current);
      if (parent === null || this.known.has(parent)) break;
      current = parent;
    }
  }
}

/** Removes an existing entry so the new one is created cleanly (`overwrite` semantics). */
async function replaceTarget(fs: SftpFs, target: string, overwrite: boolean): Promise<void> {
  if (!overwrite) return;
  if (!(await fs.exists(target))) return;
  const removed = await fs.remove([target], true);
  if (removed.failed.length > 0 || !removed.deleted.includes(target)) {
    throw new ApiError('SFTP_ERROR', removed.failed[0]?.message ?? `Could not replace ${target}.`, { path: target });
  }
}

/** The response lists the entries that appeared at the top level of `destinationDir`. */
async function collectExtractedEntries(
  fs: SftpFs,
  destinationDir: string,
  items: ExtractItem[],
): Promise<{ entries: FileEntry[]; truncated: boolean }> {
  const tops: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    if (item.kind === 'skip') continue;
    const top = item.relative.split('/')[0] ?? '';
    if (top === '' || seen.has(top)) continue;
    seen.add(top);
    tops.push(top);
  }

  const capped = tops.slice(0, MAX_EXTRACT_RESPONSE_ENTRIES);
  const entries: FileEntry[] = [];
  for (const top of capped) {
    const entry = await fs.stat(joinRemotePath(destinationDir, top), false).catch(() => null);
    if (entry !== null) entries.push(entry);
  }
  return { entries, truncated: tops.length > capped.length };
}

// ------------------------------------------------------------------ readers

/**
 * Pull-based byte reader over a (possibly decompressed) archive stream.
 *
 * It buffers ahead only up to a high-water mark and pauses the source beyond it, so an archive
 * larger than memory extracts in constant space.
 */
class ArchiveReader {
  private readonly chunks: Buffer[] = [];
  private buffered = 0;
  private ended = false;
  private failure: Error | null = null;
  private wake: (() => void) | null = null;
  private readonly highWater = 4 * 1024 * 1024;
  private readonly upstreams: Readable[];

  constructor(
    private readonly source: Readable,
    ...upstreams: Readable[]
  ) {
    this.upstreams = upstreams;
    source.on('data', (chunk: Buffer) => {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
      if (this.buffered >= this.highWater) this.source.pause();
      this.notify();
    });
    source.on('end', () => {
      this.ended = true;
      this.notify();
    });
    source.on('error', (err: Error) => {
      this.failure = err;
      this.notify();
    });
  }

  /** Reads exactly `length` bytes; `null` at a clean end of stream. */
  async readExactly(length: number): Promise<Buffer | null> {
    if (length <= 0) return Buffer.alloc(0);
    await this.fill(length);
    if (this.failure !== null) throw this.failure;
    if (this.buffered < length) return null;

    const out = Buffer.allocUnsafe(length);
    let copied = 0;
    while (copied < length) {
      const head = this.chunks[0] as Buffer;
      const take = Math.min(head.length, length - copied);
      head.copy(out, copied, 0, take);
      copied += take;
      if (take === head.length) this.chunks.shift();
      else this.chunks[0] = head.subarray(take);
    }
    this.buffered -= length;
    if (this.source.isPaused()) this.source.resume();
    return out;
  }

  /** Discards `length` bytes without keeping them. */
  async skip(length: number): Promise<void> {
    let remaining = length;
    while (remaining > 0) {
      const chunk = await this.readExactly(Math.min(remaining, COPY_CHUNK_BYTES));
      if (chunk === null) return;
      remaining -= chunk.length;
    }
  }

  destroy(): void {
    this.source.destroy();
    for (const upstream of this.upstreams) upstream.destroy();
  }

  private async fill(length: number): Promise<void> {
    while (this.buffered < length && !this.ended && this.failure === null) {
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }

  private notify(): void {
    const wake = this.wake;
    this.wake = null;
    wake?.();
  }
}

async function openArchiveReader(fs: SftpFs, archivePath: string, gzipped: boolean): Promise<ArchiveReader> {
  const file = await fs.openReadStream(archivePath);
  if (!gzipped) return new ArchiveReader(file);
  const gunzip = zlib.createGunzip();
  // A corrupt gzip stream must surface as a read failure, not an unhandled 'error' event.
  file.on('error', (err: Error) => gunzip.destroy(err));
  file.pipe(gunzip);
  return new ArchiveReader(gunzip, file);
}

// ----------------------------------------------------------------- utilities

async function writeAll(sink: Writable, chunk: Buffer): Promise<void> {
  if (chunk.length === 0) return;
  if (sink.write(chunk)) return;
  await once(sink, 'drain');
}

function firstLine(text: string): string {
  const line = (text ?? '').split('\n').find((candidate) => candidate.trim() !== '') ?? '';
  return line.trim().slice(0, 300);
}
