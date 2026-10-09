/**
 * §7 Transfers, §6 download/upload routes, §8 events, §11.6/§11.7/§11.10 —
 * byte-exact round trips, progress events, ZIP batches, cancellation and
 * connection teardown.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';

import { BIG_FILE, BIG_FILE_SIZE, HELLO_FILE, README_FILE, GUIDE_FILE, DEEP_FILE } from '../support/fixtures.js';
import {
  expectErrorEnvelope,
  startHarness,
  waitFor,
  withHarness,
  WsClient,
  type Harness,
  type WsClient as WsClientType,
} from '../support/harness.js';
import { entryContent, parseZip } from '../support/zip.js';

/** Deterministic pseudo-random payload: a partially written file cannot compare equal. */
function payload(size: number, seed = 0x9e3779b9): Buffer {
  const buffer = Buffer.allocUnsafe(size);
  let state = seed >>> 0;
  for (let i = 0; i < size; i += 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    buffer[i] = (state >>> 16) & 0xff;
  }
  return buffer;
}

let h!: Harness;
let connectionId!: string;
let events!: WsClientType;

before(async () => {
  h = await startHarness();
  const trusted = await h.connectTrusting();
  connectionId = trusted.id;
  events = await h.openEventSocket();
});

after(async () => {
  await events?.close();
  await h?.close();
});

const fsPath = (suffix: string): string => `/api/connections/${connectionId}${suffix}`;

async function transfersFor(connection: string): Promise<any[]> {
  const res = await h.json('GET', `/api/connections/${connection}/transfers`);
  assert.equal(res.status, 200, res.text.slice(0, 200));
  return res.json.transfers;
}

describe('upload/download round trip', () => {
  test('the same bytes survive upload → download, with active/done progress events', async () => {
    const remoteDir = `/e2e-transfer-${Date.now().toString(36)}`;
    const name = 'round-trip.bin';
    const bytes = payload(2 * 1024 * 1024);
    const remotePath = `${remoteDir}/${name}`;

    assert.equal((await h.json('POST', fsPath('/fs/mkdir'), { path: remoteDir })).status, 201);

    const upload = await h.request('POST', fsPath(`/fs/upload?path=${encodeURIComponent(remoteDir)}&name=${name}`), {
      headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length) },
      body: bytes,
      timeoutMs: 30_000,
    });
    assert.equal(upload.status, 200, `upload failed: ${upload.status} ${upload.text.slice(0, 300)}`);
    const uploadTransfer = upload.json.transfer;
    assert.equal(uploadTransfer.direction, 'upload');
    assert.equal(uploadTransfer.name, name);
    assert.equal(uploadTransfer.state, 'done', 'the upload response must report a finished transfer');
    assert.equal(uploadTransfer.transferred, bytes.length);
    assert.equal(uploadTransfer.size, bytes.length);
    assert.equal(typeof uploadTransfer.id, 'string');

    // The bytes really landed on the remote filesystem.
    const stat = await h.json('GET', fsPath(`/fs/stat?path=${encodeURIComponent(remotePath)}`));
    assert.equal(stat.status, 200, stat.text.slice(0, 200));
    assert.equal(stat.json.entry.size, bytes.length);

    // Download it back and compare bytes.
    const download = await h.stream(fsPath(`/fs/download?path=${encodeURIComponent(remotePath)}`), {
      timeoutMs: 30_000,
    });
    assert.equal(download.status, 200, `download failed: ${download.status}`);
    assert.equal(download.headers.get('content-type'), 'application/octet-stream');
    const disposition = download.headers.get('content-disposition') ?? '';
    assert.match(disposition, /attachment/, `Content-Disposition must be an attachment (got ${disposition})`);
    assert.ok(
      disposition.includes(encodeURIComponent(name)) || disposition.includes(name),
      `Content-Disposition must carry the filename (got ${disposition})`,
    );
    assert.equal(download.headers.get('content-length'), String(bytes.length));

    const downloaded = Buffer.from(await download.arrayBuffer());
    assert.ok(downloaded.equals(bytes), `downloaded ${downloaded.length} bytes != uploaded ${bytes.length}`);

    // §11.6: at least one transfer:update with state "active" and one with "done".
    const uploadActive = await events.waitForFrame(
      (f) =>
        f.type === 'transfer:update' &&
        (f.transfer as any)?.id === uploadTransfer.id &&
        (f.transfer as any)?.state === 'active',
      { timeoutMs: 5_000, label: 'transfer:update active for the upload' },
    );
    assert.equal((uploadActive.transfer as any).state, 'active');

    // Progress must be observable: some active/done frame reports transferred > 0.
    const progressFrames = events.frames.filter(
      (f) => f.type === 'transfer:update' && (f.transfer as any)?.id === uploadTransfer.id,
    );
    assert.ok(
      progressFrames.some((f) => Number((f.transfer as any).transferred) > 0),
      `progress events must report transferred bytes (got ${JSON.stringify(
        progressFrames.map((f) => `${(f.transfer as any).state}:${(f.transfer as any).transferred}`),
      )})`,
    );

    await events.waitForFrame(
      (f) =>
        f.type === 'transfer:update' &&
        (f.transfer as any)?.id === uploadTransfer.id &&
        (f.transfer as any)?.state === 'done',
      { timeoutMs: 5_000, label: 'transfer:update done for the upload' },
    );

    const listed = await transfersFor(connectionId);
    assert.ok(
      listed.some((t: any) => t.id === uploadTransfer.id && t.direction === 'upload'),
      'GET /api/connections/:id/transfers must list the upload',
    );

    // The download registered its own transfer with a local path (§2).
    const downloadTransfer = await waitFor(
      async () => {
        const all = await transfersFor(connectionId);
        return all.find((t: any) => t.direction === 'download' && t.remotePath === remotePath) ?? null;
      },
      { timeoutMs: 5_000, label: 'the download transfer to be registered' },
    );
    assert.equal(downloadTransfer.size, bytes.length);
    assert.equal(downloadTransfer.transferred, bytes.length);
    assert.equal(downloadTransfer.state, 'done');
    assert.ok(
      downloadTransfer.localPath === null || typeof downloadTransfer.localPath === 'string',
      'localPath must be a string or null',
    );

    // §11.6 progress events for the download too.
    await events.waitForFrame(
      (f) =>
        f.type === 'transfer:update' &&
        (f.transfer as any)?.id === downloadTransfer.id &&
        (f.transfer as any)?.state === 'active',
      { timeoutMs: 5_000, label: 'transfer:update active for the download' },
    );

    // Uploading over an existing name overwrites it (§6).
    const overwrite = payload(4096, 0x12345678);
    const second = await h.request('POST', fsPath(`/fs/upload?path=${encodeURIComponent(remoteDir)}&name=${name}`), {
      headers: { 'content-type': 'application/octet-stream' },
      body: overwrite,
    });
    assert.equal(second.status, 200, second.text.slice(0, 200));
    const restat = await h.json('GET', fsPath(`/fs/stat?path=${encodeURIComponent(remotePath)}`));
    assert.equal(restat.json.entry.size, overwrite.length, 'the upload must overwrite the existing file');

    const cleanup = await h.json('POST', fsPath('/fs/delete'), { paths: [remoteDir], recursive: true });
    assert.equal(cleanup.status, 200);
    assert.deepEqual(cleanup.json.failed, []);
  });
});

