import type { Request } from 'express';

import type { Config } from '../config.js';
import { badRequest, notFound } from '../errors.js';
import type { Logger } from '../logger.js';
import type { ProfileStore } from '../store/profileStore.js';
import type { SecretVault } from '../store/secretVault.js';
import type { SettingsStore } from '../store/settingsStore.js';
import type { SftpFs } from '../ssh/fsOps.js';
import type { KnownHostsStore } from '../ssh/hostKeys.js';
import type { SshConnection } from '../ssh/SshConnection.js';
import type { SshConnectionManager } from '../ssh/SshConnectionManager.js';
import type { TransferManager } from '../transfers/TransferManager.js';
import type { WsHub } from '../ws/hub.js';

/** Everything a route needs. Assembled once in `server.ts`. */
export interface RouteContext {
  config: Config;
  logger: Logger;
  hub: WsHub;
  profiles: ProfileStore;
  /** Encrypted store for saved credentials (contract §14). */
  secrets: SecretVault;
  /** Persisted transfer settings (contract §7). */
  settings: SettingsStore;
  /** Host key store: read by the handshake, managed by §15. */
  knownHosts: KnownHostsStore;
  connections: SshConnectionManager;
  transfers: TransferManager;
}

/** `:id` accepts a connection id or a saved profile id (contract §5). */
export function requireConnection(ctx: RouteContext, req: Request): SshConnection {
  const raw = req.params['id'];
  const id = typeof raw === 'string' ? raw : Array.isArray(raw) ? (raw[0] ?? '') : '';
  if (id === '') throw badRequest('A connection id is required.', { path: ['id'] });
  return ctx.connections.getOrThrow(id);
}

export function requireAuthenticatedConnection(ctx: RouteContext, req: Request): SshConnection {
  const connection = requireConnection(ctx, req);
  if (!connection.isAuthenticated) {
    throw notFound(`Connection ${connection.id} is not authenticated.`, { id: connection.id });
  }
  return connection;
}

/** The per-connection filesystem facade. */
export function fsFor(ctx: RouteContext, connection: SshConnection): SftpFs {
  return connection.fs(ctx.logger);
}

/** Emits `fs:changed` after a mutating route (contract §8). */
export function notifyFsChanged(ctx: RouteContext, connectionId: string, path: string): void {
  ctx.hub.broadcast({ type: 'fs:changed', connectionId, path });
}

export function notifyToast(ctx: RouteContext, level: 'info' | 'warn' | 'error', message: string): void {
  ctx.hub.broadcast({ type: 'toast', level, message });
}
