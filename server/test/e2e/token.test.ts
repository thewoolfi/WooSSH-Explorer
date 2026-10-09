/**
 * §10 the token: the default is a generated one, so a fresh instance is never open by accident.
 *
 * The explicit-token case lives in `connection.test.ts`; this file covers the generated state
 * and the fact that the token only ever travels one way — a client sends it, the server never
 * echoes it.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { expectErrorEnvelope, withHarness } from '../support/harness.js';

/** Pulls the generated token out of the clickable URL the server logs at startup. */
function tokenOf(tokenUrl: string): string {
  const parsed = new URL(tokenUrl);
  const token = parsed.searchParams.get('token');
  assert.ok(token && token.length > 0, `expected a token in ${tokenUrl}`);
  return token;
}

describe('generated token (§10)', () => {
  test('requires the generated token on every /api route', async () => {
    await withHarness({ generateToken: true }, async (h) => {
      const tokenUrl = h.api.tokenUrl;
      assert.ok(tokenUrl, 'a generated token must be reachable through the clickable URL');
      assert.ok(tokenUrl.startsWith(h.baseUrl), `expected ${tokenUrl} to start with ${h.baseUrl}`);
      assert.equal(h.api.url.includes('token'), false, 'the plain url stays free of the secret');

      const token = tokenOf(tokenUrl);
      assert.match(token, /^[A-Za-z0-9_-]+$/, 'the token must be URL-safe');

      for (const route of ['/api/health', '/api/system/info', '/api/connections']) {
        const denied = await h.request('GET', route);
        assert.equal(denied.status, 401, `${route} must require the token, got ${denied.status}`);
        const error = expectErrorEnvelope(denied);
        assert.equal(error.code, 'AUTH_FAILED');
        assert.ok(!denied.text.includes(token), 'the token is never echoed back');
      }

      const allowed = await h.request('GET', '/api/health', { headers: { 'x-ssh-explorer-token': token } });
      assert.equal(allowed.status, 200, allowed.text.slice(0, 200));
      assert.equal(allowed.json.ok, true);
      assert.ok(!allowed.text.includes(token), 'the token is never echoed back');

      const wrong = await h.request('GET', '/api/health', { headers: { 'x-ssh-explorer-token': 'not-the-token' } });
      assert.equal(wrong.status, 401);
      assert.equal(expectErrorEnvelope(wrong).code, 'AUTH_FAILED');
    });
  });

  test('two instances generate different tokens', async () => {
    await withHarness({ generateToken: true }, async (first) => {
      await withHarness({ generateToken: true }, async (second) => {
        assert.notEqual(tokenOf(first.api.tokenUrl as string), tokenOf(second.api.tokenUrl as string));
      });
    });
  });

  test('a WebSocket upgrade can carry the token in the query string', async () => {
    await withHarness({ generateToken: true }, async (h) => {
      const token = tokenOf(h.api.tokenUrl as string);
      const { WsClient } = await import('../support/harness.js');
      const wsBase = h.baseUrl.replace(/^http/, 'ws');

      const denied = await WsClient.open(`${wsBase}/api/ws`).then(
        () => null,
        () => 'rejected',
      );
      assert.equal(denied, 'rejected', 'an unauthenticated upgrade must not open a socket');

      const socket = await WsClient.open(`${wsBase}/api/ws?token=${encodeURIComponent(token)}`);
      try {
        // `hello` is sent on connect, which races with the client attaching its listener, so the
        // liveness check is a ping/pong round trip instead.
        socket.send({ type: 'ping' });
        await socket.waitForType('pong', { timeoutMs: 5_000 });
      } finally {
        await socket.close();
      }
    });
  });

  test('the token guards the API, not the static shell', async () => {
    await withHarness({ generateToken: true }, async (h) => {
      // No static directory in the test harness, so `/` is a 404 envelope — the point is that it
      // is *not* the 401 the API would answer, because the shell has to load before a token can
      // be read from the URL.
      const root = await h.request('GET', '/');
      assert.notEqual(root.status, 401, 'the shell must be reachable without a token');
      expectErrorEnvelope(root);
    });
  });
});
