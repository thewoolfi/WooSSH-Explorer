/**
 * Archive entry safety (contract §6 `fs/extract`).
 *
 * Every entry of an archive is untrusted input: a `..` segment, an absolute name or a symlink
 * pointing outside the destination is a path-traversal attack ("zip slip"). These helpers are
 * pure so the rules can be unit tested on their own — they never touch the filesystem.
 */
import { isInsideRemotePath, joinRemotePath, normalizeRemotePath, parentRemotePath } from './remotePath.js';

export interface SafeEntryPath {
  ok: true;
  /** Absolute remote path inside the destination directory. */
  path: string;
  /** Normalised, relative entry name. */
  relative: string;
}

export interface UnsafeEntryPath {
  ok: false;
  /** The entry name exactly as it appeared in the archive. */
  entry: string;
  /** Short, user-facing reason (without the entry name). */
  reason: string;
}

export type SafePathResult = SafeEntryPath | UnsafeEntryPath;

function unsafe(entry: string, reason: string): UnsafeEntryPath {
  return { ok: false, entry, reason };
}

/** Windows-style absolute names (`C:\x`, `C:/x`) must never be honoured on the remote host. */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/**
 * Normalises an archive entry name into an absolute path under `destinationDir`.
 *
 * Rejected: empty names, NUL bytes, absolute names (`/etc/passwd`, `C:\x`), and any `..`
 * segment — including the Windows spelling `..\..\x`, because an archive written on Windows
 * is still extracted by this server.
 */
export function safeArchiveEntryPath(destinationDir: string, rawName: string): SafePathResult {
  const entry = rawName;
  if (typeof rawName !== 'string' || rawName.trim() === '') return unsafe(entry, 'the entry name is empty');
  if (rawName.includes('\0')) return unsafe(entry, 'the entry name contains a NUL byte');

  const separatorNormalised = rawName.replace(/\\/g, '/');
  if (separatorNormalised.startsWith('/')) return unsafe(entry, 'the entry is an absolute path');
  if (WINDOWS_ABSOLUTE.test(separatorNormalised)) return unsafe(entry, 'the entry is an absolute path');

  // Validation treats `\` as a separator (an archive written on Windows is extracted by this
  // POSIX server), but the stored name keeps it: `a\b.txt` is a legal POSIX file name.
  for (const segment of separatorNormalised.split('/')) {
    if (segment === '..') return unsafe(entry, 'the entry contains a ".." segment');
  }

  const relative = normalizeRemotePath(rawName.replace(/\/+$/, ''));
  if (relative === '.' || relative === '') return unsafe(entry, 'the entry name is empty');
  if (relative.startsWith('..')) return unsafe(entry, 'the entry escapes the destination directory');

  const destination = normalizeRemotePath(destinationDir);
  const path = normalizeRemotePath(`${destination.replace(/\/+$/, '')}/${relative}`);
  if (!isInsideRemotePath(path, destination)) {
    return unsafe(entry, 'the entry escapes the destination directory');
  }

  return { ok: true, path, relative };
}

/**
 * Validates a symlink (or hardlink) target.
 *
 * An absolute target is refused outright, and a relative one is resolved against the link's own
 * directory and must stay inside `destinationDir` — that is what stops the classic
 * "symlink to /etc then write through it" attack.
 */
export function safeArchiveLinkTarget(
  destinationDir: string,
  linkPath: string,
  rawTarget: string,
): SafePathResult {
  if (typeof rawTarget !== 'string' || rawTarget.trim() === '') {
    return unsafe(rawTarget, 'the link target is empty');
  }
  if (rawTarget.includes('\0')) return unsafe(rawTarget, 'the link target contains a NUL byte');
  if (rawTarget.startsWith('/') || WINDOWS_ABSOLUTE.test(rawTarget)) {
    return unsafe(rawTarget, 'the link target is an absolute path');
  }

  const destination = normalizeRemotePath(destinationDir);
  const linkDirectory = parentRemotePath(normalizeRemotePath(linkPath)) ?? destination;
  const resolved = normalizeRemotePath(joinRemotePath(linkDirectory, rawTarget));

  if (!isInsideRemotePath(resolved, destination)) {
    return unsafe(rawTarget, 'the link target points outside the destination directory');
  }
  return { ok: true, path: resolved, relative: rawTarget };
}
