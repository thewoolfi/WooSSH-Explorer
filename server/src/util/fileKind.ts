import type { ReadKind } from '../types.js';

/** Bytes inspected when deciding whether a file is text. Contract §6: the first 8 KiB. */
export const TEXT_SNIFF_BYTES = 8 * 1024;

export const DEFAULT_MAX_READ_BYTES = 262_144;
export const MAX_MAX_READ_BYTES = 2_097_152;

/** Everything we are willing to render inline as an `<img>` in the browser. */
const IMAGE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};

const TEXT_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  txt: 'text/plain',
  text: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  rst: 'text/x-rst',
  csv: 'text/csv',
  tsv: 'text/tab-separated-values',
  html: 'text/html',
  htm: 'text/html',
  xhtml: 'application/xhtml+xml',
  xml: 'application/xml',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  cjs: 'text/javascript',
  jsx: 'text/jsx',
  ts: 'text/typescript',
  tsx: 'text/tsx',
  json: 'application/json',
  jsonc: 'application/json',
  json5: 'application/json',
  yml: 'text/yaml',
  yaml: 'text/yaml',
  toml: 'text/toml',
  ini: 'text/plain',
  conf: 'text/plain',
  cfg: 'text/plain',
  env: 'text/plain',
  properties: 'text/plain',
  sql: 'text/x-sql',
  sh: 'text/x-shellscript',
  bash: 'text/x-shellscript',
  zsh: 'text/x-shellscript',
  fish: 'text/x-shellscript',
  ps1: 'text/x-powershell',
  bat: 'text/x-batch',
  cmd: 'text/x-batch',
  py: 'text/x-python',
  rb: 'text/x-ruby',
  pl: 'text/x-perl',
  php: 'text/x-php',
  go: 'text/x-go',
  rs: 'text/x-rust',
  c: 'text/x-c',
  h: 'text/x-c',
  cc: 'text/x-c++',
  cpp: 'text/x-c++',
  hpp: 'text/x-c++',
  java: 'text/x-java',
  kt: 'text/x-kotlin',
  cs: 'text/x-csharp',
  swift: 'text/x-swift',
  lua: 'text/x-lua',
  diff: 'text/x-diff',
  patch: 'text/x-diff',
  service: 'text/plain',
  socket: 'text/plain',
  desktop: 'text/plain',
  pem: 'text/plain',
  crt: 'text/plain',
  cer: 'text/plain',
  key: 'text/plain',
  pub: 'text/plain',
};

const DEFAULT_TEXT_MIME = 'text/plain';
const DEFAULT_BINARY_MIME = 'application/octet-stream';

/** Lower-cased extension without the leading dot, or `''` when there is none. */
export function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}

/** MIME type for a remote file name. Binary defaults to `application/octet-stream`. */
export function mimeTypeFor(name: string, kind: ReadKind): string {
  const ext = extensionOf(name);
  const image = IMAGE_MIME_BY_EXTENSION[ext];
  if (image !== undefined) return image;
  const text = TEXT_MIME_BY_EXTENSION[ext];
  if (text !== undefined) return text;
  return kind === 'text' ? DEFAULT_TEXT_MIME : DEFAULT_BINARY_MIME;
}

/** True when the extension is one we are willing to inline as an image. */
export function isImageName(name: string): boolean {
  return IMAGE_MIME_BY_EXTENSION[extensionOf(name)] !== undefined;
}

/**
 * Contract §6 detection for `fs/read`.
 *
 * - a known image extension → `image` (or `tooLarge` when it exceeds `maxBytes`);
 * - otherwise a NUL byte in the first 8 KiB → `binary` (never text);
 * - otherwise `text`, truncated rather than refused when it is oversized.
 *
 * The extension is checked first: an image can legitimately contain NUL bytes (8- and 16-bit
 * PNG samples, for example) and reporting it as opaque binary would break inline previews.
 * Nothing here throws, whatever the bytes are.
 */
export function detectReadKind(sample: Buffer, options: { name: string; size: number; maxBytes: number }): ReadKind {
  const { name, size, maxBytes } = options;

  if (isImageName(name)) return size > maxBytes ? 'tooLarge' : 'image';
  if (!looksLikeText(sample)) return 'binary';
  return 'text';
}

/** True when a chunk of bytes looks like text (no NUL byte in the first 8 KiB). */
export function looksLikeText(sample: Buffer): boolean {
  return !sample.subarray(0, TEXT_SNIFF_BYTES).includes(0);
}

/**
 * Counts lines the way an editor does: a trailing newline does not start a new line.
 * `truncated` guards against claiming a complete line count for a clipped file.
 */
export function countLines(text: string): number {
  if (text === '') return 0;
  const newlines = text.split('\n').length - 1;
  // A trailing newline terminates the last line rather than adding an empty one.
  return text.endsWith('\n') ? Math.max(newlines, 1) : newlines + 1;
}
