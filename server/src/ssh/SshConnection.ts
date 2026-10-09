import { Client as SshClient } from 'ssh2';
import type { Client, ClientChannel, ConnectConfig, ExecOptions, PseudoTtyOptions, SFTPWrapper } from 'ssh2';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';

import { ApiError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { AuthMethod, ConnectionStatus, ConnectionSummary, ServerInfo } from '../types.js';
import { newId } from '../util/ids.js';
import { joinRemotePath } from '../util/remotePath.js';
import type { KnownHostsStore } from './hostKeys.js';
import { computeFingerprint, formatHostPattern } from './hostKeys.js';
import { SftpFs } from './fsOps.js';

/** Credentials, held in memory only — never serialised, never logged, never written to disk. */
export type SshCredentials =
  | { method: 'password'; password: string }
  | { method: 'privateKey'; privateKey?: string | Buffer; privateKeyPath?: string; passphrase?: string }
  | { method: 'agent'; socket?: string };

export interface SshConnectionOptions {
  id?: string;
  label?: string;
  color?: string;
  host: string;
  port: number;
  username: string;
  credentials: SshCredentials;
  hostKeys: KnownHostsStore;
  logger: Logger;
  /** `true` when the user accepted the fingerprint shown by the trust dialog. */
  trustHostKey?: boolean;
  /** Fingerprint echoed back by the client when trusting. A different one is a MISMATCH. */
  expectedFingerprint?: string;
  readyTimeoutMs?: number;
  /** Toggled off by the manager during shutdown so no timers survive. */
  measureLatency?: boolean;
}

interface PresentedHostKey {
  keyType: string;
  blob: Buffer;
  base64: string;
  fingerprint: string;
}

const DEFAULT_READY_TIMEOUT_MS = 20_000;
const LATENCY_INTERVAL_MS = 30_000;
const KEEPALIVE_INTERVAL_MS = 15_000;

const SERVER_INFO_COMMAND =
  'uname -s; uname -r; uname -m; echo $HOME; pwd; echo $SHELL; id -un; hostname';

/** Turn an ssh2 channel into a whole-buffer result, honouring a timeout. */
interface ExecOutcome {
  stdout: string;
  stderr: string;
  code: number | null;
}

function firstLine(text: string): string {
  const line = text.split('\n')[0] ?? '';
  return line.trim();
}

/**
 * One wrapped `ssh2.Client`.
 *
 * Lifetime: `connect()` → use → `close()`. All failures are surfaced as {@link ApiError} so the
 * HTTP layer can render the §1 envelope unchanged.
 */
export class SshConnection extends EventEmitter {
  readonly id: string;
  label: string;
  color: string;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly authMethod: AuthMethod;
  /** Set when this connection was created from a saved profile (§5 `:id` may be a profile id). */
  profileId: string | undefined;

  private readonly options: SshConnectionOptions;
  private readonly logger: Logger;

  /**
   * Credentials, held in memory only. Public *read-only* on purpose so `SshConnectionManager`
   * can reuse them for `reconnect`; nothing in `summary()`, the event bus or any log ever reads
   * this field, and it is never written to disk.
   */
  readonly credentials: SshCredentials;

  private client: Client | null = null;
  private sftpSession: SFTPWrapper | null = null;
  private sftpPending: Promise<SFTPWrapper> | null = null;
  private closed = false;

  private presentedKey: PresentedHostKey | null = null;
  /** Last error emitted by the ssh2 client; used to explain an unexpected disconnect. */
  private lastClientError: Error | null = null;
  private negotiatedHostKeyAlgorithm: string | undefined;
  private verifiedFingerprint = '';
  private hostKeyFailure: ApiError | null = null;

  private resolvedHome: string | null = null;
  private _fs: SftpFs | null = null;
  private info: ServerInfo | null = null;
  private connectedAt: number | null = null;
  private statusValue: ConnectionStatus = 'connecting';
  private statusDetailValue: string | undefined;
  private latency: number | null = null;
  private latencyTimer: NodeJS.Timeout | null = null;

  constructor(options: SshConnectionOptions) {
    super();
    this.options = options;
    this.logger = options.logger.child({ ssh: `${options.username}@${options.host}:${options.port}` });
    this.id = options.id ?? newId('conn');
    this.label = options.label ?? `${options.username}@${options.host}`;
    this.color = options.color ?? 'slate';
    this.host = options.host;
    this.port = options.port;
    this.username = options.username;
    this.credentials = options.credentials;
    this.authMethod = options.credentials.method;
  }

  // ---------------------------------------------------------------- connection

  /** Resolves only after the `ready` event; every other outcome is a typed {@link ApiError}. */
  async connect(): Promise<void> {
    if (this.closed) throw new ApiError('CONNECT_FAILED', 'The connection has been closed.', { reason: 'CLOSED' });
    if (this.client !== null) throw new Error('SshConnection.connect() may only be called once');

    const client = new SshClient();
    this.client = client;
    this.setStatus('connecting', undefined);

    // ssh2 keeps emitting after a failed or torn-down attempt (for example
    // "Connection lost before handshake" when a refused socket is destroyed). Without a
    // permanent listener those late errors become unhandled 'error' events and kill the
    // process, so this sink stays attached for the whole lifetime of the client.
    client.on('error', (err: Error) => {
      this.lastClientError = err;
      this.logger.debug('ssh client error', { error: err });
    });

    const config = await this.buildConnectConfig();

    await new Promise<void>((resolve, reject) => {
      let settled = false;

      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        client.removeListener('ready', onReady);
        client.removeListener('error', onError);
        client.removeListener('close', onClose);
        if (err === undefined) {
          resolve();
        } else {
          reject(err);
        }
      };

      const onReady = (): void => finish();
      const onError = (err: Error): void => {
        // A rejected host key surfaces here as a generic handshake error; prefer the specific one.
        if (this.hostKeyFailure !== null) {
          finish(this.hostKeyFailure);
          return;
        }
        finish(err);
      };
      const onClose = (): void => {
        finish(this.hostKeyFailure ?? new ApiError('CONNECT_FAILED', 'The connection was closed before authentication completed.', { reason: 'CONNECTION_CLOSED' }));
      };

      const timeoutMs = this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
      const timer = setTimeout(() => {
        finish(new ApiError('CONNECT_FAILED', 'The connection attempt timed out.', { reason: 'ETIMEDOUT' }));
        try {
          client.destroy();
        } catch {
          /* already gone */
        }
      }, timeoutMs);
      timer.unref?.();

      client.once('ready', onReady);
      client.once('error', onError);
      client.once('close', onClose);
      client.on('handshake', (negotiated: { srvHostKey?: string }) => {
        this.negotiatedHostKeyAlgorithm = negotiated.srvHostKey;
      });
      // A transport that dies on its own must be visible to the UI, not silently unusable.
      client.on('close', () => {
        if (this.closed || this.client !== client) return;
        if (this.statusValue === 'authenticated' || this.statusValue === 'connecting') {
          const detail =
            this.lastClientError !== null
              ? `The SSH connection was lost: ${this.lastClientError.message}`
              : 'The SSH connection was closed by the remote host.';
          this.sftpSession = null;
          this.setStatus('disconnected', detail);
          this.emit('closed', detail);
        }
      });

      try {
        client.connect(config);
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });

    this.connectedAt = Date.now();
    this.setStatus('authenticated', undefined);

    if (this.verifiedFingerprint === '' && this.presentedKey !== null) {
      this.verifiedFingerprint = this.presentedKey.fingerprint;
    }

    // Server info is best effort: a failure here must not fail the connection.
    this.info = await this.collectServerInfo().catch((err: unknown) => {
      this.logger.warn('could not collect server info', { error: err });
      return null;
    });

    if (this.options.measureLatency !== false) this.startLatencyProbe();
  }

  /**
   * Drops the SSH transport and dials again with the credentials already held in memory
   * (contract §5 `POST /connections/:id/reconnect`). The connection id is preserved so client
   * state keyed by id keeps working.
   */
  async reconnect(): Promise<void> {
    this.logger.info('reconnecting', { id: this.id });

    if (this.latencyTimer !== null) {
      clearInterval(this.latencyTimer);
      this.latencyTimer = null;
    }
    this.sftpSession = null;
    this.sftpPending = null;
    this.info = null;
    this.connectedAt = null;
    this.hostKeyFailure = null;
    this.presentedKey = null;
    this.negotiatedHostKeyAlgorithm = undefined;
    this.verifiedFingerprint = '';
    this.statusValue = 'connecting';
    this.statusDetailValue = undefined;
    this.emitStatus();

    const client = this.client;
    this.client = null;
    if (client !== null) {
      try {
        client.end();
      } catch {
        /* ignore */
      }
      try {
        client.destroy();
      } catch {
        /* ignore */
      }
    }

    return this.connect();
  }

  private async buildConnectConfig(): Promise<ConnectConfig> {
    const config: ConnectConfig = {
      host: this.host,
      port: this.port,
      username: this.username,
      readyTimeout: this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
      keepaliveInterval: KEEPALIVE_INTERVAL_MS,
      keepaliveCountMax: 3,
      hostVerifier: (key: Buffer | string, callback?: (accept: boolean) => void) => {
        const blob = Buffer.isBuffer(key) ? key : Buffer.from(String(key), 'utf8');
        void this.verifyHostKey(blob)
          .then((ok) => callback?.(ok))
          .catch((err: unknown) => {
            this.logger.warn('host key verification failed', { error: err });
            callback?.(false);
          });
        // The callback form is asynchronous: never accept synchronously.
        return undefined;
      },
    };

    const credentials = this.credentials;
    if (credentials.method === 'password') {
      config.password = credentials.password;
    } else if (credentials.method === 'privateKey') {
      config.privateKey = await this.resolvePrivateKey(credentials);
      if (credentials.passphrase !== undefined) config.passphrase = credentials.passphrase;
    } else {
      config.agent = credentials.socket !== undefined && credentials.socket !== '' ? credentials.socket : 'pageant';
    }

    return config;
  }

  /** Reads a key from disk when the caller passed a path instead of material. */
  private async resolvePrivateKey(credentials: Extract<SshCredentials, { method: 'privateKey' }>): Promise<string | Buffer> {
    if (credentials.privateKey !== undefined && credentials.privateKey !== '') return credentials.privateKey;
    if (credentials.privateKeyPath === undefined || credentials.privateKeyPath === '') {
      throw new ApiError('BAD_REQUEST', 'A private key is required for privateKey authentication.');
    }
    try {
      return await readFile(credentials.privateKeyPath);
    } catch (err) {
      const code = (err as { code?: string }).code;
      throw new ApiError('AUTH_FAILED', `The private key at ${credentials.privateKeyPath} could not be read.`, {
        reason: code ?? 'KEY_UNREADABLE',
      });
    }
  }

  /**
   * Compares the presented host key with the stored one.
   *
   * - stored key matches            → accept
   * - host unknown, `trustHostKey`  → accept and record the fingerprint in memory (the caller
   *   persists it only after authentication actually succeeds)
   * - host unknown, no trust flag   → `HOST_KEY_UNKNOWN`
   * - stored key differs            → `HOST_KEY_MISMATCH`, or `HOST_KEY_UNKNOWN` when the client
   *   echoed a *different* fingerprint than the one presented (contract §5)
   */
  private async verifyHostKey(blob: Buffer): Promise<boolean> {
    const keyType = this.keyTypeOf(blob);
    const presented: PresentedHostKey = {
      keyType,
      blob,
      base64: blob.toString('base64'),
      fingerprint: computeFingerprint(blob),
    };
    this.presentedKey = presented;

    const knownHostsPath = this.options.hostKeys.writePath;
    const lookup = await this.options.hostKeys.verify(this.host, this.port, blob);

    if (lookup.status === 'match') {
      this.verifiedFingerprint = presented.fingerprint;
      return true;
    }

    if (lookup.status === 'revoked') {
      this.hostKeyFailure = new ApiError('HOST_KEY_MISMATCH', `The host key for ${this.host} is marked as revoked.`, {
        host: this.host,
        port: this.port,
        fingerprint: presented.fingerprint,
        expected: lookup.fingerprint,
        knownHostsPath,
        revoked: true,
      });
      return false;
    }

    if (lookup.status === 'mismatch') {
      this.hostKeyFailure = new ApiError('HOST_KEY_MISMATCH', `The host key presented by ${this.host} has changed.`, {
        host: this.host,
        port: this.port,
        fingerprint: presented.fingerprint,
        expected: lookup.expected,
        knownHostsPath,
      });
      return false;
    }

    // Unknown host.
    if (this.options.trustHostKey === true) {
      const echoed = this.options.expectedFingerprint;
      if (echoed !== undefined && echoed !== presented.fingerprint) {
        this.hostKeyFailure = new ApiError(
          'HOST_KEY_MISMATCH',
          `The host key presented by ${this.host} does not match the fingerprint that was trusted.`,
          {
            host: this.host,
            port: this.port,
            fingerprint: presented.fingerprint,
            expected: echoed,
            knownHostsPath,
          },
        );
        return false;
      }
      this.verifiedFingerprint = presented.fingerprint;
      return true;
    }

    this.hostKeyFailure = new ApiError('HOST_KEY_UNKNOWN', `The host key for ${this.host} is not known yet.`, {
      host: this.host,
      port: this.port,
      fingerprint: presented.fingerprint,
      keyType: presented.keyType,
      knownHostsPath,
      algorithm: this.negotiatedHostKeyAlgorithm ?? presented.keyType,
    });
    return false;
  }

  /** Algorithm name of the presented key, taken from the wire format. */
  private keyTypeOf(blob: Buffer): string {
    try {
      const length = blob.readUInt32BE(0);
      if (length > 0 && length <= blob.length - 4) {
        const name = blob.subarray(4, 4 + length).toString('utf8');
        if (/^[A-Za-z0-9@._+-]+$/.test(name)) return name;
      }
    } catch {
      /* fall through to the negotiated algorithm */
    }
    return this.negotiatedHostKeyAlgorithm ?? 'unknown';
  }

  /**
   * Persists a trusted key. Called by the manager *after* authentication succeeded, so a
   * fingerprint is never recorded for a host we could not actually talk to.
   */
  async persistHostKey(): Promise<boolean> {
    const key = this.presentedKey;
    if (key === null || this.verifiedFingerprint !== key.fingerprint) return false;
    try {
      return await this.options.hostKeys.append(this.host, this.port, key.keyType, key.base64);
    } catch (err) {
      this.logger.warn('could not append to known_hosts', { error: err });
      return false;
    }
  }

  private startLatencyProbe(): void {
    if (this.latencyTimer !== null) return;
    const timer = setInterval(() => {
      void this.measureLatency();
    }, LATENCY_INTERVAL_MS);
    // Never keep the process alive just to measure latency.
    timer.unref?.();
    this.latencyTimer = timer;
  }

  /** Round-trips a trivial SFTP call and records the result. */
  async measureLatency(): Promise<number | null> {
    if (this.statusValue !== 'authenticated') return this.latency;
    const started = process.hrtime.bigint();
    try {
      const sftp = await this.sftp();
      await new Promise<void>((resolve, reject) => {
        sftp.realpath('.', (err) => (err ? reject(err) : resolve()));
      });
      const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
      this.latency = Math.max(1, Math.round(elapsed));
      this.emitStatus();
      return this.latency;
    } catch {
      return this.latency;
    }
  }

  // ---------------------------------------------------------------------- sftp

  /** One cached SFTP session per SSH connection, opened at most once at a time. */
  async sftp(): Promise<SFTPWrapper> {
    if (this.closed) throw new ApiError('CONNECT_FAILED', 'The connection is closed.', { reason: 'CLOSED' });
    if (this.sftpSession !== null) return this.sftpSession;
    if (this.sftpPending !== null) return this.sftpPending;

    const client = this.client;
    if (client === null || this.statusValue !== 'authenticated') {
      throw new ApiError('CONNECT_FAILED', 'The connection is not authenticated.', { reason: 'NOT_AUTHENTICATED' });
    }

    const pending = new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((err, sftp) => {
        if (err !== undefined && err !== null) {
          reject(
            new ApiError('SFTP_UNAVAILABLE', 'The SSH server refused the sftp subsystem.', {
              reason: (err as { message?: string }).message ?? 'UNKNOWN',
            }),
          );
          return;
        }
        if (sftp === undefined) {
          reject(new ApiError('SFTP_UNAVAILABLE', 'The SSH server did not provide an sftp session.'));
          return;
        }
        this.sftpSession = sftp;
        // A dying SFTP session must never be handed out again.
        sftp.once('close', () => {
          if (this.sftpSession === sftp) this.sftpSession = null;
        });
        sftp.on('error', () => {
          if (this.sftpSession === sftp) this.sftpSession = null;
        });
        resolve(sftp);
      });
    }).finally(() => {
      this.sftpPending = null;
    });

    this.sftpPending = pending;
    return pending;
  }

  /**
   * Runs `fn` against the cached SFTP session, re-opening it once when the session turns out to
   * be dead. Callers never see a closed session.
   */
  async withSftp<T>(fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    const sftp = await this.sftp();
    try {
      return await fn(sftp);
    } catch (err) {
      if (!isSftpSessionError(err)) throw err;
      if (this.sftpSession === sftp) this.sftpSession = null;
      const reopened = await this.sftp();
      if (reopened === sftp) throw err;
      return fn(reopened);
    }
  }

  // ---------------------------------------------------------------------- exec

  /** Runs a command and buffers its output (bounded by `maxBytes`). */
  async exec(command: string, options: { timeoutMs?: number; maxBytes?: number; pty?: PseudoTtyOptions | boolean } = {}): Promise<ExecOutcome> {
    const client = this.client;
    if (client === null || this.statusValue !== 'authenticated') {
      throw new ApiError('CONNECT_FAILED', 'The connection is not authenticated.', { reason: 'NOT_AUTHENTICATED' });
    }

    const maxBytes = options.maxBytes ?? 4 * 1024 * 1024;
    const timeoutMs = options.timeoutMs ?? 30_000;

    const execOptions: ExecOptions = {};
    if (options.pty !== undefined) execOptions.pty = options.pty;

    return new Promise<ExecOutcome>((resolve, reject) => {
      let settled = false;
      let stdout = '';
      let stderr = '';
      let code: number | null = null;

      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err === undefined) {
          resolve({ stdout, stderr, code });
        } else {
          reject(err);
        }
      };

      const timer = setTimeout(() => {
        try {
          channel?.close();
        } catch {
          /* ignore */
        }
        finish(
          new ApiError('REMOTE_ERROR', `The remote command timed out after ${timeoutMs} ms.`, {
            reason: 'ETIMEDOUT',
            command,
          }),
        );
      }, timeoutMs);
      timer.unref?.();

      let channel: ClientChannel | undefined;
      try {
        client.exec(command, execOptions, (err, stream) => {
          if (err !== undefined && err !== null) {
            finish(
              new ApiError('REMOTE_ERROR', `The remote command could not be started: ${err.message}`, {
                reason: 'EXEC_FAILED',
              }),
            );
            return;
          }
          channel = stream;
          stream.on('data', (chunk: Buffer) => {
            if (stdout.length < maxBytes) stdout += chunk.toString('utf8');
          });
          stream.stderr.on('data', (chunk: Buffer) => {
            if (stderr.length < maxBytes) stderr += chunk.toString('utf8');
          });
          stream.on('exit', (exitCode: number | null) => {
            code = exitCode;
          });
          stream.on('error', (streamErr: Error) => finish(streamErr));
          stream.on('close', (exitCode?: number | null, signal?: string | null) => {
            if (typeof exitCode === 'number') code = exitCode;
            if (settled) return;
            if (signal !== undefined && signal !== null) {
              finish(
                new ApiError('REMOTE_ERROR', `The remote command was terminated by ${signal}.`, {
                  reason: signal,
                  command,
                }),
              );
              return;
            }
            finish();
          });
        });
      } catch (err) {
        finish(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Opens an interactive shell channel. The caller owns the returned stream. */
  shell(window: PseudoTtyOptions | false): Promise<ClientChannel> {
    const client = this.client;
    if (client === null || this.statusValue !== 'authenticated') {
      return Promise.reject(
        new ApiError('CONNECT_FAILED', 'The connection is not authenticated.', { reason: 'NOT_AUTHENTICATED' }),
      );
    }
    return new Promise<ClientChannel>((resolve, reject) => {
      try {
        client.shell(window, (err, stream) => {
          if (err !== undefined && err !== null) {
            reject(new ApiError('REMOTE_ERROR', `Could not open a shell: ${err.message}`, { reason: 'SHELL_FAILED' }));
            return;
          }
          resolve(stream);
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  // -------------------------------------------------------------- server info

  /**
   * Collects `serverInfo` once. Uses one combined `exec` and falls back to SFTP `realpath('.')`
   * when the server does not support `exec` at all (contract §2).
   */
  private async collectServerInfo(): Promise<ServerInfo | null> {
    let home: string | null = null;
    let cwd: string | null = null;
    let platform = '';
    let release = '';
    let arch = '';
    let shell = '';
    let username = this.username;
    let hostname = this.host;

    try {
      const result = await this.exec(SERVER_INFO_COMMAND, { timeoutMs: 8_000 });
      const lines = result.stdout.split('\n').map((line) => line.trim());
      const at = (index: number): string => lines[index] ?? '';
      platform = at(0);
      release = at(1);
      arch = at(2);
      home = at(3) === '' ? null : at(3);
      cwd = at(4) === '' ? null : at(4);
      shell = at(5);
      if (at(6) !== '') username = at(6);
      if (at(7) !== '') hostname = at(7);

      // `pwd` inside a non-interactive shell can legitimately report the home directory.
      if (home !== null && cwd === home) cwd = home;
    } catch (err) {
      this.logger.debug('server info exec failed', { error: err });
    }

    // Fallback / completion over SFTP: `realpath('.')` is defined for every server.
    if (home === null || cwd === null) {
      try {
        const resolved = await this.withSftp(
          (sftp) =>
            new Promise<string>((resolve, reject) => {
              sftp.realpath('.', (err, absPath) => {
                if (err !== undefined && err !== null) reject(err);
                else resolve(absPath ?? '');
              });
            }),
        );
        if (resolved !== '') {
          cwd ??= resolved;
          home ??= resolved;
        }
      } catch (err) {
        this.logger.debug('realpath fallback failed', { error: err });
      }
    }

    this.resolvedHome = home;

    if (home === null && cwd === null && platform === '') return null;

    return {
      platform: platform === '' ? 'unknown' : platform,
      release: release === '' ? 'unknown' : release,
      arch: arch === '' ? 'unknown' : arch,
      home: home ?? cwd ?? '.',
      cwd: cwd ?? home ?? '.',
      shell,
      username,
      hostname,
    };
  }

  /**
   * The per-connection filesystem facade (§6). Cached so the uid/gid lookup and the resolved
   * home directory survive across requests.
   */
  fs(logger: Logger): SftpFs {
    if (this._fs === null) {
      this._fs = new SftpFs(this, logger.child({ ssh: `${this.username}@${this.host}` }));
    }
    return this._fs;
  }

  /** Absolute remote home directory, resolved on demand when `serverInfo` is unavailable. */
  async remoteHome(): Promise<string> {
    if (this.resolvedHome !== null) return this.resolvedHome;
    if (this.info !== null) {
      this.resolvedHome = this.info.home;
      return this.resolvedHome;
    }
    const resolved = await this.withSftp(
      (sftp) =>
        new Promise<string>((resolve, reject) => {
          sftp.realpath('.', (err, absPath) => {
            if (err !== undefined && err !== null) reject(err);
            else resolve(absPath ?? '/');
          });
        }),
    );
    this.resolvedHome = resolved === '' ? '/' : resolved;
    return this.resolvedHome;
  }

  /**
   * Resolves a user-typed remote path: `~` is expanded through `realpath` by the server itself,
   * relative paths are anchored at the home directory, and absolute paths are returned as-is.
   */
  async resolvePath(input: string | undefined, baseDir?: string): Promise<string> {
    if (input === undefined || input === '') {
      return baseDir ?? (await this.remoteHome());
    }
    if (input === '~') return this.remoteHome();
    if (input.startsWith('~/')) {
      return joinRemotePath(await this.remoteHome(), input.slice(2));
    }
    if (!input.startsWith('/')) {
      return joinRemotePath(baseDir ?? (await this.remoteHome()), input);
    }
    // Tilde inside a path (or a path the shell would expand) is left to `realpath`.
    return input.includes('~')
      ? this.realpath(input)
      : input;
  }

  /** `realpath` through SFTP, mapped to the §1 error table. */
  async realpath(remotePath: string): Promise<string> {
    return this.withSftp(
      (sftp) =>
        new Promise<string>((resolve, reject) => {
          sftp.realpath(remotePath, (err, absPath) => {
            if (err !== undefined && err !== null) reject(err);
            else resolve(absPath ?? remotePath);
          });
        }),
    );
  }

  // ------------------------------------------------------------------- queries

  get serverInfo(): ServerInfo | null {
    return this.info;
  }

  get latencyMs(): number | null {
    return this.latency;
  }

  get status(): ConnectionStatus {
    return this.statusValue;
  }

  get statusDetail(): string | undefined {
    return this.statusDetailValue;
  }

  get isAuthenticated(): boolean {
    return !this.closed && this.statusValue === 'authenticated';
  }

  get hostKeyFingerprint(): string {
    return this.verifiedFingerprint !== '' ? this.verifiedFingerprint : (this.presentedKey?.fingerprint ?? '');
  }

  /** Host pattern as it would appear in `known_hosts` (handy for error details). */
  get knownHostsPattern(): string {
    return formatHostPattern(this.host, this.port);
  }

  summary(): ConnectionSummary {
    const summary: ConnectionSummary = {
      id: this.id,
      label: this.label,
      color: this.color,
      host: this.host,
      port: this.port,
      username: this.username,
      authMethod: this.authMethod,
      status: this.statusValue,
      hostKeyFingerprint: this.hostKeyFingerprint,
      connectedAt: this.connectedAt,
      latencyMs: this.latency,
    };
    if (this.statusDetailValue !== undefined) summary.statusDetail = this.statusDetailValue;
    if (this.info !== null) summary.serverInfo = this.info;
    return summary;
  }

  private setStatus(status: ConnectionStatus, detail: string | undefined): void {
    this.statusValue = status;
    this.statusDetailValue = detail;
    this.emitStatus();
  }

  private emitStatus(): void {
    this.emit('status', this.summary());
  }

  // --------------------------------------------------------------------- close

  /** Idempotent: ends the SSH transport (which destroys the socket) and drops all state. */
  close(reason?: string): void {
    if (this.closed) return;
    this.closed = true;

    if (this.latencyTimer !== null) {
      clearInterval(this.latencyTimer);
      this.latencyTimer = null;
    }

    const session = this.sftpSession;
    this.sftpSession = null;
    if (session !== null) {
      try {
        session.end();
      } catch {
        /* already gone */
      }
    }

    const client = this.client;
    this.client = null;
    if (client !== null) {
      try {
        client.end();
      } catch {
        /* ignore */
      }
      // `end()` waits for a graceful disconnect; destroy guarantees the socket is gone.
      try {
        client.destroy();
      } catch {
        /* ignore */
      }
    }

    this.setStatus('disconnected', reason ?? 'Connection closed.');
    this.emit('closed', reason ?? 'closed');
    this.removeAllListeners();
  }
}

/** True when an error indicates the cached SFTP session itself is unusable. */
export function isSftpSessionError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === 6 || code === 7) return true; // SFTP NO_CONNECTION / CONNECTION_LOST
  const message = (err as { message?: unknown }).message;
  if (typeof message === 'string') {
    return /no connection|connection lost|channel.*(?:closed|not open)|SFTP session/i.test(message);
  }
  return false;
}
