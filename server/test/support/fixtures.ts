/**
 * Deterministic fixture tree used by the mock SSH server (see `mockSshServer.ts`).
 *
 * The mock serves a REAL temporary directory as the SFTP root (`/`), so everything
 * here is created with genuine `fs` calls. Contents are exported so the e2e suite
 * can assert byte-exact equality against what the remote filesystem really holds.
 *
 * Layout (all paths are remote/POSIX paths, `/` == `rootDir`):
 *
 *   /readme.txt                 multi-line ASCII text (~1 KiB, for maxBytes tests)
 *   /hello.txt                  short ASCII text (exact-content assertions)
 *   /unicode.txt                UTF-8 text with non-ASCII characters
 *   /.hidden                    dotfile at the root
 *   /.config/settings.json      hidden directory + nested file
 *   /docs/guide.md              nested directory
 *   /docs/nested/deep.txt       deeper nesting
 *   /images/tiny.png            real 1x1 PNG (image detection)
 *   /bin/nul.bin                binary payload containing NUL bytes
 *   /bin/zero.bin               zero-byte file
 *   /big/sparse.bin             32 MiB sparse file (progress / cancel)
 *   /links/to-docs       -> ../docs        (directory symlink)
 *   /links/to-readme.txt -> ../readme.txt  (file symlink)
 */
import fs from 'node:fs';
import path from 'node:path';

/** Fixed mtime for every fixture file (2023-11-14T22:13:20Z, a whole second). */
export const FIXTURE_MTIME_MS = 1_700_000_000_000;

/** Remote POSIX owner/group reported by the mock for every entry. */
export const FIXTURE_UID = 1000;
export const FIXTURE_GID = 1000;
export const FIXTURE_USER = 'tester';

export interface FixtureFile {
  /** Remote absolute path. */
  path: string;
  name: string;
  content: Buffer;
}

function file(p: string, content: Buffer): FixtureFile {
  return { path: p, name: path.posix.basename(p), content };
}

export const README_FILE = file(
  '/readme.txt',
  Buffer.from(
    [
      'SSH Explorer mock fixture',
      '=========================',
      '',
      'This file exists so the integration suite can read real bytes over SFTP.',
      'It is deliberately longer than a few dozen bytes so that maxBytes truncation',
      'can be exercised without inventing synthetic data.',
      '',
      'Line 8 is here.',
      'Line 9 is here.',
      'Line 10 is here.',
      '',
    ].join('\n'),
    'utf8',
  ),
);

export const HELLO_FILE = file('/hello.txt', Buffer.from('hello from the mock ssh server\n', 'utf8'));

export const UNICODE_FILE = file(
  '/unicode.txt',
  Buffer.from('Привет, мир! Grüße — 日本語 — 🚀\nsecond line\n', 'utf8'),
);

export const DOTFILE = file('/.hidden', Buffer.from('dotfile contents\n', 'utf8'));

export const CONFIG_FILE = file('/.config/settings.json', Buffer.from('{\n  "hidden": true\n}\n', 'utf8'));

export const GUIDE_FILE = file('/docs/guide.md', Buffer.from('# Guide\n\nnested documentation\n', 'utf8'));

export const DEEP_FILE = file('/docs/nested/deep.txt', Buffer.from('deeply nested\n', 'utf8'));

/** Minimal valid 1x1 PNG (67 bytes) — decoded here so the bytes are exact and stable. */
export const PNG_FILE = file(
  '/images/tiny.png',
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
);

/** Binary payload with NUL bytes inside the first 8 KiB (=> never "text"). */
export const NUL_FILE = file(
  '/bin/nul.bin',
  Buffer.concat([
    Buffer.from('binary-payload:', 'utf8'),
    Buffer.from([0x00, 0x01, 0x02, 0x03, 0x00, 0xff, 0xfe]),
    Buffer.from(' tail', 'utf8'),
  ]),
);

/** Zero-byte file. */
export const ZERO_FILE = file('/bin/zero.bin', Buffer.alloc(0));

/** Sparse file big enough that a transfer is still active when the suite cancels it. */
export const BIG_FILE_SIZE = 32 * 1024 * 1024;
export const BIG_FILE = { path: '/big/sparse.bin', name: 'sparse.bin', size: BIG_FILE_SIZE };