describe('batch download', () => {
  test('download-batch returns a valid ZIP with the requested files', async () => {
    const res = await h.stream(fsPath('/fs/download-batch'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ paths: [HELLO_FILE.path, GUIDE_FILE.path, '/docs'], name: 'e2e-batch.zip' }),
      timeoutMs: 30_000,
    });
    const archive = Buffer.from(await res.arrayBuffer());
    assert.equal(
      res.status,
      200,
      `download-batch failed: ${res.status} ${archive.subarray(0, 200).toString('utf8')}`,
    );
    assert.match(res.headers.get('content-type') ?? '', /application\/zip/);

    const entries = parseZip(archive);
    assert.ok(entries.length > 0, 'the ZIP must not be empty');

    const hello = entryContent(entries, HELLO_FILE.path);
    assert.ok(hello, `hello.txt must be in the ZIP (entries: ${entries.map((e) => e.name).join(', ')})`);
    assert.ok(hello!.equals(HELLO_FILE.content), 'hello.txt content must match byte for byte');

    const guide = entryContent(entries, GUIDE_FILE.path);
    assert.ok(guide, `guide.md must be in the ZIP (entries: ${entries.map((e) => e.name).join(', ')})`);
    assert.ok(guide!.equals(GUIDE_FILE.content));

    // Directories are zipped recursively (§6).
    const deep = entryContent(entries, DEEP_FILE.path);
    assert.ok(deep, `the directory argument must be zipped recursively (entries: ${entries.map((e) => e.name).join(', ')})`);
    assert.ok(deep!.equals(DEEP_FILE.content));

    // One download transfer per file, sharing a batchId (§6/§2).
    const batch = await waitFor(
      async () => {
        const all = await transfersFor(connectionId);
        const zip = all.filter((t: any) => t.batchId && t.name === 'hello.txt');
        return zip.length > 0 ? zip : null;
      },
      { timeoutMs: 5_000, label: 'batch download transfers' },
    );
    const batchIds = new Set(batch.map((t: any) => t.batchId));
    assert.equal(batchIds.size, 1, 'batch transfers must share one batchId');
    assert.ok(
      batch.every((t: any) => t.direction === 'download'),
      'batch transfers are downloads',
    );
  });

  test('an empty paths array is rejected', async () => {
    const res = await h.json('POST', fsPath('/fs/download-batch'), { paths: [] });
    assert.ok(res.status >= 400, `expected a 4xx for an empty batch, got ${res.status}`);
    expectErrorEnvelope(res);
  });
});

