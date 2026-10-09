/**
 * Contract §14 — the encrypted credential vault.
 *
 * The point of these tests is not just that saving works, but that the secret
 * never travels back out: the API is metadata-only, and the file on disk must be
 * ciphertext. They also pin the rule that a credential is only persisted after a
 * *successful* handshake, so a typo can never reach the vault.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { expectErrorEnvelope, withHarness, type Harness } from '../support/harness.js';

let harness: Harness;

/** A connection body that deliberately omits the credentials. */
function body(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    host: harness.mock.host,
    port: harness.mock.port,
    username: harness.mock.username,
    ...extra,
  };
}

function credentials(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return body({ auth: { method: 'password', password: harness.mock.password }, ...extra });
}

function secretsFile(): string {
  return path.join(harness.stateDir, 'secrets.json');
}

/**
 * Connects with the mock's password and `saveSecret`, doing the host-key dance
 * only when the key is not trusted yet (earlier tests may already have trusted it).
 */
async function connectSaving(): Promise<{ status: number; savedSecret: boolean; id: string; text: string }> {
  let response = await harness.json('POST', '/api/connections', credentials({ saveSecret: true }));
  if (response.status === 409 && response.error?.code === 'HOST_KEY_UNKNOWN') {
    const fingerprint = (response.error.details as Record<string, unknown>).fingerprint;
    response = await harness.json(
      'POST',
      '/api/connections',
      credentials({ saveSecret: true, trustHostKey: true, hostKeyFingerprint: fingerprint }),
    );
  }
  return {
    status: response.status,
    savedSecret: response.json?.savedSecret === true,
    id: response.json?.connection?.id ?? '',
    text: response.text,
  };
}

before(async () => {
  const { startHarness } = await import('../support/harness.js');
  harness = await startHarness();
});
after(async () => {
  await harness?.close();
});

describe('secret storage (§14)', () => {
  test('system/info advertises how credentials are protected', async () => {
    const response = await harness.request('GET', '/api/system/info');
    assert.equal(response.status, 200);
    const storage = response.json.secretStorage;
    assert.equal(storage.available, true);
    assert.ok(['os-keychain', 'local-key'].includes(storage.kind), `unexpected kind ${storage.kind}`);
    assert.equal(typeof storage.label, 'string');
    assert.ok(storage.label.length > 10, 'the label must actually explain the protection');
    assert.equal(storage.vaultPath, secretsFile());
  });

  test('nothing is stored while the host key is still unverified', async () => {
    const first = await harness.json('POST', '/api/connections', credentials({ saveSecret: true }));
    assert.equal(first.status, 409);
    assert.equal(first.error?.code, 'HOST_KEY_UNKNOWN');

    // The connection never completed, so the password must not have been kept.
    const list = await harness.request('GET', '/api/secrets');
    assert.deepEqual(list.json.secrets, []);
  });

  test('saves after a successful connect, then reconnects without any credentials', async () => {
    const saved = await connectSaving();
    assert.equal(saved.status, 201, saved.text);
    assert.equal(saved.savedSecret, true, 'the vault must report the save');

    // A second dial with no `auth` at all must be driven by the vault.
    await harness.json('DELETE', `/api/connections/${saved.id}`);
    const reused = await harness.json('POST', '/api/connections', body());
    assert.equal(reused.status, 201, reused.text);
    assert.equal(reused.json.usedStoredSecret, true);
    assert.equal(reused.json.connection.status, 'authenticated');
    await harness.json('DELETE', `/api/connections/${reused.json.connection.id}`);
  });

  test('the vault lists metadata only and the file is ciphertext', async () => {
    const list = await harness.request('GET', '/api/secrets');
    assert.equal(list.status, 200);
    assert.equal(list.json.secrets.length, 1);

    const entry = list.json.secrets[0];
    assert.equal(entry.host, harness.mock.host);
    assert.equal(entry.port, harness.mock.port);
    assert.equal(entry.username, harness.mock.username);
    assert.equal(entry.authMethod, 'password');
    assert.equal(typeof entry.updatedAt, 'number');
    assert.equal(entry.id, `${entry.id}`);

    // Nothing in the HTTP response may carry the secret.
    assert.equal(list.text.includes(harness.mock.password), false, 'the list leaked the password');

    // Neither may the file.
    const raw = await readFile(secretsFile(), 'utf8');
    assert.equal(raw.includes(harness.mock.password), false, 'the vault file is not encrypted');
    const parsed = JSON.parse(raw) as { box: string; entries: { payload: string }[] };
    assert.equal(parsed.entries.length, 1);
    assert.equal(typeof parsed.entries[0]?.payload, 'string');
    assert.ok((parsed.entries[0]?.payload.length ?? 0) > 20, 'the payload looks empty');
  });

  test('a failed authentication stores nothing', async () => {
    // A second host triple so this test cannot see the entry from the one above.
    const wrong = await harness.json('POST', '/api/connections', {
      ...credentials({ saveSecret: true }),
      username: `${harness.mock.username}-nope`,
    });
    const code = wrong.status === 409 ? 'HOST_KEY_UNKNOWN' : wrong.error?.code;
    assert.ok(code === 'AUTH_FAILED' || code === 'HOST_KEY_UNKNOWN', `unexpected error ${wrong.text}`);

    const list = await harness.request('GET', '/api/secrets');
    assert.equal(
      list.json.secrets.some((s: { username: string }) => s.username.endsWith('-nope')),
      false,
      'a failed dial must not persist a credential',
    );
  });

  test('useStoredSecret: false falls back to requiring an auth block', async () => {
    const response = await harness.json('POST', '/api/connections', body({ useStoredSecret: false }));
    assert.equal(response.status, 400, response.text);
    const error = expectErrorEnvelope(response);
    assert.equal(error.code, 'BAD_REQUEST');
  });

  test('forgetting a credential makes the next dial fail again', async () => {
    const before = await harness.request('GET', '/api/secrets');
    const id = before.json.secrets[0].id as string;

    const removed = await harness.request('DELETE', `/api/secrets/${encodeURIComponent(id)}`);
    assert.equal(removed.status, 204);

    const again = await harness.request('DELETE', `/api/secrets/${encodeURIComponent(id)}`);
    assert.equal(again.status, 404, 'a second delete must report NOT_FOUND');
    expectErrorEnvelope(again);

    const dial = await harness.json('POST', '/api/connections', body());
    assert.equal(dial.status, 400, dial.text);
    assert.equal(expectErrorEnvelope(dial).code, 'BAD_REQUEST');
  });

  test('the whole vault can be cleared at once', async () => {
    const saved = await connectSaving();
    assert.equal(saved.status, 201, saved.text);
    await harness.json('DELETE', `/api/connections/${saved.id}`);

    assert.equal((await harness.request('GET', '/api/secrets')).json.secrets.length, 1);
    assert.equal((await harness.request('DELETE', '/api/secrets')).status, 204);
    assert.deepEqual((await harness.request('GET', '/api/secrets')).json.secrets, []);
  });
});
