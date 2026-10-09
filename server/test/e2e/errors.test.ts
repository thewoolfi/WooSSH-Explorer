/**
 * §1 Error envelope + §11.9 — every error response validates against the envelope
 * and carries `x-request-id`; secrets are never echoed; failures are not silent.
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { after, before, describe, test } from 'node:test';

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

/** Bind an ephemeral port and close it again, so nothing is listening there. */
async function findClosedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Closes a test TCP server without waiting for lingering peer sockets. */
function closeServer(server: net.Server): void {
  server.closeAllConnections?.();
  server.close();
}

describe('error envelope (§1)', () => {
  test('BAD_REQUEST for a malformed connection body', async () => {
    const missingHost = await h.json('POST', '/api/connections', { username: 'tester' });
    assert.equal(missingHost.status, 400, missingHost.text.slice(0, 200));
    assert.equal(expectErrorEnvelope(missingHost).code, 'BAD_REQUEST');

    const wrongTypes = await h.json('POST', '/api/connections', { host: 'h', port: 'not-a-port', username: 'u' });
    assert.equal(wrongTypes.status, 400);
    assert.equal(expectErrorEnvelope(wrongTypes).code, 'BAD_REQUEST');

    const badJson = await h.request('POST', '/api/connections', {
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    });
    assert.equal(badJson.status, 400);
    assert.equal(expectErrorEnvelope(badJson).code, 'BAD_REQUEST');
  });

  test('BAD_REQUEST for malformed query parameters', async () => {
    const badLimit = await h.json('GET', fsPath('/fs/list?path=%2F&limit=not-a-number'));
    assert.equal(badLimit.status, 400, badLimit.text.slice(0, 200));
    assert.equal(expectErrorEnvelope(badLimit).code, 'BAD_REQUEST');

    const badMaxBytes = await h.json('GET', fsPath('/fs/read?path=%2Fhello.txt&maxBytes=abc'));
    assert.equal(badMaxBytes.status, 400);
    assert.equal(expectErrorEnvelope(badMaxBytes).code, 'BAD_REQUEST');

    const missingPath = await h.json('POST', fsPath('/fs/mkdir'), {});
    assert.equal(missingPath.status, 400);
    assert.equal(expectErrorEnvelope(missingPath).code, 'BAD_REQUEST');

    const badMode = await h.json('POST', fsPath('/fs/chmod'), { path: '/hello.txt', mode: 'not-octal' });
    assert.equal(badMode.status, 400, badMode.text.slice(0, 200));
    assert.equal(expectErrorEnvelope(badMode).code, 'BAD_REQUEST');
  });

  test('NOT_FOUND for unknown connection, profile and transfer ids', async () => {
    const cases = [
      await h.json('GET', '/api/connections/nope'),
      await h.json('DELETE', '/api/connections/nope'),
      await h.json('GET', '/api/connections/nope/fs/list?path=%2F'),
      await h.json('POST', '/api/connections/nope/fs/mkdir', { path: '/x' }),
      await h.json('GET', '/api/connections/nope/transfers'),
      await h.json('POST', '/api/connections/nope/reconnect'),
      await h.json('DELETE', '/api/transfers/nope'),
      await h.json('POST', '/api/transfers/nope/retry'),
      await h.json('PATCH', '/api/profiles/nope', { label: 'x' }),
      await h.json('DELETE', '/api/profiles/nope'),
    ];
    for (const res of cases) {
      assert.equal(res.status, 404, `expected 404, got ${res.status}: ${res.text.slice(0, 200)}`);
      assert.equal(expectErrorEnvelope(res).code, 'NOT_FOUND');
    }
  });

  test('CONNECT_FAILED (502) with details.reason when nothing is listening', async () => {
    const port = await findClosedPort();
    const res = await h.json('POST', '/api/connections', {
      host: '127.0.0.1',
      port,
      username: 'tester',
      auth: { method: 'password', password: 'whatever' },
    });
    assert.equal(res.status, 502, `expected 502, got ${res.status}: ${res.text.slice(0, 200)}`);
    const error = expectErrorEnvelope(res);
    assert.equal(error.code, 'CONNECT_FAILED');
    assert.equal((error.details as Record<string, unknown>).reason, 'ECONNREFUSED');
  });

  test('CONNECT_FAILED (502) when the peer drops the connection before the handshake', async () => {
    // A real TCP peer that accepts and immediately closes: ssh2 reports
    // "Connection lost before handshake", which §1 classifies as CONNECT_FAILED.
    const dropper = net.createServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => dropper.listen(0, '127.0.0.1', () => resolve()));
    const address = dropper.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const res = await h.json('POST', '/api/connections', {
        host: '127.0.0.1',
        port,
        username: 'tester',
        auth: { method: 'password', password: 'whatever' },
      });
      assert.equal(res.status, 502, `expected 502 CONNECT_FAILED, got ${res.status}: ${res.text.slice(0, 200)}`);
      const error = expectErrorEnvelope(res);
      assert.equal(error.code, 'CONNECT_FAILED');
      assert.equal(typeof (error.details as Record<string, unknown>).reason, 'string');
    } finally {
      closeServer(dropper);
    }
  });

  test('CONNECT_FAILED (502) when the peer never completes the handshake', async () => {
    // A TCP peer that accepts the connection and then stays silent: the SSH handshake
    // times out, which §1 classifies as CONNECT_FAILED with details.reason.
    const silent = net.createServer(() => {});
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', () => resolve()));
    const address = silent.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const started = Date.now();
      const res = await h.json(
        'POST',
        '/api/connections',
        {
          host: '127.0.0.1',
          port,
          username: 'tester',
          auth: { method: 'password', password: 'whatever' },
        },
        { timeoutMs: 60_000 },
      );
      assert.equal(res.status, 502, `expected 502 CONNECT_FAILED, got ${res.status}: ${res.text.slice(0, 200)}`);
      const error = expectErrorEnvelope(res);
      assert.equal(error.code, 'CONNECT_FAILED');
      const reason = (error.details as Record<string, unknown>).reason;
      assert.equal(typeof reason, 'string');
      assert.equal(reason, 'ETIMEDOUT', `expected details.reason ETIMEDOUT, got ${String(reason)}`);
      assert.ok(Date.now() - started < 60_000, 'the dial must give up on its own');
    } finally {
      closeServer(silent);
    }
  });

  test('CONNECT_FAILED (502) for an unroutable host instead of an internal error', async () => {
    // 192.0.2.0/24 (RFC 5737) is reserved for documentation: a SYN there never gets an
    // answer, so the connect attempt fails after a few seconds. §1 maps *any* TCP/DNS/
    // handshake failure to CONNECT_FAILED — never to INTERNAL.
    const res = await h.json(
      'POST',
      '/api/connections',
      {
        host: '192.0.2.1',
        port: 2222,
        username: 'tester',
        auth: { method: 'password', password: 'whatever' },
      },
      { timeoutMs: 60_000 },
    );
    assert.equal(res.status, 502, `unreachable host must be 502 CONNECT_FAILED, got ${res.status}: ${res.text.slice(0, 200)}`);
    const error = expectErrorEnvelope(res);
    assert.equal(error.code, 'CONNECT_FAILED');
    assert.equal(typeof (error.details as Record<string, unknown>).reason, 'string');
  });

  test('AUTH_FAILED (401) for rejected credentials', async () => {
    await withHarness({ mock: { rejectAuth: true } }, async (rejecting) => {
      const res = await rejecting.json('POST', '/api/connections', {
        host: rejecting.mock.host,
        port: rejecting.mock.port,
        username: rejecting.mock.username,
        auth: { method: 'password', password: rejecting.mock.password },
        trustHostKey: true,
        hostKeyFingerprint: rejecting.mock.hostKeyFingerprint,
      });
      assert.equal(res.status, 401, res.text.slice(0, 200));
      assert.equal(expectErrorEnvelope(res).code, 'AUTH_FAILED');
      await rejecting.json('GET', '/api/health');
    });
  });

  test('every successful response carries x-request-id too', async () => {
    const responses = [
      await h.json('GET', '/api/health'),
      await h.json('GET', '/api/system/info'),
      await h.json('GET', '/api/connections'),
      await h.json('GET', '/api/profiles'),
      await h.json('GET', fsPath('/fs/list?path=%2F')),
      await h.json('GET', `/api/connections/${connectionId}/transfers`),
      await h.json('GET', '/api/transfers'),
      await h.json('POST', `/api/connections/${connectionId}/exec`, { command: 'true' }),
    ];
    for (const res of responses) {
      assert.ok(res.status < 400, `unexpected failure: ${res.status} ${res.text.slice(0, 200)}`);
      assert.ok(res.requestId && res.requestId.length > 0, 'every response must carry x-request-id');
    }
  });

  test('the request id differs between requests and is echoed in the header', async () => {
    const a = await h.json('GET', '/api/health');
    const b = await h.json('GET', '/api/health');
    assert.notEqual(a.requestId, b.requestId, 'request ids must be unique');
    const denied = await h.json('GET', '/api/connections/nope');
    assert.ok(denied.requestId, 'error responses carry the id as well');
  });
});

