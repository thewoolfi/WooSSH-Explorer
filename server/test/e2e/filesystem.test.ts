/**
 * §6 Filesystem + §11.4/§11.5 — listing, stat, read, mutations and the round trip,
 * all against real bytes in the mock's temp directory.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import {
  CONFIG_FILE,
  DOTFILE,
  FIXTURE_MTIME_MS,
  GUIDE_FILE,
  HELLO_FILE,
  NUL_FILE,
  PNG_FILE,
  README_FILE,
  ROOT_ENTRY_NAMES,
  SYMLINK_TO_FILE,
  UNICODE_FILE,
  ZERO_FILE,
} from '../support/fixtures.js';
import { expectErrorEnvelope, startHarness, waitFor, type Harness } from '../support/harness.js';

const MODE_TEXT_RE = /^[-dl][rwx-]{9}$/;
const SANE_MS = 1_600_000_000_000; // 2020-09-13 — anything below means seconds, not ms

let h!: Harness;
let connectionId!: string;

before(async () => {
  h = await startHarness();
  const trusted = await h.connectTrusting();
  connectionId = trusted.id;
});

after(async () => {
  await h?.close();
});

const fsPath = (suffix: string): string => `/api/connections/${connectionId}${suffix}`;

function assertEntryShape(entry: any, context: string): void {
  assert.equal(typeof entry.name, 'string', `${context}: name`);
  assert.equal(typeof entry.path, 'string', `${context}: path`);
  assert.ok(entry.path.startsWith('/'), `${context}: path must be absolute (${entry.path})`);
  assert.ok(
    ['file', 'directory', 'symlink', 'other'].includes(entry.kind),
    `${context}: unexpected kind ${entry.kind}`,
  );
  assert.equal(typeof entry.size, 'number', `${context}: size`);
  assert.ok(entry.size >= 0, `${context}: size must not be negative`);
  assert.equal(typeof entry.mtime, 'number', `${context}: mtime`);
  assert.ok(entry.mtime > SANE_MS, `${context}: mtime must be epoch ms (§2), got ${entry.mtime}`);
  assert.equal(typeof entry.atime, 'number', `${context}: atime`);
  assert.ok(entry.atime > SANE_MS, `${context}: atime must be epoch ms, got ${entry.atime}`);
  assert.equal(typeof entry.mode, 'number', `${context}: mode`);
  assert.match(entry.modeText, MODE_TEXT_RE, `${context}: modeText "${entry.modeText}"`);
  assert.equal(typeof entry.owner, 'string', `${context}: owner`);
  assert.ok(entry.owner.length > 0, `${context}: owner must not be empty`);
  assert.equal(typeof entry.group, 'string', `${context}: group`);
  assert.equal(typeof entry.uid, 'number', `${context}: uid`);
  assert.equal(typeof entry.gid, 'number', `${context}: gid`);
  assert.equal(typeof entry.hidden, 'boolean', `${context}: hidden`);
  assert.equal(entry.hidden, entry.name.startsWith('.'), `${context}: hidden must follow the leading dot`);
}

describe('fs/list', () => {
  test('lists the whole fixture root including dotfiles', async () => {
    const res = await h.json('GET', fsPath('/fs/list?path=/'));
    assert.equal(res.status, 200, res.text.slice(0, 300));
    const listing = res.json.listing;
    assert.equal(listing.path, '/');
    assert.equal(listing.parent, null, 'parent must be null at the root');
    assert.equal(listing.truncated, false);
    assert.ok(Array.isArray(listing.entries));

    const names = listing.entries.map((e: any) => e.name);
    for (const expected of ROOT_ENTRY_NAMES) {
      assert.ok(names.includes(expected), `listing must contain ${expected} (got ${names.join(', ')})`);
    }
    for (const entry of listing.entries) assertEntryShape(entry, `root entry ${entry.name}`);

    // Dotfiles are returned as real entries (§11.4) with hidden === true.
    const hidden = listing.entries.find((e: any) => e.name === '.hidden');
    assert.ok(hidden, '.hidden must be listed');
    assert.equal(hidden.hidden, true);
    assert.equal(hidden.kind, 'file');
    assert.equal(hidden.size, DOTFILE.content.length);

    const hello = listing.entries.find((e: any) => e.name === 'hello.txt');
    assert.equal(hello.kind, 'file');
    assert.equal(hello.size, HELLO_FILE.content.length);
    assert.equal(hello.path, '/hello.txt');
    assert.equal(hello.uid, 1000, 'the mock reports POSIX uid 1000');
    assert.ok(
      Math.abs(hello.mtime - FIXTURE_MTIME_MS) < 2_000,
      `mtime must be the fixture time in ms (expected ~${FIXTURE_MTIME_MS}, got ${hello.mtime})`,
    );
    assert.equal(hello.modeText, '-rw-r--r--');

    const docs = listing.entries.find((e: any) => e.name === 'docs');
    assert.equal(docs.kind, 'directory');
    assert.equal(docs.modeText, 'drwxr-xr-x');

    // Real SFTP servers return "." and ".." in READDIR; the API must filter them.
    assert.ok(!names.includes('.'), `fs/list must not return a "." entry (got ${names.join(', ')})`);
    assert.ok(!names.includes('..'), `fs/list must not return a ".." entry (got ${names.join(', ')})`);
  });

  test('showHidden=false is only a hint — the server still returns everything', async () => {
    const res = await h.json('GET', fsPath('/fs/list?path=/&showHidden=false'));
    assert.equal(res.status, 200);
    const names = res.json.listing.entries.map((e: any) => e.name);
    assert.ok(names.includes('.hidden'), '§6: the server always returns every entry');
    assert.ok(names.includes('.config'));
  });

  test('resolves ~ and relative paths through realpath, and reports parents', async () => {
    const tilde = await h.json('GET', fsPath('/fs/list?path=~'));
    assert.equal(tilde.status, 200, tilde.text.slice(0, 200));
    assert.equal(tilde.json.listing.path, '/', '~ must resolve to the remote home');
    assert.equal(tilde.json.listing.parent, null);

    const dot = await h.json('GET', fsPath('/fs/list?path=.'));
    assert.equal(dot.status, 200);
    assert.equal(dot.json.listing.path, '/');

    const relative = await h.json('GET', fsPath('/fs/list?path=docs'));
    assert.equal(relative.status, 200, relative.text.slice(0, 200));
    assert.equal(relative.json.listing.path, '/docs');
    assert.equal(relative.json.listing.parent, '/');
    const names = relative.json.listing.entries.map((e: any) => e.name);
    assert.ok(names.includes('guide.md'));
    assert.ok(names.includes('nested'));

    const trailingSlash = await h.json('GET', fsPath('/fs/list?path=/docs/nested/'));
    assert.equal(trailingSlash.status, 200);
    assert.equal(trailingSlash.json.listing.path, '/docs/nested');
  });

  test('limit truncates the listing', async () => {
    const res = await h.json('GET', fsPath('/fs/list?path=/&limit=3'));
    assert.equal(res.status, 200, res.text.slice(0, 200));
    assert.equal(res.json.listing.truncated, true, 'limit=3 over 10 entries must set truncated');
    assert.ok(res.json.listing.entries.length <= 3);

    const full = await h.json('GET', fsPath('/fs/list?path=/&limit=20000'));
    assert.equal(full.status, 200);
    assert.equal(full.json.listing.truncated, false);
  });
});

describe('fs/stat', () => {
  test('returns a FileEntry for a file, a directory and a symlink', async () => {
    const file = await h.json('GET', fsPath(`/fs/stat?path=${encodeURIComponent('/hello.txt')}`));
    assert.equal(file.status, 200, file.text.slice(0, 200));
    assertEntryShape(file.json.entry, 'stat /hello.txt');
    assert.equal(file.json.entry.kind, 'file');
    assert.equal(file.json.entry.size, HELLO_FILE.content.length);

    const dir = await h.json('GET', fsPath('/fs/stat?path=%2Fdocs'));
    assert.equal(dir.status, 200);
    assert.equal(dir.json.entry.kind, 'directory');
    assert.equal(dir.json.entry.modeText, 'drwxr-xr-x');

    const link = await h.json('GET', fsPath(`/fs/stat?path=${encodeURIComponent(SYMLINK_TO_FILE.path)}`));
    assert.equal(link.status, 200, link.text.slice(0, 200));
    assert.equal(link.json.entry.kind, 'symlink', 'lstat semantics are required to see a symlink');
    if (link.json.entry.target !== undefined) {
      assert.equal(link.json.entry.target, SYMLINK_TO_FILE.target);
    }

    const nested = await h.json('GET', fsPath('/fs/stat?path=%2F.config%2Fsettings.json'));
    assert.equal(nested.status, 200);
    assert.equal(nested.json.entry.size, CONFIG_FILE.content.length);
    assert.equal(nested.json.entry.hidden, false, 'hidden follows the entry name: "settings.json" has no dot');

    const hiddenDir = await h.json('GET', fsPath('/fs/stat?path=%2F.config'));
    assert.equal(hiddenDir.status, 200);
    assert.equal(hiddenDir.json.entry.hidden, true, '".config" itself is hidden');
    assert.equal(hiddenDir.json.entry.kind, 'directory');
  });

  test('fs/list marks symlinks (EntryKind "symlink" + target)', async () => {
    const res = await h.json('GET', fsPath('/fs/list?path=%2Flinks'));
    assert.equal(res.status, 200, res.text.slice(0, 200));
    const link = res.json.listing.entries.find((e: any) => e.name === 'to-readme.txt');
    assert.ok(link, 'the fixture symlink must be listed');
    assert.equal(link.kind, 'symlink');
    assert.equal(link.modeText, 'lrwxrwxrwx');
    assert.equal(link.target, SYMLINK_TO_FILE.target);
  });
});

describe('fs/read', () => {
  test('text files come back byte-exact', async () => {
    const res = await h.json('GET', fsPath(`/fs/read?path=${encodeURIComponent(HELLO_FILE.path)}`));
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.equal(res.json.kind, 'text');
    assert.equal(res.json.content, HELLO_FILE.content.toString('utf8'));
    assert.equal(res.json.size, HELLO_FILE.content.length);
    assert.equal(res.json.truncated, false);
    assert.equal(res.json.encoding, 'utf8');
    assert.equal(typeof res.json.mimeType, 'string');
    assert.equal(typeof res.json.lines, 'number');
  });

  test('UTF-8 content survives the round trip', async () => {
    const res = await h.json('GET', fsPath(`/fs/read?path=${encodeURIComponent(UNICODE_FILE.path)}`));
    assert.equal(res.status, 200);
    assert.equal(res.json.kind, 'text');
    assert.equal(res.json.content, UNICODE_FILE.content.toString('utf8'));
    assert.equal(Buffer.byteLength(res.json.content, 'utf8'), UNICODE_FILE.content.length);
  });

  test('a file with NUL bytes is not text', async () => {
    const res = await h.json('GET', fsPath(`/fs/read?path=${encodeURIComponent(NUL_FILE.path)}`));
    assert.equal(res.status, 200, 'binary content must never throw (§6)');
    assert.notEqual(res.json.kind, 'text', `NUL bytes must disable text detection (got ${res.json.kind})`);
    assert.equal(res.json.size, NUL_FILE.content.length);
    assert.equal(res.json.content, undefined, 'binary payloads must not be inlined as text');
  });

  test('a PNG is reported as an image with a data URL', async () => {
    const res = await h.json('GET', fsPath(`/fs/read?path=${encodeURIComponent(PNG_FILE.path)}`));
    assert.equal(res.status, 200);
    assert.equal(res.json.kind, 'image');
    assert.equal(res.json.size, PNG_FILE.content.length);
    assert.ok(
      typeof res.json.dataUrl === 'string' && res.json.dataUrl.startsWith('data:image/png;base64,'),
      `expected a PNG data URL, got ${String(res.json.dataUrl).slice(0, 60)}`,
    );
    const decoded = Buffer.from(res.json.dataUrl.split(',')[1] ?? '', 'base64');
    assert.ok(decoded.equals(PNG_FILE.content), 'the data URL must carry the exact PNG bytes');
  });

  test('maxBytes truncates instead of throwing', async () => {
    const res = await h.json('GET', fsPath(`/fs/read?path=${encodeURIComponent(README_FILE.path)}&maxBytes=10`));
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.equal(res.json.kind, 'text');
    assert.equal(res.json.truncated, true);
    assert.equal(res.json.content.length, 10, 'the first maxBytes of an ASCII file');
    assert.equal(res.json.size, README_FILE.content.length, 'size stays the real file size');
    assert.equal(res.json.content, README_FILE.content.subarray(0, 10).toString('utf8'));

    const whole = await h.json(
      'GET',
      fsPath(`/fs/read?path=${encodeURIComponent(README_FILE.path)}&maxBytes=2097152`),
    );
    assert.equal(whole.status, 200);
    assert.equal(whole.json.truncated, false);
    assert.equal(whole.json.content, README_FILE.content.toString('utf8'));
  });

  test('a zero-byte file is handled without throwing', async () => {
    const res = await h.json('GET', fsPath(`/fs/read?path=${encodeURIComponent(ZERO_FILE.path)}`));
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.equal(res.json.size, 0);
    assert.equal(res.json.truncated, false);
    assert.ok(['text', 'binary'].includes(res.json.kind), `unexpected kind ${res.json.kind}`);
  });

  test('reading a missing path is a 400 SFTP_ERROR with the SFTP status code', async () => {
    const res = await h.json('GET', fsPath('/fs/read?path=%2Fdefinitely-not-here.txt'));
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${res.text}`);
    const error = expectErrorEnvelope(res);
    assert.equal(error.code, 'SFTP_ERROR');
    assert.equal((error.details as Record<string, unknown>).code, 2, 'SFTP NO_SUCH_FILE === 2');
  });
});

describe('fs mutations', () => {
  test('mkdir → rename → list → delete round trip', async () => {
    const dir = `/e2e-roundtrip-${Date.now().toString(36)}`;
    const renamed = `${dir}-renamed`;

    const mkdir = await h.json('POST', fsPath('/fs/mkdir'), { path: dir });
    assert.equal(mkdir.status, 201, `mkdir: ${mkdir.status} ${mkdir.text.slice(0, 200)}`);
    assert.equal(mkdir.json.entry.kind, 'directory');
    assert.equal(mkdir.json.entry.path, dir);
    assert.match(mkdir.json.entry.modeText, MODE_TEXT_RE);

    const rename = await h.json('POST', fsPath('/fs/rename'), { from: dir, to: renamed });
    assert.equal(rename.status, 200, `rename: ${rename.status} ${rename.text.slice(0, 200)}`);
    assert.equal(rename.json.entry.path, renamed);

    const listing = await h.json('GET', fsPath('/fs/list?path=/'));
    const names = listing.json.listing.entries.map((e: any) => e.name);
    assert.ok(names.includes(renamed.split('/').pop()), 'the renamed directory must be listed');
    assert.ok(!names.includes(dir.split('/').pop()), 'the old name must be gone');

    const del = await h.json('POST', fsPath('/fs/delete'), { paths: [renamed], recursive: true });
    assert.equal(del.status, 200, `delete: ${del.status} ${del.text.slice(0, 200)}`);
    assert.deepEqual(del.json.failed, []);
    assert.ok(del.json.deleted.includes(renamed));

    const after = await h.json('GET', fsPath('/fs/list?path=/'));
    assert.ok(!after.json.listing.entries.some((e: any) => e.name === renamed.split('/').pop()));
  });

  test('a non-empty directory needs recursive:true; recursive delete removes the tree', async () => {
    const root = `/e2e-tree-${Date.now().toString(36)}`;
    const sub = `${root}/sub`;
    const payload = Buffer.from('nested payload bytes\n', 'utf8');

    assert.equal((await h.json('POST', fsPath('/fs/mkdir'), { path: root })).status, 201);
    assert.equal((await h.json('POST', fsPath('/fs/mkdir'), { path: sub })).status, 201);

    const upload = await h.request('POST', fsPath(`/fs/upload?path=${encodeURIComponent(sub)}&name=inner.txt`), {
      headers: { 'content-type': 'application/octet-stream' },
      body: payload,
    });
    assert.equal(upload.status, 200, `upload: ${upload.status} ${upload.text.slice(0, 200)}`);

    const listing = await h.json('GET', fsPath(`/fs/list?path=${encodeURIComponent(sub)}`));
    const inner = listing.json.listing.entries.find((e: any) => e.name === 'inner.txt');
    assert.ok(inner, 'the uploaded file must exist in the subdirectory');
    assert.equal(inner.size, payload.length);

    // §6: without recursive:true a non-empty directory lands in `failed` and is kept.
    const nonRecursive = await h.json('POST', fsPath('/fs/delete'), { paths: [root] });
    assert.equal(nonRecursive.status, 200, nonRecursive.text.slice(0, 200));
    assert.ok(
      nonRecursive.json.failed.some((f: any) => f.path === root),
      `expected ${root} in failed[] (got ${JSON.stringify(nonRecursive.json)})`,
    );
    assert.ok(!nonRecursive.json.deleted.includes(root));
    const stillThere = await h.json('GET', fsPath(`/fs/stat?path=${encodeURIComponent(root)}`));
    assert.equal(stillThere.status, 200, 'the directory must survive a refused delete');

    const recursive = await h.json('POST', fsPath('/fs/delete'), { paths: [root], recursive: true });
    assert.equal(recursive.status, 200, recursive.text.slice(0, 300));
    assert.deepEqual(recursive.json.failed, [], `recursive delete must not fail: ${recursive.text.slice(0, 300)}`);
    assert.ok(recursive.json.deleted.includes(root));

    const gone = await h.json('GET', fsPath(`/fs/stat?path=${encodeURIComponent(root)}`));
    assert.ok(gone.status >= 400 && gone.status < 500, `the deleted tree must be gone, got ${gone.status}`);
  });

  test('chmod rewrites modeText as expected', async () => {
    const before = await h.json('GET', fsPath(`/fs/stat?path=${encodeURIComponent(HELLO_FILE.path)}`));
    assert.equal(before.json.entry.modeText, '-rw-r--r--');

    const readOnly = await h.json('POST', fsPath('/fs/chmod'), { path: HELLO_FILE.path, mode: '444' });
    assert.equal(readOnly.status, 200, readOnly.text.slice(0, 200));
    assert.equal(readOnly.json.entry.modeText, '-r--r--r--');
    assert.equal(readOnly.json.entry.mode & 0o222, 0, 'no write bits after chmod 444');

    const statReadOnly = await h.json('GET', fsPath(`/fs/stat?path=${encodeURIComponent(HELLO_FILE.path)}`));
    assert.equal(statReadOnly.json.entry.modeText, '-r--r--r--', 'chmod must persist');

    const restored = await h.json('POST', fsPath('/fs/chmod'), { path: HELLO_FILE.path, mode: '644' });
    assert.equal(restored.status, 200);
    assert.equal(restored.json.entry.modeText, '-rw-r--r--');

    const exec = await h.json('POST', fsPath('/fs/chmod'), { path: HELLO_FILE.path, mode: '0755' });
    assert.equal(exec.status, 200, 'a leading zero ("0755") is allowed by §6');
    assert.equal(exec.json.entry.modeText, '-rwxr-xr-x');

    await h.json('POST', fsPath('/fs/chmod'), { path: HELLO_FILE.path, mode: '644' });
  });

  test('touch updates mtime', async () => {
    const target = FIXTURE_MTIME_MS + 86_400_000;
    const res = await h.json('POST', fsPath('/fs/touch'), { path: HELLO_FILE.path, mtimeMs: target });
    assert.equal(res.status, 200, res.text.slice(0, 200));
    assert.ok(
      Math.abs(res.json.entry.mtime - target) < 2_000,
      `touch must set mtimeMs (expected ~${target}, got ${res.json.entry.mtime})`,
    );

    const again = await h.json('GET', fsPath(`/fs/stat?path=${encodeURIComponent(HELLO_FILE.path)}`));
    assert.ok(Math.abs(again.json.entry.mtime - target) < 2_000, 'the new mtime must persist');

    await h.json('POST', fsPath('/fs/touch'), { path: HELLO_FILE.path, mtimeMs: FIXTURE_MTIME_MS });
  });

  test('search finds nested files case-insensitively', async () => {
    const res = await h.json('GET', fsPath('/fs/search?path=%2F&query=GUIDE&limit=50'));
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.ok(Array.isArray(res.json.results));
    assert.equal(typeof res.json.truncated, 'boolean');
    assert.equal(typeof res.json.scanned, 'number');
    const paths = res.json.results.map((e: any) => e.path);
    assert.ok(paths.includes(GUIDE_FILE.path), `search must find ${GUIDE_FILE.path} (got ${paths.join(', ')})`);
  });

  test('usage reports byte counts for files and directories', async () => {
    const res = await h.json('GET', fsPath(`/fs/usage?paths=${encodeURIComponent('/docs')}&paths=${encodeURIComponent(HELLO_FILE.path)}`));
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.ok(Array.isArray(res.json.usage));
    const forDocs = res.json.usage.find((u: any) => u.path === '/docs');
    const forHello = res.json.usage.find((u: any) => u.path === HELLO_FILE.path);
    assert.ok(forDocs, `usage must include /docs (got ${JSON.stringify(res.json.usage)})`);
    assert.ok(forHello, 'usage must include /hello.txt');
    assert.ok(forDocs.bytes > 0, 'the docs directory is not empty');
    assert.ok(
      forHello.bytes >= HELLO_FILE.content.length,
      `usage for hello.txt must be at least its size, got ${forHello.bytes}`,
    );
  });

  test('fs:changed events are emitted after mutating routes', async () => {
    const socket = await h.openEventSocket();
    try {
      const dir = `/e2e-events-${Date.now().toString(36)}`;
      const mkdir = await h.json('POST', fsPath('/fs/mkdir'), { path: dir });
      assert.equal(mkdir.status, 201);
      const frame = await socket.waitForFrame(
        (f) =>
          f.type === 'fs:changed' &&
          f.connectionId === connectionId &&
          typeof f.path === 'string' &&
          ['/', dir].includes(String(f.path)),
        { timeoutMs: 5_000, label: 'fs:changed after mkdir' },
      );
      assert.equal(frame.connectionId, connectionId);
      await h.json('POST', fsPath('/fs/delete'), { paths: [dir] });
    } finally {
      await socket.close();
    }
  });
});

describe('mock invariants', () => {
  test('the fixture directory really holds the fixture bytes', async () => {
    // Guards the suite itself: if the mock's fixtures drift, this fails loudly.
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const real = await readFile(join(h.mock.rootDir, 'hello.txt'));
    assert.ok(real.equals(HELLO_FILE.content));
    await waitFor(() => true, { timeoutMs: 100 });
  });
});
