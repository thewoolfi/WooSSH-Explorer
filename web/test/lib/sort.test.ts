import { describe, expect, test } from 'vitest';

import {
  DEFAULT_SORT,
  compareEntries,
  filterEntries,
  nextSort,
  sortEntries,
  type SortSpec,
} from '../../src/lib/sort';
import type { FileEntry } from '../../src/api/types';
import type { FileKind } from '../../src/lib/path';
import { dirEntry, fileEntry, symlinkEntry } from '../helpers/fixtures';

const asc = (key: SortSpec['key']): SortSpec => ({ key, direction: 'asc' });
const desc = (key: SortSpec['key']): SortSpec => ({ key, direction: 'desc' });

const names = (entries: FileEntry[]): string[] => entries.map((entry) => entry.name);

describe('sortEntries', () => {
  test('puts directories first even when the direction is descending', () => {
    const entries = [
      fileEntry({ name: 'a.txt' }),
      dirEntry('zulu'),
      fileEntry({ name: 'b.txt' }),
      dirEntry('alpha'),
    ];

    expect(names(sortEntries(entries, asc('name')))).toEqual(['alpha', 'zulu', 'a.txt', 'b.txt']);
    // The directory group stays on top; only the order *inside* each group flips.
    expect(names(sortEntries(entries, desc('name')))).toEqual(['zulu', 'alpha', 'b.txt', 'a.txt']);
  });

  test('ranks symlinks between directories and plain files', () => {
    const entries = [
      fileEntry({ name: 'plain.txt' }),
      symlinkEntry('link', '/etc/hosts'),
      dirEntry('folder'),
    ];

    expect(names(sortEntries(entries, asc('name')))).toEqual(['folder', 'link', 'plain.txt']);
    expect(names(sortEntries(entries, desc('name')))).toEqual(['folder', 'link', 'plain.txt']);
  });

  test('treats a non-file, non-directory, non-symlink entry as a plain file', () => {
    const socket = fileEntry({ name: 'a.sock', kind: 'other' });
    const entries = [socket, fileEntry({ name: 'z.txt' }), dirEntry('dir')];

    expect(names(sortEntries(entries, asc('name')))).toEqual(['dir', 'a.sock', 'z.txt']);
  });

  test('does not mutate the input array', () => {
    const entries = [fileEntry({ name: 'b' }), fileEntry({ name: 'a' })];
    const snapshot = [...entries];

    sortEntries(entries, asc('name'));

    expect(entries).toEqual(snapshot);
    expect(names(entries)).toEqual(['b', 'a']);
  });

  test('keeps ties in their original order (stable sort)', () => {
    // The collator is case-insensitive ("sensitivity: base"), so these two compare equal.
    const upper = fileEntry({ name: 'File', path: '/File' });
    const lower = fileEntry({ name: 'file', path: '/file' });

    expect(names(sortEntries([upper, lower], asc('name')))).toEqual(['File', 'file']);
    expect(names(sortEntries([lower, upper], asc('name')))).toEqual(['file', 'File']);
  });

  test('sorts names numerically, not lexicographically', () => {
    const entries = [
      fileEntry({ name: 'file10.txt' }),
      fileEntry({ name: 'file2.txt' }),
      fileEntry({ name: 'file1.txt' }),
    ];

    expect(names(sortEntries(entries, asc('name')))).toEqual(['file1.txt', 'file2.txt', 'file10.txt']);
    expect(names(sortEntries(entries, desc('name')))).toEqual(['file10.txt', 'file2.txt', 'file1.txt']);
  });
});

