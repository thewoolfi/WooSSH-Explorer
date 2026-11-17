import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  basename,
  ensureDirectoryMode,
  isAbsoluteRemotePath,
  isHomeRelative,
  isInsideRemotePath,
  joinRemotePath,
  normalizeRemotePath,
  parentRemotePath,
  resolveRemotePath,
} from '../../src/util/remotePath.js';

describe('normalizeRemotePath', () => {
  it('collapses duplicate slashes and dot segments', () => {
    assert.equal(normalizeRemotePath('/a//b/./c'), '/a/b/c');
    assert.equal(normalizeRemotePath('///a///b'), '/a/b');
    assert.equal(normalizeRemotePath('/a/b/'), '/a/b');
  });

  it('resolves parent segments without escaping the root', () => {
    assert.equal(normalizeRemotePath('/a/b/../c'), '/a/c');
    assert.equal(normalizeRemotePath('/..'), '/');
    assert.equal(normalizeRemotePath('/../..'), '/');
    assert.equal(normalizeRemotePath('/a/../../b'), '/b');
  });

  it('keeps relative paths relative', () => {
    assert.equal(normalizeRemotePath('a/b'), 'a/b');
    assert.equal(normalizeRemotePath('./a'), 'a');
    assert.equal(normalizeRemotePath('../a'), '../a');
    assert.equal(normalizeRemotePath(''), '.');
    assert.equal(normalizeRemotePath('.'), '.');
  });

  it('never produces a backslash, whatever the input', () => {
    assert.equal(normalizeRemotePath('/a\\b/c'), '/a\\b/c');
    assert.ok(!normalizeRemotePath('/a/b').includes('\\'));
  });
});

describe('joinRemotePath', () => {
  it('joins with a single slash', () => {
    assert.equal(joinRemotePath('/a', 'b'), '/a/b');
    assert.equal(joinRemotePath('/a/', 'b'), '/a/b');
    assert.equal(joinRemotePath('/a', 'b', 'c'), '/a/b/c');
  });

  it('lets an absolute segment reset the result', () => {
    assert.equal(joinRemotePath('/a', '/b/c'), '/b/c');
  });

  it('preserves a leading slash of the first segment', () => {
    assert.equal(joinRemotePath('/', 'a'), '/a');
    assert.equal(joinRemotePath('/', ''), '/');
  });
});

describe('parentRemotePath', () => {
  it('returns null only at the root', () => {
    assert.equal(parentRemotePath('/'), null);
    assert.equal(parentRemotePath('/a'), '/');
    assert.equal(parentRemotePath('/a/b'), '/a');
    assert.equal(parentRemotePath('/a/b/'), '/a');
  });
});

describe('basename', () => {
  it('returns the last segment', () => {
    assert.equal(basename('/a/b/c.txt'), 'c.txt');
    assert.equal(basename('/a/b/'), 'b');
    assert.equal(basename('/'), '/');
    assert.equal(basename('file.txt'), 'file.txt');
  });
});

describe('resolveRemotePath', () => {
  it('anchors relative paths at the base directory', () => {
    assert.equal(resolveRemotePath('sub/file.txt', '/home/user'), '/home/user/sub/file.txt');
    assert.equal(resolveRemotePath('../file.txt', '/home/user'), '/home/file.txt');
  });

  it('keeps absolute paths absolute', () => {
    assert.equal(resolveRemotePath('/etc/hosts', '/home/user'), '/etc/hosts');
  });
});

describe('path predicates', () => {
  it('detects absolute and home-relative paths', () => {
    assert.equal(isAbsoluteRemotePath('/a'), true);
    assert.equal(isAbsoluteRemotePath('a'), false);
    assert.equal(isHomeRelative('~'), true);
    assert.equal(isHomeRelative('~/a'), true);
    assert.equal(isHomeRelative('/~a'), false);
  });

  it('detects containment', () => {
    assert.equal(isInsideRemotePath('/a/b', '/a'), true);
    assert.equal(isInsideRemotePath('/a', '/a'), true);
    assert.equal(isInsideRemotePath('/ab', '/a'), false);
    assert.equal(isInsideRemotePath('/a/b', '/'), true);
  });
});

describe('ensureDirectoryMode', () => {
  it('defaults undefined to 0o755', () => {
    assert.equal(ensureDirectoryMode(undefined), 0o755);
  });

  it('guarantees user rwx (0o700) for directories', () => {
    assert.equal(ensureDirectoryMode(0o666), 0o777);
    assert.equal(ensureDirectoryMode(0o644), 0o755);
    assert.equal(ensureDirectoryMode(0o755), 0o755);
    assert.equal(ensureDirectoryMode(0o700), 0o700);
    assert.equal(ensureDirectoryMode(0o400), 0o700);
  });

  it('adds execute bit when read bit is present on group or other', () => {
    // 0o640 -> user rwx (0o700), group r+x (0o050), other 0 -> 0o750
    assert.equal(ensureDirectoryMode(0o640), 0o750);
    // 0o604 -> user rwx (0o700), group 0, other r+x (0o005) -> 0o705
    assert.equal(ensureDirectoryMode(0o604), 0o705);
  });
});