export const SYMLINK_TO_DIR = { path: '/links/to-docs', name: 'to-docs', target: '../docs' };
export const SYMLINK_TO_FILE = { path: '/links/to-readme.txt', name: 'to-readme.txt', target: '../readme.txt' };

/** Every regular-file fixture (contents in memory, zero-byte and sparse files included). */
export const ALL_FILES: FixtureFile[] = [
  README_FILE,
  HELLO_FILE,
  UNICODE_FILE,
  DOTFILE,
  CONFIG_FILE,
  GUIDE_FILE,
  DEEP_FILE,
  PNG_FILE,
  NUL_FILE,
  ZERO_FILE,
  file(BIG_FILE.path, Buffer.alloc(0)),
];

/** Entry names directly inside `/`, excluding `.` and `..`. */
export const ROOT_ENTRY_NAMES: string[] = [
  '.config',
  '.hidden',
  'bin',
  'big',
  'docs',
  'hello.txt',
  'images',
  'links',
  'readme.txt',
  'unicode.txt',
];

export interface FixtureTree {
  rootDir: string;
  /** false when the host refused symlink creation (unprivileged Windows). */
  symlinksCreated: boolean;
}

function writeFileAt(rootDir: string, remotePath: string, content: Buffer): void {
  const real = path.join(rootDir, ...remotePath.split('/').filter(Boolean));
  fs.mkdirSync(path.dirname(real), { recursive: true });
  fs.writeFileSync(real, content);
  fs.utimesSync(real, new Date(FIXTURE_MTIME_MS), new Date(FIXTURE_MTIME_MS));
}

function mkdirAt(rootDir: string, remotePath: string): void {
  const real = path.join(rootDir, ...remotePath.split('/').filter(Boolean));
  fs.mkdirSync(real, { recursive: true });
  fs.utimesSync(real, new Date(FIXTURE_MTIME_MS), new Date(FIXTURE_MTIME_MS));
}

/**
 * Creates the whole fixture tree inside `rootDir` (which must already exist).
 * Fully synchronous and idempotent — the mock calls it once per server start.
 */
export function createFixtureTree(rootDir: string): FixtureTree {
  mkdirAt(rootDir, '/');
  mkdirAt(rootDir, '/.config');
  mkdirAt(rootDir, '/docs');
  mkdirAt(rootDir, '/docs/nested');
  mkdirAt(rootDir, '/images');
  mkdirAt(rootDir, '/bin');
  mkdirAt(rootDir, '/big');
  mkdirAt(rootDir, '/links');

  for (const f of [README_FILE, HELLO_FILE, UNICODE_FILE, DOTFILE, CONFIG_FILE, GUIDE_FILE, DEEP_FILE, PNG_FILE, NUL_FILE]) {
    writeFileAt(rootDir, f.path, f.content);
  }

  // Zero-byte file: create then truncate so the size is exactly 0.
  const zeroReal = path.join(rootDir, 'bin', 'zero.bin');
  fs.writeFileSync(zeroReal, '');
  fs.utimesSync(zeroReal, new Date(FIXTURE_MTIME_MS), new Date(FIXTURE_MTIME_MS));

  // Multi-megabyte file: extended with ftruncate, so it is cheap and still reports
  // a real, exact size over SFTP.
  const bigReal = path.join(rootDir, 'big', 'sparse.bin');
  const fd = fs.openSync(bigReal, 'w');
  try {
    fs.ftruncateSync(fd, BIG_FILE_SIZE);
  } finally {
    fs.closeSync(fd);
  }
  fs.utimesSync(bigReal, new Date(FIXTURE_MTIME_MS), new Date(FIXTURE_MTIME_MS));

  let symlinksCreated = true;
  for (const link of [SYMLINK_TO_DIR, SYMLINK_TO_FILE]) {
    const real = path.join(rootDir, ...link.path.split('/').filter(Boolean));
    try {
      fs.symlinkSync(link.target, real);
    } catch {
      symlinksCreated = false;
    }
  }

  return { rootDir, symlinksCreated };
}
