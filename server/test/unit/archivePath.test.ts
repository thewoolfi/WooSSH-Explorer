/**
 * §6 `fs/extract` path safety — the security-relevant part of archive handling.
 *
 * Every case here is a real attack shape: `..` segments, absolute names, Windows-style
 * absolute names and symlinks that leave the destination directory.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { safeArchiveEntryPath, safeArchiveLinkTarget } from '../../src/util/archivePath.js';

const DEST = '/tmp/restore';

function accepted(result: ReturnType<typeof safeArchiveEntryPath>): Extract<ReturnType<typeof safeArchiveEntryPath>, { ok: true }> {
  assert.equal(result.ok, true, `expected the entry to be accepted, got: ${JSON.stringify(result)}`);
  return result as Extract<ReturnType<typeof safeArchiveEntryPath>, { ok: true }>;
}

function rejected(result: ReturnType<typeof safeArchiveEntryPath>): Extract<ReturnType<typeof safeArchiveEntryPath>, { ok: false }> {
  assert.equal(result.ok, false, `expected the entry to be rejected, got: ${JSON.stringify(result)}`);
  return result as Extract<ReturnType<typeof safeArchiveEntryPath>, { ok: false }>;
}

describe('safeArchiveEntryPath', () => {
  it('accepts ordinary entries and resolves them under the destination', () => {
    assert.equal(accepted(safeArchiveEntryPath(DEST, 'app/index.js')).path, '/tmp/restore/app/index.js');
    assert.equal(accepted(safeArchiveEntryPath(DEST, 'app/')).path, '/tmp/restore/app');
    assert.equal(accepted(safeArchiveEntryPath(DEST, './app/./index.js')).relative, 'app/index.js');
    assert.equal(accepted(safeArchiveEntryPath(DEST, 'a//b')).path, '/tmp/restore/a/b');
    // A backslash is a perfectly legal POSIX filename character.
    assert.equal(accepted(safeArchiveEntryPath(DEST, 'weird\\name.txt')).path, '/tmp/restore/weird\\name.txt');
  });

  it('rejects a ".." segment anywhere in the name', () => {
    for (const name of ['../etc/passwd', 'app/../../etc/passwd', 'a/b/../../../x', '..', 'app/..']) {
      const result = rejected(safeArchiveEntryPath(DEST, name));
      assert.ok(
        result.reason.includes('..') || result.reason.includes('escapes'),
        `unexpected reason for ${name}: ${result.reason}`,
      );
      assert.equal(result.entry, name, 'the offending entry must be named');
    }
  });

  it('rejects a Windows-written traversal, because the archive is still extracted here', () => {
    for (const name of ['..\\..\\Windows\\System32\\evil.dll', 'app\\..\\..\\evil']) {
      const result = rejected(safeArchiveEntryPath(DEST, name));
      assert.match(result.reason, /\.\.|escapes/);
    }
  });

  it('rejects absolute names in both spellings', () => {
    assert.match(rejected(safeArchiveEntryPath(DEST, '/etc/passwd')).reason, /absolute/);
    assert.match(rejected(safeArchiveEntryPath(DEST, 'C:\\Windows\\evil.dll')).reason, /absolute/);
    assert.match(rejected(safeArchiveEntryPath(DEST, 'C:/Windows/evil.dll')).reason, /absolute/);
  });

  it('rejects empty names and NUL bytes', () => {
    assert.match(rejected(safeArchiveEntryPath(DEST, '')).reason, /empty/);
    assert.match(rejected(safeArchiveEntryPath(DEST, '   ')).reason, /empty/);
    assert.match(rejected(safeArchiveEntryPath(DEST, 'a\0b')).reason, /NUL/);
    assert.match(rejected(safeArchiveEntryPath(DEST, './')).reason, /empty/);
  });

  it('never produces a path outside the destination, whatever the input', () => {
    for (const name of ['a', 'a/b/c', '../a', '/a', 'x/../../y', '..\\z']) {
      const result = safeArchiveEntryPath(DEST, name);
      if (result.ok) {
        assert.ok(
          result.path.startsWith(`${DEST}/`),
          `${name} resolved to ${result.path}, which is outside ${DEST}`,
        );
      }
    }
  });

  it('honours a destination other than a temp path', () => {
    assert.equal(accepted(safeArchiveEntryPath('/', 'a/b')).path, '/a/b');
    assert.equal(accepted(safeArchiveEntryPath('/srv/app', 'a/b')).path, '/srv/app/a/b');
  });
});

describe('safeArchiveLinkTarget', () => {
  it('accepts a relative target that stays inside the destination', () => {
    assert.equal(
      accepted(safeArchiveLinkTarget(DEST, '/tmp/restore/app/link', '../lib/util.js')).path,
      '/tmp/restore/lib/util.js',
    );
    assert.equal(
      accepted(safeArchiveLinkTarget(DEST, '/tmp/restore/link', 'app/index.js')).path,
      '/tmp/restore/app/index.js',
    );
  });

  it('rejects an absolute target', () => {
    assert.match(rejected(safeArchiveLinkTarget(DEST, '/tmp/restore/link', '/etc/passwd')).reason, /absolute/);
    assert.match(rejected(safeArchiveLinkTarget(DEST, '/tmp/restore/link', 'C:\\Windows')).reason, /absolute/);
  });

  it('rejects a relative target that escapes the destination', () => {
    const cases: [string, string][] = [
      ['/tmp/restore/app/link', '../../etc/passwd'],
      ['/tmp/restore/link', '../outside'],
      ['/tmp/restore/link', 'a/../../outside'],
    ];
    for (const [link, target] of cases) {
      const result = rejected(safeArchiveLinkTarget(DEST, link, target));
      assert.match(result.reason, /outside|escapes/, `unexpected reason for ${target}: ${result.reason}`);
    }
  });

  it('rejects empty, NUL-containing and whitespace targets', () => {
    assert.match(rejected(safeArchiveLinkTarget(DEST, `${DEST}/l`, '')).reason, /empty/);
    assert.match(rejected(safeArchiveLinkTarget(DEST, `${DEST}/l`, '   ')).reason, /empty/);
    assert.match(rejected(safeArchiveLinkTarget(DEST, `${DEST}/l`, 'a\0b')).reason, /NUL/);
  });

  it('allows a target that walks up but stays inside the destination', () => {
    // `sub/link -> ../shared/x` is a normal, safe archive layout.
    assert.equal(
      accepted(safeArchiveLinkTarget(DEST, `${DEST}/sub/link`, '../shared/x')).path,
      '/tmp/restore/shared/x',
    );
  });
});