describe('cancellation', () => {
  test('cancelling an active transfer moves it to cancelled and stops the bytes', async () => {
    const response = await h.stream(fsPath(`/fs/download?path=${encodeURIComponent(BIG_FILE.path)}`), {
      timeoutMs: 60_000,
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-length'), String(BIG_FILE_SIZE));

    const active = await waitFor(
      async () => {
        const all = await transfersFor(connectionId);
        const transfer = all.find((t: any) => t.direction === 'download' && t.remotePath === BIG_FILE.path && t.state !== 'done');
        return transfer && transfer.state === 'active' ? transfer : null;
      },
      { timeoutMs: 10_000, label: 'the big download to become active' },
    );

    const cancelled = await h.json('DELETE', `/api/transfers/${active.id}`);
    assert.equal(cancelled.status, 200, `cancel failed: ${cancelled.status} ${cancelled.text.slice(0, 200)}`);
    assert.equal(cancelled.json.transfer.state, 'cancelled');
    assert.equal(cancelled.json.transfer.id, active.id);

    await events.waitForFrame(
      (f) =>
        f.type === 'transfer:update' && (f.transfer as any)?.id === active.id && (f.transfer as any)?.state === 'cancelled',
      { timeoutMs: 5_000, label: 'transfer:update cancelled' },
    );

    // The byte flow stops: progress must freeze.
    const first = (await transfersFor(connectionId)).find((t: any) => t.id === active.id);
    await new Promise((resolve) => setTimeout(resolve, 400));
    const second = (await transfersFor(connectionId)).find((t: any) => t.id === active.id);
    assert.equal(second.transferred, first.transferred, 'a cancelled transfer must not keep transferring');
    assert.ok(second.transferred < BIG_FILE_SIZE, 'the transfer was cancelled before completing');

    // The HTTP stream must terminate (end or error) rather than hang.
    const reader = response.body?.getReader();
    let received = 0;
    let stopped = false;
    const pump = (async () => {
      try {
        for (;;) {
          const chunk = await reader!.read();
          if (chunk.done) {
            stopped = true;
            return;
          }
          received += chunk.value?.length ?? 0;
        }
      } catch {
        stopped = true; // the server destroyed the stream — the byte flow stopped
      }
    })();
    const guard = new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        reader?.cancel().catch(() => {});
        resolve();
      }, 10_000);
      timer.unref?.();
    });
    await Promise.race([pump, guard]);
    assert.ok(stopped, 'the download stream must end or error once cancelled (§11.7: the byte flow stops)');
    assert.ok(received < BIG_FILE_SIZE, `only ${received} of ${BIG_FILE_SIZE} bytes may arrive`);

    // A cancelled transfer can be retried (§7).
    const retry = await h.json('POST', `/api/transfers/${active.id}/retry`);
    assert.equal(retry.status, 200, `retry failed: ${retry.status} ${retry.text.slice(0, 200)}`);
    assert.equal(retry.json.transfer.id, active.id);
    const afterRetry = await waitFor(
      async () => {
        const t = (await transfersFor(connectionId)).find((x: any) => x.id === active.id);
        return t && ['queued', 'active', 'done', 'cancelled', 'error'].includes(t.state) ? t : null;
      },
      { timeoutMs: 5_000, label: 'the retried transfer to be listed' },
    );
    if (afterRetry.state === 'active' || afterRetry.state === 'queued') {
      const cancelAgain = await h.json('DELETE', `/api/transfers/${active.id}`);
      assert.equal(cancelAgain.status, 200);
    }
  });

  test('DELETE /api/transfers clears finished transfers', async () => {
    const before = await h.json('GET', '/api/transfers');
    assert.equal(before.status, 200);
    assert.ok(Array.isArray(before.json.transfers));

    const cleared = await h.json('DELETE', '/api/transfers');
    assert.equal(cleared.status, 204);

    const after = await h.json('GET', '/api/transfers');
    const stillActive = after.json.transfers.filter((t: any) => t.state === 'active' || t.state === 'queued');
    const done = after.json.transfers.filter((t: any) => ['done', 'cancelled', 'error'].includes(t.state));
    assert.equal(done.length, 0, 'finished transfers must be cleared');
    assert.ok(stillActive.length >= 0);
  });

  test('cancelling an unknown transfer is NOT_FOUND', async () => {
    const res = await h.json('DELETE', '/api/transfers/transfer-does-not-exist');
    assert.equal(res.status, 404);
    assert.equal(expectErrorEnvelope(res).code, 'NOT_FOUND');
  });
});

