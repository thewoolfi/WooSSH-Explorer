import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Logger } from '../logger.js';
import type { TransferSettings } from '../types.js';

/**
 * Persisted settings (contract §7). The file lives next to `profiles.json` in the state
 * directory, is written atomically with mode 0600 and a missing or corrupt file degrades to
 * the defaults — a broken settings file must never stop the server from starting.
 */

const FILE_VERSION = 1;

export const MIN_MAX_CONCURRENT = 1;
export const MAX_MAX_CONCURRENT = 8;

/** §7: 1…8 concurrent transfers, three by default, no throughput ceiling. */
export const DEFAULT_TRANSFER_SETTINGS: Readonly<TransferSettings> = Object.freeze({
  maxConcurrent: 3,
  speedLimitKbps: null,
});

interface SettingsFileShape {
  version?: number;
  transfers?: unknown;
}

export interface SettingsStoreOptions {
  filePath: string;
  logger: Logger;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Clamps an arbitrary value into the §7 range; anything unusable falls back to the default. */
export function normalizeTransferSettings(value: unknown): TransferSettings {
  if (!isRecord(value)) return { ...DEFAULT_TRANSFER_SETTINGS };

  const rawConcurrent = value['maxConcurrent'];
  const maxConcurrent =
    typeof rawConcurrent === 'number' && Number.isFinite(rawConcurrent)
      ? Math.min(MAX_MAX_CONCURRENT, Math.max(MIN_MAX_CONCURRENT, Math.round(rawConcurrent)))
      : DEFAULT_TRANSFER_SETTINGS.maxConcurrent;

  let speedLimitKbps: number | null = DEFAULT_TRANSFER_SETTINGS.speedLimitKbps;
  const rawSpeed = value['speedLimitKbps'];
  if (rawSpeed === null) {
    speedLimitKbps = null;
  } else if (typeof rawSpeed === 'number' && Number.isFinite(rawSpeed) && rawSpeed > 0) {
    speedLimitKbps = Math.round(rawSpeed);
  }

  return { maxConcurrent, speedLimitKbps };
}

export class SettingsStore {
  private writeChain: Promise<void> = Promise.resolve();
  /** Cached so hot paths (every queued transfer) never touch the disk. */
  private cached: TransferSettings | null = null;

  constructor(private readonly options: SettingsStoreOptions) {}

  get filePath(): string {
    return this.options.filePath;
  }

  /** Never throws: an unreadable or corrupt file yields the defaults. */
  async get(): Promise<TransferSettings> {
    if (this.cached !== null) return { ...this.cached };

    let raw: string;
    try {
      raw = await readFile(this.options.filePath, 'utf8');
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'ENOENT') {
        this.options.logger.warn('could not read the settings file', { path: this.options.filePath, code });
      }
      this.cached = { ...DEFAULT_TRANSFER_SETTINGS };
      return { ...this.cached };
    }

    let parsed: unknown;
    try {
      parsed = raw.trim() === '' ? {} : JSON.parse(raw);
    } catch {
      this.options.logger.warn('settings file is corrupt; using the defaults', { path: this.options.filePath });
      this.cached = { ...DEFAULT_TRANSFER_SETTINGS };
      return { ...this.cached };
    }

    const transfers = isRecord(parsed) ? (parsed as SettingsFileShape).transfers : undefined;
    this.cached = normalizeTransferSettings(transfers);
    return { ...this.cached };
  }

  /** Merges `patch` into the stored settings, writes them and returns the merged result. */
  async patch(patch: Partial<TransferSettings>): Promise<TransferSettings> {
    const current = await this.get();
    const merged: TransferSettings = {
      maxConcurrent: patch.maxConcurrent ?? current.maxConcurrent,
      speedLimitKbps: patch.speedLimitKbps === undefined ? current.speedLimitKbps : patch.speedLimitKbps,
    };
    await this.persist(merged);
    this.cached = merged;
    return { ...merged };
  }

  /** Atomic write: temp file in the same directory, then `rename` over the target. */
  private async persist(settings: TransferSettings): Promise<void> {
    const payload = `${JSON.stringify({ version: FILE_VERSION, transfers: settings }, null, 2)}\n`;
    const run = async (): Promise<void> => {
      const directory = path.dirname(this.options.filePath);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temp = path.join(directory, `.settings.${process.pid}.${randomUUID()}.tmp`);
      try {
        await writeFile(temp, payload, { encoding: 'utf8', mode: 0o600 });
        await chmod(temp, 0o600).catch(() => undefined);
        await rename(temp, this.options.filePath);
      } catch (err) {
        await rm(temp, { force: true }).catch(() => undefined);
        throw err;
      }
      await chmod(this.options.filePath, 0o600).catch(() => undefined);
    };

    // Serialise writes; a rejected write must not poison the chain for later callers.
    const next = this.writeChain.then(run, run);
    this.writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    await next;
  }
}
