import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

import { createLogger } from '../../src/logger.js';
import {
  isStorable,
  LocalKeySecretBox,
  redactForStorage,
  SecretVault,
} from '../../src/store/secretVault.js';

const logger = createLogger('silent');

let root: string;
before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'ssh-explorer-vault-'));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

function paths(name: string) {
  const dir = path.join(root, name);
  return { dir, vault: path.join(dir, 'secrets.json'), key: path.join(dir, 'secret.key') };
}

describe('LocalKeySecretBox', () => {
  test('round-trips and picks a fresh IV per call', async () => {
    const { key } = paths('box-roundtrip');
    const box = new LocalKeySecretBox(key, logger);

    const first = await box.encrypt('hunter2');
    const second = await box.encrypt('hunter2');
    assert.notEqual(first, second, 'the same plaintext must not produce the same ciphertext');
    assert.equal(await box.decrypt(first), 'hunter2');
    assert.equal(await box.decrypt(second), 'hunter2');
  });

  test('creates a 32-byte key file and survives a restart', async () => {
    const { key } = paths('box-persist');
    const written = await new LocalKeySecretBox(key, logger).encrypt('s3cret');
    assert.equal((await readFile(key)).length, 32);

    // A brand new instance must read the same key back.
    const reopened = new LocalKeySecretBox(key, logger);
    assert.equal(await reopened.decrypt(written), 's3cret');
  });

  test('refuses a payload sealed with a different key', async () => {
    const a = paths('box-key-a');
    const b = paths('box-key-b');
    const sealed = await new LocalKeySecretBox(a.key, logger).encrypt('topsecret');
    await assert.rejects(new LocalKeySecretBox(b.key, logger).decrypt(sealed));
  });

  test('rejects a truncated payload instead of returning garbage', async () => {
    const { key } = paths('box-truncated');
    const box = new LocalKeySecretBox(key, logger);
    await assert.rejects(box.decrypt(Buffer.alloc(8).toString('base64')));
  });

  test('regenerates a key file of the wrong size rather than failing', async () => {
    const { dir, key } = paths('box-badkey');
    await mkdir(dir, { recursive: true });
    await writeFile(key, Buffer.alloc(7), { mode: 0o600 });
    const box = new LocalKeySecretBox(key, logger);
    const sealed = await box.encrypt('value');
    assert.equal((await readFile(key)).length, 32);
    assert.equal(await box.decrypt(sealed), 'value');
  });
});

