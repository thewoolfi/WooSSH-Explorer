import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { LogLevel } from './types.js';

/**
 * Where the shared secret came from (contract §10). `env-no-token` is the loud one: the
 * API answers any process on the machine, so the server warns about it at startup.
 */
export type TokenSource = 'explicit' | 'generated' | 'env-no-token' | 'disabled';

/**
 * Configuration is read once at startup from the environment (§10 of the contract) and may be
 * overridden per instance by `createServer(options)`.
 */
export interface Config {
  port: number;
  host: string;
  /** Local home directory (used for `~/.ssh` lookups and the static default). */
  homeDir: string;
  /** State directory: holds `known_hosts` and `profiles.json`. */
  stateDir: string;
  knownHostsPath: string;
  profilesPath: string;
  /** Encrypted credential vault (contract §14). */
  secretsPath: string;
  /** Key file for the fallback local-key box; unused when an OS keychain is injected. */
  secretKeyPath: string;
  /** Persisted transfer settings (contract §7). */
  settingsPath: string;
  downloadDir: string;
  staticDir: string | null;
  logLevel: LogLevel;
  /** Rotating log file; the only diagnostics a windowed application can offer. */
  logFilePath: string;
  /** `null` disables the requirement; otherwise every `/api` request must send it (§10). */
  token: string | null;
  tokenSource: TokenSource;
  version: string;
}

export interface ConfigOverrides {
  port?: number;
  host?: string;
  stateDir?: string;
  downloadDir?: string;
  logLevel?: LogLevel;
  logFilePath?: string;
  staticDir?: string | null;
  token?: string | null;
}

const LOG_LEVELS: ReadonlySet<string> = new Set(['silent', 'error', 'warn', 'info', 'debug']);

const DEFAULT_PORT = 5178;
const DEFAULT_HOST = '127.0.0.1';

const pkgRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** Best-effort read of this package's version; never throws. */
export function packageVersion(): string {
  for (const candidate of [
    path.join(pkgRoot, 'package.json'),
    path.join(pkgRoot, '..', 'package.json'),
  ]) {
    try {
      if (!existsSync(candidate)) continue;
      // Synchronous read is deliberate: this runs once, before the HTTP server starts.
      const raw = readFileSync(candidate, 'utf8');
      const parsed = JSON.parse(raw) as { version?: unknown };
      if (typeof parsed.version === 'string') return parsed.version;
    } catch {
      /* ignore — a missing or malformed package.json must never be fatal */
    }
  }
  return '0.0.0';
}

/** Expand a leading `~` using the *local* home directory. */
export function expandHome(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/') || input.startsWith('~\\')) return path.join(homedir(), input.slice(2));
  return input;
}

function readEnv(name: string): string | undefined {
  const value = process.env[name];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 0 || n > 65535) return fallback;
  return n;
}

function parseLogLevel(raw: string | undefined): LogLevel | undefined {
  if (raw === undefined) return undefined;
  const lower = raw.toLowerCase();
  return LOG_LEVELS.has(lower) ? (lower as LogLevel) : undefined;
}

/** URL-safe random shared secret (§10): 32 bytes of entropy, base64url encoded. */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/** True for the values that turn `SSH_EXPLORER_NO_TOKEN` on. `0`, `false` and `no` do not. */
function isTruthyFlag(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const lower = raw.toLowerCase();
  return lower === '1' || lower === 'true' || lower === 'yes' || lower === 'on';
}

/**
 * Resolves the three states of §10:
 *
 * - an explicit string (option or `SSH_EXPLORER_TOKEN`) is required as-is;
 * - `null` (option) or `SSH_EXPLORER_NO_TOKEN=1` disables the requirement entirely;
 * - omitting it generates a random token, so a fresh install is never open by accident.
 *
 * An explicit `createServer({ token })` override always wins over the environment: the
 * integration tests pass `null` and must keep working even on a machine that exports a token.
 */
export function resolveToken(override: string | null | undefined): { token: string | null; source: TokenSource } {
  if (override !== undefined) {
    return override === null || override === ''
      ? { token: null, source: 'disabled' }
      : { token: override, source: 'explicit' };
  }
  if (isTruthyFlag(readEnv('SSH_EXPLORER_NO_TOKEN'))) return { token: null, source: 'env-no-token' };

  const fromEnv = readEnv('SSH_EXPLORER_TOKEN');
  if (fromEnv !== undefined) return { token: fromEnv, source: 'explicit' };

  return { token: generateToken(), source: 'generated' };
}

/** Resolves the directory of the built web app, or `null` when it does not exist. */
function detectStaticDir(explicit: string | undefined): string | null {
  if (explicit) {
    const abs = path.resolve(expandHome(explicit));
    return existsSync(abs) ? abs : null;
  }
  const candidate = path.join(pkgRoot, '..', 'web', 'dist');
  return existsSync(candidate) ? path.resolve(candidate) : null;
}

export function loadConfig(overrides: ConfigOverrides = {}): Config {
  const home = homedir();

  const stateDir = path.resolve(
    expandHome(overrides.stateDir ?? readEnv('SSH_EXPLORER_HOME') ?? path.join(home, '.ssh-explorer')),
  );

  const downloadDir = path.resolve(
    expandHome(
      overrides.downloadDir ??
        readEnv('SSH_EXPLORER_DOWNLOAD_DIR') ??
        path.join(home, 'Downloads', 'SSH Explorer'),
    ),
  );

  const envLogLevel = parseLogLevel(readEnv('SSH_EXPLORER_LOG_LEVEL'));

  const { token, source: tokenSource } = resolveToken(overrides.token);

  const staticDir =
    overrides.staticDir === null
      ? null
      : detectStaticDir(overrides.staticDir ?? readEnv('SSH_EXPLORER_STATIC'));

  return {
    port: overrides.port ?? parsePort(readEnv('SSH_EXPLORER_PORT'), DEFAULT_PORT),
    host: overrides.host ?? readEnv('SSH_EXPLORER_HOST') ?? DEFAULT_HOST,
    homeDir: home,
    stateDir,
    knownHostsPath: path.join(stateDir, 'known_hosts'),
    profilesPath: path.join(stateDir, 'profiles.json'),
    secretsPath: path.join(stateDir, 'secrets.json'),
    secretKeyPath: path.join(stateDir, 'secret.key'),
    settingsPath: path.join(stateDir, 'settings.json'),
    downloadDir,
    staticDir,
    logLevel: overrides.logLevel ?? envLogLevel ?? 'info',
    logFilePath:
      overrides.logFilePath ??
      readEnv('SSH_EXPLORER_LOG_FILE') ??
      path.join(stateDir, 'logs', 'ssh-explorer.log'),
    token,
    tokenSource,
    version: packageVersion(),
  };
}
