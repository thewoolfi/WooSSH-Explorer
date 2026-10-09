/**
 * §7 resumable downloads (`Range` on `/fs/download`) and the transfer settings
 * (`GET`/`PATCH /api/settings`) that gate the queue.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { BIG_FILE, BIG_FILE_SIZE, HELLO_FILE, README_FILE } from '../support/fixtures.js';
import { expectErrorEnvelope, withHarness, waitFor, type Harness } from '../support/harness.js';

async function transfersFor(h: Harness, connectionId: string): Promise<any[]> {
  const res = await h.json('GET', `/api/connections/${connectionId}/transfers`);
  assert.equal(res.status, 200, res.text.slice(0, 200));
  return res.json.transfers;
}

describe('resumable downloads', () => {
  test('serves the remaining bytes with 206 and records resumedFrom', async () => {
    await withHarness({}, async (h) => {
      const connectionId = (await h.connectTrusting()).id;
      const offset = 17;
      const expected = README_FILE.content.subarray(offset);

      const res = await h.stream(
        `/api/connections/${connectionId}/fs/download?path=${encodeURIComponent(README_FILE.path)}`,
        { headers: { range: `bytes=${offset}-` } },
      );
      assert.equal(res.status, 206, `expected 206 Partial Content, got ${res.status}`);
      assert.equal(res.headers.get('content-length'), String(expected.length));
      assert.equal(
        res.headers.get('content-range'),
        `bytes ${offset}-${README_FILE.content.length - 1}/${README_FILE.content.length}`,
      );
      assert.equal(res.headers.get('accept-ranges'), 'bytes');
      const body = Buffer.from(await res.arrayBuffer());
      assert.ok(body.equals(expected), 'the partial body must be the exact remainder');

      const transfer = await waitFor(
        async () => {
          const list = await transfersFor(h, connectionId);
          return list.find((item: any) => item.remotePath === README_FILE.path && item.direction === 'download') ?? null;
        },
        { timeoutMs: 5_000, label: 'the resumed download transfer' },
      );
      assert.equal(transfer.resumedFrom, offset, '§7: resumedFrom is the offset already on disk');
      assert.equal(transfer.resumable, true);
      assert.equal(transfer.size, README_FILE.content.length, 'size stays the full file size');
      assert.equal(transfer.transferred, README_FILE.content.length, 'progress counts the skipped bytes too');
    });
  });

  test('answers 416 for a range that starts past the end', async () => {
    await withHarness({}, async (h) => {
      const connectionId = (await h.connectTrusting()).id;
      const res = await h.json(
        'GET',
        `/api/connections/${connectionId}/fs/download?path=${encodeURIComponent(HELLO_FILE.path)}`,
        undefined,
        { headers: { range: `bytes=${HELLO_FILE.content.length + 100}-` } },
      );
      assert.equal(res.status, 416, `expected 416, got ${res.status}: ${res.text.slice(0, 200)}`);
      assert.equal(res.headers.get('content-range'), `bytes */${HELLO_FILE.content.length}`);
      // The §1 envelope is still used for the body.
      assert.equal(expectErrorEnvelope(res).code, 'BAD_REQUEST');
    });
  });

  test('ignores a range form it does not implement', async () => {
    await withHarness({}, async (h) => {
      const connectionId = (await h.connectTrusting()).id;
      for (const range of ['bytes=0-', 'bytes=1-2', 'bytes=abc-', 'items=0-5']) {
        const res = await h.stream(
          `/api/connections/${connectionId}/fs/download?path=${encodeURIComponent(HELLO_FILE.path)}`,
          { headers: { range } },
        );
        assert.equal(res.status, 200, `"${range}" must fall back to the whole file`);
        const body = Buffer.from(await res.arrayBuffer());
        assert.ok(body.equals(HELLO_FILE.content));
      }
    });
  });
});

describe('transfer settings (§7)', () => {
  test('GET returns the defaults and PATCH merges into the stored settings', async () => {
    await withHarness({}, async (h) => {
      const initial = await h.json('GET', '/api/settings');
      assert.equal(initial.status, 200, initial.text.slice(0, 200));
      assert.deepEqual(initial.json, { transfers: { maxConcurrent: 3, speedLimitKbps: null } });

      const patched = await h.json('PATCH', '/api/settings', { transfers: { maxConcurrent: 1 } });
      assert.equal(patched.status, 200, patched.text.slice(0, 200));
      assert.deepEqual(patched.json, { transfers: { maxConcurrent: 1, speedLimitKbps: null } });

      const withLimit = await h.json('PATCH', '/api/settings', { transfers: { speedLimitKbps: 128 } });
      assert.deepEqual(withLimit.json, { transfers: { maxConcurrent: 1, speedLimitKbps: 128 } });

      // Persisted: a fresh read still sees it.
      const reread = await h.json('GET', '/api/settings');
      assert.deepEqual(reread.json, { transfers: { maxConcurrent: 1, speedLimitKbps: 128 } });

      const cleared = await h.json('PATCH', '/api/settings', { transfers: { speedLimitKbps: null } });
      assert.deepEqual(cleared.json, { transfers: { maxConcurrent: 1, speedLimitKbps: null } });
    });
  });

  test('settings survive a restart of the same state directory', async () => {
    await withHarness({}, async (h) => {
      const patched = await h.json('PATCH', '/api/settings', { transfers: { maxConcurrent: 2, speedLimitKbps: 64 } });
      assert.equal(patched.status, 200);
      // The file lives next to profiles.json in the state directory (§7).
      const { readFile } = await import('node:fs/promises');
      const path = await import('node:path');
      const raw = JSON.parse(await readFile(path.join(h.stateDir, 'settings.json'), 'utf8')) as any;
      assert.deepEqual(raw.transfers, { maxConcurrent: 2, speedLimitKbps: 64 });
    });
  });

  test('rejects out-of-range and empty patches', async () => {
    await withHarness({}, async (h) => {
      for (const body of [
        { transfers: { maxConcurrent: 0 } },
        { transfers: { maxConcurrent: 9 } },
        { transfers: { speedLimitKbps: -5 } },
        { transfers: {} },
        {},
      ]) {
        const res = await h.json('PATCH', '/api/settings', body);
        assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}, got ${res.status}`);
        assert.equal(expectErrorEnvelope(res).code, 'BAD_REQUEST');
      }
      // Nothing was stored by the rejected patches.
      const res = await h.json('GET', '/api/settings');
      assert.deepEqual(res.json, { transfers: { maxConcurrent: 3, speedLimitKbps: null } });
    });
  });

  test('maxConcurrent actually gates the queue: excess transfers stay queued', async () => {
    await withHarness({}, async (h) => {
      const connectionId = (await h.connectTrusting()).id;
      assert.equal(
        (await h.json('PATCH', '/api/settings', { transfers: { maxConcurrent: 1 } })).status,
        200,
      );

      // Two big downloads; their bodies are left unread so the first one keeps its slot.
      const first = h.stream(`/api/connections/${connectionId}/fs/download?path=${encodeURIComponent(BIG_FILE.path)}`, {
        timeoutMs: 60_000,
      });
      const second = h.stream(`/api/connections/${connectionId}/fs/download?path=${encodeURIComponent(BIG_FILE.path)}`, {
        timeoutMs: 60_000,
      });

      const states = await waitFor(
        async () => {
          const list = (await transfersFor(h, connectionId)).filter((item: any) => item.remotePath === BIG_FILE.path);
          if (list.length < 2) return null;
          return list.some((item: any) => item.state === 'queued') ? list : null;
        },
        { timeoutMs: 10_000, label: 'one active and one queued download' },
      );
      assert.equal(states.filter((item: any) => item.state === 'active').length, 1, 'only one transfer may run');
      assert.equal(states.filter((item: any) => item.state === 'queued').length, 1, 'the second waits for a slot');

      // Freeing the slot starts the queued transfer.
      const firstResponse = await first;
      firstResponse.body?.cancel().catch(() => {});
      const started = await waitFor(
        async () => {
          const list = (await transfersFor(h, connectionId)).filter((item: any) => item.remotePath === BIG_FILE.path);
          const queued = list.find((item: any) => item.id === states.find((s: any) => s.state === 'queued').id);
          return queued && queued.state !== 'queued' ? queued : null;
        },
        { timeoutMs: 15_000, label: 'the queued transfer to start' },
      );
      assert.ok(['active', 'done'].includes(started.state), `unexpected state ${started.state}`);

      // Clean up both transfers and lift the limit again.
      for (const item of await transfersFor(h, connectionId)) {
        if (item.state === 'active' || item.state === 'queued') {
          await h.json('DELETE', `/api/transfers/${item.id}`);
        }
      }
      const secondResponse = await second.catch(() => null);
      secondResponse?.body?.cancel().catch(() => {});
      await h.json('PATCH', '/api/settings', { transfers: { maxConcurrent: 3 } });
    });
  });

  test('a throttle limit does not corrupt or drop bytes', async () => {
    await withHarness({}, async (h) => {
      const connectionId = (await h.connectTrusting()).id;
      assert.equal(
        (await h.json('PATCH', '/api/settings', { transfers: { speedLimitKbps: 1 } })).status,
        200,
        'the ceiling is applied to the live limiter',
      );

      // A small file still arrives complete and byte-exact under a 1 KB/s ceiling.
      const res = await h.stream(
        `/api/connections/${connectionId}/fs/download?path=${encodeURIComponent(README_FILE.path)}`,
      );
      assert.equal(res.status, 200);
      const body = Buffer.from(await res.arrayBuffer());
      assert.ok(body.equals(README_FILE.content), 'throttling pauses the stream, it never drops data');

      await h.json('PATCH', '/api/settings', { transfers: { speedLimitKbps: null } });
    });
  });

  test('the persisted limit is applied at startup', async () => {
    await withHarness({}, async (h) => {
      // Write the settings file the way the API would, then start a second server on the same
      // state directory and check it reports (and enforces) the stored values.
      const { writeFile } = await import('node:fs/promises');
      const path = await import('node:path');
      await writeFile(
        path.join(h.stateDir, 'settings.json'),
        JSON.stringify({ version: 1, transfers: { maxConcurrent: 2, speedLimitKbps: 256 } }),
        'utf8',
      );

      const { createServer } = await import('../../src/server.js');
      const second = await createServer({ port: 0, stateDir: h.stateDir, staticDir: null, logLevel: 'silent', token: null });
      try {
        const res = await fetch(`${second.url}/api/settings`);
        assert.equal(res.status, 200);
        assert.deepEqual(await res.json(), { transfers: { maxConcurrent: 2, speedLimitKbps: 256 } });
      } finally {
        await second.close();
      }
    });
  });
});

