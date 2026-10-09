import { timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server as HttpServer } from 'node:http';
import path from 'node:path';
import express from 'express';
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express';

import { loadConfig } from './config.js';
import { ApiError, errorHandler, notFoundHandler, requestIdMiddleware } from './errors.js';
import { createLogger } from './logger.js';
import { registerRoutes } from './routes/index.js';
import { SecretVault, LocalKeySecretBox, type SecretBox } from './store/secretVault.js';
import type { RouteContext } from './routes/context.js';
import { KnownHostsStore } from './ssh/hostKeys.js';
import { SshConnectionManager } from './ssh/SshConnectionManager.js';
import { ProfileStore } from './store/profileStore.js';
import { SettingsStore } from './store/settingsStore.js';
import { TransferManager } from './transfers/TransferManager.js';
import type { LogLevel } from './types.js';
import { WsHub } from './ws/hub.js';

/** Contract §12: the options the integration tests pass. */
export interface CreateServerOptions {
  /** `0` => ephemeral port. */
  port?: number;
  host?: string;
  /** Overrides `SSH_EXPLORER_HOME`, which is what isolates `known_hosts` and `profiles.json`. */
  stateDir?: string;
  downloadDir?: string;
  logLevel?: LogLevel;
  /** Where the rotating log file goes; defaults to `<stateDir>/logs/ssh-explorer.log`. */
  logFilePath?: string;
  /** `null` disables static serving. */
  staticDir?: string | null;
  token?: string | null;
  /**
   * Overrides where saved credentials are encrypted. The desktop shell passes an
   * Electron `safeStorage` box so secrets are sealed by the OS keychain (DPAPI on
   * Windows); everything else falls back to a local AES-256-GCM key file.
   */
  secretBox?: SecretBox;
}

/** Contract §12: what the tests get back. */
export interface RunningServer {
  url: string;
  /**
   * The clickable `http://host:port/?token=…` URL when the server generated the token itself
   * (§10). `null` when no token is required; an explicitly configured token is never printed,
   * because the operator already has it.
   */
  tokenUrl: string | null;
  port: number;
  httpServer: HttpServer;
  close(): Promise<void>;
}

const MAX_JSON_BODY = '20mb';

function jsonBodyParser(limit: string): RequestHandler {
  const parse = express.json({ limit });
  return (req, res, next) => {
    // Raw bodies belong to the upload route: express must not consume them. DELETE is *not*
    // skipped — §15 removes a known host with a JSON body.
    if (req.method === 'GET' || req.method === 'HEAD') {
      next();
      return;
    }
    const contentType = req.headers['content-type'] ?? '';
    if (!contentType.includes('application/json')) {
      next();
      return;
    }
    parse(req, res, next);
  };
}

