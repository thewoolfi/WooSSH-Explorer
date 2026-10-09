import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { Logger } from './logger.js';
import { redact } from './logger.js';

/**
 * The stable machine-readable error codes of the contract (§1) and their HTTP statuses.
 */
export const API_STATUS = {
  BAD_REQUEST: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  AUTH_FAILED: 401,
  HOST_KEY_UNKNOWN: 409,
  HOST_KEY_MISMATCH: 409,
  CONNECT_FAILED: 502,
  SFTP_UNAVAILABLE: 502,
  SFTP_ERROR: 400,
  REMOTE_ERROR: 502,
  NOT_SUPPORTED: 501,
  INTERNAL: 500,
} as const;

export type ApiCode = keyof typeof API_STATUS;

export interface ApiErrorBody {
  error: {
    code: ApiCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

export class ApiError extends Error {
  readonly code: ApiCode;
  readonly details?: Record<string, unknown>;
  readonly status: number;

  constructor(code: ApiCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = API_STATUS[code];
    if (details !== undefined) this.details = details;
    Error.captureStackTrace?.(this, ApiError);
  }

  toBody(): ApiErrorBody {
    const error: ApiErrorBody['error'] = { code: this.code, message: this.message };
    if (this.details !== undefined) error.details = this.details;
    return { error };
  }
}

/** Convenience constructors — keeps call sites short and consistent. */
export const badRequest = (message: string, details?: Record<string, unknown>): ApiError =>
  new ApiError('BAD_REQUEST', message, details);

export const notFound = (message: string, details?: Record<string, unknown>): ApiError =>
  new ApiError('NOT_FOUND', message, details);

export const conflict = (message: string, details?: Record<string, unknown>): ApiError =>
  new ApiError('CONFLICT', message, details);

export const sftpError = (message: string, details?: Record<string, unknown>): ApiError =>
  new ApiError('SFTP_ERROR', message, details);

export const internal = (message = 'Unexpected server error.'): ApiError =>
  new ApiError('INTERNAL', message);

/** Reads an ssh2/SFTP failure code without trusting the shape of `err`. */
function codeOf(err: unknown): string | number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' || typeof code === 'number') return code;
  return undefined;
}

/**
 * ssh2 tags every error it raises with a `level`, which is available even when the
 * socket could not supply an errno — the case that used to fall through to
 * `INTERNAL`. See `node_modules/ssh2/lib/protocol/utils.js` (`makeError`).
 */
const SSH2_LEVEL_REASONS: Readonly<Record<string, string>> = {
  'client-socket': 'SOCKET_ERROR',
  'client-timeout': 'ETIMEDOUT',
  'client-dns': 'ENOTFOUND',
  'client-authentication': 'AUTH_FAILED',
  'client-identification': 'IDENTIFICATION_FAILED',
  handshake: 'HANDSHAKE_FAILED',
  protocol: 'PROTOCOL_ERROR',
  'agent': 'AGENT_ERROR',
};

function levelOf(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const level = (err as { level?: unknown }).level;
  return typeof level === 'string' ? level : undefined;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return 'Unknown remote error.';
}

/** TCP/DNS socket errno codes that mean "we never got a connection". */
const SOCKET_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EADDRNOTAVAIL',
  'EPIPE',
  'ECONNABORTED',
]);

/** SSH protocol-level failures that mean "we connected but could not proceed". */
const HANDSHAKE_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [
  { pattern: /no matching (?:key exchange|kex) algorithm/i, reason: 'KEX_NEGOTIATION_FAILED' },
  { pattern: /no matching (?:cipher|mac|host key) algorithm/i, reason: 'ALGORITHM_NEGOTIATION_FAILED' },
  { pattern: /handshake.*(?:timeout|timed out)/i, reason: 'HANDSHAKE_TIMEOUT' },
  // ssh2's catch-all when the transport dies without an errno — e.g. a SYN to an
  // unroutable address that the OS eventually gives up on.
  { pattern: /(?:connection|socket) lost before handshake/i, reason: 'CONNECTION_CLOSED' },
  { pattern: /key exchange failed/i, reason: 'KEX_NEGOTIATION_FAILED' },
  { pattern: /(?:cannot|unable to) parse.*host key/i, reason: 'HOST_KEY_INVALID' },
  { pattern: /socket hang up/i, reason: 'CONNECTION_CLOSED' },
  { pattern: /(?:connection|socket) (?:closed|reset) by (?:the )?(?:remote|peer|host)/i, reason: 'CONNECTION_CLOSED' },
];

function handshakeReason(message: string): string | undefined {
  for (const { pattern, reason } of HANDSHAKE_PATTERNS) {
    if (pattern.test(message)) return reason;
  }
  return undefined;
}

/**
 * Maps an arbitrary ssh2/SFTP/socket/HTTP failure to the §1 code table.
 *
 * The mapping is intentionally total: anything unrecognised becomes `INTERNAL`.
 */