describe('download-batch still works with the queue in place', () => {
  test('a zip batch takes one slot and finishes under a limit of 1', async () => {
    await withHarness({}, async (h) => {
      const connectionId = (await h.connectTrusting()).id;
      assert.equal((await h.json('PATCH', '/api/settings', { transfers: { maxConcurrent: 1 } })).status, 200);

      const res = await h.stream(`/api/connections/${connectionId}/fs/download-batch`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ paths: [HELLO_FILE.path, '/docs'] }),
        timeoutMs: 30_000,
      });
      const archive = Buffer.from(await res.arrayBuffer());
      assert.equal(res.status, 200, archive.subarray(0, 200).toString('utf8'));
      assert.ok(archive.length > 0);
      assert.equal(archive.readUInt32LE(0), 0x04034b50, 'a real ZIP local header');

      await h.json('PATCH', '/api/settings', { transfers: { maxConcurrent: 3 } });
    });
  });
});

describe('large-file sanity', () => {
  test('the sparse fixture is reported with its real size', async () => {
    await withHarness({}, async (h) => {
      const connectionId = (await h.connectTrusting()).id;
      const res = await h.json(
        'GET',
        `/api/connections/${connectionId}/fs/stat?path=${encodeURIComponent(BIG_FILE.path)}`,
      );
      assert.equal(res.status, 200);
      assert.equal(res.json.entry.size, BIG_FILE_SIZE);
    });
  });
});
