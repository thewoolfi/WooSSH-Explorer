/**
 * POSIX path helpers for *remote* paths.
 *
 * `node:path` must never be used for remote paths: on Windows it would produce backslashes and
 * drive-relative results. Everything here is pure string manipulation.
 */

/** Collapses `.`/`..`, duplicate slashes and a trailing slash. Relative input stays relative. */
export function normalizeRemotePath(input: string): string {
  const raw = input.replace(/\0/g, '');
  if (raw === '') return '.';

  const isAbsolute = raw.startsWith('/');
  // A leading `//` is not special in POSIX; collapsing it keeps results predictable.
  const segments = raw.split('/');
  const out: string[] = [];

  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      const last = out[out.length - 1];
      if (out.length > 0 && last !== '..') {
        out.pop();
      } else if (!isAbsolute) {
        out.push('..');
      }
      // `..` at the root of an absolute path is a no-op.
      continue;
    }
    out.push(segment);
  }

  const joined = out.join('/');
  if (isAbsolute) return joined === '' ? '/' : `/${joined}`;
  return joined === '' ? '.' : joined;
}

/** Joins remote path segments with `/`, honouring absolute segments. */
export function joinRemotePath(...parts: string[]): string {
  const cleaned = parts.filter((part) => part !== undefined && part !== null && part !== '');
  if (cleaned.length === 0) return '.';

  let result = cleaned[0] as string;
  for (let i = 1; i < cleaned.length; i += 1) {
    const part = cleaned[i] as string;
    if (part.startsWith('/')) {
      result = part;
      continue;
    }
    result = result.endsWith('/') ? result + part : `${result}/${part}`;
  }
  return normalizeRemotePath(result);
}

/** The parent directory, or `null` for the filesystem root. */
export function parentRemotePath(input: string): string | null {
  const normalized = normalizeRemotePath(input);
  if (normalized === '/' || normalized === '.') return null;
  const index = normalized.lastIndexOf('/');
  if (index < 0) return '.';
  if (index === 0) return '/';
  return normalized.slice(0, index);
}

/** The final path segment. `/` yields `/` (matching POSIX `basename`). */
export function basename(input: string): string {
  const normalized = normalizeRemotePath(input);
  if (normalized === '/') return '/';
  if (normalized === '.') return '.';
  const index = normalized.lastIndexOf('/');
  return index < 0 ? normalized : normalized.slice(index + 1);
}

/** True when the path is absolute (starts with `/`). */
export function isAbsoluteRemotePath(input: string): boolean {
  return input.startsWith('/');
}

/** True when the path starts with `~` and therefore needs server-side expansion. */
export function isHomeRelative(input: string): boolean {
  return input === '~' || input.startsWith('~/');
}

/**
 * Resolves a user-typed path against a base directory without touching the filesystem.
 * `~` expansion needs the remote `$HOME`, which only the SFTP `realpath` call can do.
 */
export function resolveRemotePath(input: string, baseDir: string): string {
  if (isAbsoluteRemotePath(input)) return normalizeRemotePath(input);
  return joinRemotePath(baseDir, input);
}

/** True when `child` is `parent` itself or lives underneath it. */
export function isInsideRemotePath(child: string, parent: string): boolean {
  const c = normalizeRemotePath(child);
  const p = normalizeRemotePath(parent);
  if (p === '/') return c.startsWith('/');
  return c === p || c.startsWith(`${p}/`);
}
