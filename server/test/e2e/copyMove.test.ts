/**
 * §6 `fs/copy` and `fs/move`.
 *
 * The suite runs twice: against a host whose `cp`/`mv` work (one `exec`) and against a host that
 * does not have them (`command not found`), which is what forces the SFTP implementation. Both
 * paths must produce the same result.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { GUIDE_FILE, HELLO_FILE, README_FILE, SYMLINK_TO_FILE } from '../support/fixtures.js';
import { expectErrorEnvelope, startHarness, withHarness, type Harness } from '../support/harness.js';

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

async function entryOf(path: string): Promise<any> {
  const res = await h.json('GET', fsPath(`/fs/stat?path=${encodeURIComponent(path)}`));
  assert.equal(res.status, 200, `stat ${path}: ${res.status} ${res.text.slice(0, 200)}`);
  return res.json.entry;
}

async function exists(path: string): Promise<boolean> {
  const res = await h.json('GET', fsPath(`/fs/stat?path=${encodeURIComponent(path)}`));
  return res.status === 200;
}

async function download(path: string): Promise<Buffer> {
  const res = await h.stream(fsPath(`/fs/download?path=${encodeURIComponent(path)}`));
  assert.equal(res.status, 200, `download ${path}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function removeTree(path: string): Promise<void> {
  await h.json('POST', fsPath('/fs/delete'), { paths: [path], recursive: true });
}

async function uploadFile(remoteDir: string, name: string, body: Buffer): Promise<void> {
  const res = await h.request('POST', fsPath(`/fs/upload?path=${encodeURIComponent(remoteDir)}&name=${name}`), {
    headers: { 'content-type': 'application/octet-stream' },
    body,
  });
  assert.equal(res.status, 200, `upload ${name}: ${res.status} ${res.text.slice(0, 200)}`);
}

/** A small tree: a nested directory, a file with a non-default mode and a nested file. */
async function makeTree(root: string): Promise<void> {
  assert.equal((await h.json('POST', fsPath('/fs/mkdir'), { path: root })).status, 201);
  assert.equal((await h.json('POST', fsPath('/fs/mkdir'), { path: `${root}/sub` })).status, 201);
  await uploadFile(root, 'payload.bin', Buffer.from('payload inside the copied tree\n', 'utf8'));
  await uploadFile(`${root}/sub`, 'nested.txt', HELLO_FILE.content);
  assert.equal((await h.json('POST', fsPath('/fs/chmod'), { path: `${root}/payload.bin`, mode: '640' })).status, 200);
}