/** Constant-time token comparison; missing/incorrect tokens are always rejected. */
function tokenMatches(expected: string, provided: string | undefined): boolean {
  if (provided === undefined) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) {
    // Still compare something of equal length so the failure cost does not leak the length.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

function tokenFromRequest(req: IncomingMessage): string | undefined {
  const header = req.headers['x-ssh-explorer-token'];
  if (typeof header === 'string' && header !== '') return header;
  if (Array.isArray(header) && header.length > 0) return header[0];
  return undefined;
}

/** Token for a WebSocket upgrade: header first, then the `token` query parameter. */
function tokenFromUpgrade(req: IncomingMessage): string | undefined {
  const header = tokenFromRequest(req);
  if (header !== undefined) return header;
  const raw = req.url ?? '';
  const index = raw.indexOf('?');
  if (index < 0) return undefined;
  const params = new URLSearchParams(raw.slice(index + 1));
  return params.get('token') ?? params.get('access_token') ?? undefined;
}

function createTokenMiddleware(token: string): RequestHandler {
  return (req, res, next) => {
    // Contract §10: when a token is configured, *every* `/api` request must send it — the
    // health route is not exempt (the e2e suite asserts that).
    const provided = req.get('x-ssh-explorer-token');
    if (!tokenMatches(token, provided)) {
      next(new ApiError('AUTH_FAILED', 'A valid x-ssh-explorer-token header is required.'));
      return;
    }
    next();
  };
}

/**
 * Builds the whole backend: configuration, stores, connection manager, transfers, WebSocket hub
 * and the express app. Resolves once the HTTP socket is bound (contract §12).
 */
export async function createServer(options: CreateServerOptions = {}): Promise<RunningServer> {
  const config = loadConfig({
    ...(options.port !== undefined ? { port: options.port } : {}),
    ...(options.host !== undefined ? { host: options.host } : {}),
    ...(options.stateDir !== undefined ? { stateDir: options.stateDir } : {}),
    ...(options.downloadDir !== undefined ? { downloadDir: options.downloadDir } : {}),
    ...(options.logLevel !== undefined ? { logLevel: options.logLevel } : {}),
    ...(options.logFilePath !== undefined ? { logFilePath: options.logFilePath } : {}),
    ...(options.staticDir !== undefined ? { staticDir: options.staticDir } : {}),
    ...(options.token !== undefined ? { token: options.token } : {}),
  });

  // The file sink is what makes a windowed build diagnosable: stderr goes nowhere when
  // the application is started from a shortcut.
  const logger = createLogger(config.logLevel, { filePath: config.logFilePath });

  // §10: never start an unauthenticated API by accident. A generated token is the default, and
  // an operator who really wants an open port has to say so with SSH_EXPLORER_NO_TOKEN=1.
  if (config.tokenSource === 'generated') {
    logger.info('a random API token was generated for this run; open the URL below to use it');
  } else if (config.tokenSource === 'env-no-token') {
    logger.warn(
      'SSH_EXPLORER_NO_TOKEN is set: the API is open to every process on this machine, and a saved credential can be used by anyone who can reach the port',
    );
  }

  const knownHosts = new KnownHostsStore({
    readPath: path.join(config.homeDir, '.ssh', 'known_hosts'),
    writePath: config.knownHostsPath,
    logger,
  });
  const profiles = new ProfileStore({ filePath: config.profilesPath, logger });
  // The desktop shell injects an OS-keychain box; a standalone server falls back to
  // AES-256-GCM with a local key file, and says so through `system/info`.
  const secrets = new SecretVault({
    filePath: config.secretsPath,
    box: options.secretBox ?? new LocalKeySecretBox(config.secretKeyPath, logger),
    logger,
  });
  const settings = new SettingsStore({ filePath: config.settingsPath, logger });
  const connections = new SshConnectionManager({ hostKeys: knownHosts, logger });
  // §7: the persisted settings are the queue's starting point, so a restart keeps them.
  const storedSettings = await settings.get();
  const transfers = new TransferManager({
    downloadDir: config.downloadDir,
    logger,
    maxConcurrent: storedSettings.maxConcurrent,
    speedLimitKbps: storedSettings.speedLimitKbps,
  });

  const hub = new WsHub({
    logger,
    version: config.version,
    connections,
    authorize: (req) => (config.token === null ? true : tokenMatches(config.token, tokenFromUpgrade(req))),
  });

  // §8: connection status changes are republished on the event bus.
  connections.on('connection:status', (summary) => hub.broadcast({ type: 'connection:status', connection: summary }));
  connections.on('connection:closed', (connectionId: string, reason: string) =>
    hub.broadcast({ type: 'connection:closed', connectionId, reason }),
  );
  transfers.on('transfer:update', (transfer) => hub.broadcast({ type: 'transfer:update', transfer }));

  const ctx: RouteContext = { config, logger, hub, profiles, secrets, settings, knownHosts, connections, transfers };

  const app: Express = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use(requestIdMiddleware());
  // Scoped to `/api`: the token guards the API, not the static shell. Mounting it
  // globally made a token-protected deployment serve 401 JSON for `/` and every
  // `/assets/*.js`, so the bundled web app could never load in the first place.
  if (config.token !== null) app.use('/api', createTokenMiddleware(config.token));
  app.use(jsonBodyParser(MAX_JSON_BODY));
  app.use(registerRoutes(ctx));

  const httpServer = createHttpServer(app);

  if (config.staticDir !== null) {
    const staticDir = config.staticDir;
    app.use(express.static(staticDir, { index: ['index.html'], fallthrough: true, redirect: false }));
    // SPA fallback: any non-`/api` GET that is not a file serves the shell.
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        next();
        return;
      }
      if (req.path.startsWith('/api')) {
        next();
        return;
      }
      res.sendFile(path.join(staticDir, 'index.html'), (err?: Error) => {
        if (err !== undefined && err !== null) next();
      });
    });
  }

  app.use(notFoundHandler());
  app.use(errorHandler({ logger }));

  // WebSocket upgrades are handled outside express.
  httpServer.on('upgrade', (req, socket, head) => hub.handleUpgrade(req, socket, head));

  // Housekeeping only; `unref()` keeps the process from being held open by it.
  const sweeper = setInterval(() => {
    try {
      transfers.clearFinished();
    } catch (err) {
      logger.debug('transfer sweep failed', { error: err });
    }
  }, 5 * 60_000);
  sweeper.unref();

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      httpServer.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      httpServer.removeListener('error', onError);
      resolve();
    };
    httpServer.once('error', onError);
    httpServer.once('listening', onListening);
    httpServer.listen(config.port, config.host);
  });

  const address = httpServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;
  const host = config.host === '::' ? '[::]' : config.host;
  const url = `http://${host}:${port}`;
  // §10: a generated token has to reach the user, otherwise nothing can talk to the API.
  const tokenUrl =
    config.tokenSource === 'generated' && config.token !== null
      ? `${url}/?token=${encodeURIComponent(config.token)}`
      : null;

  // The clickable URL is logged as *meta*, not as part of the message: `redact()` scrubs a
  // `token=…` assignment out of the message body, and this token is the only way in.
  logger.info('ssh explorer listening', {
    url,
    stateDir: config.stateDir,
    static: config.staticDir ?? 'disabled',
    token: config.token === null ? 'off' : 'on',
  });
  if (tokenUrl !== null) {
    logger.info('open this URL to sign in (no token needed in the browser)', { tokenUrl });
  }

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;

    clearInterval(sweeper);
    logger.debug('shutting down');

    // 1. stop accepting work, 2. drop transports, 3. close the listener.
    transfers.shutdown();
    connections.removeAllListeners();
    await hub.close();
    await connections.closeAll();

    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
      // Sockets held open by keep-alive connections must not delay shutdown.
      httpServer.closeAllConnections?.();
      const timer = setTimeout(() => {
        httpServer.closeAllConnections?.();
        resolve();
      }, 500);
      timer.unref?.();
    });
  };

  return { url, tokenUrl, port, httpServer, close };
}
