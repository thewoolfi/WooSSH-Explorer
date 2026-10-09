import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { Logger } from '../logger.js';

/**
 * OpenSSH `known_hosts` handling.
 *
 * File format reference: each non-empty, non-comment line is
 * `[marker] hosts keytype base64-key [comment]`, where `hosts` is a comma-separated list of
 * host patterns and a non-default port is written as `[host]:port`.
 */

export type KnownHostMarker = 'cert-authority' | 'revoked';

export interface KnownHostEntry {
  /** 1-based line number in the source file. */
  line: number;
  marker?: KnownHostMarker;
  hosts: string[];
  keyType: string;
  /** Base64 key blob exactly as stored. */
  keyBlob: string;
  comment?: string;
}

export interface HostKeyLookupMatch {
  status: 'match';
  entry: KnownHostEntry;
  fingerprint: string;
}

export interface HostKeyLookupRevoked {
  status: 'revoked';
  entry: KnownHostEntry;
  fingerprint: string;
}

export interface HostKeyLookupMismatch {
  status: 'mismatch';
  entry: KnownHostEntry;
  /** Fingerprint of the key currently stored in `known_hosts`. */
  expected: string;
  /** Fingerprint the server just presented. */
  fingerprint: string;
}

export interface HostKeyLookupUnknown {
  status: 'unknown';
  fingerprint: string;
}

export type HostKeyLookup =
  | HostKeyLookupMatch
  | HostKeyLookupRevoked
  | HostKeyLookupMismatch
  | HostKeyLookupUnknown;

/**
 * `SHA256:<base64 of the SHA-256 digest of the raw key blob, without `=` padding>` —
 * exactly the format `ssh-keygen -lf` prints.
 */
export function computeFingerprint(keyBlob: Buffer): string {
  const digest = createHash('sha256').update(keyBlob).digest('base64');
  return `SHA256:${digest.replace(/=+$/, '')}`;
}

/** Fingerprint of a base64 key blob as stored in `known_hosts`. */
export function fingerprintOfBase64(keyBlobBase64: string): string {
  return computeFingerprint(Buffer.from(keyBlobBase64, 'base64'));
}

/** `host` for port 22, `[host]:port` otherwise — the OpenSSH convention. */
export function formatHostPattern(host: string, port: number): string {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return port === 22 ? bare : `[${bare}]:${port}`;
}

/** True when a single `known_hosts` host pattern matches `host`/`port`. */
export function hostPatternMatches(pattern: string, host: string, port: number): boolean {
  if (pattern.startsWith('|')) {
    // Hashed entries (`HashKnownHosts yes`) cannot be matched without reimplementing the salt
    // algorithm; we never write them, and refusing to guess is safer than a false match.
    return false;
  }
  // The parser already split comma-separated pattern lists, so this is a single pattern.
  return pattern === formatHostPattern(host, port);
}

/** True for the OpenSSH per-line markers, with or without the leading `@`. */
export function isMarker(token: string): boolean {
  const bare = token.startsWith('@') ? token.slice(1) : token;
  return bare === 'cert-authority' || bare === 'revoked';
}

/** Normalises `@revoked` / `revoked` to the bare marker name. */
function markerName(token: string): KnownHostMarker {
  return (token.startsWith('@') ? token.slice(1) : token) as KnownHostMarker;
}

/**
 * Parses a `known_hosts` file body. Malformed lines are skipped rather than fatal: a corrupt
 * file must never prevent the user from connecting.
 */
