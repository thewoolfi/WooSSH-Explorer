import type { FileEntry } from '../api/types';
import { extensionOf } from './format';

/** POSIX remote path helpers — mirrors the server's `util/remotePath.ts`. */

export function isAbsolute(p: string): boolean {
  return p.startsWith('/');
}

/** Collapses `//`, `.` and `..` without touching the filesystem. */
export function normalizeRemotePath(input: string): string {
  if (!input) return '/';
  const absolute = input.startsWith('/');
  const parts: string[] = [];
  for (const segment of input.split('/')) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (parts.length && parts[parts.length - 1] !== '..') parts.pop();
      else if (!absolute) parts.push('..');
      continue;
    }
    parts.push(segment);
  }
  const body = parts.join('/');
  if (absolute) return `/${body}`;
  return body || '.';
}

export function joinRemotePath(base: string, ...segments: string[]): string {
  const tail = segments.filter(Boolean).join('/');
  if (!tail) return normalizeRemotePath(base);
  if (tail.startsWith('/')) return normalizeRemotePath(tail);
  return normalizeRemotePath(`${base.replace(/\/+$/, '')}/${tail}`);
}

export function parentRemotePath(p: string): string | null {
  const normalized = normalizeRemotePath(p);
  if (normalized === '/' || normalized === '.') return null;
  const idx = normalized.lastIndexOf('/');
  if (idx <= 0) return normalized.startsWith('/') ? '/' : null;
  return normalized.slice(0, idx);
}

export function basenameRemotePath(p: string): string {
  const normalized = normalizeRemotePath(p);
  if (normalized === '/') return '/';
  const idx = normalized.lastIndexOf('/');
  return idx < 0 ? normalized : normalized.slice(idx + 1);
}

/** Breadcrumb segments, each with the absolute path it navigates to. */
export interface Crumb {
  label: string;
  path: string;
}

export function crumbsFor(p: string): Crumb[] {
  const normalized = normalizeRemotePath(p);
  const crumbs: Crumb[] = [{ label: '/', path: '/' }];
  if (normalized === '/') return crumbs;
  const parts = normalized.split('/').filter(Boolean);
  let acc = '';
  for (const part of parts) {
    acc += `/${part}`;
    crumbs.push({ label: part, path: acc });
  }
  return crumbs;
}

/* ------------------------------------------------------------------------ */
/*  File type classification (icons, previews, default actions)              */
/* ------------------------------------------------------------------------ */

export type FileKind =
  | 'folder'
  | 'text'
  | 'code'
  | 'image'
  | 'archive'
  | 'pdf'
  | 'audio'
  | 'video'
  | 'sheet'
  | 'key'
  | 'database'
  | 'binary';

const CODE_EXT = new Set([
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx', 'json', 'jsonc', 'yml', 'yaml', 'toml', 'ini',
  'conf', 'cfg', 'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'py', 'rb', 'go', 'rs', 'c',
  'h', 'cc', 'cpp', 'hpp', 'cs', 'java', 'kt', 'swift', 'php', 'pl', 'lua', 'sql', 'html',
  'htm', 'css', 'scss', 'sass', 'less', 'vue', 'svelte', 'xml', 'env', 'service', 'tf',
  'dockerfile', 'mk', 'gradle', 'properties',
]);

const TEXT_EXT = new Set(['txt', 'md', 'markdown', 'log', 'csv', 'tsv', 'rst', 'rtf', 'nfo']);
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'avif', 'tiff']);
const ARCHIVE_EXT = new Set(['zip', 'tar', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'zst', 'jar', 'war']);
const AUDIO_EXT = new Set(['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus']);
const VIDEO_EXT = new Set(['mp4', 'mkv', 'mov', 'avi', 'webm', 'm4v']);
const SHEET_EXT = new Set(['xls', 'xlsx', 'ods', 'numbers']);
const KEY_EXT = new Set(['pem', 'key', 'pub', 'crt', 'cer', 'p12', 'pfx', 'ppk', 'asc', 'gpg']);
const DB_EXT = new Set(['db', 'sqlite', 'sqlite3', 'mdb', 'dump']);

export function classify(entry: Pick<FileEntry, 'name' | 'kind'>): FileKind {
  if (entry.kind === 'directory') return 'folder';
  const name = entry.name.toLowerCase();
  if (name === 'dockerfile' || name === 'makefile' || name === '.env' || name === '.gitignore') {
    return 'code';
  }
  const ext = extensionOf(entry.name);
  if (CODE_EXT.has(ext)) return 'code';
  if (TEXT_EXT.has(ext)) return 'text';
  if (IMAGE_EXT.has(ext)) return 'image';
  if (ARCHIVE_EXT.has(ext)) return 'archive';
  if (ext === 'pdf') return 'pdf';
  if (AUDIO_EXT.has(ext)) return 'audio';
  if (VIDEO_EXT.has(ext)) return 'video';
  if (SHEET_EXT.has(ext)) return 'sheet';
  if (KEY_EXT.has(ext)) return 'key';
  if (DB_EXT.has(ext)) return 'database';
  return 'binary';
}

/** Minimal language hint for the preview's crude tokenizer. */
export function languageOf(name: string): 'json' | 'shell' | 'code' | 'markup' | 'plain' {
  const lower = name.toLowerCase();
  const ext = extensionOf(name);
  if (lower === 'dockerfile' || lower === 'makefile' || ext === 'mk') return 'shell';
  if (ext === 'json' || ext === 'jsonc') return 'json';
  if (ext === 'html' || ext === 'htm' || ext === 'xml' || ext === 'svg' || ext === 'vue') {
    return 'markup';
  }
  if (ext === 'sh' || ext === 'bash' || ext === 'zsh' || ext === 'fish' || ext === 'ps1') {
    return 'shell';
  }
  if (CODE_EXT.has(ext)) return 'code';
  return 'plain';
}
