import type { LogLevel } from './types.js';
import { RotatingFileSink } from './logFile.js';

const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

/**
 * Patterns for values that must never reach the log, even by accident.
 * Keep this list conservative — a false positive only costs diagnostics.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\bssh-(?:rsa|dss|ed25519|ecdsa-sha2-[a-z0-9-]+)\s+[A-Za-z0-9+/=]{16,}/g,
  /\b(?:password|passphrase|passwd|secret|token|privateKey)\b\s*[:=]\s*(?:"[^"]*"|'[^']*'|\S+)/gi,
];

const REDACTED = '[redacted]';

/** Scrubs anything that looks like a credential from a log line. */
export function redact(input: unknown): string {
  let text: string;
  if (typeof input === 'string') {
    text = input;
  } else if (input instanceof Error) {
    text = input.stack ?? `${input.name}: ${input.message}`;
  } else {
    try {
      text = JSON.stringify(input) ?? String(input);
    } catch {
      text = String(input);
    }
  }
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

export interface Logger {
  level: LogLevel;
  error(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  debug(message: string, meta?: unknown): void;
  child(bindings: Record<string, unknown>): Logger;
}

function formatMeta(meta: unknown): string {
  if (meta === undefined) return '';
  if (meta instanceof Error) {
    return ` ${redact({ name: meta.name, message: meta.message, code: (meta as { code?: unknown }).code })}`;
  }
  if (typeof meta === 'object' && meta !== null && !Array.isArray(meta)) {
    const entries = Object.entries(meta as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : redact(v)}`);
    return entries.length > 0 ? ` ${entries.join(' ')}` : '';
  }
  return ` ${redact(meta)}`;
}

class LineLogger implements Logger {
  constructor(
    readonly level: LogLevel,
    private readonly bindings: Record<string, unknown> = {},
    /** Mirrors every line to disk; absent when the caller did not ask for a file. */
    private readonly sink: { write(line: string): void } | null = null,
  ) {}

  private emit(level: Exclude<LogLevel, 'silent'>, message: string, meta?: unknown): void {
    if (LEVEL_ORDER[this.level] < LEVEL_ORDER[level]) return;
    const bindings = Object.entries(this.bindings)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v : redact(v)}`)
      .join(' ');
    const line = [
      new Date().toISOString(),
      level.toUpperCase().padEnd(5),
      bindings,
      redact(message) + formatMeta(meta),
    ]
      .filter((part) => part !== '')
      .join(' ');
    // Redact the assembled line, not just the pieces. Field-by-field scrubbing missed
    // string values entirely — `logger.error('auth failed', { password })` wrote the
    // password in clear, which is the most natural way anyone would log an auth failure.
    const safe = redact(line);
    // One line per event, always on stderr so stdout stays free for piping.
    process.stderr.write(`${safe}\n`);
    this.sink?.write(`${safe}\n`);
  }

  error(message: string, meta?: unknown): void {
    this.emit('error', message, meta);
  }

  warn(message: string, meta?: unknown): void {
    this.emit('warn', message, meta);
  }

  info(message: string, meta?: unknown): void {
    this.emit('info', message, meta);
  }

  debug(message: string, meta?: unknown): void {
    this.emit('debug', message, meta);
  }

  child(bindings: Record<string, unknown>): Logger {
    return new LineLogger(this.level, { ...this.bindings, ...bindings }, this.sink);
  }
}

export interface CreateLoggerOptions {
  /** Mirrors every line into a rotating file, for environments with no console. */
  filePath?: string;
  maxBytes?: number;
  keep?: number;
}

export function createLogger(level: LogLevel = 'info', options: CreateLoggerOptions = {}): Logger {
  const sink = options.filePath
    ? new RotatingFileSink({
        filePath: options.filePath,
        ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
        ...(options.keep !== undefined ? { keep: options.keep } : {}),
      })
    : null;
  return new LineLogger(level, {}, sink);
}

/** A logger that drops everything; handy for tests. */
export const silentLogger: Logger = new LineLogger('silent');
