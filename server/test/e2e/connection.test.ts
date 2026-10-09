/**
 * §3 System, §5 Connections, §10 Config, §11.1–§11.3 — connection lifecycle,
 * authentication, host-key trust and teardown.
 *
 * Written strictly against `docs/API.md`; the mock SSH server is the only thing the
 * API can talk to. Every connection test runs in its own harness (fresh API server,
 * fresh mock, fresh isolated stateDir) so that host-key trust state and the
 * one-connection-per-triple rule from §5 cannot leak between tests.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';

import {
  expectErrorEnvelope,
  startHarness,
  waitFor,
  withHarness,
  type Harness,
} from '../support/harness.js';
import { startMockSshServer } from '../support/mockSshServer.js';

let systemHarness!: Harness;

before(async () => {
  systemHarness = await startHarness();
});

after(async () => {
  await systemHarness?.close();
});

describe('system', () => {
  test('GET /api/health returns the documented shape', async () => {
    const res = await systemHarness.json('GET', '/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(typeof res.json.version, 'string');
    assert.equal(typeof res.json.uptimeSeconds, 'number');
    assert.ok(res.json.uptimeSeconds >= 0);
    assert.equal(typeof res.json.pid, 'number');
    assert.ok(res.json.pid > 0);
    assert.ok(res.requestId, 'x-request-id must be set on success responses too');
  });

  test('GET /api/system/info exposes paths, keys and version', async () => {
    const res = await systemHarness.json('GET', '/api/system/info');
    assert.equal(res.status, 200);
    const info = res.json;
    assert.equal(typeof info.version, 'string');
    assert.equal(typeof info.platform, 'string');
    assert.equal(typeof info.homeDir, 'string');
    assert.equal(typeof info.sshDir, 'string');
    assert.equal(typeof info.knownHostsPath, 'string');
    assert.equal(typeof info.profilesPath, 'string');
    assert.equal(typeof info.defaultDownloadDir, 'string');
    assert.ok(Array.isArray(info.keys), 'keys must be an array');
    assert.ok(res.requestId);

    // stateDir must be the isolated temp dir handed to createServer().
    assert.ok(
      info.knownHostsPath.startsWith(systemHarness.stateDir),
      `known_hosts must live in the isolated stateDir (${info.knownHostsPath} vs ${systemHarness.stateDir})`,
    );
    assert.ok(info.profilesPath.startsWith(systemHarness.stateDir), 'profiles.json must live in the isolated stateDir');
    assert.ok(
      info.defaultDownloadDir.startsWith(systemHarness.downloadDir),
      `defaultDownloadDir must honour createServer({downloadDir}) (${info.defaultDownloadDir})`,
    );

    // The developer's real ~/.ssh-explorer must never be touched.
    const realStateDir = join(homedir(), '.ssh-explorer');
    assert.ok(
      !info.knownHostsPath.startsWith(realStateDir),
      `must not use the real ${realStateDir} (got ${info.knownHostsPath})`,
    );
  });
});

describe('connections', () => {
  test('correct password authenticates and returns a ConnectionSummary', async () => {
    await withHarness({}, async (h) => {
      const { response, id, summary } = await h.connectTrusting();
      assert.equal(response.status, 201, `expected 201, got ${response.status}: ${response.text}`);

      assert.equal(typeof id, 'string');
      assert.equal(summary.host, h.mock.host);
      assert.equal(summary.port, h.mock.port);
      assert.equal(summary.username, h.mock.username);
      assert.equal(summary.authMethod, 'password');
      assert.equal(summary.status, 'authenticated');
      assert.equal(summary.hostKeyFingerprint, h.mock.hostKeyFingerprint);
      assert.equal(typeof summary.connectedAt, 'number');
      assert.ok(summary.connectedAt > 0);
      assert.equal(typeof summary.label, 'string');
      assert.equal(typeof summary.color, 'string');
      assert.ok(summary.latencyMs === null || typeof summary.latencyMs === 'number');
      assert.ok(!JSON.stringify(summary).includes(h.mock.password), 'the password must never be echoed back');

      // serverInfo is optional in the contract, but when present it must be shaped right.
      const withInfo = await waitFor(
        async () => {
          const res = await h.json('GET', `/api/connections/${id}`);
          return res.json?.connection?.serverInfo ? res.json.connection : null;
        },
        { timeoutMs: 5_000, label: 'serverInfo to be populated' },
      ).catch(() => null);
      if (!withInfo) {
        console.log('[diagnostic] ConnectionSummary.serverInfo never appeared within 5s');
      } else {
        const info = withInfo.serverInfo;
        for (const field of ['platform', 'release', 'arch', 'home', 'cwd', 'shell', 'username', 'hostname']) {
          assert.equal(typeof info[field], 'string', `serverInfo.${field} must be a string`);
        }
        assert.equal(info.home, '/', 'home must be the mock SFTP root');
        assert.equal(info.cwd, '/');
      }

      const del = await h.json('DELETE', `/api/connections/${id}`);
      assert.equal(del.status, 204);
      await waitFor(() => h.mock.connectionCount === 0, {
        timeoutMs: 5_000,
        label: 'the SSH socket to be closed after DELETE /api/connections/:id',
      });
    });
  });

  test('wrong password returns 401 AUTH_FAILED and leaks no sockets', async () => {
    await withHarness({}, async (h) => {
      const res = await h.json('POST', '/api/connections', {
        label: 'bad-password',
        host: h.mock.host,
        port: h.mock.port,
        username: h.mock.username,
        auth: { method: 'password', password: 'definitely-not-the-password' },
        trustHostKey: true,
        hostKeyFingerprint: h.mock.hostKeyFingerprint,
      });
      assert.equal(res.status, 401, `expected 401, got ${res.status}: ${res.text}`);
      const error = expectErrorEnvelope(res);
      assert.equal(error.code, 'AUTH_FAILED');

      // §11.1: the failed client is destroyed — no leaked sockets.
      await waitFor(() => h.mock.connectionCount === 0, {
        timeoutMs: 5_000,
        label: 'the failed SSH client to be destroyed (connectionCount back to 0)',
      });
    });
  });

  test('unknown username is rejected as well', async () => {
    await withHarness({}, async (h) => {
      const res = await h.json('POST', '/api/connections', {
        host: h.mock.host,
        port: h.mock.port,
        username: 'nobody',
        auth: { method: 'password', password: h.mock.password },
        trustHostKey: true,
        hostKeyFingerprint: h.mock.hostKeyFingerprint,
      });
      assert.equal(res.status, 401);
      assert.equal(expectErrorEnvelope(res).code, 'AUTH_FAILED');
      await waitFor(() => h.mock.connectionCount === 0, { timeoutMs: 5_000, label: 'no leaked sockets' });
    });
  });

  test('first contact is 409 HOST_KEY_UNKNOWN, trust makes it 201, and the next dial needs no trust', async () => {
    // §11.2 — fresh stateDir so this really is "first contact".
    await withHarness({}, async (h) => {
      const first = await h.connect();
      assert.equal(first.status, 409, `expected 409, got ${first.status}: ${first.text}`);
      const unknown = expectErrorEnvelope(first);
      assert.equal(unknown.code, 'HOST_KEY_UNKNOWN');
      const details = unknown.details as Record<string, unknown>;
      assert.equal(details.host, h.mock.host);
      assert.equal(details.port, h.mock.port);
      assert.equal(details.fingerprint, h.mock.hostKeyFingerprint);
      assert.equal(typeof details.keyType, 'string');
      assert.equal(typeof details.knownHostsPath, 'string');
      assert.equal(typeof details.algorithm, 'string');

      // Trusting with the echoed fingerprint succeeds.
      const trusted = await h.connect({ trustHostKey: true, hostKeyFingerprint: details.fingerprint });
      assert.equal(trusted.status, 201, `expected 201 after trusting, got ${trusted.status}: ${trusted.text}`);
      const id = trusted.json.connection.id;
      assert.equal(trusted.json.connection.hostKeyFingerprint, h.mock.hostKeyFingerprint);

      // The key must now be stored on disk (OpenSSH stores the key blob, not the fingerprint).
      const knownHostsPath = details.knownHostsPath as string;
      const stored = await readFile(knownHostsPath, 'utf8').catch(() => '');
      assert.ok(stored.trim().length > 0, `known_hosts must be written after trusting (${knownHostsPath})`);
      assert.ok(
        stored.includes(String(details.host)),
        `known_hosts must contain an entry for the host: ${JSON.stringify(stored.slice(0, 200))}`,
      );

      await h.json('DELETE', `/api/connections/${id}`);
      await waitFor(() => h.mock.connectionCount === 0, { timeoutMs: 5_000, label: 'connection teardown' });

      // §11.2 — a subsequent connection to the same host needs no trust flag.
      const again = await h.connect();
      assert.equal(again.status, 201, `expected 201 without trustHostKey, got ${again.status}: ${again.text}`);
      await h.json('DELETE', `/api/connections/${again.json.connection.id}`);
      await waitFor(() => h.mock.connectionCount === 0, { timeoutMs: 5_000, label: 'connection teardown' });
    });
  });

  test('a rotated host key is 409 HOST_KEY_MISMATCH and the stored key is unchanged', async () => {
    // The mock serves K1 until the first successful authentication, then K2 on the same
    // host:port — so this assertion does not depend on how known_hosts is keyed.
    await withHarness({ mock: { rotateHostKey: true } }, async (h) => {
      const trusted = await h.connectTrusting();
      assert.equal(trusted.response.status, 201);
      const firstFingerprint = trusted.summary.hostKeyFingerprint;
      assert.equal(firstFingerprint, h.mock.hostKeyFingerprint);

      const info = await h.json('GET', '/api/system/info');
      const knownHostsPath = info.json.knownHostsPath as string;
      const before = await readFile(knownHostsPath, 'utf8').catch(() => '');
      assert.ok(before.trim().length > 0, 'known_hosts must be written after trusting');

      await h.json('DELETE', `/api/connections/${trusted.id}`);
      await waitFor(() => h.mock.connectionCount === 0, { timeoutMs: 5_000, label: 'connection teardown' });

      const second = await h.connect();
      assert.equal(second.status, 409, `expected 409 HOST_KEY_MISMATCH, got ${second.status}: ${second.text}`);
      const error = expectErrorEnvelope(second);
      assert.equal(error.code, 'HOST_KEY_MISMATCH');
      const details = error.details as Record<string, unknown>;
      assert.equal(details.host, h.mock.host);
      assert.equal(details.port, h.mock.port);
      assert.equal(details.expected, firstFingerprint, 'details.expected must be the previously trusted fingerprint');
      assert.notEqual(details.fingerprint, firstFingerprint, 'the presented key must be the rotated one');
      assert.equal(typeof details.knownHostsPath, 'string');

      // §11.3 — the stored key is NOT overwritten.
      const after = await readFile(knownHostsPath, 'utf8').catch(() => '');
      assert.equal(after, before, 'a mismatch must not rewrite known_hosts');
    });
  });

  test('private key authentication works with the mock-generated key', async () => {
    await withHarness({}, async (h) => {
      const res = await h.json('POST', '/api/connections', {
        label: 'key-auth',
        host: h.mock.host,
        port: h.mock.port,
        username: h.mock.username,
        auth: { method: 'privateKey', privateKeyPath: h.mock.privateKeyPath },
        trustHostKey: true,
        hostKeyFingerprint: h.mock.hostKeyFingerprint,
      });
      assert.equal(res.status, 201, `expected 201 for key auth, got ${res.status}: ${res.text}`);
      assert.equal(res.json.connection.authMethod, 'privateKey');
      await h.json('DELETE', `/api/connections/${res.json.connection.id}`);
      await waitFor(() => h.mock.connectionCount === 0, { timeoutMs: 5_000, label: 'connection teardown' });
    });
  });

  test('listing, fetching and deleting connections works', async () => {
    await withHarness({}, async (h) => {
      const { id } = await h.connectTrusting();
      const list = await h.json('GET', '/api/connections');
      assert.equal(list.status, 200);
      assert.ok(Array.isArray(list.json.connections));
      assert.ok(
        list.json.connections.some((c: any) => c.id === id),
        'the new connection must be listed',
      );

      const one = await h.json('GET', `/api/connections/${id}`);
      assert.equal(one.status, 200);
      assert.equal(one.json.connection.id, id);

      const missing = await h.json('GET', '/api/connections/does-not-exist');
      assert.equal(missing.status, 404);
      assert.equal(expectErrorEnvelope(missing).code, 'NOT_FOUND');

      const del = await h.json('DELETE', `/api/connections/${id}`);
      assert.equal(del.status, 204);
      const after = await h.json('GET', `/api/connections/${id}`);
      assert.equal(after.status, 404);
      await waitFor(() => h.mock.connectionCount === 0, { timeoutMs: 5_000, label: 'connection teardown' });
    });
  });

  test('dialing the same triple twice returns the existing connection with 200', async () => {
    await withHarness({}, async (h) => {
      const { id } = await h.connectTrusting();
      const second = await h.connect({ trustHostKey: true, hostKeyFingerprint: h.mock.hostKeyFingerprint });
      assert.equal(second.status, 200, `expected 200 for a duplicate dial, got ${second.status}: ${second.text}`);
      assert.equal(second.json.connection.id, id, 'the same connection must be reused');
      await h.json('DELETE', `/api/connections/${id}`);
      await waitFor(() => h.mock.connectionCount === 0, { timeoutMs: 5_000, label: 'connection teardown' });
    });
  });

  test('reconnect reuses the stored credentials', async () => {
    await withHarness({}, async (h) => {
      const { id } = await h.connectTrusting();
      const res = await h.json('POST', `/api/connections/${id}/reconnect`);
      assert.equal(res.status, 200, `expected 200 from reconnect, got ${res.status}: ${res.text}`);
      assert.equal(res.json.connection.id, id);
      assert.equal(res.json.connection.status, 'authenticated');
      await h.json('DELETE', `/api/connections/${id}`);
      await waitFor(() => h.mock.connectionCount === 0, { timeoutMs: 5_000, label: 'connection teardown' });
    });
  });

  test('POST /api/connections/:id/exec runs whitelisted commands', async () => {
    await withHarness({}, async (h) => {
      const { id } = await h.connectTrusting();

      const ok = await h.json('POST', `/api/connections/${id}/exec`, { command: 'echo hello-exec' });
      assert.equal(ok.status, 200, `expected 200, got ${ok.status}: ${ok.text}`);
      assert.equal(ok.json.stdout, 'hello-exec\n');
      assert.equal(ok.json.stderr, '');
      assert.equal(ok.json.code, 0);

      const uname = await h.json('POST', `/api/connections/${id}/exec`, { command: 'uname -s' });
      assert.equal(uname.status, 200);
      assert.equal(uname.json.stdout.trim(), 'Linux');

      const unknown = await h.json('POST', `/api/connections/${id}/exec`, { command: 'frobnicate --all' });
      assert.equal(unknown.status, 200, 'a failing remote command is still a 200 with a non-zero code');
      assert.notEqual(unknown.json.code, 0);
      assert.ok(String(unknown.json.stderr).length > 0, 'stderr must explain the failure');

      const badPath = await h.json('POST', '/api/connections/nope/exec', { command: 'true' });
      assert.equal(badPath.status, 404);

      await h.json('DELETE', `/api/connections/${id}`);
      await waitFor(() => h.mock.connectionCount === 0, { timeoutMs: 5_000, label: 'connection teardown' });
    });
  });
});

describe('config', () => {
  test('the createServer token option forces the x-ssh-explorer-token header', async () => {
    await withHarness({ token: 'super-secret-token' }, async (h) => {
      const denied = await h.json('GET', '/api/health');
      assert.ok(
        denied.status >= 400 && denied.status < 500,
        `expected the token to be enforced, got ${denied.status}: ${denied.text.slice(0, 200)}`,
      );
      expectErrorEnvelope(denied);

      const wrong = await h.request('GET', '/api/health', { headers: { 'x-ssh-explorer-token': 'wrong-token' } });
      assert.ok(wrong.status >= 400 && wrong.status < 500, `expected a wrong token to be rejected, got ${wrong.status}`);

      const allowed = await h.request('GET', '/api/health', {
        headers: { 'x-ssh-explorer-token': 'super-secret-token' },
      });
      assert.equal(allowed.status, 200);
      assert.equal(allowed.json.ok, true);
      assert.ok(!allowed.text.includes('super-secret-token'), 'the token must never be echoed back');
    });
  });
});

describe('mock self-check', () => {
  test('the mock reports the host key fingerprint the product sees', async () => {
    const standalone = await startMockSshServer();
    try {
      assert.match(standalone.hostKeyFingerprint, /^SHA256:[A-Za-z0-9+/]+$/);
      assert.ok(!standalone.hostKeyFingerprint.endsWith('='), 'OpenSSH fingerprints are unpadded');
      const res = await systemHarness.connect({ host: standalone.host, port: standalone.port });
      assert.equal(res.status, 409, `expected 409, got ${res.status}: ${res.text}`);
      assert.equal(
        (res.error?.details as Record<string, unknown>).fingerprint,
        standalone.hostKeyFingerprint,
        'the API must echo the fingerprint the SSH handshake produced',
      );
    } finally {
      await standalone.close();
    }
  });
});