describe('compareEntries', () => {
  test('name: direction flips the sign', () => {
    const a = fileEntry({ name: 'alpha' });
    const b = fileEntry({ name: 'beta' });

    expect(compareEntries(a, b, asc('name'))).toBeLessThan(0);
    expect(compareEntries(b, a, asc('name'))).toBeGreaterThan(0);
    expect(compareEntries(a, b, desc('name'))).toBeGreaterThan(0);
    expect(compareEntries(a, a, asc('name'))).toBe(0);
  });

  test('size: compares bytes, then falls back to an ascending name', () => {
    const small = fileEntry({ name: 'small', size: 10 });
    const big = fileEntry({ name: 'big', size: 20 });

    expect(compareEntries(small, big, asc('size'))).toBeLessThan(0);
    expect(compareEntries(small, big, desc('size'))).toBeGreaterThan(0);

    // Equal sizes tie-break by name — and the tie-break is *not* flipped by direction.
    const a = fileEntry({ name: 'a', size: 10 });
    const b = fileEntry({ name: 'b', size: 10 });
    expect(compareEntries(b, a, asc('size'))).toBeGreaterThan(0);
    expect(compareEntries(b, a, desc('size'))).toBeGreaterThan(0);
    expect(compareEntries(a, b, desc('size'))).toBeLessThan(0);
  });

  test('mtime: newest first when descending', () => {
    const older = fileEntry({ name: 'older', mtime: 1_000 });
    const newer = fileEntry({ name: 'newer', mtime: 2_000 });

    expect(compareEntries(older, newer, asc('mtime'))).toBeLessThan(0);
    expect(compareEntries(older, newer, desc('mtime'))).toBeGreaterThan(0);

    const sameA = fileEntry({ name: 'a', mtime: 5 });
    const sameB = fileEntry({ name: 'b', mtime: 5 });
    expect(compareEntries(sameB, sameA, desc('mtime'))).toBeGreaterThan(0);
  });

  test('owner: compares the owner string, then the name', () => {
    const alice = fileEntry({ name: 'x', owner: 'alice' });
    const bob = fileEntry({ name: 'x', owner: 'bob' });

    expect(compareEntries(alice, bob, asc('owner'))).toBeLessThan(0);
    expect(compareEntries(alice, bob, desc('owner'))).toBeGreaterThan(0);

    const rootA = fileEntry({ name: 'a', owner: 'root' });
    const rootB = fileEntry({ name: 'b', owner: 'root' });
    expect(compareEntries(rootB, rootA, desc('owner'))).toBeGreaterThan(0);
  });

  test('mode: compares raw permission bits numerically', () => {
    const ro = fileEntry({ name: 'ro', mode: 0o100444 });
    const rw = fileEntry({ name: 'rw', mode: 0o100644 });

    expect(compareEntries(ro, rw, asc('mode'))).toBeLessThan(0);
    expect(compareEntries(ro, rw, desc('mode'))).toBeGreaterThan(0);
  });

  test('kind: compares the classified kind, not the raw entry kind', () => {
    const image = fileEntry({ name: 'shot.png' });
    const text = fileEntry({ name: 'notes.txt' });
    const directory = dirEntry('dir');

    // 'image' < 'text' alphabetically.
    expect(compareEntries(image, text, asc('kind'))).toBeLessThan(0);
    expect(compareEntries(image, text, desc('kind'))).toBeGreaterThan(0);
    // classify() maps a directory to the 'folder' kind.
    expect(compareEntries(dirEntry('a'), fileEntry({ name: 'b.png' }), asc('kind'))).toBeLessThan(0);
    expect(compareEntries(directory, text, asc('kind'))).toBeLessThan(0);

    // Two entries of the same kind fall back to an ascending name.
    const pngA = fileEntry({ name: 'a.png' });
    const pngB = fileEntry({ name: 'b.png' });
    expect(compareEntries(pngB, pngA, desc('kind'))).toBeGreaterThan(0);
  });

  test('DEFAULT_SORT sorts by ascending name', () => {
    expect(DEFAULT_SORT).toEqual({ key: 'name', direction: 'asc' });
    expect(names(sortEntries([fileEntry({ name: 'b' }), fileEntry({ name: 'a' })], DEFAULT_SORT))).toEqual([
      'a',
      'b',
    ]);
  });
});