export function parseKnownHosts(content: string): KnownHostEntry[] {
  const entries: KnownHostEntry[] = [];
  const lines = content.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    const tokens = line.split(/\s+/);
    let cursor = 0;
    let marker: KnownHostMarker | undefined;
    const first = tokens[0];
    if (first !== undefined && isMarker(first)) {
      marker = markerName(first);
      cursor = 1;
    }

    const hostField = tokens[cursor];
    const keyType = tokens[cursor + 1];
    const keyBlob = tokens[cursor + 2];
    if (hostField === undefined || keyType === undefined || keyBlob === undefined) continue;
    // A real key line has an algorithm-named type and a base64 blob. The minimum lengths filter
    // out prose that merely happens to split into three tokens.
    if (!/^(?:ssh|ecdsa|sk)-[a-z0-9@.-]+$/i.test(keyType)) continue;
    if (keyBlob.length < 24 || !/^[A-Za-z0-9+/]+={0,3}$/.test(keyBlob)) continue;

    const hosts = hostField
      .split(',')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    if (hosts.length === 0) continue;

    // A prefix applied to the whole list is the same as prefixing every entry.
    const firstHost = hosts[0] as string;
    if (marker === undefined && isMarker(firstHost)) {
      marker = markerName(firstHost);
      hosts.shift();
      if (hosts.length === 0) continue;
    }

    const comment = tokens.slice(cursor + 3).join(' ');
    entries.push({
      line: index + 1,
      ...(marker !== undefined ? { marker } : {}),
      hosts,
      keyType,
      keyBlob,
      ...(comment !== '' ? { comment } : {}),
    });
  }

  return entries;
}

export interface KnownHostLookupOptions {
  host: string;
  port: number;
  /** Raw host key blob as presented during the handshake. */
  keyBlob: Buffer;
  /** Parsed `known_hosts` content. */
  content: string;
}

/** The API shape of `GET /api/known-hosts` (contract §15). */
export interface KnownHostView {
  /** The host field exactly as written, e.g. `[10.0.0.1]:2222`. */
  host: string;
  keyType: string;
  fingerprint: string;
  marker?: KnownHostMarker;
  line: number;
}

/** Maps parsed entries to the §15 wire shape (fingerprint instead of the raw key blob). */
export function knownHostViews(content: string): KnownHostView[] {
  return parseKnownHosts(content).map((entry) => ({
    host: entry.hosts.join(','),
    keyType: entry.keyType,
    fingerprint: fingerprintOfBase64(entry.keyBlob),
    ...(entry.marker !== undefined ? { marker: entry.marker } : {}),
    line: entry.line,
  }));
}

/**
 * Removes the given 1-based lines, preserving every other byte of the file — line endings,
 * comments and blank lines included (contract §15). Splitting on `\n` alone keeps a `\r` inside
 * its line, so a CRLF file stays a CRLF file.
 */
export function removeKnownHostLines(content: string, lines: ReadonlySet<number>): string {
  if (lines.size === 0) return content;
  const parts = content.split('\n');
  const kept: string[] = [];
  for (let index = 0; index < parts.length; index += 1) {
    if (lines.has(index + 1)) continue;
    kept.push(parts[index] as string);
  }
  return kept.join('\n');
}

/**
 * Classifies a presented host key against the stored entries.
 *
 * `@cert-authority` entries are ignored (we do not implement CA verification); `@revoked`
 * entries produce an explicit `revoked` result.
 */
export function classifyHostKey(options: KnownHostLookupOptions): HostKeyLookup {
  const { host, port, keyBlob, content } = options;
  const fingerprint = computeFingerprint(keyBlob);

  // Only entries that name this exact host/port participate in the decision.
  const entries = parseKnownHosts(content).filter((entry) =>
    entry.hosts.some((pattern) => hostPatternMatches(pattern, host, port)),
  );

  let firstMismatch: { entry: KnownHostEntry; expected: string } | undefined;

  for (const entry of entries) {
    const entryFingerprint = fingerprintOfBase64(entry.keyBlob);

    if (entry.marker === 'revoked') {
      // An explicitly revoked key is fatal, whenever it matches.
      if (entryFingerprint === fingerprint) {
        return { status: 'revoked', entry, fingerprint };
      }
      continue;
    }
    if (entry.marker === 'cert-authority') {
      // No CA verification is implemented; such an entry is not evidence of a mismatch.
      continue;
    }

    if (entryFingerprint === fingerprint) {
      return { status: 'match', entry, fingerprint };
    }
    firstMismatch ??= { entry, expected: entryFingerprint };
  }

  if (firstMismatch !== undefined) {
    // The host is known, but not with this key: always fatal (contract §11.3).
    return {
      status: 'mismatch',
      entry: firstMismatch.entry,
      expected: firstMismatch.expected,
      fingerprint,
    };
  }

  return { status: 'unknown', fingerprint };
}

export interface KnownHostsStoreOptions {
  /** Where lookups are read from (`~/.ssh/known_hosts`). */
  readPath: string;
  /** Where newly trusted keys are appended (`<state>/known_hosts`). */
  writePath: string;
  logger: Logger;
}