describe('secret handling', () => {
  test('passwords never appear in responses or in profiles', async () => {
    await withHarness({}, async (secret) => {
      const secretValue = `top-secret-${Date.now()}`;
      const trusted = await secret.connectTrusting();
      const second = await secret.json('POST', '/api/connections', {
        label: 'second',
        host: '127.0.0.1',
        port: await findClosedPort(),
        username: 'tester',
        auth: { method: 'password', password: secretValue },
      });
      // Whatever the outcome, the password must not be echoed.
      assert.ok(!second.text.includes(secretValue), 'the password must never be echoed back');

      const created = await secret.json('POST', '/api/profiles', {
        label: 'no-secrets',
        host: 'example.invalid',
        port: 22,
        username: 'deploy',
        authMethod: 'password',
      });
      assert.equal(created.status, 201, created.text.slice(0, 200));
      const profile = created.json.profile;
      assert.ok(!('password' in profile), 'SavedProfile must never contain a password');
      assert.ok(!('passphrase' in profile), 'SavedProfile must never contain a passphrase');
      assert.ok(!JSON.stringify(profile).includes(secretValue));

      const listed = await secret.json('GET', '/api/profiles');
      assert.ok(!JSON.stringify(listed.json).includes(secretValue));
      assert.ok(!JSON.stringify(listed.json).includes(secret.mock.password));

      const connections = await secret.json('GET', '/api/connections');
      assert.ok(!JSON.stringify(connections.json).includes(secret.mock.password));

      await secret.json('DELETE', `/api/connections/${trusted.id}`);
    });
  });
});