describe('nextSort', () => {
  test('a new column starts descending, except for the name column', () => {
    expect(nextSort(asc('name'), 'size')).toEqual({ key: 'size', direction: 'desc' });
    expect(nextSort(asc('size'), 'mtime')).toEqual({ key: 'mtime', direction: 'desc' });
    expect(nextSort(desc('size'), 'name')).toEqual({ key: 'name', direction: 'asc' });
  });

  test('the active column toggles direction on every click', () => {
    let sort: SortSpec = { key: 'name', direction: 'asc' };
    sort = nextSort(sort, 'name');
    expect(sort).toEqual({ key: 'name', direction: 'desc' });
    sort = nextSort(sort, 'name');
    expect(sort).toEqual({ key: 'name', direction: 'asc' });
    sort = nextSort(sort, 'name');
    expect(sort).toEqual({ key: 'name', direction: 'desc' });
  });

  test('re-selecting a column keeps it as the active key', () => {
    expect(nextSort({ key: 'owner', direction: 'desc' }, 'owner')).toEqual({
      key: 'owner',
      direction: 'asc',
    });
  });

  test('returns a fresh object rather than mutating the current sort', () => {
    const current: SortSpec = { key: 'name', direction: 'asc' };
    const next = nextSort(current, 'name');

    expect(next).not.toBe(current);
    expect(current).toEqual({ key: 'name', direction: 'asc' });
  });
});

describe('filterEntries', () => {
  const entries = [
    fileEntry({ name: 'README.md' }),
    fileEntry({ name: 'notes.TXT' }),
    fileEntry({ name: 'archive.zip' }),
    dirEntry('photos'),
    dirEntry('.config'),
    fileEntry({ name: '.bashrc', hidden: true }),
  ];

  const all = { query: '', showHidden: true, kinds: null };

  test('returns everything for an empty query', () => {
    expect(names(filterEntries(entries, all))).toEqual([
      'README.md',
      'notes.TXT',
      'archive.zip',
      'photos',
      '.config',
      '.bashrc',
    ]);
  });

  test('hides hidden entries unless showHidden is set', () => {
    expect(names(filterEntries(entries, { ...all, showHidden: false }))).toEqual([
      'README.md',
      'notes.TXT',
      'archive.zip',
      'photos',
    ]);
  });

  test('matches the query case-insensitively and ignores surrounding blanks', () => {
    expect(names(filterEntries(entries, { ...all, query: 'readme' }))).toEqual(['README.md']);
    expect(names(filterEntries(entries, { ...all, query: '  README  ' }))).toEqual(['README.md']);
    expect(names(filterEntries(entries, { ...all, query: 'PHOTO' }))).toEqual(['photos']);
    // Whitespace-only is treated as "no filter".
    expect(filterEntries(entries, { ...all, query: '   ' })).toHaveLength(6);
  });

  test('matches an extension with or without a leading dot, whatever the case', () => {
    expect(names(filterEntries(entries, { ...all, query: '.zip' }))).toEqual(['archive.zip']);
    expect(names(filterEntries(entries, { ...all, query: 'ZIP' }))).toEqual(['archive.zip']);
    expect(names(filterEntries(entries, { ...all, query: '.TXT' }))).toEqual(['notes.TXT']);
  });

  test('matches a substring of the name, not a prefix', () => {
    expect(names(filterEntries(entries, { ...all, query: 'ote' }))).toEqual(['notes.TXT']);
  });

  test('matches the file name only — the containing path is not searched', () => {
    // Documents current behaviour: the doc comment claims "the whole path", but only
    // `entry.name`, `entry.hidden` and the extension are inspected.
    const nested = [fileEntry({ name: 'report.pdf', path: '/home/anna/private/report.pdf' })];
    expect(filterEntries(nested, { ...all, query: 'anna' })).toHaveLength(0);
    expect(filterEntries(nested, { ...all, query: 'report' })).toHaveLength(1);
  });

  test('restricts results to the requested kinds', () => {
    const folders = new Set<FileKind>(['folder']);
    expect(names(filterEntries(entries, { ...all, query: '', kinds: folders }))).toEqual([
      'photos',
      '.config',
    ]);

    const text = new Set<FileKind>(['text']);
    expect(names(filterEntries(entries, { ...all, query: '', kinds: text }))).toEqual([
      'README.md',
      'notes.TXT',
    ]);

    // An empty set is a real filter: nothing classifies into it.
    expect(filterEntries(entries, { ...all, kinds: new Set<FileKind>() })).toHaveLength(0);
  });

  test('combines the kind filter, the hidden filter and the query', () => {
    const result = filterEntries(entries, {
      query: 'p',
      showHidden: false,
      kinds: new Set<FileKind>(['archive']),
    });
    expect(names(result)).toEqual(['archive.zip']);
  });

  test('does not mutate the input list', () => {
    const input = [...entries];
    filterEntries(input, { ...all, query: 'photo' });
    expect(input).toEqual(entries);
  });
});
