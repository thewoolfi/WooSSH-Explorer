/**
 * §16 `GET /api/connections/:id/system/stats` — one round trip against the mock's Linux-shaped
 * fixture output (see `SYS_STATS` in `test/support/mockSshServer.ts`).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { expectErrorEnvelope, withHarness } from '../support/harness.js';

const KIB = 1024;

describe('remote system stats (§16)', () => {
  test('collects uptime, load, cpu, memory, swap, disks, hostname and kernel', async () => {
    await withHarness({}, async (h) => {
      const connectionId = (await h.connectTrusting()).id;

      const res = await h.json('GET', `/api/connections/${connectionId}/system/stats`);
      assert.equal(res.status, 200, res.text.slice(0, 300));
      const stats = res.json;

      assert.equal(typeof stats.collectedAt, 'number');
      assert.ok(Math.abs(stats.collectedAt - Date.now()) < 60_000, 'collectedAt is "now"');

      // 10 days, 3:22 of uptime.
      assert.equal(stats.uptimeSeconds, 10 * 86_400 + 3 * 3600 + 22 * 60);
      assert.deepEqual(stats.load, [0.42, 0.55, 0.61]);
      assert.equal(stats.cpuCount, 4);

      assert.deepEqual(stats.memory, {
        totalBytes: 8_589_934_592,
        usedBytes: 4_294_967_296,
        availableBytes: 5_368_709_120,
      });
      assert.deepEqual(stats.swap, { totalBytes: 2_147_483_648, usedBytes: 268_435_456 });

      assert.equal(stats.disks.length, 2);
      assert.deepEqual(stats.disks[0], {
        filesystem: '/dev/sda1',
        sizeBytes: 103_080_448 * KIB,
        usedBytes: 42_949_672 * KIB,
        availableBytes: 60_130_776 * KIB,
        mount: '/',
      });
      assert.equal(stats.disks[1].mount, '/dev/shm');

      assert.equal(stats.hostname, 'mock-host');
      assert.equal(stats.kernel, 'Linux 6.1.0-mock');
    });
  });

  test('is one round trip and never an error, even repeated', async () => {
    await withHarness({}, async (h) => {
      const connectionId = (await h.connectTrusting()).id;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const res = await h.json('GET', `/api/connections/${connectionId}/system/stats`);
        assert.equal(res.status, 200, `attempt ${attempt}: ${res.status} ${res.text.slice(0, 200)}`);
        assert.ok(res.requestId, 'carries x-request-id like every other response');
      }
    });
  });

  test('answers 404 for an unknown or unauthenticated connection', async () => {
    await withHarness({}, async (h) => {
      const unknown = await h.json('GET', '/api/connections/nope/system/stats');
      assert.equal(unknown.status, 404);
      assert.equal(expectErrorEnvelope(unknown).code, 'NOT_FOUND');
    });
  });

  test('a host without the tools degrades to nulls instead of failing', async () => {
    // The mock answers `command not found` for everything it does not know; hiding the stats
    // tools is the closest thing to a host without /proc, `free` or `df`.
    await withHarness(
      { mock: { missingCommands: ['uptime', 'free', 'df', 'nproc', 'cat'] } },
      async (h) => {
        const connectionId = (await h.connectTrusting()).id;
        const res = await h.json('GET', `/api/connections/${connectionId}/system/stats`);
        assert.equal(res.status, 200, `stats must never fail: ${res.status} ${res.text.slice(0, 300)}`);
        assert.equal(res.json.uptimeSeconds, null);
        assert.equal(res.json.load, null);
        assert.equal(res.json.cpuCount, null);
        assert.equal(res.json.memory, null);
        assert.equal(res.json.swap, null);
        assert.deepEqual(res.json.disks, []);
        // What the handshake knows is still reported: `uname` works, so the panel is not empty.
        assert.equal(res.json.kernel, 'Linux 6.1.0-mock');
        assert.equal(res.json.hostname, 'mock-host');
      },
    );
  });
});
