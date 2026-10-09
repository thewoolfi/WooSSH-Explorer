import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Logger } from '../logger.js';
import type { AuthMethod } from '../types.js';
import type { SshCredentials } from '../ssh/SshConnection.js';

/**
 * Credential vault.
 *
 * Saved passwords, passphrases and inline keys are encrypted with a {@link SecretBox}
 * before they touch the disk, and are **never** sent back to a client: the API only
 * reports which host/user pairs have a stored secret.
 *
 * Two boxes ship:
 *
 * - `SafeStorageSecretBox` (desktop only) — Electron's `safeStorage`, which is DPAPI on
 *   Windows, the Keychain on macOS and libsecret on Linux. The key never leaves the OS
 *   keychain and the ciphertext is bound to the logged-in user account.
 * - `LocalKeySecretBox` (fallback / standalone server) — AES-256-GCM with a random key
 *   file in the state directory. This protects against another user reading the file and
 *   against accidental commits or backups, but **not** against someone who already has
 *   access to your account: they can read the key next to the data. `describe()` says so,
 *   and the UI shows which one is in use.
 */

export type SecretBoxKind = 'os-keychain' | 'local-key';

export interface SecretBox {
  readonly kind: SecretBoxKind;
  /** Human-readable description shown in the UI. */
  readonly label: string;
  encrypt(plaintext: string): Promise<string>;
  decrypt(payload: string): Promise<string>;
}

/** What a caller may persist. `agent` has nothing secret to keep. */
export type StorableCredentials = Exclude<SshCredentials, { method: 'agent' }>;

export interface VaultEntrySummary {
  id: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  updatedAt: number;
}

interface VaultRecord extends VaultEntrySummary {
  /** Ciphertext produced by the box, opaque to the vault. */
  payload: string;
}

interface VaultFile {
  version: number;
  box: SecretBoxKind;
  entries: VaultRecord[];
}

const FILE_VERSION = 1;
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/* -------------------------------------------------------------------------- */
/*  Boxes                                                                      */
/* -------------------------------------------------------------------------- */

export class LocalKeySecretBox implements SecretBox {
  readonly kind = 'local-key' as const;
  readonly label =
    'AES-256-GCM with a key file in the state directory — protects against other users and stray backups, not against someone using your account';

  private key: Buffer | null = null;

  constructor(
    private readonly keyPath: string,
    private readonly logger: Logger,
  ) {}

  private async loadKey(): Promise<Buffer> {
    if (this.key !== null) return this.key;

    try {
      const existing = await readFile(this.keyPath);
      if (existing.length === KEY_BYTES) {
        this.key = existing;
        return existing;
      }
      this.logger.warn('secret key file has the wrong size; regenerating (stored secrets become unreadable)', {
        path: this.keyPath,
        bytes: existing.length,
      });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'ENOENT') {
        this.logger.warn('could not read the secret key file; regenerating', { path: this.keyPath, code });
      }
    }

    const key = randomBytes(KEY_BYTES);
    await mkdir(path.dirname(this.keyPath), { recursive: true, mode: 0o700 });
    await writeFile(this.keyPath, key, { mode: 0o600 });
    await chmod(this.keyPath, 0o600).catch(() => undefined);
    this.key = key;
    return key;
  }

  async encrypt(plaintext: string): Promise<string> {
    const key = await this.loadKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const sealed = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString('base64');
  }

  async decrypt(payload: string): Promise<string> {
    const key = await this.loadKey();
    const raw = Buffer.from(payload, 'base64');
    if (raw.length <= IV_BYTES + TAG_BYTES) throw new Error('stored secret is malformed');
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const sealed = raw.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(sealed), decipher.final()]).toString('utf8');
  }
}

/* -------------------------------------------------------------------------- */
/*  Vault                                                                      */
/* -------------------------------------------------------------------------- */

export interface SecretVaultOptions {
  filePath: string;
  box: SecretBox;
  logger: Logger;
}

export class SecretVault {
  constructor(private readonly options: SecretVaultOptions) {}

  get boxKind(): SecretBoxKind {
    return this.options.box.kind;
  }

  get boxLabel(): string {
    return this.options.box.label;
  }

  /** Stable, non-reversible id for a host triple. */
  static idFor(host: string, port: number, username: string): string {
    return createHash('sha256').update(`${username}\u0000${host}\u0000${port}`).digest('hex').slice(0, 24);
  }