describe('fs/copy', () => {
  test('copies one file to a full target path, preserving bytes and mode', async () => {
    const source = '/e2e-copy-source.txt';
    const target = '/e2e-copy-target.txt';
    await removeTree(target);
    await uploadFile('/', 'e2e-copy-source.txt', README_FILE.content);
    assert.equal((await h.json('POST', fsPath('/fs/chmod'), { path: source, mode: '0640' })).status, 200);

    const res = await h.json('POST', fsPath('/fs/copy'), { sources: [source], destination: target });
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.deepEqual(res.json.failed, []);
    assert.equal(res.json.copied.length, 1);
    assert.equal(res.json.copied[0].path, target);
    assert.equal(res.json.copied[0].kind, 'file');
    assert.equal(res.json.copied[0].size, README_FILE.content.length);

    assert.ok((await download(target)).equals(README_FILE.content), 'the bytes must match exactly');
    assert.equal(
      (await entryOf(target)).mode & 0o777,
      0o640,
      'the copy must keep the source mode (§6: "file modes are preserved")',
    );
    assert.ok((await download(source)).equals(README_FILE.content), 'the source stays untouched');

    await removeTree(source);
    await removeTree(target);
  });

  test('copies a directory recursively, with nested files and modes intact', async () => {
    const root = '/e2e-copy-tree';
    const target = '/e2e-copy-tree-out';
    await removeTree(root);
    await removeTree(target);
    await makeTree(root);

    const res = await h.json('POST', fsPath('/fs/copy'), { sources: [root], destination: target });
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.deepEqual(res.json.failed, []);
    assert.equal(res.json.copied[0].kind, 'directory');

    const copiedFile = await entryOf(`${target}/payload.bin`);
    assert.equal(copiedFile.mode & 0o777, 0o640, 'nested modes survive the copy');
    assert.ok((await download(`${target}/payload.bin`)).equals(Buffer.from('payload inside the copied tree\n')));
    assert.equal((await entryOf(`${target}/sub`)).kind, 'directory');
    assert.ok((await download(`${target}/sub/nested.txt`)).equals(HELLO_FILE.content));

    await removeTree(root);
    await removeTree(target);
  });

  test('recreates symlinks instead of following them', async () => {
    // The fixture creates the link on the real filesystem; an unprivileged Windows host may not
    // be able to, in which case there is nothing to assert.
    const before = await h.json('GET', fsPath(`/fs/stat?path=${encodeURIComponent(SYMLINK_TO_FILE.path)}`));
    if (before.status !== 200 || before.json.entry.kind !== 'symlink') return;

    const target = '/e2e-links-copy';
    await removeTree(target);
    const res = await h.json('POST', fsPath('/fs/copy'), { sources: ['/links'], destination: target });
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.deepEqual(res.json.failed, []);

    const copied = await entryOf(`${target}/${SYMLINK_TO_FILE.name}`);
    assert.equal(copied.kind, 'symlink', 'a symlink must be copied as a symlink');
    assert.equal(copied.target, SYMLINK_TO_FILE.target, 'the link target must be preserved');

    await removeTree(target);
  });

  test('copies into an existing directory, keeping each basename', async () => {
    const into = '/e2e-copy-into';
    await removeTree(into);
    assert.equal((await h.json('POST', fsPath('/fs/mkdir'), { path: into })).status, 201);

    const res = await h.json('POST', fsPath('/fs/copy'), {
      sources: [HELLO_FILE.path, GUIDE_FILE.path],
      destination: into,
    });
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.deepEqual(res.json.failed, []);
    assert.deepEqual(
      res.json.copied.map((entry: any) => entry.path).sort(),
      [`${into}/guide.md`, `${into}/hello.txt`],
    );
    assert.ok((await download(`${into}/hello.txt`)).equals(HELLO_FILE.content));
    assert.ok((await download(`${into}/guide.md`)).equals(GUIDE_FILE.content));

    await removeTree(into);
  });

  test('refuses to overwrite when overwrite is false, and replaces when it is true', async () => {
    const source = '/e2e-copy-overwrite-src.txt';
    const target = '/e2e-copy-overwrite-dst.txt';
    const first = Buffer.from('first generation\n', 'utf8');
    const second = Buffer.from('second generation, longer\n', 'utf8');
    await uploadFile('/', 'e2e-copy-overwrite-src.txt', first);
    await uploadFile('/', 'e2e-copy-overwrite-dst.txt', second);

    const refused = await h.json('POST', fsPath('/fs/copy'), { sources: [source], destination: target });
    assert.equal(refused.status, 200);
    assert.deepEqual(refused.json.copied, []);
    assert.equal(refused.json.failed.length, 1);
    assert.equal(refused.json.failed[0].path, source);
    assert.match(refused.json.failed[0].message, /already exists/);
    assert.ok((await download(target)).equals(second), 'the existing file must be untouched');

    const replaced = await h.json('POST', fsPath('/fs/copy'), {
      sources: [source],
      destination: target,
      overwrite: true,
    });
    assert.equal(replaced.status, 200, replaced.text.slice(0, 300));
    assert.deepEqual(replaced.json.failed, []);
    assert.ok((await download(target)).equals(first), 'overwrite must replace the content');

    await removeTree(source);
    await removeTree(target);
  });

  test('reports a missing source in failed[] without aborting the batch', async () => {
    const into = '/e2e-copy-missing';
    await removeTree(into);
    assert.equal((await h.json('POST', fsPath('/fs/mkdir'), { path: into })).status, 201);

    const res = await h.json('POST', fsPath('/fs/copy'), {
      sources: ['/definitely-not-here.txt', HELLO_FILE.path],
      destination: into,
    });
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.equal(res.json.failed.length, 1);
    assert.equal(res.json.failed[0].path, '/definitely-not-here.txt');
    assert.match(res.json.failed[0].message, /No such file|not exist/i);
    assert.equal(res.json.copied.length, 1, 'the healthy source must still be copied');
    assert.ok((await download(`${into}/hello.txt`)).equals(HELLO_FILE.content));

    await removeTree(into);
  });

  test('refuses to copy a directory into itself or its own subtree', async () => {
    const root = '/e2e-copy-self';
    await removeTree(root);
    assert.equal((await h.json('POST', fsPath('/fs/mkdir'), { path: root })).status, 201);
    assert.equal((await h.json('POST', fsPath('/fs/mkdir'), { path: `${root}/inner` })).status, 201);

    for (const destination of [root, `${root}/inner`, `${root}/inner/deeper`]) {
      const res = await h.json('POST', fsPath('/fs/copy'), { sources: [root], destination });
      assert.equal(res.status, 400, `copying ${root} into ${destination} must be refused`);
      const error = expectErrorEnvelope(res);
      assert.equal(error.code, 'BAD_REQUEST');
      assert.match(error.message, /subtree|same path/);
    }

    assert.equal((await entryOf(root)).kind, 'directory', 'a refused copy must change nothing');
    await removeTree(root);
  });

  test('rejects a NUL byte in a path', async () => {
    const res = await h.json('POST', fsPath('/fs/copy'), {
      sources: ['/a\u0000b'],
      destination: '/',
    });
    assert.equal(res.status, 400, res.text.slice(0, 200));
    assert.equal(expectErrorEnvelope(res).code, 'BAD_REQUEST');
  });

  test('requires a directory destination for several sources', async () => {
    const res = await h.json('POST', fsPath('/fs/copy'), {
      sources: [HELLO_FILE.path, GUIDE_FILE.path],
      destination: '/no-such-directory-e2e',
    });
    assert.equal(res.status, 400, res.text.slice(0, 200));
    assert.equal(expectErrorEnvelope(res).code, 'BAD_REQUEST');
  });
});

