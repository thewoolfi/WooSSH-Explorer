import { pipeline } from 'node:stream/promises';

import { ApiError, badRequest } from '../errors.js';
import { joinRemotePath } from '../util/remotePath.js';
import type { SftpFs } from './fsOps.js';

/**
 * The SFTP implementation of `fs/copy` (contract §6), used when the remote `cp` is missing.
 *
 * Guarantees:
 * - symlinks are recreated as symlinks and **never** followed, so a link loop cannot recurse;
 * - modes are preserved (`createWriteStream` mode plus an explicit `chmod` after the bytes,
 *   because an SFTP server applies its umask to a freshly created file);
 * - the walk is bounded by depth and node count, so a pathological tree fails instead of
 *   hanging the request forever.
 */

export interface CopyLimits {
  maxDepth: number;
  maxNodes: number;
}

export const DEFAULT_COPY_LIMITS: Readonly<CopyLimits> = Object.freeze({
  maxDepth: 128,
  maxNodes: 200_000,
});

export interface CopyTreeStats {
  files: number;
  directories: number;
  symlinks: number;
  bytes: number;
}

/** Marker for the cap reached in {@link copyTreeSftp}. */
export class CopyLimitError extends ApiError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('SFTP_ERROR', message, details);
    this.name = 'CopyLimitError';
  }
}

/** Recursively copies `source` to `target` (both absolute, already resolved). */
export async function copyTreeSftp(
  fs: SftpFs,
  source: string,
  target: string,
  limits: CopyLimits = DEFAULT_COPY_LIMITS,
): Promise<CopyTreeStats> {
  const stats: CopyTreeStats = { files: 0, directories: 0, symlinks: 0, bytes: 0 };
  const state = { nodes: 0 };
  await copyNode(fs, source, target, limits, state, stats, 0);
  return stats;
}

async function copyNode(
  fs: SftpFs,
  source: string,
  target: string,
  limits: CopyLimits,
  state: { nodes: number },
  stats: CopyTreeStats,
  depth: number,
): Promise<void> {
  if (depth > limits.maxDepth) {
    throw new CopyLimitError(`Refusing to copy ${source}: the tree is deeper than ${limits.maxDepth} levels.`, {
      path: source,
    });
  }
  state.nodes += 1;
  if (state.nodes > limits.maxNodes) {
    throw new CopyLimitError(`Refusing to copy ${source}: more than ${limits.maxNodes} entries.`, { path: source });
  }

  // lstat semantics: a symlink stays a symlink (and is never traversed).
  const entry = await fs.stat(source, false);

  if (entry.kind === 'symlink') {
    const linkTarget = entry.target ?? (await fs.readlink(source));
    if (linkTarget === null) {
      throw new ApiError('SFTP_ERROR', `Could not read the symlink target of ${source}.`, { path: source });
    }
    await fs.symlink(target, linkTarget);
    stats.symlinks += 1;
    return;
  }

  if (entry.kind === 'directory') {
    if (!(await fs.exists(target))) await fs.mkdir(target);
    const listing = await fs.list({ path: source, limit: 20_000 });
    for (const child of listing.entries) {
      await copyNode(fs, child.path, joinRemotePath(target, child.name), limits, state, stats, depth + 1);
    }
    // After the children, so a read-only source directory does not block its own contents.
    await fs.chmod(target, entry.mode & 0o7777).catch(() => undefined);
    stats.directories += 1;
    return;
  }

  if (entry.kind !== 'file') {
    throw badRequest(`Cannot copy ${source}: only files, directories and symlinks are supported.`, { path: source });
  }

  const sourceStream = await fs.openReadStream(source);
  const targetStream = await fs.openWriteStream(target, entry.mode & 0o7777);
  await pipeline(sourceStream, targetStream);
  // The server's umask may have trimmed the create mode; restore it exactly.
  await fs.chmod(target, entry.mode & 0o7777).catch(() => undefined);
  stats.files += 1;
  stats.bytes += entry.size;
}