/**
 * Reads and writes `known_hosts` files. Never logs key material and never throws on I/O
 * problems that should degrade to "host key unknown".
 */
export class KnownHostsStore {
  constructor(private readonly options: KnownHostsStoreOptions) {}

  get readPath(): string {
    return this.options.readPath;
  }

  get writePath(): string {
    return this.options.writePath;
  }

  /** Reads and concatenates both known_hosts files. A missing file is simply empty. */
  async readContent(): Promise<string> {
    const parts: string[] = [];
    const seen = new Set<string>();
    for (const candidate of [this.options.readPath, this.options.writePath]) {
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      try {
        const text = await readFile(candidate, 'utf8');
        if (text !== '') parts.push(text);
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code !== 'ENOENT' && code !== 'EACCES' && code !== 'EPERM') {
          this.options.logger.warn('could not read known_hosts', { path: candidate, code });
        }
      }
    }
    return parts.join('\n');
  }

  /** Classifies a presented host key against everything we have stored. */
  async verify(host: string, port: number, keyBlob: Buffer): Promise<HostKeyLookup> {
    const content = await this.readContent();
    return classifyHostKey({ host, port, keyBlob, content });
  }

  /**
   * Appends a newly trusted key with mode 0600. Returns `false` when an identical entry was
   * already present (no duplicate lines are ever written).
   */
  async append(host: string, port: number, keyType: string, keyBlobBase64: string, comment?: string): Promise<boolean> {
    const directory = path.dirname(this.options.writePath);
    await mkdir(directory, { recursive: true, mode: 0o700 });

    const existing = await this.readContent();
    const pattern = formatHostPattern(host, port);
    const duplicate = parseKnownHosts(existing).some(
      (entry) =>
        entry.marker === undefined &&
        entry.hosts.includes(pattern) &&
        entry.keyType === keyType &&
        entry.keyBlob === keyBlobBase64,
    );
    if (duplicate) return false;

    const suffix = comment !== undefined && comment !== '' ? ` ${comment}` : '';
    const line = `${pattern} ${keyType} ${keyBlobBase64}${suffix}\n`;
    await writeFile(this.options.writePath, line, { encoding: 'utf8', flag: 'a', mode: 0o600 });
    await this.restrictPermissions(this.options.writePath);
    return true;
  }

  /**
   * Removes every entry for `host`/`port`. Used when the user explicitly replaces a stale key;
   * a plain mismatch never calls this (contract §11.3). Returns the number of removed lines, or
   * `0` when nothing matched (the route turns that into `404 NOT_FOUND`).
   */
  async removeHost(host: string, port: number): Promise<number> {
    let content: string;
    try {
      content = await readFile(this.options.writePath, 'utf8');
    } catch {
      return 0;
    }
    const entries = parseKnownHosts(content);
    const doomed = new Set(
      entries
        .filter((entry) => entry.hosts.some((pattern) => hostPatternMatches(pattern, host, port)))
        .map((entry) => entry.line),
    );
    if (doomed.size === 0) return 0;

    const kept = removeKnownHostLines(content, doomed);
    await writeFile(this.options.writePath, kept, { encoding: 'utf8', mode: 0o600 });
    await this.restrictPermissions(this.options.writePath);
    return doomed.size;
  }

  /** The writable file's entries in the §15 wire shape (a missing file is simply empty). */
  async listEntries(): Promise<KnownHostView[]> {
    try {
      return knownHostViews(await readFile(this.options.writePath, 'utf8'));
    } catch {
      return [];
    }
  }

  /** Best-effort chmod 0600; on Windows this is a no-op and must not fail the request. */
  private async restrictPermissions(filePath: string): Promise<void> {
    try {
      await chmod(filePath, 0o600);
    } catch (err) {
      this.options.logger.debug('could not set known_hosts mode', {
        path: filePath,
        code: (err as { code?: string }).code,
      });
    }
  }

  /** True when the file exists and is readable. */
  async exists(): Promise<boolean> {
    try {
      const handle = await open(this.options.writePath, fsConstants.O_RDONLY);
      await handle.close();
      return true;
    } catch {
      return false;
    }
  }
}
