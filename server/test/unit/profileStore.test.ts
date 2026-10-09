import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { silentLogger } from '../../src/logger.js';
import { ProfileStore } from '../../src/store/profileStore.js';
import { ApiError } from '../../src/errors.js';
import type { ProfileInput } from '../../src/store/profileStore.js';

function input(overrides: Partial<ProfileInput> = {}): ProfileInput {
  return {
    label: 'prod-web-01',
    host: '10.0.4.11',
    port: 22,
    username: 'deploy',
    authMethod: 'password',
    color: 'mint',
    ...overrides,
  };
}

describe('ProfileStore', () => {
  let dir: string;
  let filePath: string;
  let store: ProfileStore;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ssh-explorer-profiles-'));
    filePath = path.join(dir, 'profiles.json');
    store = new ProfileStore({ filePath, logger: silentLogger });
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports an empty list for a missing file', async () => {
    assert.deepEqual(await store.list(), []);
    assert.equal(await store.get('nope'), undefined);
  });

  it('creates a profile with a uuid and the contract shape', async () => {
    const created = await store.create(input());
    assert.match(created.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(created.label, 'prod-web-01');
    assert.equal(created.color, 'mint');
    assert.equal(created.lastUsedAt, null);
    assert.deepEqual(Object.keys(created).sort(), [
      'authMethod',
      'color',
      'host',
      'id',
      'label',
      'lastUsedAt',
      'port',
      'username',
    ]);
  });

  it('round-trips through the JSON file', async () => {
    const fresh = new ProfileStore({ filePath, logger: silentLogger });
    const listed = await fresh.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.host, '10.0.4.11');
    assert.equal(listed[0]?.authMethod, 'password');
  });

  it('never writes a secret field', async () => {
    await store.create(
      input({ label: 'key-host', host: 'h2', authMethod: 'privateKey', privateKeyPath: '/home/u/.ssh/id_ed25519' }),
    );
    const raw = await readFile(filePath, 'utf8');
    // No secret *fields*: `authMethod: "password"` is allowed, a `password:` key is not.
    for (const forbidden of ['"password"', '"passphrase"', '"privateKey"', '"secret"']) {
      assert.ok(!raw.includes(`${forbidden}:`), `profiles.json must not contain a ${forbidden} field`);
    }
    assert.ok(raw.includes('id_ed25519'));
  });

  it('creates the file with mode 0600 where supported', async () => {
    if (process.platform === 'win32') return;
    const info = await stat(filePath);
    assert.equal(info.mode & 0o777, 0o600);
  });

  it('treats a corrupt file as empty and recovers on the next write', async () => {
    const corruptPath = path.join(dir, 'corrupt', 'profiles.json');
    await mkdir(path.dirname(corruptPath), { recursive: true });
    await writeFile(corruptPath, '{ this is not json');
    const corrupt = new ProfileStore({ filePath: corruptPath, logger: silentLogger });
    assert.deepEqual(await corrupt.list(), []);

    const created = await corrupt.create(input({ label: 'recovered' }));
    assert.equal((await corrupt.list())[0]?.id, created.id);
  });

  it('tolerates a structurally wrong file', async () => {
    const wrongPath = path.join(dir, 'wrong', 'profiles.json');
    await mkdir(path.dirname(wrongPath), { recursive: true });
    await writeFile(wrongPath, JSON.stringify({ version: 1, profiles: [{ id: 'x' }, null, 'nonsense', 42] }));
    const wrong = new ProfileStore({ filePath: wrongPath, logger: silentLogger });
    assert.deepEqual(await wrong.list(), []);
  });

  it('accepts a bare array as well as the versioned object', async () => {
    const arrayPath = path.join(dir, 'array', 'profiles.json');
    await mkdir(path.dirname(arrayPath), { recursive: true });
    const profile = {
      id: 'p1',
      label: 'a',
      host: 'h',
      port: 22,
      username: 'u',
      authMethod: 'agent',
      color: 'sky',
      lastUsedAt: null,
    };
    await writeFile(arrayPath, JSON.stringify([profile, profile]));
    const arrayStore = new ProfileStore({ filePath: arrayPath, logger: silentLogger });
    // Duplicate ids collapse to one entry.
    assert.equal((await arrayStore.list()).length, 1);
  });

  it('rejects a duplicate label with CONFLICT', async () => {
    await assert.rejects(
      () => store.create(input({ label: 'PROD-WEB-01', host: 'other' })),
      (err: unknown) => err instanceof ApiError && err.code === 'CONFLICT',
    );
  });

  it('rejects a duplicate host/port/username triple with CONFLICT', async () => {
    await assert.rejects(
      () => store.create(input({ label: 'different-name' })),
      (err: unknown) => err instanceof ApiError && err.code === 'CONFLICT',
    );
  });

  it('updates a subset of fields and keeps the rest', async () => {
    const created = await store.create(input({ label: 'patch-me', host: 'p1' }));
    const updated = await store.update(created.id, { label: 'patched', port: 2222 });
    assert.equal(updated.label, 'patched');
    assert.equal(updated.port, 2222);
    assert.equal(updated.host, 'p1');
    assert.equal(updated.id, created.id);

    // A rename onto another existing label is still a conflict.
    await assert.rejects(
      () => store.update(created.id, { label: 'prod-web-01' }),
      (err: unknown) => err instanceof ApiError && err.code === 'CONFLICT',
    );
  });

  it('drops privateKeyPath when the auth method changes away from privateKey', async () => {
    const created = await store.create(input({ label: 'key2', host: 'k2', authMethod: 'privateKey', privateKeyPath: '/k' }));
    assert.equal(created.privateKeyPath, '/k');
    const updated = await store.update(created.id, { authMethod: 'agent' });
    assert.equal(updated.privateKeyPath, undefined);
  });

  it('throws NOT_FOUND for unknown ids', async () => {
    await assert.rejects(
      () => store.update('missing', { label: 'x' }),
      (err: unknown) => err instanceof ApiError && err.code === 'NOT_FOUND',
    );
    await assert.rejects(
      () => store.delete('missing'),
      (err: unknown) => err instanceof ApiError && err.code === 'NOT_FOUND',
    );
  });

  it('deletes a profile', async () => {
    const created = await store.create(input({ label: 'delete-me', host: 'd1' }));
    await store.delete(created.id);
    assert.equal(await store.get(created.id), undefined);
  });

  it('records lastUsedAt without throwing for unknown ids', async () => {
    const created = await store.create(input({ label: 'used', host: 'u1' }));
    await store.touchLastUsed(created.id, 1_730_000_000_000);
    assert.equal((await store.get(created.id))?.lastUsedAt, 1_730_000_000_000);
    await store.touchLastUsed('does-not-exist');
  });

  it('leaves no temp files behind after an atomic write', async () => {
    const leftovers = (await import('node:fs/promises')).readdir;
    const names = await leftovers(dir);
    assert.ok(!names.some((name) => name.includes('.tmp')), `unexpected temp files: ${names.join(', ')}`);
  });
});