describe('SecretVault', () => {
  function vaultFor(name: string) {
    const { dir, vault, key } = paths(name);
    return {
      dir,
      path: vault,
      vault: new SecretVault({ filePath: vault, box: new LocalKeySecretBox(key, logger), logger }),
    };
  }

  const project = { host: 'prod.example.com', port: 22, username: 'deploy' };

  test('stores, lists and returns a credential without leaking it into the list', async () => {
    const { path: file, vault } = vaultFor('vault-basic');

    assert.equal(await vault.get(project.host, project.port, project.username), null);
    assert.equal(await vault.has(project.host, project.port, project.username), false);

    const summary = await vault.put(project, { method: 'password', password: 'hunter2' });
    assert.equal(summary.host, project.host);
    assert.equal(summary.authMethod, 'password');

    assert.equal(await vault.has(project.host, project.port, project.username), true);
    assert.deepEqual(await vault.get(project.host, project.port, project.username), {
      method: 'password',
      password: 'hunter2',
    });

    const listed = await vault.list();
    assert.equal(listed.length, 1);
    assert.equal(JSON.stringify(listed).includes('hunter2'), false, 'the list must never carry a secret');

    // The file on disk must not contain the plaintext either.
    const raw = await readFile(file, 'utf8');
    assert.equal(raw.includes('hunter2'), false, 'the vault file must be ciphertext only');
  });

  test('keys the entry by host, port and username independently', async () => {
    const { vault } = vaultFor('vault-keyed');
    await vault.put(project, { method: 'password', password: 'a' });

    assert.equal(await vault.has(project.host, 22, 'other'), false);
    assert.equal(await vault.has(project.host, 2222, project.username), false);
    assert.equal(await vault.has('other.example.com', 22, project.username), false);
    assert.equal(SecretVault.idFor('h', 22, 'u') === SecretVault.idFor('h', 22, 'u'), true);
    assert.notEqual(SecretVault.idFor('h', 22, 'u'), SecretVault.idFor('h', 22, 'U'));
  });

  test('replaces an existing entry instead of duplicating it', async () => {
    const { vault } = vaultFor('vault-replace');
    await vault.put(project, { method: 'password', password: 'first' });
    await vault.put(project, { method: 'password', password: 'second' });

    assert.equal((await vault.list()).length, 1);
    assert.deepEqual(await vault.get(project.host, project.port, project.username), {
      method: 'password',
      password: 'second',
    });
  });

  test('keeps a private-key path and passphrase together', async () => {
    const { vault } = vaultFor('vault-keyauth');
    await vault.put(project, {
      method: 'privateKey',
      privateKeyPath: 'C:\\keys\\id_ed25519',
      passphrase: 'letmein',
    });
    assert.deepEqual(await vault.get(project.host, project.port, project.username), {
      method: 'privateKey',
      privateKeyPath: 'C:\\keys\\id_ed25519',
      passphrase: 'letmein',
    });
  });

  test('forgets by id and by triple', async () => {
    const { vault } = vaultFor('vault-forget');
    const summary = await vault.put(project, { method: 'password', password: 'x' });
    assert.equal(await vault.forget(summary.id), true);
    assert.equal(await vault.forget(summary.id), false);
    assert.equal(await vault.list().then((l) => l.length), 0);

    await vault.put(project, { method: 'password', password: 'y' });
    assert.equal(await vault.forgetTriple(project.host, project.port, project.username), true);
    assert.equal(await vault.has(project.host, project.port, project.username), false);
  });

  test('treats a corrupt vault file as empty rather than throwing', async () => {
    const { dir, path: file, vault } = vaultFor('vault-corrupt');
    await mkdir(dir, { recursive: true });
    await writeFile(file, '{ this is not json', 'utf8');
    assert.deepEqual(await vault.list(), []);
    assert.equal(await vault.get(project.host, project.port, project.username), null);

    // And it recovers: a write replaces the broken file.
    await vault.put(project, { method: 'password', password: 'fresh' });
    assert.equal((await vault.list()).length, 1);
  });

  test('returns null instead of throwing when the key no longer matches', async () => {
    const { path: file, vault } = vaultFor('vault-rotated');
    await vault.put(project, { method: 'password', password: 'hunter2' });

    // Simulate a rotated/foreign key next to an existing vault.
    const { vault: other } = vaultFor('vault-rotated-other');
    await other.put(project, { method: 'password', password: 'ignored' });
    const foreign = await readFile(path.join(root, 'vault-rotated-other', 'secrets.json'), 'utf8');
    await writeFile(file, foreign, 'utf8');

    assert.equal(await vault.get(project.host, project.port, project.username), null);
    assert.equal((await vault.list()).length, 1, 'metadata stays readable even when decryption fails');
  });

  test('clear() removes the vault', async () => {
    const { vault } = vaultFor('vault-clear');
    await vault.put(project, { method: 'password', password: 'x' });
    await vault.clear();
    assert.deepEqual(await vault.list(), []);
  });
});

describe('credential storage helpers', () => {
  test('isStorable only accepts credentials that carry a secret', () => {
    assert.equal(isStorable({ method: 'password', password: 'x' }), true);
    assert.equal(isStorable({ method: 'password', password: '' }), false);
    assert.equal(isStorable({ method: 'agent' }), false);
    assert.equal(isStorable({ method: 'privateKey', privateKeyPath: '/k' }), false);
    assert.equal(isStorable({ method: 'privateKey', privateKeyPath: '/k', passphrase: 'p' }), true);
    assert.equal(isStorable({ method: 'privateKey', privateKey: 'PEM' }), true);
  });

  test('redactForStorage keeps the key path but drops nothing else needed', () => {
    const stored = redactForStorage({
      method: 'privateKey',
      privateKeyPath: '/home/u/.ssh/id_ed25519',
      passphrase: 'p',
    });
    assert.deepEqual(stored, {
      method: 'privateKey',
      privateKeyPath: '/home/u/.ssh/id_ed25519',
      passphrase: 'p',
    });
    assert.deepEqual(redactForStorage({ method: 'password', password: 'x' }), {
      method: 'password',
      password: 'x',
    });
  });
});
