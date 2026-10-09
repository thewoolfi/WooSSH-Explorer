import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { badRequest, conflict, notFound } from '../errors.js';
import type { Logger } from '../logger.js';
import type { AuthMethod, SavedProfile } from '../types.js';

/**
 * Saved profiles (§4). The file only ever contains `SavedProfile` fields — a password or
 * passphrase must never appear here, and the writer enforces that by construction.
 */

const FILE_VERSION = 1;

interface ProfileFileShape {
  version?: number;
  profiles?: unknown;
}

const AUTH_METHODS: ReadonlySet<string> = new Set(['password', 'privateKey', 'agent']);

/** The fields a client may send, after validation. */
export interface ProfileInput {
  label: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  privateKeyPath?: string;
  color?: string;
}

export type ProfilePatch = Partial<ProfileInput>;

export interface ProfileStoreOptions {
  filePath: string;
  logger: Logger;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asPort(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535) return value;
  return undefined;
}

function asAuthMethod(value: unknown): AuthMethod | undefined {
  return typeof value === 'string' && AUTH_METHODS.has(value) ? (value as AuthMethod) : undefined;
}

/** Builds a `SavedProfile` from untrusted JSON, or `null` when the record is unusable. */
function normalizeProfile(value: unknown): SavedProfile | null {
  if (!isRecord(value)) return null;
  const id = asString(value['id']);
  const label = asString(value['label']);
  const host = asString(value['host']);
  const username = asString(value['username']);
  const port = asPort(value['port']);
  const authMethod = asAuthMethod(value['authMethod']);
  if (id === undefined || label === undefined || host === undefined || username === undefined) return null;
  if (port === undefined || authMethod === undefined) return null;

  const profile: SavedProfile = {
    id,
    label,
    host,
    port,
    username,
    authMethod,
    color: asString(value['color']) ?? 'slate',
    lastUsedAt: typeof value['lastUsedAt'] === 'number' && Number.isFinite(value['lastUsedAt']) ? value['lastUsedAt'] : null,
  };
  const privateKeyPath = asString(value['privateKeyPath']);
  if (privateKeyPath !== undefined) profile.privateKeyPath = privateKeyPath;
  return profile;
}

/**
 * JSON-file backed profile store.
 *
 * - reads tolerate a missing, empty or corrupt file (treated as "no profiles");
 * - every write is atomic (temp file in the same directory + `rename`) and mode 0600;
 * - writes are serialised through a promise chain so two requests cannot interleave.
 */