  private async read(): Promise<VaultFile> {
    try {
      const raw = await readFile(this.options.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<VaultFile>;
      const entries = Array.isArray(parsed.entries) ? (parsed.entries as VaultRecord[]) : [];
      const box = (parsed.box as SecretBoxKind) ?? this.options.box.kind;
      if (parsed.box !== undefined && parsed.box !== this.options.box.kind) {
        // Switching between the OS keychain and a local key (or running the same state
        // directory under a different account) makes old entries unreadable. Say so
        // instead of failing silently on the next connect.
        this.options.logger.warn(
          'credential vault was written with a different secret box; stored secrets will be asked for again',
          { vaultBox: parsed.box, currentBox: this.options.box.kind, path: this.options.filePath },
        );
      }
      return {
        version: typeof parsed.version === 'number' ? parsed.version : FILE_VERSION,
        box,
        entries: entries.filter(
          (entry) =>
            typeof entry?.id === 'string' &&
            typeof entry?.host === 'string' &&
            typeof entry?.username === 'string' &&
            typeof entry?.payload === 'string',
        ),
      };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'ENOENT') {
        this.options.logger.warn('could not read the credential vault; treating it as empty', {
          path: this.options.filePath,
          code,
        });
      }
      return { version: FILE_VERSION, box: this.options.box.kind, entries: [] };
    }
  }

  private async write(file: VaultFile): Promise<void> {
    const directory = path.dirname(this.options.filePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temp = `${this.options.filePath}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(file, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, this.options.filePath);
    await chmod(this.options.filePath, 0o600).catch(() => undefined);
  }

  /** Metadata only — never a secret. */
  async list(): Promise<VaultEntrySummary[]> {
    const file = await this.read();
    return file.entries
      .map(({ id, host, port, username, authMethod, updatedAt }) => ({
        id,
        host,
        port,
        username,
        authMethod,
        updatedAt,
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async has(host: string, port: number, username: string): Promise<boolean> {
    const id = SecretVault.idFor(host, port, username);
    const file = await this.read();
    return file.entries.some((entry) => entry.id === id);
  }

  /** Decrypts the stored credential, or `null` when nothing is saved for this triple. */
  async get(host: string, port: number, username: string): Promise<StorableCredentials | null> {
    const id = SecretVault.idFor(host, port, username);
    const file = await this.read();
    const record = file.entries.find((entry) => entry.id === id);
    if (record === undefined) return null;

    try {
      const plaintext = await this.options.box.decrypt(record.payload);
      const parsed = JSON.parse(plaintext) as StorableCredentials;
      if (parsed?.method !== 'password' && parsed?.method !== 'privateKey') return null;
      return parsed;
    } catch (err) {
      // A rotated key, a copied vault or a different OS user: report it, do not crash.
      this.options.logger.warn('could not decrypt a stored credential; it will be asked for again', {
        host,
        port,
        username,
        reason: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** Creates or replaces the stored credential for a triple. */
  async put(
    identity: { host: string; port: number; username: string },
    credentials: StorableCredentials,
  ): Promise<VaultEntrySummary> {
    const id = SecretVault.idFor(identity.host, identity.port, identity.username);
    const payload = await this.options.box.encrypt(JSON.stringify(credentials));
    const record: VaultRecord = {
      id,
      host: identity.host,
      port: identity.port,
      username: identity.username,
      authMethod: credentials.method,
      updatedAt: Date.now(),
      payload,
    };

    const file = await this.read();
    const index = file.entries.findIndex((entry) => entry.id === id);
    if (index >= 0) file.entries[index] = record;
    else file.entries.push(record);
    await this.write({ ...file, box: this.options.box.kind });

    const { payload: _payload, ...summary } = record;
    return summary;
  }

  async forget(id: string): Promise<boolean> {
    const file = await this.read();
    const remaining = file.entries.filter((entry) => entry.id !== id);
    if (remaining.length === file.entries.length) return false;
    await this.write({ ...file, entries: remaining });
    return true;
  }

  async forgetTriple(host: string, port: number, username: string): Promise<boolean> {
    return this.forget(SecretVault.idFor(host, port, username));
  }

  /** Removes the vault file itself. Used by tests and by "forget everything". */
  async clear(): Promise<void> {
    await rm(this.options.filePath, { force: true });
  }
}

/** True when the credential carries something worth encrypting. */
export function isStorable(credentials: SshCredentials): credentials is StorableCredentials {
  if (credentials.method === 'password') return credentials.password !== '';
  if (credentials.method === 'privateKey') {
    return credentials.privateKey !== undefined || credentials.passphrase !== undefined;
  }
  return false;
}

/**
 * The exact shape persisted for a private-key credential.
 *
 * `privateKeyPath` is not a secret, but it is kept so a stored credential is
 * self-sufficient: the user can reconnect without re-picking the key file. The vault
 * encrypts the whole record anyway.
 */
export function redactForStorage(credentials: StorableCredentials): StorableCredentials {
  if (credentials.method === 'password') return { method: 'password', password: credentials.password };
  return {
    method: 'privateKey',
    ...(credentials.privateKey !== undefined ? { privateKey: credentials.privateKey } : {}),
    ...(credentials.privateKeyPath !== undefined ? { privateKeyPath: credentials.privateKeyPath } : {}),
    ...(credentials.passphrase !== undefined ? { passphrase: credentials.passphrase } : {}),
  };
}