describe('profiles (§4)', () => {
  test('create, patch, list and delete a profile', async () => {
    await withHarness({}, async (profiles) => {
      const created = await profiles.json('POST', '/api/profiles', {
        label: 'e2e-profile',
        host: profiles.mock.host,
        port: profiles.mock.port,
        username: profiles.mock.username,
        authMethod: 'privateKey',
        privateKeyPath: profiles.mock.privateKeyPath,
        color: 'mint',
      });
      assert.equal(created.status, 201, created.text.slice(0, 200));
      const profile = created.json.profile;
      assert.equal(typeof profile.id, 'string');
      assert.equal(profile.label, 'e2e-profile');
      assert.equal(profile.port, profiles.mock.port);
      assert.equal(profile.authMethod, 'privateKey');
      assert.equal(profile.privateKeyPath, profiles.mock.privateKeyPath);
      assert.equal(profile.color, 'mint');
      assert.ok(profile.lastUsedAt === null || typeof profile.lastUsedAt === 'number');

      const patched = await profiles.json('PATCH', `/api/profiles/${profile.id}`, { label: 'renamed' });
      assert.equal(patched.status, 200, patched.text.slice(0, 200));
      assert.equal(patched.json.profile.label, 'renamed');
      assert.equal(patched.json.profile.id, profile.id);

      const list = await profiles.json('GET', '/api/profiles');
      assert.equal(list.status, 200);
      assert.ok(list.json.profiles.some((p: any) => p.id === profile.id));

      // §5: `:id` may be a saved profile id, and the server fields default from it.
      const byProfileId = await profiles.json('POST', '/api/connections', {
        profileId: profile.id,
        trustHostKey: true,
        hostKeyFingerprint: profiles.mock.hostKeyFingerprint,
      });
      assert.equal(
        byProfileId.status,
        201,
        `a profileId-backed dial must connect to the mock, got ${byProfileId.status}: ${byProfileId.text.slice(0, 250)}`,
      );
      assert.equal(byProfileId.json.connection.host, profiles.mock.host);
      assert.equal(byProfileId.json.connection.username, profiles.mock.username);
      assert.equal(byProfileId.json.connection.authMethod, 'privateKey');
      assert.equal(byProfileId.json.connection.label, 'renamed', 'the profile label is the default label');
      await profiles.json('DELETE', `/api/connections/${byProfileId.json.connection.id}`);

      const del = await profiles.json('DELETE', `/api/profiles/${profile.id}`);
      assert.equal(del.status, 204);
      const after = await profiles.json('GET', '/api/profiles');
      assert.ok(!after.json.profiles.some((p: any) => p.id === profile.id));
    });
  });
});
