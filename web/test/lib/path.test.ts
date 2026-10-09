import { describe, expect, test } from 'vitest';

import {
  basenameRemotePath,
  classify,
  crumbsFor,
  isAbsolute,
  joinRemotePath,
  languageOf,
  normalizeRemotePath,
  parentRemotePath,
  type FileKind,
} from '../../src/lib/path';
import type { EntryKind } from '../../src/api/types';

/** Shortcut for the two fields `classify` inspects. */
const entry = (name: string, kind: EntryKind = 'file') => ({ name, kind });

describe('normalizeRemotePath', () => {
  test('collapses duplicate slashes and trailing slashes', () => {
    expect(normalizeRemotePath('/a//b/./c')).toBe('/a/b/c');
    expect(normalizeRemotePath('///a///b')).toBe('/a/b');
    expect(normalizeRemotePath('/a/b/')).toBe('/a/b');
    expect(normalizeRemotePath('/a/b///')).toBe('/a/b');
  });

  test('resolves parent segments without escaping the root', () => {
    expect(normalizeRemotePath('/a/b/../c')).toBe('/a/c');
    expect(normalizeRemotePath('/..')).toBe('/');
    expect(normalizeRemotePath('/../..')).toBe('/');
    expect(normalizeRemotePath('/a/../../b')).toBe('/b');
    expect(normalizeRemotePath('/a/b/..')).toBe('/a');
  });

  test('keeps relative paths relative and preserves leading parent segments', () => {
    expect(normalizeRemotePath('a/b')).toBe('a/b');
    expect(normalizeRemotePath('./a')).toBe('a');
    expect(normalizeRemotePath('../a')).toBe('../a');
    expect(normalizeRemotePath('a/../../b')).toBe('../b');
    expect(normalizeRemotePath('a/..')).toBe('.');
  });

  test('maps empty-ish inputs to the canonical "." / "/"', () => {
    expect(normalizeRemotePath('')).toBe('/');
    expect(normalizeRemotePath('.')).toBe('.');
    expect(normalizeRemotePath('./')).toBe('.');
    expect(normalizeRemotePath('..')).toBe('..');
    expect(normalizeRemotePath('/')).toBe('/');
    expect(normalizeRemotePath('//')).toBe('/');
  });

  test('leaves names that merely contain dots or spaces alone', () => {
    expect(normalizeRemotePath('/a/..b/c')).toBe('/a/..b/c');
    expect(normalizeRemotePath('/a b/c d')).toBe('/a b/c d');
    expect(normalizeRemotePath('/.hidden')).toBe('/.hidden');
  });

  test('never rewrites backslashes into separators', () => {
    expect(normalizeRemotePath('/a\\b/c')).toBe('/a\\b/c');
    expect(normalizeRemotePath('C:\\tmp')).toBe('C:\\tmp');
  });
});

describe('isAbsolute', () => {
  test('only a leading slash counts', () => {
    expect(isAbsolute('/a')).toBe(true);
    expect(isAbsolute('/')).toBe(true);
    expect(isAbsolute('a')).toBe(false);
    expect(isAbsolute('../a')).toBe(false);
    expect(isAbsolute('')).toBe(false);
  });
});

describe('joinRemotePath', () => {
  test('joins with exactly one slash', () => {
    expect(joinRemotePath('/a', 'b')).toBe('/a/b');
    expect(joinRemotePath('/a/', 'b')).toBe('/a/b');
    expect(joinRemotePath('/a', 'b', 'c')).toBe('/a/b/c');
    expect(joinRemotePath('/a/', 'b/')).toBe('/a/b');
  });

  test('a leading absolute segment resets the result', () => {
    expect(joinRemotePath('/a', '/b/c')).toBe('/b/c');
    expect(joinRemotePath('/a/', '/b/')).toBe('/b');
    // Only the *first* segment can reset the base: later ones are joined as plain
    // components, so an embedded slash collapses instead of restarting from root.
    expect(joinRemotePath('/a', 'b', '/c')).toBe('/a/b/c');
  });

  test('skips empty segments and normalizes what is left', () => {
    expect(joinRemotePath('/a', '', 'b')).toBe('/a/b');
    expect(joinRemotePath('/a', '', '')).toBe('/a');
    expect(joinRemotePath('/a', '.', 'b')).toBe('/a/b');
    expect(joinRemotePath('/a', 'b/../c')).toBe('/a/c');
    expect(joinRemotePath('/', '')).toBe('/');
    expect(joinRemotePath('/', 'a')).toBe('/a');
  });

  test('is idempotent for an already-normalized base', () => {
    expect(joinRemotePath('/a/b')).toBe('/a/b');
    expect(joinRemotePath('/a//b/', '/')).toBe('/');
  });
});

