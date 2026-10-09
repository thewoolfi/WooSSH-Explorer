import { EventEmitter } from 'node:events';

import { ApiError, notFound } from '../errors.js';
import type { Logger } from '../logger.js';
import type { ConnectionSummary, ServerInfo } from '../types.js';
import type { KnownHostsStore } from './hostKeys.js';
import { SshConnection } from './SshConnection.js';
import type { SshConnectionOptions, SshCredentials } from './SshConnection.js';

export interface ConnectRequest {
  profileId?: string;
  label?: string;
  color?: string;
  host: string;
  port: number;
  username: string;
  credentials: SshCredentials;
  trustHostKey?: boolean;
  hostKeyFingerprint?: string;
}

export interface ConnectOutcome {
  connection: SshConnection;
  summary: ConnectionSummary;
  /** `true` when an already-open connection for the same triple was reused (HTTP 200 vs 201). */
  reused: boolean;
}

export interface SshConnectionManagerOptions {
  hostKeys: KnownHostsStore;
  logger: Logger;
}

/**
 * Owns every {@link SshConnection} for the process lifetime.
 *
 * Contract §5: only one active connection per `(host, port, username)` triple is ever created;
 * asking twice returns the existing summary. Every status change is republished as the
 * `connection:status` / `connection:closed` events of §8.
 */
export class SshConnectionManager extends EventEmitter {
  private readonly connections = new Map<string, SshConnection>();
  private readonly byTriple = new Map<string, string>();
  private closed = false;

  constructor(private readonly options: SshConnectionManagerOptions) {
    super();
  }

  private static triple(host: string, port: number, username: string): string {
    return `${host}\u0000${port}\u0000${username}`;
  }

  /** All connections, newest last. */
  list(): ConnectionSummary[] {
    return [...this.connections.values()].map((connection) => connection.summary());
  }

  /** `:id` accepts a connection id (contract §5). */
  get(id: string): SshConnection | undefined {
    return this.connections.get(id);
  }

  /** `:id` accepts a connection id, a saved profile id, or `host:port` (contract §5). */
  getOrThrow(id: string, profileId?: string): SshConnection {
    const direct = this.connections.get(id);
    if (direct !== undefined) return direct;

    const byProfile = this.findByProfileId(profileId ?? id);
    if (byProfile !== undefined) return byProfile;

    throw notFound(`Unknown connection: ${id}.`);
  }

  findByProfileId(profileId: string): SshConnection | undefined {
    for (const connection of this.connections.values()) {
      if (connection.profileId === profileId) return connection;
    }
    return undefined;
  }

  /** Connects, or returns the already-authenticated connection for the same triple. */
  async connect(request: ConnectRequest, profileId?: string): Promise<ConnectOutcome> {
    if (this.closed) throw new ApiError('CONNECT_FAILED', 'The server is shutting down.', { reason: 'SHUTDOWN' });

    const key = SshConnectionManager.triple(request.host, request.port, request.username);
    const existingId = this.byTriple.get(key);
    if (existingId !== undefined) {
      const existing = this.connections.get(existingId);
      if (existing !== undefined && existing.isAuthenticated) {
        this.options.logger.debug('reusing existing connection', { id: existing.id, host: request.host });
        return { connection: existing, summary: existing.summary(), reused: true };
      }
      if (existing !== undefined) {
        // A previous attempt for this triple is still connecting or has failed: drop it.
        this.forget(existing.id);
      }
    }

    const connection = new SshConnection({
      ...this.buildOptions(request),
      ...(profileId !== undefined ? {} : {}),
    });
    if (profileId !== undefined) connection.profileId = profileId;

    this.attach(connection, key);

    try {
      await connection.connect();
    } catch (err) {
      // Contract §11.1: a failed attempt must not leak a socket.
      this.forget(connection.id);
      throw err;
    }

    // Only record the key once we know the host really is who it claimed to be.
    if (request.trustHostKey === true) {
      await connection.persistHostKey();
    }

    return { connection, summary: connection.summary(), reused: false };
  }

  private buildOptions(request: ConnectRequest): SshConnectionOptions {
    const options: SshConnectionOptions = {
      host: request.host,
      port: request.port,
      username: request.username,
      credentials: request.credentials,
      hostKeys: this.options.hostKeys,
      logger: this.options.logger,
    };
    if (request.label !== undefined) options.label = request.label;
    if (request.color !== undefined) options.color = request.color;
    if (request.trustHostKey !== undefined) options.trustHostKey = request.trustHostKey;
    if (request.hostKeyFingerprint !== undefined) options.expectedFingerprint = request.hostKeyFingerprint;
    return options;
  }

  private attach(connection: SshConnection, tripleKey: string): void {
    this.connections.set(connection.id, connection);
    this.byTriple.set(tripleKey, connection.id);

    connection.on('status', (summary: ConnectionSummary) => {
      this.emit('connection:status', summary);
    });
    connection.on('closed', (reason: string) => {
      this.emit('connection:closed', connection.id, reason);
    });
  }

  private forget(id: string): void {
    const connection = this.connections.get(id);
    if (connection === undefined) return;
    this.connections.delete(id);
    const key = SshConnectionManager.triple(connection.host, connection.port, connection.username);
    if (this.byTriple.get(key) === id) this.byTriple.delete(key);
    connection.removeAllListeners();
    connection.close('Connection failed.');
  }

  /**
   * Reconnects with the credentials still held in memory (contract §5). The connection id is
   * preserved and any transfer that was running on the old transport is cancelled.
   */
  async reconnect(id: string): Promise<ConnectionSummary> {
    const connection = this.getOrThrow(id);
    this.options.logger.info('reconnecting', { id: connection.id, host: connection.host });
    await connection.reconnect();
    return connection.summary();
  }

  /** Tears down SFTP, shells and transfers for one connection (contract §11.10). */
  close(id: string, reason = 'Closed by the client.'): void {
    const connection = this.connections.get(id);
    if (connection === undefined) throw notFound(`Unknown connection: ${id}.`);
    this.forget(id);
    connection.close(reason);
  }

  /** Closes every connection. Safe to call twice; never throws. */
  async closeAll(): Promise<void> {
    this.closed = true;
    for (const id of [...this.connections.keys()]) {
      try {
        this.connections.get(id)?.close('Server shutting down.');
      } catch {
        /* ignore */
      }
      this.connections.delete(id);
    }
    this.byTriple.clear();
  }

  serverInfoOf(id: string): ServerInfo | null {
    return this.connections.get(id)?.serverInfo ?? null;
  }
}