describe('fs/move', () => {
  test('moves a file (rename inside one filesystem) and removes the source', async () => {
    const source = '/e2e-move-src.txt';
    const target = '/e2e-move-dst.txt';
    await removeTree(target);
    await uploadFile('/', 'e2e-move-src.txt', README_FILE.content);

    const res = await h.json('POST', fsPath('/fs/move'), { sources: [source], destination: target });
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.deepEqual(res.json.failed, []);
    assert.equal(res.json.copied[0].path, target);
    assert.ok((await download(target)).equals(README_FILE.content));
    assert.equal(await exists(source), false, 'the source must be gone after a move');

    await removeTree(target);
  });

  test('moves a directory with its contents', async () => {
    const root = '/e2e-move-tree';
    const target = '/e2e-move-tree-out';
    await removeTree(root);
    await removeTree(target);
    await makeTree(root);

    const res = await h.json('POST', fsPath('/fs/move'), { sources: [root], destination: target });
    assert.equal(res.status, 200, res.text.slice(0, 300));
    assert.deepEqual(res.json.failed, []);
    assert.equal((await entryOf(`${target}/payload.bin`)).kind, 'file');
    assert.ok((await download(`${target}/sub/nested.txt`)).equals(HELLO_FILE.content));
    assert.equal(await exists(root), false);

    await removeTree(target);
  });

  test('refuses to move a directory into its own subtree', async () => {
    const root = '/e2e-move-self';
    await removeTree(root);
    assert.equal((await h.json('POST', fsPath('/fs/mkdir'), { path: root })).status, 201);
    assert.equal((await h.json('POST', fsPath('/fs/mkdir'), { path: `${root}/inner` })).status, 201);

    const res = await h.json('POST', fsPath('/fs/move'), { sources: [root], destination: `${root}/inner` });
    assert.equal(res.status, 400, res.text.slice(0, 200));
    assert.equal(expectErrorEnvelope(res).code, 'BAD_REQUEST');
    assert.equal((await entryOf(root)).kind, 'directory', 'the refused move must change nothing');
    await removeTree(root);
  });

  test('replaces an existing target when overwrite is true', async () => {
    const source = '/e2e-move-over-src.txt';
    const target = '/e2e-move-over-dst.txt';
    await uploadFile('/', 'e2e-move-over-src.txt', Buffer.from('new\n', 'utf8'));
    await uploadFile('/', 'e2e-move-over-dst.txt', Buffer.from('old and longer\n', 'utf8'));

    const refused = await h.json('POST', fsPath('/fs/move'), { sources: [source], destination: target });
    assert.equal(refused.status, 200);
    assert.equal(refused.json.failed.length, 1);
    assert.equal(await exists(source), true, 'a refused move keeps the source');

    const moved = await h.json('POST', fsPath('/fs/move'), {
      sources: [source],
      destination: target,
      overwrite: true,
    });
    assert.equal(moved.status, 200, moved.text.slice(0, 300));
    assert.deepEqual(moved.json.failed, []);
    assert.ok((await download(target)).equals(Buffer.from('new\n')));
    assert.equal(await exists(source), false);

    await removeTree(target);
  });

  test('emits fs:changed for the destination and for the vacated source directory', async () => {
    const dir = '/e2e-move-events';
    await removeTree(dir);
    assert.equal((await h.json('POST', fsPath('/fs/mkdir'), { path: dir })).status, 201);
    await uploadFile(dir, 'moving.txt', Buffer.from('move me\n', 'utf8'));

    const socket = await h.openEventSocket();
    try {
      const res = await h.json('POST', fsPath('/fs/move'), {
        sources: [`${dir}/moving.txt`],
        destination: '/e2e-move-events-dst.txt',
      });
      assert.equal(res.status, 200, res.text.slice(0, 300));
      await socket.waitForFrame(
        (frame) => frame.type === 'fs:changed' && frame.connectionId === connectionId && frame.path === dir,
        { timeoutMs: 5_000, label: 'fs:changed for the vacated source directory' },
      );
      await socket.waitForFrame(
        (frame) =>
          frame.type === 'fs:changed' && frame.connectionId === connectionId && frame.path === '/',
        { timeoutMs: 5_000, label: 'fs:changed for the destination directory' },
      );
    } finally {
      await socket.close();
      await removeTree(dir);
      await removeTree('/e2e-move-events-dst.txt');
    }
  });
});

