import { EventEmitter } from 'node:events';
import { Client, FTPError } from 'basic-ftp';

import { ApiError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { ConnectionStatus, ConnectionSummary, ServerInfo } from '../types.js';
import { newId } from '../util/ids.js';
import { joinRemotePath, normalizeRemotePath } from '../util/remotePath.js';
import { FtpFs } from './FtpFs.js';

export interface FtpConnectionOptions {
  id?: string;
  label?: string;
  color?: string;
  host: string;
  port?: number;
  username?: string;
  password?: string;
  secure?: boolean;
  logger: Logger;
  readyTimeoutMs?: number;
}

const DEFAULT_READY_TIMEOUT_MS = 20_000;
const KEEPALIVE_INTERVAL_MS = 30_000;

export class FtpConnection extends EventEmitter {
  readonly id: string;
  label: string;
  color: string;
  readonly host: string;
  readonly port: number;
  readonly username: string;
  readonly password?: string;
  readonly secure: boolean;
  readonly authMethod = 'password' as const;
  readonly protocol = 'ftp' as const;
  profileId: string | undefined;

  private readonly options: FtpConnectionOptions;
  private readonly logger: Logger;

  private client: Client | null = null;
  private _fs: FtpFs | null = null;
  private closed = false;

  private homeDir = '/';
  private info: ServerInfo | null = null;
  private connectedAt: number | null = null;
  private statusValue: ConnectionStatus = 'connecting';
  private statusDetailValue: string | undefined;
  private latency: number | null = null;
  private latencyTimer: NodeJS.Timeout | null = null;
  private auxiliaryFailedAt: number | null = null;

  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: FtpConnectionOptions) {
    super();
    this.options = options;
    this.host = options.host;
    this.port = options.port ?? 21;
    this.username = options.username || 'anonymous';
    this.password = options.password ?? '';
    this.secure = options.secure ?? false;
    this.logger = options.logger.child({ ftp: `${this.username}@${this.host}:${this.port}` });
    this.id = options.id ?? newId('conn');
    this.label = options.label ?? `ftp://${this.username}@${this.host}`;
    this.color = options.color ?? 'mint';
  }

  get isAuthenticated(): boolean {
    return this.statusValue === 'authenticated' && !this.closed;
  }

  get serverInfo(): ServerInfo | null {
    return this.info;
  }

  get latencyMs(): number | null {
    return this.latency;
  }

  summary(): ConnectionSummary {
    return {
      id: this.id,
      label: this.label,
      color: this.color,
      host: this.host,
      port: this.port,
      username: this.username,
      authMethod: this.authMethod,
      protocol: this.protocol,
      status: this.statusValue,
      ...(this.statusDetailValue !== undefined ? { statusDetail: this.statusDetailValue } : {}),
      hostKeyFingerprint: '',
      connectedAt: this.connectedAt,
      latencyMs: this.latency,
      ...(this.info !== null ? { serverInfo: this.info } : {}),
    };
  }

  remoteHome(): string {
    return this.homeDir;
  }

  resolvePath(input: string | undefined, baseDir?: string): string {
    const raw = (input ?? '').trim();
    if (raw === '' || raw === '.') return baseDir ?? this.homeDir;
    if (raw === '~' || raw.startsWith('~/')) {
      const home = this.homeDir;
      return raw === '~' ? home : joinRemotePath(home, raw.slice(2));
    }
    if (raw.startsWith('/')) return normalizeRemotePath(raw);
    return joinRemotePath(baseDir ?? this.homeDir, raw);
  }

  fs(logger: Logger): FtpFs {
    if (this._fs === null) {
      this._fs = new FtpFs(this, logger);
    }
    return this._fs;
  }

  /**
   * Serialises metadata commands on the primary control connection to prevent
   * 'Client is busy' errors.
   */
  async withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
    if (this.closed || this.client === null) {
      throw new ApiError('CONNECT_FAILED', 'FTP connection is closed.');
    }
    const run = async (): Promise<T> => {
      if (this.closed || this.client === null) {
        throw new ApiError('CONNECT_FAILED', 'FTP connection is closed.');
      }
      return await fn(this.client);
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => undefined);
    return (await next) as T;
  }

  /**
   * Spawns a dedicated auxiliary FTP client for streaming file transfers (upload/download),
   * allowing transfers to stream concurrently without blocking the control connection.
   */
  async createTransferClient(timeoutMs?: number): Promise<Client | null> {
    if (this.auxiliaryFailedAt !== null && Date.now() - this.auxiliaryFailedAt < 60_000) {
      return null;
    }
    const timeout = Math.min(timeoutMs ?? 4_000, this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
    const client = new Client(timeout);
    try {
      await client.access({
        host: this.host,
        port: this.port,
        user: this.username,
        password: this.password,
        secure: this.secure,
      });
      return client;
    } catch (err) {
      this.auxiliaryFailedAt = Date.now();
      this.logger.debug('Auxiliary FTP transfer client unavailable, falling back to control connection', { error: err });
      client.close();
      return null;
    }
  }

  async connect(): Promise<void> {
    if (this.closed) throw new ApiError('CONNECT_FAILED', 'The connection has been closed.', { reason: 'CLOSED' });
    if (this.client !== null) throw new Error('FtpConnection.connect() may only be called once');

    this.setStatus('connecting', undefined);
    const timeout = this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS;
    const client = new Client(timeout);
    this.client = client;

    try {
      await client.access({
        host: this.host,
        port: this.port,
        user: this.username,
        password: this.password,
        secure: this.secure,
      });

      // Probe current directory as home
      try {
        const pwd = await client.pwd();
        if (pwd) this.homeDir = normalizeRemotePath(pwd);
      } catch {
        this.homeDir = '/';
      }

      this.info = {
        platform: 'ftp',
        release: '',
        arch: '',
        home: this.homeDir,
        cwd: this.homeDir,
        shell: '',
        username: this.username,
        hostname: this.host,
      };

      this.connectedAt = Date.now();
      this.setStatus('authenticated', undefined);
      this.startKeepalive();
    } catch (err) {
      this.close('Authentication or connection failed.');
      if (err instanceof FTPError) {
        if (err.code === 530) {
          throw new ApiError('AUTH_FAILED', `FTP authentication failed: ${err.message}`, { code: err.code });
        }
        throw new ApiError('CONNECT_FAILED', `FTP connection failed: ${err.message}`, { code: err.code });
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new ApiError('CONNECT_FAILED', `FTP connection failed: ${message}`);
    }
  }

  private startKeepalive(): void {
    if (this.latencyTimer !== null) clearInterval(this.latencyTimer);
    this.latencyTimer = setInterval(async () => {
      if (!this.isAuthenticated) return;
      const start = Date.now();
      try {
        await this.withClient((c) => c.pwd());
        this.latency = Math.max(1, Date.now() - start);
        this.emit('status', this.summary());
      } catch (err) {
        this.logger.debug('ftp keepalive failed', { error: err });
        this.setStatus('disconnected', 'Keepalive failed.');
      }
    }, KEEPALIVE_INTERVAL_MS);
    this.latencyTimer.unref?.();
  }

  private setStatus(status: ConnectionStatus, detail?: string): void {
    this.statusValue = status;
    this.statusDetailValue = detail;
    this.emit('status', this.summary());
  }

  async reconnect(): Promise<void> {
    this.close('Reconnecting');
    this.closed = false;
    this.client = null;
    this._fs = null;
    await this.connect();
  }

  close(reason = 'Closed.'): void {
    if (this.closed) return;
    this.closed = true;
    if (this.latencyTimer !== null) {
      clearInterval(this.latencyTimer);
      this.latencyTimer = null;
    }
    if (this.client !== null) {
      try {
        this.client.close();
      } catch {
        /* ignore */
      }
      this.client = null;
    }
    this.setStatus('disconnected', reason);
    this.emit('closed', reason);
  }

  async exec(_command: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
    throw new ApiError('NOT_SUPPORTED', 'FTP connections do not support command execution.');
  }

  async shell(): Promise<never> {
    throw new ApiError('NOT_SUPPORTED', 'FTP connections do not support terminal shell sessions.');
  }

  async persistHostKey(): Promise<void> {
    // FTP connections do not use SSH host keys
  }
}
