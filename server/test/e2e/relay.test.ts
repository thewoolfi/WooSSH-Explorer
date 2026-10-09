/**
 * §7 `POST /api/transfers/relay` — a copy that goes from one SSH connection straight to another
 * without the bytes passing through the client.
 *
 * Two mock SSH servers are used so the relay really is server-to-server, and the batch runs in
 * the background behind a `202`, so every assertion polls a bounded condition.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { HELLO_FILE, README_FILE } from '../support/fixtures.js';
import { expectErrorEnvelope, withHarness, waitFor, type Harness } from '../support/harness.js';
import { startMockSshServer, type MockSshServer } from '../support/mockSshServer.js';

/** Connects to a mock, doing the host-key trust dance when it is a fresh server. */
async function connectTo(h: Harness, mock: MockSshServer, label: string): Promise<string> {
  const body = {
    label,
    host: mock.host,
    port: mock.port,
    username: mock.username,
    auth: { method: 'password', password: mock.password },
  };
  const first = await h.json('POST', '/api/connections', body);
  if (first.status === 201) return first.json.connection.id;
  assert.equal(first.status, 409, `unexpected first contact: ${first.status} ${first.text.slice(0, 200)}`);
  assert.equal(first.error?.code, 'HOST_KEY_UNKNOWN');
  const fingerprint = (first.error?.details as Record<string, unknown> | undefined)?.['fingerprint'];
  const second = await h.json('POST', '/api/connections', {
    ...body,
    trustHostKey: true,
    hostKeyFingerprint: fingerprint,
  });
  assert.equal(second.status, 201, `trusted dial failed: ${second.status} ${second.text.slice(0, 300)}`);
  return second.json.connection.id;
}

async function waitForTransfer(
  h: Harness,
  connectionId: string,
  transferId: string,
  states: string[],
  timeoutMs = 10_000,
): Promise<any> {
  return waitFor(
    async () => {
      const res = await h.json('GET', `/api/connections/${connectionId}/transfers`);
      const transfer = res.json.transfers.find((item: any) => item.id === transferId);
      return transfer && states.includes(transfer.state) ? transfer : null;
    },
    { timeoutMs, label: `transfer ${transferId} to reach ${states.join('/')}` },
  );
}