describe('the SFTP fallback (no cp/mv on the host)', () => {
  test('copy and move behave identically when the tools are missing', async () => {
    await withHarness({ mock: { missingCommands: ['cp', 'mv'] } }, async (restricted) => {
      const trusted = await restricted.connectTrusting();
      const id = trusted.id;
      const base = (suffix: string): string => `/api/connections/${id}${suffix}`;

      const root = '/no-tools-tree';
      const copyTarget = '/no-tools-tree-copy';
      assert.equal((await restricted.json('POST', base('/fs/mkdir'), { path: root })).status, 201);
      const upload = await restricted.request(
        'POST',
        base(`/fs/upload?path=${encodeURIComponent(root)}&name=nested.txt`),
        { headers: { 'content-type': 'application/octet-stream' }, body: HELLO_FILE.content },
      );
      assert.equal(upload.status, 200, upload.text.slice(0, 200));
      assert.equal(
        (await restricted.json('POST', base('/fs/chmod'), { path: `${root}/nested.txt`, mode: '600' })).status,
        200,
      );

      const copy = await restricted.json('POST', base('/fs/copy'), {
        sources: [root],
        destination: copyTarget,
      });
      assert.equal(copy.status, 200, copy.text.slice(0, 300));
      assert.deepEqual(copy.json.failed, [], 'the SFTP copy must succeed without cp');

      const copied = await restricted.json(
        'GET',
        base(`/fs/stat?path=${encodeURIComponent(`${copyTarget}/nested.txt`)}`),
      );
      assert.equal(copied.status, 200, copied.text.slice(0, 200));
      assert.equal(copied.json.entry.size, HELLO_FILE.content.length);
      assert.equal(copied.json.entry.mode & 0o777, 0o600, 'the SFTP copy preserves modes');

      const download = await restricted.stream(
        base(`/fs/download?path=${encodeURIComponent(`${copyTarget}/nested.txt`)}`),
      );
      assert.equal(download.status, 200);
      assert.ok(Buffer.from(await download.arrayBuffer()).equals(HELLO_FILE.content));

      const move = await restricted.json('POST', base('/fs/move'), {
        sources: [copyTarget],
        destination: '/no-tools-tree-moved',
      });
      assert.equal(move.status, 200, move.text.slice(0, 300));
      assert.deepEqual(move.json.failed, [], 'the SFTP move (copy + delete) must succeed');
      const gone = await restricted.json('GET', base(`/fs/stat?path=${encodeURIComponent(copyTarget)}`));
      assert.ok(gone.status >= 400, 'the moved directory must be gone');

      // The self-subtree guard is shared by both implementations.
      const intoItself = await restricted.json('POST', base('/fs/copy'), {
        sources: ['/no-tools-tree-moved'],
        destination: '/no-tools-tree-moved/sub',
      });
      assert.equal(intoItself.status, 400);
    });
  });
});