describe('connection teardown', () => {
  // §5 allows only one connection per (host, port, username) triple, so these tests
  // get their own harness (and therefore their own mock on a fresh port).
  test('DELETE /api/connections/:id cancels in-flight transfers and closes shells', async () => {
    await withHarness({}, async (h) => {
      const trusted = await h.connectTrusting({ label: 'teardown-target' });
      const target = trusted.id;

      // An in-flight download that nobody consumes keeps the transfer active.
      const download = await h.stream(
        `/api/connections/${target}/fs/download?path=${encodeURIComponent(BIG_FILE.path)}`,
        { timeoutMs: 60_000 },
      );
      assert.equal(download.status, 200);

      await waitFor(
        async () => {
          const res = await h.json('GET', `/api/connections/${target}/transfers`);
          return res.json.transfers.some((t: any) => t.remotePath === BIG_FILE.path && t.state === 'active');
        },
        { timeoutMs: 10_000, label: 'the transfer to become active' },
      );

      // A live shell on the same connection.
      const shell = await WsClient.open(
        `${h.baseUrl.replace(/^http/, 'ws')}/api/ws/terminal?connectionId=${target}&cols=80&rows=24`,
      );
      try {
        await shell.waitForFrame((f) => f.t === 'ready' || f.t === 'output', {
          timeoutMs: 8_000,
          label: 'the terminal to come up before teardown',
        });
        await waitFor(() => h.mock.openShells >= 1, { timeoutMs: 5_000, label: 'the mock to report an open shell' });

        const del = await h.json('DELETE', `/api/connections/${target}`);
        assert.equal(del.status, 204, `delete failed: ${del.status} ${del.text.slice(0, 200)}`);

        // §11.10 — shells are closed.
        await waitFor(() => h.mock.openShells === 0, {
          timeoutMs: 8_000,
          label: 'the shell to be closed by DELETE /api/connections/:id',
        });

        // §11.10 — in-flight transfers are cancelled.
        await waitFor(
          async () => {
            const res = await h.json('GET', '/api/transfers');
            const transfer = res.json.transfers.find((t: any) => t.remotePath === BIG_FILE.path);
            return transfer && transfer.state === 'cancelled' ? transfer : null;
          },
          { timeoutMs: 8_000, label: 'the in-flight transfer to be cancelled' },
        );

        await waitFor(() => h.mock.connectionCount === 0, {
          timeoutMs: 8_000,
          label: 'every SSH socket of the deleted connection to be gone',
        });
      } finally {
        await shell.close();
        download.body?.cancel().catch(() => {});
      }
    });
  });

  test('routes of a deleted connection answer 404', async () => {
    await withHarness({}, async (h) => {
      const trusted = await h.connectTrusting({ label: 'deleted-target' });
      const target = trusted.id;
      assert.equal((await h.json('DELETE', `/api/connections/${target}`)).status, 204);

      for (const route of ['/fs/list?path=%2F', '/fs/stat?path=%2Fhello.txt', '/transfers']) {
        const res = await h.json('GET', `/api/connections/${target}${route}`);
        assert.equal(res.status, 404, `${route} must be 404 after the connection is gone`);
        assert.equal(expectErrorEnvelope(res).code, 'NOT_FOUND');
      }
      const exec = await h.json('POST', `/api/connections/${target}/exec`, { command: 'true' });
      assert.equal(exec.status, 404);
    });
  });
});

describe('download headers', () => {
  test('a download of a missing file fails without leaking a partial body', async () => {
    const res = await h.json('GET', fsPath('/fs/download?path=%2Fmissing-file.bin'));
    assert.ok(res.status >= 400, `expected an error status, got ${res.status}`);
    expectErrorEnvelope(res);
  });

  test('Content-Disposition encodes the filename', async () => {
    const res = await h.stream(fsPath(`/fs/download?path=${encodeURIComponent(README_FILE.path)}`));
    assert.equal(res.status, 200);
    const disposition = res.headers.get('content-disposition') ?? '';
    assert.match(disposition, /attachment/);
    assert.ok(
      disposition.includes("filename*=UTF-8''") || disposition.includes('filename='),
      `expected an RFC 5987 filename (got ${disposition})`,
    );
    const body = Buffer.from(await res.arrayBuffer());
    assert.ok(body.equals(README_FILE.content));
  });
});