describe('relayed transfers', () => {
  test('copies a file from one connection to another, sharing one batchId', async () => {
    await withHarness({}, async (h) => {
      const second = await startMockSshServer();
      try {
        const sourceId = (await h.connectTrusting({ label: 'relay-source' })).id;
        const targetId = await connectTo(h, second, 'relay-target');

        const payload = Buffer.concat([README_FILE.content, HELLO_FILE.content]);
        const upload = await h.request(
          'POST',
          `/api/connections/${sourceId}/fs/upload?path=%2F&name=relay-payload.bin`,
          { headers: { 'content-type': 'application/octet-stream' }, body: payload },
        );
        assert.equal(upload.status, 200, upload.text.slice(0, 200));

        const mkdir = await h.json('POST', `/api/connections/${targetId}/fs/mkdir`, { path: '/incoming' });
        assert.equal(mkdir.status, 201, mkdir.text.slice(0, 200));

        const events = await h.openEventSocket();
        try {
          const res = await h.json('POST', '/api/transfers/relay', {
            sourceConnectionId: sourceId,
            paths: ['/relay-payload.bin'],
            targetConnectionId: targetId,
            targetDir: '/incoming',
          });
          assert.equal(res.status, 202, res.text.slice(0, 300));
          assert.equal(typeof res.json.batchId, 'string');
          assert.equal(res.json.transfers.length, 1);

          const transfer = res.json.transfers[0];
          assert.equal(transfer.direction, 'relay');
          assert.equal(transfer.batchId, res.json.batchId);
          assert.equal(transfer.name, 'relay-payload.bin');
          assert.equal(transfer.size, payload.length);
          assert.equal(transfer.localPath, null);
          // §7: only downloads are resumable.
          assert.equal(transfer.resumable, false);
          assert.equal(transfer.resumedFrom, 0);
          assert.equal(transfer.connectionId, targetId, 'the transfer belongs to the connection it is written to');

          const done = await waitForTransfer(h, targetId, transfer.id, ['done']);
          assert.equal(done.transferred, payload.length, 'combined progress is reported from the read side');
          assert.ok(done.bytesPerSecond >= 0);

          // Progress events keep working for relays (§8).
          await events.waitForFrame(
            (frame) =>
              frame.type === 'transfer:update' &&
              (frame.transfer as any)?.id === transfer.id &&
              (frame.transfer as any)?.direction === 'relay',
            { timeoutMs: 5_000, label: 'a transfer:update frame for the relay' },
          );

          // The bytes really landed on the *target* host.
          const download = await h.stream(
            `/api/connections/${targetId}/fs/download?path=${encodeURIComponent('/incoming/relay-payload.bin')}`,
          );
          assert.equal(download.status, 200, `target download failed: ${download.status}`);
          assert.ok(Buffer.from(await download.arrayBuffer()).equals(payload), 'the relayed bytes must match');

          // The source is untouched.
          const sourceStill = await h.json(
            'GET',
            `/api/connections/${sourceId}/fs/stat?path=${encodeURIComponent('/relay-payload.bin')}`,
          );
          assert.equal(sourceStill.status, 200);
        } finally {
          await events.close();
        }
      } finally {
        await second.close();
      }
    });
  });

  test('a taken name is reported up front and does not stop the rest of the batch', async () => {
    await withHarness({}, async (h) => {
      const second = await startMockSshServer();
      try {
        const sourceId = (await h.connectTrusting({ label: 'relay-batch-source' })).id;
        const targetId = await connectTo(h, second, 'relay-batch-target');

        for (const [name, body] of [
          ['batch-a.txt', Buffer.from('first file\n', 'utf8')],
          ['batch-b.txt', Buffer.from('second file\n', 'utf8')],
        ] as [string, Buffer][]) {
          const upload = await h.request(
            'POST',
            `/api/connections/${sourceId}/fs/upload?path=%2F&name=${name}`,
            { headers: { 'content-type': 'application/octet-stream' }, body },
          );
          assert.equal(upload.status, 200, upload.text.slice(0, 200));
        }

        assert.equal((await h.json('POST', `/api/connections/${targetId}/fs/mkdir`, { path: '/incoming' })).status, 201);
        const upload = await h.request(
          'POST',
          `/api/connections/${targetId}/fs/upload?path=%2Fincoming&name=batch-a.txt`,
          { headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from('already here\n', 'utf8') },
        );
        assert.equal(upload.status, 200, upload.text.slice(0, 200));

        const res = await h.json('POST', '/api/transfers/relay', {
          sourceConnectionId: sourceId,
          paths: ['/batch-a.txt', '/batch-b.txt'],
          targetConnectionId: targetId,
          targetDir: '/incoming',
          overwrite: false,
        });
        assert.equal(res.status, 202, res.text.slice(0, 300));
        // §7: the taken name is named in `conflicts` and never started — the client asks the
        // user, exactly like it does for `fs/copy`. The other path still runs, so one refusal
        // does not abort the batch.
        assert.deepEqual(res.json.conflicts, [
          { sourcePath: '/batch-a.txt', targetPath: '/incoming/batch-a.txt' },
        ]);
        assert.equal(res.json.transfers.length, 1);

        const ok = await waitForTransfer(h, targetId, res.json.transfers[0].id, ['done']);
        assert.equal(ok.transferred, Buffer.byteLength('second file\n'));

        const download = await h.stream(
          `/api/connections/${targetId}/fs/download?path=${encodeURIComponent('/incoming/batch-b.txt')}`,
        );
        assert.equal(download.status, 200);
        assert.ok(Buffer.from(await download.arrayBuffer()).equals(Buffer.from('second file\n')));

        // The pre-existing file was not replaced.
        const untouched = await h.stream(
          `/api/connections/${targetId}/fs/download?path=${encodeURIComponent('/incoming/batch-a.txt')}`,
        );
        assert.ok(Buffer.from(await readBody(untouched)).equals(Buffer.from('already here\n')));

        // Answering "overwrite" re-issues just that path and replaces it.
        const retry = await h.json('POST', '/api/transfers/relay', {
          sourceConnectionId: sourceId,
          paths: ['/batch-a.txt'],
          targetConnectionId: targetId,
          targetDir: '/incoming',
          overwrite: true,
        });
        assert.equal(retry.status, 202, retry.text.slice(0, 300));
        assert.deepEqual(retry.json.conflicts, []);
        await waitForTransfer(h, targetId, retry.json.transfers[0].id, ['done']);

        const replaced = await h.stream(
          `/api/connections/${targetId}/fs/download?path=${encodeURIComponent('/incoming/batch-a.txt')}`,
        );
        assert.ok(Buffer.from(await readBody(replaced)).equals(Buffer.from('first file\n')));
      } finally {
        await second.close();
      }
    });
  });

  test('relays a whole directory tree as a single transfer', async () => {
    await withHarness({}, async (h) => {
      const second = await startMockSshServer();
      try {
        const sourceId = (await h.connectTrusting({ label: 'relay-tree-source' })).id;
        const targetId = await connectTo(h, second, 'relay-tree-target');

        // A small project: two levels, a file at each, plus a nested empty directory.
        const files: [string, string][] = [
          ['/project/readme.md', '# project\n'],
          ['/project/src/main.ts', 'export const main = 1;\n'],
          ['/project/src/lib/helper.ts', 'export const helper = 2;\n'],
        ];
        for (const [path, body] of files) {
          const dir = path.slice(0, path.lastIndexOf('/'));
          const mkdir = await h.json('POST', `/api/connections/${sourceId}/fs/mkdir`, { path: dir });
          assert.ok([201, 409].includes(mkdir.status), `mkdir ${dir}: ${mkdir.status}`);
          const upload = await h.request(
            'POST',
            `/api/connections/${sourceId}/fs/upload?path=${encodeURIComponent(dir)}&name=${path.slice(dir.length + 1)}`,
            { headers: { 'content-type': 'application/octet-stream' }, body: Buffer.from(body, 'utf8') },
          );
          assert.equal(upload.status, 200, upload.text.slice(0, 200));
        }

        assert.equal((await h.json('POST', `/api/connections/${targetId}/fs/mkdir`, { path: '/incoming' })).status, 201);

        const res = await h.json('POST', '/api/transfers/relay', {
          sourceConnectionId: sourceId,
          paths: ['/project'],
          targetConnectionId: targetId,
          targetDir: '/incoming',
        });
        assert.equal(res.status, 202, res.text.slice(0, 300));
        // One row for the whole tree, sized as the sum of its files — not one row per file.
        assert.equal(res.json.transfers.length, 1);
        const expectedBytes = files.reduce((sum, [, body]) => sum + Buffer.byteLength(body), 0);
        assert.equal(res.json.transfers[0].size, expectedBytes);
        assert.equal(res.json.transfers[0].name, 'project');

        const done = await waitForTransfer(h, targetId, res.json.transfers[0].id, ['done'], 20_000);
        assert.equal(done.transferred, expectedBytes);

        // Every file arrived, at the same relative path, with the same bytes.
        for (const [path, body] of files) {
          const download = await h.stream(
            `/api/connections/${targetId}/fs/download?path=${encodeURIComponent(path.replace('/project', '/incoming/project'))}`,
          );
          assert.equal(download.status, 200, `${path} missing on the target`);
          assert.ok(Buffer.from(await download.arrayBuffer()).equals(Buffer.from(body)), `${path} differs`);
        }

        // The intermediate directory exists even though it holds no files of its own.
        const listing = await h.json('GET', `/api/connections/${targetId}/fs/list?path=${encodeURIComponent('/incoming/project/src/lib')}`);
        assert.equal(listing.status, 200, listing.text.slice(0, 200));
        assert.deepEqual(
          listing.json.listing.entries.map((entry: any) => entry.name),
          ['helper.ts'],
        );
      } finally {
        await second.close();
      }
    });
  });

  test('replaces an existing target when overwrite is true', async () => {
    await withHarness({}, async (h) => {
      const second = await startMockSshServer();
      try {
        const sourceId = (await h.connectTrusting({ label: 'relay-over-source' })).id;
        const targetId = await connectTo(h, second, 'relay-over-target');

        assert.equal((await h.json('POST', `/api/connections/${targetId}/fs/mkdir`, { path: '/incoming' })).status, 201);
        for (const [connection, name, body] of [
          [sourceId, 'over.txt', Buffer.from('fresh\n', 'utf8')],
          [targetId, 'over.txt', Buffer.from('stale and longer\n', 'utf8')],
        ] as [string, string, Buffer][]) {
          const upload = await h.request(
            'POST',
            `/api/connections/${connection}/fs/upload?path=${encodeURIComponent(connection === sourceId ? '/' : '/incoming')}&name=${name}`,
            { headers: { 'content-type': 'application/octet-stream' }, body },
          );
          assert.equal(upload.status, 200, upload.text.slice(0, 200));
        }

        const res = await h.json('POST', '/api/transfers/relay', {
          sourceConnectionId: sourceId,
          paths: ['/over.txt'],
          targetConnectionId: targetId,
          targetDir: '/incoming',
          overwrite: true,
        });
        assert.equal(res.status, 202, res.text.slice(0, 200));
        await waitForTransfer(h, targetId, res.json.transfers[0].id, ['done']);

        const download = await h.stream(
          `/api/connections/${targetId}/fs/download?path=${encodeURIComponent('/incoming/over.txt')}`,
        );
        assert.ok(Buffer.from(await download.arrayBuffer()).equals(Buffer.from('fresh\n')));
      } finally {
        await second.close();
      }
    });
  });

  test('rejects a directory source and an unknown target directory', async () => {
    await withHarness({}, async (h) => {
      const sourceId = (await h.connectTrusting({ label: 'relay-reject' })).id;

      const directory = await h.json('POST', '/api/transfers/relay', {
        sourceConnectionId: sourceId,
        paths: ['/docs'],
        targetConnectionId: sourceId,
        targetDir: '/',
      });
      assert.equal(directory.status, 400, directory.text.slice(0, 200));
      assert.equal(expectErrorEnvelope(directory).code, 'BAD_REQUEST');

      const missingDir = await h.json('POST', '/api/transfers/relay', {
        sourceConnectionId: sourceId,
        paths: [HELLO_FILE.path],
        targetConnectionId: sourceId,
        targetDir: '/not-a-directory-e2e',
      });
      assert.equal(missingDir.status, 400, missingDir.text.slice(0, 200));
      assert.equal(expectErrorEnvelope(missingDir).code, 'BAD_REQUEST');

      const unknownConnection = await h.json('POST', '/api/transfers/relay', {
        sourceConnectionId: 'nope',
        paths: [HELLO_FILE.path],
        targetConnectionId: sourceId,
        targetDir: '/',
      });
      assert.equal(unknownConnection.status, 404);
      assert.equal(expectErrorEnvelope(unknownConnection).code, 'NOT_FOUND');

      const missingSource = await h.json('POST', '/api/transfers/relay', {
        sourceConnectionId: sourceId,
        paths: ['/definitely-not-here.bin'],
        targetConnectionId: sourceId,
        targetDir: '/',
      });
      assert.ok(missingSource.status >= 400, 'a missing source path is refused before any transfer starts');
      expectErrorEnvelope(missingSource);
    });
  });
});

/** Reads a raw download response into a buffer. */
async function readBody(response: Response): Promise<Buffer> {
  assert.equal(response.status, 200, `unexpected status ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}