describe('parentRemotePath', () => {
  test('walks one directory up', () => {
    expect(parentRemotePath('/a/b')).toBe('/a');
    expect(parentRemotePath('/a/b/')).toBe('/a');
    expect(parentRemotePath('/a')).toBe('/');
    expect(parentRemotePath('a/b')).toBe('a');
    expect(parentRemotePath('../a')).toBe('..');
  });

  test('returns null where there is no parent', () => {
    expect(parentRemotePath('/')).toBe(null);
    expect(parentRemotePath('//')).toBe(null);
    expect(parentRemotePath('.')).toBe(null);
    expect(parentRemotePath('a')).toBe(null);
    expect(parentRemotePath('./a')).toBe(null);
  });
});

describe('basenameRemotePath', () => {
  test('returns the last segment', () => {
    expect(basenameRemotePath('/a/b/c.txt')).toBe('c.txt');
    expect(basenameRemotePath('/a/b/')).toBe('b');
    expect(basenameRemotePath('file.txt')).toBe('file.txt');
    expect(basenameRemotePath('/a/b/../c')).toBe('c');
  });

  test('the root keeps its slash as the visible name', () => {
    expect(basenameRemotePath('/')).toBe('/');
    expect(basenameRemotePath('//')).toBe('/');
    expect(basenameRemotePath('')).toBe('/');
  });

  test('relative inputs survive unchanged', () => {
    expect(basenameRemotePath('.')).toBe('.');
    expect(basenameRemotePath('..')).toBe('..');
    expect(basenameRemotePath('../a')).toBe('a');
  });
});

describe('crumbsFor', () => {
  test('the root is a single crumb pointing at itself', () => {
    expect(crumbsFor('/')).toEqual([{ label: '/', path: '/' }]);
    expect(crumbsFor('//')).toEqual([{ label: '/', path: '/' }]);
  });

  test('accumulates an absolute path per segment', () => {
    expect(crumbsFor('/home/anna/docs')).toEqual([
      { label: '/', path: '/' },
      { label: 'home', path: '/home' },
      { label: 'anna', path: '/home/anna' },
      { label: 'docs', path: '/home/anna/docs' },
    ]);
  });

  test('normalizes before splitting, so trailing and duplicate slashes vanish', () => {
    expect(crumbsFor('/home//anna/')).toEqual([
      { label: '/', path: '/' },
      { label: 'home', path: '/home' },
      { label: 'anna', path: '/home/anna' },
    ]);
  });

  test('a relative path still yields root-anchored crumbs (current behaviour)', () => {
    // The first crumb is always "/", even when the input is not absolute.
    expect(crumbsFor('home/anna')).toEqual([
      { label: '/', path: '/' },
      { label: 'home', path: '/home' },
      { label: 'anna', path: '/home/anna' },
    ]);
  });

  test('a parent segment pops the accumulated crumb', () => {
    expect(crumbsFor('/a/b/../c').map((crumb) => crumb.path)).toEqual(['/', '/a', '/a/c']);
  });
});

