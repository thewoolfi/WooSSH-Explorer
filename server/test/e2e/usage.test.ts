/**
 * §6 `fs/usage` gained `truncated`: `false` for an exact `du` answer, and `true` when the SFTP
 * size walk hit its node cap (so the byte count is a lower bound).
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { HELLO_FILE } from '../support/fixtures.js';
import { withHarness } from '../support/harness.js';

describe('fs/usage (§6)', () => {
  test('reports exact numbers with truncated: false', async () => {
    await withHarness({}, async (h) => {
      const connectionId = (await h.connectTrusting()).id;
      const res = await h.json(
        'GET',
        `/api/connections/${connectionId}/fs/usage?paths=${encodeURIComponent('/docs')}&paths=${encodeURIComponent(HELLO_FILE.path)}`,
      );
      assert.equal(res.status, 200, res.text.slice(0, 300));
      assert.equal(res.json.usage.length, 2);
      for (const entry of res.json.usage) {
        assert.equal(typeof entry.path, 'string');
        assert.equal(typeof entry.bytes, 'number');
        assert.equal(entry.truncated, false, 'a completed answer is not a lower bound');
      }
      const hello = res.json.usage.find((entry: any) => entry.path === HELLO_FILE.path);
      assert.ok(hello.bytes >= HELLO_FILE.content.length);
    });
  });

  test('still answers (and never claims truncation) when du is unavailable', async () => {
    await withHarness({ mock: { missingCommands: ['du'] } }, async (h) => {
      const connectionId = (await h.connectTrusting()).id;
      const res = await h.json(
        'GET',
        `/api/connections/${connectionId}/fs/usage?paths=${encodeURIComponent('/docs')}`,
      );
      assert.equal(res.status, 200, res.text.slice(0, 300));
      const entry = res.json.usage[0];
      assert.equal(entry.path, '/docs');
      assert.equal(entry.truncated, false, 'a walk that finished is not truncated');
      assert.ok(entry.bytes > 0, 'the SFTP walk must still measure the tree');
    });
  });

  /**
   * The walk costs one round trip per entry, so an unbounded one keeps the request open for
   * as long as the tree takes — hours on a real link — and the interface spins for exactly
   * that long. It has to give up and say so instead.
   */
  test('gives up when the walk runs out of time, and reports a lower bound', async () => {
    const saved = process.env.SSH_EXPLORER_USAGE_BUDGET_MS;
    process.env.SSH_EXPLORER_USAGE_BUDGET_MS = '0';
    try {
      await withHarness({ mock: { missingCommands: ['du'] } }, async (h) => {
        const connectionId = (await h.connectTrusting()).id;
        const started = Date.now();
        const res = await h.json(
          'GET',
          `/api/connections/${connectionId}/fs/usage?paths=${encodeURIComponent('/docs')}`,
        );
        const elapsed = Date.now() - started;
        assert.equal(res.status, 200, res.text.slice(0, 300));
        const entry = res.json.usage[0];
        assert.equal(entry.truncated, true, 'an exhausted budget must be flagged');
        assert.ok(elapsed < 5_000, `the request must return promptly, took ${elapsed} ms`);
      });
    } finally {
      if (saved === undefined) delete process.env.SSH_EXPLORER_USAGE_BUDGET_MS;
      else process.env.SSH_EXPLORER_USAGE_BUDGET_MS = saved;
    }
  });
});