export class ProfileStore {
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: ProfileStoreOptions) {}

  get filePath(): string {
    return this.options.filePath;
  }

  /** All profiles. Never throws: an unreadable or corrupt file yields an empty list. */
  async list(): Promise<SavedProfile[]> {
    let raw: string;
    try {
      raw = await readFile(this.options.filePath, 'utf8');
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== 'ENOENT') {
        this.options.logger.warn('could not read the profiles file', { path: this.options.filePath, code });
      }
      return [];
    }

    if (raw.trim() === '') return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.options.logger.warn('profiles file is corrupt; treating it as empty', { path: this.options.filePath });
      return [];
    }

    const records = Array.isArray(parsed) ? parsed : isRecord(parsed) ? (parsed as ProfileFileShape).profiles : undefined;
    if (!Array.isArray(records)) return [];

    const profiles: SavedProfile[] = [];
    const seen = new Set<string>();
    for (const record of records) {
      const profile = normalizeProfile(record);
      if (profile === null || seen.has(profile.id)) continue;
      seen.add(profile.id);
      profiles.push(profile);
    }
    return profiles;
  }

  async get(id: string): Promise<SavedProfile | undefined> {
    const profiles = await this.list();
    return profiles.find((profile) => profile.id === id);
  }

  async getOrThrow(id: string): Promise<SavedProfile> {
    const profile = await this.get(id);
    if (profile === undefined) throw notFound(`Unknown profile: ${id}.`);
    return profile;
  }

  async create(input: ProfileInput): Promise<SavedProfile> {
    const profiles = await this.list();
    this.assertUnique(profiles, input.label, input.host, input.port, input.username, undefined);

    const profile: SavedProfile = {
      id: randomUUID(),
      label: input.label,
      host: input.host,
      port: input.port,
      username: input.username,
      authMethod: input.authMethod,
      color: input.color ?? 'slate',
      lastUsedAt: null,
    };
    if (input.authMethod === 'privateKey' && input.privateKeyPath !== undefined) {
      profile.privateKeyPath = input.privateKeyPath;
    }

    profiles.push(profile);
    await this.persist(profiles);
    return profile;
  }

  async update(id: string, patch: ProfilePatch): Promise<SavedProfile> {
    const profiles = await this.list();
    const index = profiles.findIndex((profile) => profile.id === id);
    if (index < 0) throw notFound(`Unknown profile: ${id}.`);

    const current = profiles[index] as SavedProfile;
    const merged: SavedProfile = {
      ...current,
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      ...(patch.host !== undefined ? { host: patch.host } : {}),
      ...(patch.port !== undefined ? { port: patch.port } : {}),
      ...(patch.username !== undefined ? { username: patch.username } : {}),
      ...(patch.authMethod !== undefined ? { authMethod: patch.authMethod } : {}),
      ...(patch.color !== undefined ? { color: patch.color } : {}),
      ...(patch.privateKeyPath !== undefined ? { privateKeyPath: patch.privateKeyPath } : {}),
    };

    // A patch that switches away from privateKey authentication drops the stale key path.
    if (merged.authMethod !== 'privateKey') delete merged.privateKeyPath;

    this.assertUnique(profiles, merged.label, merged.host, merged.port, merged.username, id);

    profiles[index] = merged;
    await this.persist(profiles);
    return merged;
  }

  async delete(id: string): Promise<void> {
    const profiles = await this.list();
    const remaining = profiles.filter((profile) => profile.id !== id);
    if (remaining.length === profiles.length) throw notFound(`Unknown profile: ${id}.`);
    await this.persist(remaining);
  }

  /** Records that a profile was used. Best effort: a failure must not break a connection. */
  async touchLastUsed(id: string, when = Date.now()): Promise<void> {
    try {
      const profiles = await this.list();
      const index = profiles.findIndex((profile) => profile.id === id);
      if (index < 0) return;
      profiles[index] = { ...(profiles[index] as SavedProfile), lastUsedAt: when };
      await this.persist(profiles);
    } catch (err) {
      this.options.logger.debug('could not update lastUsedAt', { id, error: err });
    }
  }

  /** Two profiles may not share a label (contract: duplicate profile name ⇒ 409 CONFLICT). */
  private assertUnique(
    profiles: readonly SavedProfile[],
    label: string,
    host: string,
    port: number,
    username: string,
    ignoreId: string | undefined,
  ): void {
    for (const profile of profiles) {
      if (profile.id === ignoreId) continue;
      if (profile.label.toLowerCase() === label.toLowerCase()) {
        throw conflict(`A profile named "${label}" already exists.`, {
          field: 'label',
          value: label,
          id: profile.id,
        });
      }
      if (profile.host === host && profile.port === port && profile.username === username) {
        throw conflict(`A profile for ${username}@${host}:${port} already exists.`, {
          field: 'host',
          value: `${username}@${host}:${port}`,
          id: profile.id,
        });
      }
    }
  }

  /** Atomic write: temp file in the same directory, then `rename` over the target. */
  private async persist(profiles: readonly SavedProfile[]): Promise<void> {
    const payload = `${JSON.stringify({ version: FILE_VERSION, profiles }, null, 2)}\n`;
    const run = async (): Promise<void> => {
      const directory = path.dirname(this.options.filePath);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temp = path.join(directory, `.profiles.${process.pid}.${randomUUID()}.tmp`);
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

/**
 * Validates and narrows an untrusted create body. Zod schemas in `routes/profiles.ts` do the
 * field-level validation; this is the belt-and-braces check that nothing secret is ever stored.
 * Throws `BAD_REQUEST` with a field path.
 */
export function parseProfileInput(body: unknown): ProfileInput {
  if (!isRecord(body)) throw badRequest('A JSON object body is required.', { path: [] });
  const label = asString(body['label']);
  const host = asString(body['host']);
  const username = asString(body['username']);
  const port = asPort(body['port'] ?? 22);
  const authMethod = asAuthMethod(body['authMethod']);

  if (label === undefined) throw badRequest('label is required.', { path: ['label'] });
  if (host === undefined) throw badRequest('host is required.', { path: ['host'] });
  if (username === undefined) throw badRequest('username is required.', { path: ['username'] });
  if (port === undefined) throw badRequest('port must be an integer between 1 and 65535.', { path: ['port'] });
  if (authMethod === undefined) {
    throw badRequest('authMethod must be one of password, privateKey, agent.', { path: ['authMethod'] });
  }

  // Defence in depth: refuse to store anything that looks like a secret.
  for (const forbidden of ['password', 'passphrase', 'secret', 'privateKey']) {
    if (body[forbidden] !== undefined) {
      throw badRequest(`Profiles never store "${forbidden}".`, { path: [forbidden] });
    }
  }

  const input: ProfileInput = { label, host, port, username, authMethod };
  const privateKeyPath = asString(body['privateKeyPath']);
  if (privateKeyPath !== undefined) input.privateKeyPath = privateKeyPath;
  const color = asString(body['color']);
  if (color !== undefined) input.color = color;
  return input;
}