describe('classify', () => {
  test('a directory is always a folder, whatever its name looks like', () => {
    expect(classify(entry('archive.zip', 'directory'))).toBe('folder');
    expect(classify(entry('notes.txt', 'directory'))).toBe('folder');
    expect(classify(entry('noextension', 'directory'))).toBe('folder');
  });

  test('symlinks are classified by their name, not their kind', () => {
    expect(classify(entry('link.txt', 'symlink'))).toBe('text');
    expect(classify(entry('shot.png', 'symlink'))).toBe('image');
    expect(classify(entry('link', 'symlink'))).toBe('binary');
  });

  test('well-known extension-less names are treated as code', () => {
    for (const name of ['Dockerfile', 'dockerfile', 'Makefile', 'makefile', '.env', '.gitignore', '.ENV']) {
      expect(classify(entry(name)), name).toBe('code');
    }
  });

  const codeNames = [
    'a.js', 'a.mjs', 'a.cjs', 'a.jsx', 'a.ts', 'a.tsx', 'a.json', 'a.jsonc', 'a.yml', 'a.yaml',
    'a.toml', 'a.ini', 'a.conf', 'a.cfg', 'a.sh', 'a.bash', 'a.zsh', 'a.fish', 'a.ps1', 'a.psm1',
    'a.py', 'a.rb', 'a.go', 'a.rs', 'a.c', 'a.h', 'a.cc', 'a.cpp', 'a.hpp', 'a.cs', 'a.java',
    'a.kt', 'a.swift', 'a.php', 'a.pl', 'a.lua', 'a.sql', 'a.html', 'a.htm', 'a.css', 'a.scss',
    'a.sass', 'a.less', 'a.vue', 'a.svelte', 'a.xml', 'a.env', 'a.service', 'a.tf', 'a.dockerfile',
    'a.mk', 'a.gradle', 'a.properties',
  ];

  const textNames = ['a.txt', 'a.md', 'a.markdown', 'a.log', 'a.csv', 'a.tsv', 'a.rst', 'a.rtf', 'a.nfo'];
  const imageNames = ['a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.webp', 'a.bmp', 'a.svg', 'a.ico', 'a.avif', 'a.tiff'];
  const archiveNames = ['a.zip', 'a.tar', 'a.gz', 'a.tgz', 'a.bz2', 'a.xz', 'a.7z', 'a.rar', 'a.zst', 'a.jar', 'a.war'];
  const audioNames = ['a.mp3', 'a.wav', 'a.flac', 'a.ogg', 'a.m4a', 'a.aac', 'a.opus'];
  const videoNames = ['a.mp4', 'a.mkv', 'a.mov', 'a.avi', 'a.webm', 'a.m4v'];
  const sheetNames = ['a.xls', 'a.xlsx', 'a.ods', 'a.numbers'];
  const keyNames = ['a.pem', 'a.key', 'a.pub', 'a.crt', 'a.cer', 'a.p12', 'a.pfx', 'a.ppk', 'a.asc', 'a.gpg'];
  const dbNames = ['a.db', 'a.sqlite', 'a.sqlite3', 'a.mdb', 'a.dump'];

  const table: Array<[FileKind, string[]]> = [
    ['code', codeNames],
    ['text', textNames],
    ['image', imageNames],
    ['archive', archiveNames],
    ['audio', audioNames],
    ['video', videoNames],
    ['sheet', sheetNames],
    ['key', keyNames],
    ['database', dbNames],
  ];

  for (const [kind, list] of table) {
    test(`classifies ${kind} extensions`, () => {
      for (const name of list) expect(classify(entry(name)), name).toBe(kind);
    });
  }

  test('pdf has its own kind', () => {
    expect(classify(entry('report.pdf'))).toBe('pdf');
    expect(classify(entry('REPORT.PDF'))).toBe('pdf');
  });

  test('extensions are matched case-insensitively', () => {
    expect(classify(entry('SHOT.PNG'))).toBe('image');
    expect(classify(entry('Notes.MD'))).toBe('text');
    expect(classify(entry('data.SQLITE3'))).toBe('database');
  });

  test('anything unknown, missing or trailing-dot is binary', () => {
    for (const name of ['a.bin', 'a.exe', 'a.iso', 'noextension', 'trailing.', '.bashrc']) {
      expect(classify(entry(name)), name).toBe('binary');
    }
  });

  test('an unknown multi-dot name is decided by its last extension', () => {
    expect(classify(entry('backup.tar.gz'))).toBe('archive');
    expect(classify(entry('component.test.tsx'))).toBe('code');
    expect(classify(entry('archive.tar.bin'))).toBe('binary');
  });

  test('the "other" entry kind falls back to the name', () => {
    expect(classify(entry('sock', 'other'))).toBe('binary');
    expect(classify(entry('notes.txt', 'other'))).toBe('text');
  });
});

describe('languageOf', () => {
  test('shell scripts, Makefiles and Dockerfiles report shell', () => {
    for (const name of ['Dockerfile', 'dockerfile', 'Makefile', 'makefile', 'x.mk', 'x.sh', 'x.bash', 'x.zsh', 'x.fish', 'x.ps1']) {
      expect(languageOf(name), name).toBe('shell');
    }
  });

  test('CODE_EXT entries that are neither shell nor markup report code', () => {
    // `psm1` is in CODE_EXT but not in the explicit shell list, so it lands on "code".
    expect(languageOf('x.psm1')).toBe('code');
    expect(languageOf('x.py')).toBe('code');
    expect(languageOf('x.yml')).toBe('code');
    expect(languageOf('x.yaml')).toBe('code');
    expect(languageOf('x.css')).toBe('code');
  });

  test('json and markup get their own hints', () => {
    expect(languageOf('package.json')).toBe('json');
    expect(languageOf('tsconfig.jsonc')).toBe('json');
    expect(languageOf('PACKAGE.JSON')).toBe('json');
    for (const name of ['index.html', 'index.htm', 'feed.xml', 'logo.svg', 'App.vue']) {
      expect(languageOf(name), name).toBe('markup');
    }
  });

  test('everything else is plain', () => {
    for (const name of ['notes.txt', 'README.md', 'photo.png', 'x.bin', 'noextension', '.bashrc']) {
      expect(languageOf(name), name).toBe('plain');
    }
  });
});
