/**
 * §7 transfer settings: defaults, clamping, atomic persistence and the corrupt-file
 * degradation. The queue and the limiter are exercised separately in `transferQueue.test.ts`.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { silentLogger } from '../../src/logger.js';
import {
  DEFAULT_TRANSFER_SETTINGS,
  SettingsStore,
  normalizeTransferSettings,
} from '../../src/store/settingsStore.js';

describe('normalizeTransferSettings', () => {
  it('falls back to the contract defaults', () => {
    assert.deepEqual(normalizeTransferSettings(undefined), { maxConcurrent: 3, speedLimitKbps: null });
    assert.deepEqual(normalizeTransferSettings({}), { maxConcurrent: 3, speedLimitKbps: null });
    assert.deepEqual(normalizeTransferSettings('nonsense'), { maxConcurrent: 3, speedLimitKbps: null });
  });

  it('clamps maxConcurrent into 1…8', () => {
    assert.equal(normalizeTransferSettings({ maxConcurrent: 0 }).maxConcurrent, 1);
    assert.equal(normalizeTransferSettings({ maxConcurrent: -4 }).maxConcurrent, 1);
    assert.equal(normalizeTransferSettings({ maxConcurrent: 8 }).maxConcurrent, 8);
    assert.equal(normalizeTransferSettings({ maxConcurrent: 99 }).maxConcurrent, 8);
    assert.equal(normalizeTransferSettings({ maxConcurrent: 2.7 }).maxConcurrent, 3);
    assert.equal(normalizeTransferSettings({ maxConcurrent: Number.NaN }).maxConcurrent, 3);
  });

  it('accepts a positive speed limit and treats anything else as unlimited', () => {
    assert.equal(normalizeTransferSettings({ speedLimitKbps: 512 }).speedLimitKbps, 512);
    assert.equal(normalizeTransferSettings({ speedLimitKbps: null }).speedLimitKbps, null);
    assert.equal(normalizeTransferSettings({ speedLimitKbps: 0 }).speedLimitKbps, null);
    assert.equal(normalizeTransferSettings({ speedLimitKbps: -1 }).speedLimitKbps, null);
    assert.equal(normalizeTransferSettings({ speedLimitKbps: 'fast' }).speedLimitKbps, null);
  });
});

describe('SettingsStore', () => {
  let dir: string;
  let filePath: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ssh-explorer-settings-'));
    filePath = path.join(dir, 'settings.json');
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports the defaults for a missing file', async () => {
    const store = new SettingsStore({ filePath, logger: silentLogger });
    assert.deepEqual(await store.get(), { ...DEFAULT_TRANSFER_SETTINGS });
  });

  it('merges a patch, persists it and survives a fresh store', async () => {
    const store = new SettingsStore({ filePath, logger: silentLogger });
    const patched = await store.patch({ maxConcurrent: 1 });
    assert.deepEqual(patched, { maxConcurrent: 1, speedLimitKbps: null });

    const withLimit = await store.patch({ speedLimitKbps: 256 });
    assert.deepEqual(withLimit, { maxConcurrent: 1, speedLimitKbps: 256 });

    // A second store reading the same file sees the persisted values (a restart keeps them).
    const reopened = new SettingsStore({ filePath, logger: silentLogger });
    assert.deepEqual(await reopened.get(), { maxConcurrent: 1, speedLimitKbps: 256 });

    const raw = JSON.parse(await readFile(filePath, 'utf8')) as { version: number; transfers: unknown };
    assert.equal(raw.version, 1);
    assert.deepEqual(raw.transfers, { maxConcurrent: 1, speedLimitKbps: 256 });
  });

  it('clears the limit with an explicit null', async () => {
    const store = new SettingsStore({ filePath, logger: silentLogger });
    assert.deepEqual(await store.patch({ speedLimitKbps: null }), { maxConcurrent: 1, speedLimitKbps: null });
  });

  it('writes the file with mode 0600 where supported', async () => {
    if (process.platform === 'win32') return;
    const info = await stat(filePath);
    assert.equal(info.mode & 0o777, 0o600);
  });

  it('degrades to the defaults when the file is corrupt', async () => {
    const corrupt = path.join(dir, 'corrupt.json');
    await writeFile(corrupt, '{not json', 'utf8');
    const store = new SettingsStore({ filePath: corrupt, logger: silentLogger });
    assert.deepEqual(await store.get(), { ...DEFAULT_TRANSFER_SETTINGS });
    // Writing after a corrupt read replaces the file instead of failing.
    assert.deepEqual(await store.patch({ maxConcurrent: 2 }), { maxConcurrent: 2, speedLimitKbps: null });
    assert.deepEqual(await new SettingsStore({ filePath: corrupt, logger: silentLogger }).get(), {
      maxConcurrent: 2,
      speedLimitKbps: null,
    });
  });

  it('ignores unknown keys in the stored file', async () => {
    const extra = path.join(dir, 'extra.json');
    await writeFile(extra, JSON.stringify({ version: 1, transfers: { maxConcurrent: 5, something: true } }), 'utf8');
    const store = new SettingsStore({ filePath: extra, logger: silentLogger });
    assert.deepEqual(await store.get(), { maxConcurrent: 5, speedLimitKbps: null });
  });
});
