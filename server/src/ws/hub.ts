import { WebSocketServer } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { WebSocket } from 'ws';

import type { Logger } from '../logger.js';
import type { ConnectionSummary, Transfer } from '../types.js';
import { newId, shortId } from '../util/ids.js';
import type { SshConnectionManager } from '../ssh/SshConnectionManager.js';
import type { ClientChannel, PseudoTtyOptions } from 'ssh2';

export const EVENT_WS_PATH = '/api/ws';
export const TERMINAL_WS_PATH = '/api/ws/terminal';

export type ToastLevel = 'info' | 'warn' | 'error';

/** Every frame the server pushes on the §8 event bus. */
export type ServerEvent =
  | { type: 'hello'; serverTime: number; version: string }
  | { type: 'connection:status'; connection: ConnectionSummary }
  | { type: 'connection:closed'; connectionId: string; reason: string }
  | { type: 'transfer:update'; transfer: Transfer }
  | { type: 'fs:changed'; connectionId: string; path: string }
  | { type: 'toast'; level: ToastLevel; message: string };

/** Frames the server sends on the §9 terminal socket. */
export type TerminalFrame =
  | { t: 'ready'; sessionId: string; term: string }
  | { t: 'output'; data: string }
  | { t: 'exit'; code: number | null; signal: string | null; reason: 'exited' | 'closed' | 'error' }
  | { t: 'error'; code: string; message: string };

export interface HubOptions {
  logger: Logger;
  version: string;
  /** Called before an upgrade is accepted; a falsy result rejects it. */
  authorize?: (req: IncomingMessage) => boolean;
  connections: SshConnectionManager;
}

const TERM = 'xterm-256color';
const MAX_TERMINAL_FRAME_BYTES = 8 * 1024 * 1024;

function parseQuery(url: string): URLSearchParams {
  const index = url.indexOf('?');
  return new URLSearchParams(index < 0 ? '' : url.slice(index + 1));
}

