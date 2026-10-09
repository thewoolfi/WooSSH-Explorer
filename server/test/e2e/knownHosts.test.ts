/**
 * §15 known-hosts management: listing the writable file and removing one entry while preserving
 * every other byte.
 */
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, test } from 'node:test';

import { expectErrorEnvelope, withHarness } from '../support/harness.js';

describe('known hosts (§15)', () => {
  test('lists the entries the handshake stored, with fingerprints', async () => {
    await withHarness({}, async (h) => {
      await h.connectTrusting();
      const writePath = path.join(h.stateDir, 'known_hosts');

      const res = await h.json('GET', '/api/known-hosts');
      assert.equal(res.status, 200, res.text.slice(0, 200));
      assert.equal(res.json.path, writePath, 'the path is the writable file in the state directory');
      assert.ok(Array.isArray(res.json.entries));
      assert.equal(res.json.entries.length, 1, `expected exactly one entry: ${res.text.slice(0, 200)}`);

      const entry = res.json.entries[0];
      // The mock listens on a non-default port, so the pattern is the bracketed form.
      assert.equal(entry.host, `[127.0.0.1]:${h.mock.port}`);
      assert.equal(entry.keyType, 'ssh-ed25519');
      assert.equal(entry.fingerprint, h.mock.hostKeyFingerprint);
      assert.equal(entry.line, 1);
      assert.equal(entry.marker, undefined);
    });
  });

  test('removes one entry and preserves every other line byte for byte', async () => {
    await withHarness({}, async (h) => {
      await h.connectTrusting();
      const writePath = path.join(h.stateDir, 'known_hosts');
      const stored = await readFile(writePath, 'utf8');
      assert.ok(stored.includes(`[127.0.0.1]:${h.mock.port}`), 'the trusted key must be in the file');

      // A file with a comment, a blank line and an unrelated entry around the stored one.
      const other = `other.example ssh-ed25519 ${'A'.repeat(40)} a comment`;
      const content = `# managed by ssh-explorer\n\n${other}\n${stored}`;
      await writeFile(writePath, content, 'utf8');

      const listed = await h.json('GET', '/api/known-hosts');
      assert.equal(listed.json.entries.length, 2);
      assert.deepEqual(
        listed.json.entries.map((item: any) => item.line),
        [3, 4],
      );

      const removed = await h.json('DELETE', '/api/known-hosts', {
        host: '127.0.0.1',
        port: h.mock.port,
      });
      assert.equal(removed.status, 204, `expected 204, got ${removed.status}: ${removed.text.slice(0, 200)}`);

      const after = await readFile(writePath, 'utf8');
      assert.equal(after, `# managed by ssh-explorer\n\n${other}\n`, 'only the stored entry may disappear');
      assert.ok(!after.includes(`[127.0.0.1]:${h.mock.port}`));

      const remaining = await h.json('GET', '/api/known-hosts');
      assert.equal(remaining.json.entries.length, 1);
      assert.equal(remaining.json.entries[0].host, 'other.example');
    });
  });

  test('answers 404 for a host that is not stored', async () => {
    await withHarness({}, async (h) => {
      await h.connectTrusting();
      const res = await h.json('DELETE', '/api/known-hosts', { host: 'unknown.example', port: 22 });
      assert.equal(res.status, 404, res.text.slice(0, 200));
      const error = expectErrorEnvelope(res);
      assert.equal(error.code, 'NOT_FOUND');
      assert.equal((error.details as Record<string, unknown>).host, 'unknown.example');
    });
  });

  test('answers 404 when nothing was ever stored', async () => {
    await withHarness({}, async (h) => {
      const res = await h.json('DELETE', '/api/known-hosts', { host: '127.0.0.1', port: h.mock.port });
      assert.equal(res.status, 404);
      assert.equal(expectErrorEnvelope(res).code, 'NOT_FOUND');
    });
  });

  test('validates the delete body', async () => {
    await withHarness({}, async (h) => {
      for (const body of [{}, { host: 'x' }, { host: 'x', port: 0 }, { host: 'x', port: 70000 }, { host: '', port: 22 }]) {
        const res = await h.json('DELETE', '/api/known-hosts', body);
        assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}, got ${res.status}`);
        assert.equal(expectErrorEnvelope(res).code, 'BAD_REQUEST');
      }
    });
  });
});