export function mapError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;

  const code = codeOf(err);
  const message = messageOf(err);

  if (typeof code === 'number') {
    return sftpError(`SFTP operation failed: ${message}`, { code });
  }

  if (typeof code === 'string') {
    if (code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ERR_STREAM_DESTROYED') {
      return new ApiError('CONNECT_FAILED', 'The connection was closed while the operation was in progress.', {
        reason: 'CONNECTION_CLOSED',
      });
    }
    if (code === 'AUTH_FAILED') {
      return new ApiError('AUTH_FAILED', message);
    }
    if (code === 'HOST_KEY_UNKNOWN' || code === 'HOST_KEY_MISMATCH') {
      return new ApiError(code, message);
    }
    if (SOCKET_ERROR_CODES.has(code)) {
      return new ApiError('CONNECT_FAILED', `Could not reach the host: ${message}`, { reason: code });
    }
    if (/^ERR_(?:SFTP|SSH)/.test(code) || code === 'ENOENT' || code === 'EACCES' || code === 'EPERM') {
      return sftpError(message, { code });
    }
  }

  const reason = handshakeReason(message);
  if (reason !== undefined) {
    return new ApiError('CONNECT_FAILED', `The SSH handshake failed: ${message}`, { reason });
  }

  // Anything ssh2 itself attributed to a transport/handshake level is a failure to
  // establish the connection, even when the socket could not supply an errno.
  const level = levelOf(err);
  if (level !== undefined && level in SSH2_LEVEL_REASONS) {
    const reason = SSH2_LEVEL_REASONS[level] as string;
    if (reason === 'AUTH_FAILED') {
      return new ApiError('AUTH_FAILED', 'The SSH server rejected the credentials.');
    }
    return new ApiError('CONNECT_FAILED', `Could not establish the SSH connection: ${message}`, {
      reason,
      level,
    });
  }

  if (/(authentication|auth) (?:methods? )?(?:failed|failure)|all configured authentication methods failed/i.test(message)) {
    return new ApiError('AUTH_FAILED', 'The SSH server rejected the credentials.');
  }

  if (/sftp[^.]{0,40}(?:unavailable|not available|refused|not supported|subsystem)|subsystem[^.]{0,40}(?:not|unsupported|refused|unavailable)/i.test(message)) {
    return new ApiError('SFTP_UNAVAILABLE', 'The SSH server refused the sftp subsystem.');
  }

  if (/(timeout|timed out)/i.test(message)) {
    return new ApiError('CONNECT_FAILED', 'The connection attempt timed out.', { reason: 'ETIMEDOUT' });
  }

  return new ApiError('INTERNAL', 'Unexpected server error.');
}

/** True for errors thrown by express/body-parser when a request body cannot be read. */
function isBodyParseError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { type?: unknown; status?: unknown; statusCode?: unknown; expose?: unknown };
  if (typeof e.type === 'string' && e.type.startsWith('entity.')) return true;
  const status = typeof e.status === 'number' ? e.status : e.statusCode;
  return status === 400 || status === 413 || status === 415;
}

export interface ErrorMiddlewareOptions {
  logger: Logger;
}

/**
 * Renders the §1 envelope for every failure, attaches `x-request-id` and never leaks a stack
 * trace. Express 5 recognises this as error middleware by its four-argument signature.
 */
export function errorHandler(options: ErrorMiddlewareOptions): (
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
) => void {
  const { logger } = options;
  return (err, req, res, next) => {
    if (res.headersSent) {
      // The response has already started (a streamed body, for example) — nothing to render.
      next(err);
      return;
    }

    const requestId = requestIdOf(res);
    const mapped = err instanceof ApiError ? err : isBodyParseError(err) ? badRequest(messageOf(err)) : mapError(err);

    if (mapped.code === 'INTERNAL') {
      // Log the real cause (redacted) at error level; the client only sees a generic message.
      logger.error('unhandled request failure', {
        requestId,
        method: req.method,
        path: req.path,
        error: redact(err),
      });
    } else {
      logger.debug('request failed', {
        requestId,
        method: req.method,
        path: req.path,
        code: mapped.code,
        message: mapped.message,
      });
    }

    res.status(mapped.status);
    res.setHeader('x-request-id', requestId);
    res.json(mapped.toBody());
  };
}

const REQUEST_ID_HEADER = 'x-request-id';

/** Reads the request id assigned by {@link requestIdMiddleware}. */
export function requestIdOf(res: Response): string {
  const value = res.getHeader(REQUEST_ID_HEADER);
  if (typeof value === 'string' && value !== '') return value;
  return 'unknown';
}

export interface RequestIdOptions {
  /** Overrides id generation (tests use a deterministic counter). */
  generate?: () => string;
}

/** Guarantees `x-request-id` on *every* response, including 404s and error envelopes. */
export function requestIdMiddleware(options: RequestIdOptions = {}): RequestHandler {
  const generate = options.generate ?? (() => randomUUID());
  return (req, res, next) => {
    const incoming = req.get(REQUEST_ID_HEADER);
    const id = incoming && incoming.length <= 200 && /^[\w.:-]+$/.test(incoming) ? incoming : generate();
    // `res.locals` is the supported place for per-request values; the header covers the wire.
    (res.locals as Record<string, unknown>)['requestId'] = id;
    res.setHeader(REQUEST_ID_HEADER, id);
    next();
  };
}

/** The 404 handler: an unknown route is still an error envelope, not express' HTML page. */
export function notFoundHandler(): RequestHandler {
  return (req, res, next) => {
    if (req.method === 'OPTIONS' || req.method === 'HEAD') {
      next();
      return;
    }
    next(new ApiError('NOT_FOUND', `Unknown route: ${req.method} ${req.path}.`));
  };
}