function pathnameOf(url: string | undefined): string {
  const raw = url ?? '';
  const index = raw.search(/[?#]/);
  return index < 0 ? raw : raw.slice(0, index);
}

function decodeToken(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The §8 event bus plus the §9 terminal bridge.
 *
 * One {@link WebSocketServer} is shared by both paths; upgrades are routed by pathname. The
 * sockets never carry credentials: only the summaries defined in the contract are ever sent.
 */
export class WsHub {
  private readonly bus: WebSocketServer;
  private readonly terminals: WebSocketServer;
  private readonly sessions = new Map<string, { ws: WebSocket; channel: ClientChannel }>();
  private closed = false;

  constructor(private readonly options: HubOptions) {
    const { logger } = options;

    this.bus = new WebSocketServer({ noServer: true, maxPayload: MAX_TERMINAL_FRAME_BYTES });
    this.terminals = new WebSocketServer({ noServer: true, maxPayload: MAX_TERMINAL_FRAME_BYTES });

    this.bus.on('connection', (socket: WebSocket) => {
      logger.debug('event bus client connected', { clients: this.bus.clients.size });
      this.send(socket, { type: 'hello', serverTime: Date.now(), version: this.options.version });
      socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
        // Unparseable frames are ignored (contract §8).
        const parsed = safeJson(data);
        if (parsed === null || typeof parsed !== 'object') return;
        if ((parsed as { type?: unknown }).type === 'ping') {
          this.send(socket, { type: 'pong', t: Date.now() });
        }
      });
      socket.on('error', (err: Error) => logger.debug('event bus socket error', { error: err }));
    });

    this.terminals.on('connection', (socket: WebSocket, req: IncomingMessage) => {
      void this.attachTerminal(socket, req);
    });

    this.bus.on('error', (err: Error) => logger.warn('event bus server error', { error: err }));
    this.terminals.on('error', (err: Error) => logger.warn('terminal server error', { error: err }));

    this.handleUpgrade = this.handleUpgrade.bind(this);
  }

  /** `server.on('upgrade', hub.handleUpgrade)`. */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const pathname = pathnameOf(req.url);
    if (pathname !== EVENT_WS_PATH && pathname !== TERMINAL_WS_PATH) {
      socket.destroy();
      return;
    }
    if (this.closed) {
      socket.destroy();
      return;
    }
    const authorized = this.options.authorize === undefined ? true : this.options.authorize(req);
    if (!authorized) {
      // 1008 = policy violation; the client must present the token on the upgrade request.
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const target = pathname === TERMINAL_WS_PATH ? this.terminals : this.bus;
    target.handleUpgrade(req, socket, head, (ws) => {
      target.emit('connection', ws, req);
    });
  }

  // ------------------------------------------------------------------ event bus

  /** Broadcasts one §8 event to every connected client. */
  broadcast(event: ServerEvent): void {
    if (this.closed) return;
    const payload = JSON.stringify(event);
    for (const client of this.bus.clients) {
      if (client.readyState !== client.OPEN) continue;
      try {
        client.send(payload);
      } catch (err) {
        this.options.logger.debug('could not send broadcast', { error: err });
      }
    }
  }

  /** Number of connected event-bus clients (used by tests). */
  get clientCount(): number {
    return this.bus.clients.size;
  }

  /** Number of live terminal sessions (used by tests). */
  get terminalCount(): number {
    return this.sessions.size;
  }

  private send(socket: WebSocket, value: unknown): void {
    if (socket.readyState !== socket.OPEN) return;
    try {
      socket.send(JSON.stringify(value));
    } catch (err) {
      this.options.logger.debug('could not send frame', { error: err });
    }
  }

  // ------------------------------------------------------------------- terminal

  private async attachTerminal(socket: WebSocket, req: IncomingMessage): Promise<void> {
    const logger = this.options.logger.child({ terminal: shortId() });
    const query = parseQuery(req.url ?? '');
    const connectionId = query.get('connectionId') ?? query.get('connection') ?? '';
    const cols = clampDimension(query.get('cols'), 80, 1, 1000);
    const rows = clampDimension(query.get('rows'), 24, 1, 1000);

    const fail = (code: string, message: string): void => {
      this.send(socket, { t: 'error', code, message } satisfies TerminalFrame);
      try {
        socket.close();
      } catch {
        /* ignore */
      }
    };

    if (connectionId === '') {
      fail('BAD_REQUEST', 'connectionId is required.');
      return;
    }

    let connection;
    try {
      connection = this.options.connections.getOrThrow(connectionId);
    } catch (err) {
      fail('NOT_FOUND', err instanceof Error ? err.message : 'Unknown connection.');
      return;
    }
    if (!connection.isAuthenticated) {
      fail('CONNECT_FAILED', 'The connection is not authenticated.');
      return;
    }

    const window: PseudoTtyOptions = { term: TERM, cols, rows };
    let channel: ClientChannel;
    try {
      channel = await connection.shell(window);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Could not open a shell.';
      const code = (err as { code?: string }).code;
      fail(typeof code === 'string' ? code : 'REMOTE_ERROR', message);
      return;
    }

    const sessionId = newId('term');
    this.sessions.set(sessionId, { ws: socket, channel });
    let closed = false;

    const cleanup = (frame: TerminalFrame): void => {
      if (closed) return;
      closed = true;
      this.sessions.delete(sessionId);
      // Contract §9: the terminal always ends with an `exit` frame, then the socket closes.
      this.send(socket, frame);
      try {
        channel.close();
      } catch {
        /* already gone */
      }
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      logger.debug('terminal session ended', { sessionId });
    };

    channel.on('data', (chunk: Buffer) => {
      if (socket.readyState !== socket.OPEN) return;
      this.send(socket, { t: 'output', data: chunk.toString('utf8') } satisfies TerminalFrame);
    });
    channel.stderr?.on('data', (chunk: Buffer) => {
      if (socket.readyState !== socket.OPEN) return;
      this.send(socket, { t: 'output', data: chunk.toString('utf8') } satisfies TerminalFrame);
    });
    channel.on('exit', () => {
      /* the numeric code arrives with `close`; nothing to do here */
    });
    channel.on('close', (code?: number | null, signal?: string | null) => {
      cleanup({
        t: 'exit',
        code: typeof code === 'number' ? code : null,
        signal: signal ?? null,
        reason: 'exited',
      });
    });
    channel.on('error', (err: Error) => {
      logger.debug('terminal channel error', { error: err });
      cleanup({ t: 'exit', code: null, signal: null, reason: 'error' });
    });

    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      const parsed = safeJson(data);
      if (parsed === null || typeof parsed !== 'object') return;
      const frame = parsed as { t?: unknown; data?: unknown; cols?: unknown; rows?: unknown; signal?: unknown };

      if (frame.t === 'input') {
        if (typeof frame.data !== 'string') return;
        channel.write(frame.data);
        return;
      }
      if (frame.t === 'resize') {
        const nextCols = typeof frame.cols === 'number' ? frame.cols : undefined;
        const nextRows = typeof frame.rows === 'number' ? frame.rows : undefined;
        if (nextCols === undefined && nextRows === undefined) return;
        try {
          // ssh2's setWindow signature is (rows, cols, height, width).
          channel.setWindow(nextRows ?? rows, nextCols ?? cols, 0, 0);
        } catch (err) {
          logger.debug('could not resize the terminal', { error: err });
        }
        return;
      }
      if (frame.t === 'signal') {
        if (typeof frame.signal !== 'string') return;
        try {
          channel.signal(frame.signal);
        } catch (err) {
          logger.debug('could not deliver the signal', { error: err });
          // SIGINT in particular is often only honoured as a control character.
          if (frame.signal === 'INT') channel.write('\x03');
        }
      }
    });

    socket.on('close', () => {
      if (!closed) {
        closed = true;
        this.sessions.delete(sessionId);
        try {
          channel.close();
        } catch {
          /* ignore */
        }
        logger.debug('terminal socket closed by the client', { sessionId });
      }
    });

    socket.on('error', (err: Error) => {
      logger.debug('terminal socket error', { error: err });
    });

    this.send(socket, { t: 'ready', sessionId, term: TERM } satisfies TerminalFrame);
  }

  // --------------------------------------------------------------------- close

  /** Closes every socket and shell. Idempotent so `RunningServer.close()` can run twice. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    for (const [sessionId, session] of this.sessions) {
      this.sessions.delete(sessionId);
      try {
        session.channel.close();
      } catch {
        /* ignore */
      }
      try {
        session.ws.close();
      } catch {
        /* ignore */
      }
    }

    for (const client of this.bus.clients) {
      try {
        client.terminate();
      } catch {
        /* ignore */
      }
    }
    for (const client of this.terminals.clients) {
      try {
        client.terminate();
      } catch {
        /* ignore */
      }
    }

    await Promise.all([this.closeServer(this.bus), this.closeServer(this.terminals)]);
  }

  private closeServer(server: WebSocketServer): Promise<void> {
    return new Promise<void>((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
      // `close()` only resolves once every client is gone; `terminate()` above guarantees that,
      // but a fallback keeps shutdown from ever hanging.
      const timer = setTimeout(resolve, 250);
      timer.unref?.();
    });
  }
}

function safeJson(data: Buffer | ArrayBuffer | Buffer[] | string): unknown {
  try {
    const text = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.from(data).toString('utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function clampDimension(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(value, min), max);
}
