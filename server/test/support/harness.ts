/**
 * Shared harness for the SSH Explorer integration suite.
 *
 * Every test file starts its own API server (ephemeral port) plus its own mock SSH
 * server, with an isolated temp `stateDir`/`downloadDir` — the developer's real
 * `~/.ssh-explorer` is never touched.
 *
 * Everything asynchronous here is bounded by a timeout: a broken implementation
 * fails a test instead of hanging the suite.
 */
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { WebSocket } from 'ws';

import { createServer, type RunningServer } from '../../src/server.js';
import { startMockSshServer, type MockSshServer, type MockSshServerOptions } from './mockSshServer.js';

export const DEFAULT_TIMEOUT_MS = 15_000;

export interface Harness {
  mock: MockSshServer;
  api: RunningServer;
  baseUrl: string;
  stateDir: string;
  downloadDir: string;
  /** Raw fetch against the API origin; the body is buffered and parsed. */
  request(method: string, route: string, init?: RequestInit & { timeoutMs?: number }): Promise<ApiResponse>;
  /** JSON request helper. */
  json(method: string, route: string, body?: unknown, init?: RequestInit & { timeoutMs?: number }): Promise<ApiResponse>;
  /** Opens a streaming request (used by download tests); the caller reads the body. */
  stream(route: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response>;
  /** POST /api/connections against the mock's credentials. */
  connect(extra?: Record<string, unknown>): Promise<ApiResponse>;
  /** Full trust dance: 409 HOST_KEY_UNKNOWN, then trust + 201. */
  connectTrusting(extra?: Record<string, unknown>): Promise<{ response: ApiResponse; id: string; summary: any; first: ApiResponse }>;
  /** Opens a WebSocket to `/api/ws`. */
  openEventSocket(): Promise<WsClient>;
  close(): Promise<void>;
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface ApiResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  requestId: string | null;
  text: string;
  buffer: Buffer;
  json: any;
  error?: ApiError;
}

export interface HarnessOptions {
  mock?: MockSshServerOptions;
  logLevel?: 'silent' | 'error' | 'warn' | 'info' | 'debug';
  token?: string | null;
  /**
   * Leaves the `token` option out entirely, so the server generates one (§10) and the test can
   * pick it up from `api.tokenUrl`.
   */
  generateToken?: boolean;
}

function parseJson(text: string): any {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function toApiResponse(response: Response, buffer: Buffer): ApiResponse {
  const text = buffer.toString('utf8');
  const json = parseJson(text);
  return {
    status: response.status,
    ok: response.ok,
    headers: response.headers,
    requestId: response.headers.get('x-request-id'),
    text,
    buffer,
    json,
    error: json && typeof json === 'object' && json.error ? (json.error as ApiError) : undefined,
  };
}

/** Starts a mock SSH server + an isolated API server. */
export async function startHarness(options: HarnessOptions = {}): Promise<Harness> {
  const stateDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ssh-explorer-state-'));
  const downloadDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ssh-explorer-dl-'));
  const mock = await startMockSshServer(options.mock);

  const api = await createServer({
    port: 0,
    host: '127.0.0.1',
    stateDir,
    downloadDir,
    logLevel: options.logLevel ?? ((process.env.SSH_EXPLORER_TEST_LOG === '1' ? 'debug' : 'silent') as HarnessOptions['logLevel']),
    staticDir: null,
    ...(options.generateToken === true ? {} : { token: options.token ?? null }),
  });

  const baseUrl = api.url;

  async function request(
    method: string,
    route: string,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<ApiResponse> {
    const { timeoutMs = DEFAULT_TIMEOUT_MS, ...rest } = init;
    const response = await fetch(`${baseUrl}${route}`, {
      method,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      ...rest,
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    return toApiResponse(response, buffer);
  }

  async function json(
    method: string,
    route: string,
    body?: unknown,
    init: RequestInit & { timeoutMs?: number } = {},
  ): Promise<ApiResponse> {
    const headers = new Headers(init.headers);
    let payload: BodyInit | undefined;
    if (body !== undefined) {
      headers.set('content-type', 'application/json');
      payload = JSON.stringify(body);
    }
    return request(method, route, { ...init, headers, body: payload });
  }

  async function stream(route: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
    const { timeoutMs = 60_000, ...rest } = init;
    return fetch(`${baseUrl}${route}`, {
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
      ...rest,
    });
  }

  const connectionBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
    label: `mock-${Math.random().toString(36).slice(2, 8)}`,
    host: mock.host,
    port: mock.port,
    username: mock.username,
    auth: { method: 'password', password: mock.password },
    ...extra,
  });

  async function connect(extra: Record<string, unknown> = {}): Promise<ApiResponse> {
    return json('POST', '/api/connections', connectionBody(extra));
  }

  async function connectTrusting(
    extra: Record<string, unknown> = {},
  ): Promise<{ response: ApiResponse; id: string; summary: any; first: ApiResponse }> {
    const first = await connect(extra);
    if (first.status === 201) {
      const summary = first.json?.connection;
      return { response: first, id: summary?.id, summary, first };
    }
    if (first.status !== 409 || first.error?.code !== 'HOST_KEY_UNKNOWN') {
      throw new Error(
        `expected 409 HOST_KEY_UNKNOWN on first contact, got ${first.status} ${first.text.slice(0, 300)}`,
      );
    }
    const fingerprint = (first.error?.details as Record<string, unknown> | undefined)?.fingerprint;
    const response = await connect({ ...extra, trustHostKey: true, hostKeyFingerprint: fingerprint });
    const summary = response.json?.connection;
    return { response, id: summary?.id, summary, first };
  }

  async function openEventSocket(): Promise<WsClient> {
    return WsClient.open(`${baseUrl.replace(/^http/, 'ws')}/api/ws`);
  }

  return {
    mock,
    api,
    baseUrl,
    stateDir,
    downloadDir,
    request,
    json,
    stream,
    connect,
    connectTrusting,
    openEventSocket,
    async close(): Promise<void> {
      // Close the mock first so the API sees clean SSH disconnects, then the API server.
      await mock.close().catch(() => {});
      await api.close().catch(() => {});
      await api.close().catch(() => {}); // close() must be safe to call twice
      await fsp.rm(stateDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      await fsp.rm(downloadDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    },
  };
}

/** Runs `fn` with a dedicated harness, always tearing it down. */
export async function withHarness<T>(
  options: HarnessOptions,
  fn: (harness: Harness) => Promise<T>,
): Promise<T> {
  const harness = await startHarness(options);
  try {
    return await fn(harness);
  } finally {
    await harness.close();
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

export interface WaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  label?: string;
}

/** Polls `predicate` until it returns a truthy value; throws on timeout. */
export async function waitFor<T>(
  predicate: () => T | Promise<T>,
  options: WaitOptions = {},
): Promise<T> {
  const { timeoutMs = 5_000, intervalMs = 20, label = 'condition' } = options;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() > deadline) {
      const detail = lastError instanceof Error ? ` (last error: ${lastError.message})` : '';
      throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}${detail}`);
    }
    await sleep(intervalMs);
  }
}

/** Asserts the §1 error envelope and the `x-request-id` header; returns the error. */
export function expectErrorEnvelope(response: ApiResponse): ApiError {
  assert.ok(response.requestId, `every response must carry x-request-id (got ${JSON.stringify(response.requestId)})`);
  assert.ok(response.error, `expected an error envelope, got status ${response.status}: ${response.text.slice(0, 400)}`);
  const error = response.error!;
  assert.equal(typeof error.code, 'string', 'error.code must be a string');
  assert.ok(error.code.length > 0, 'error.code must not be empty');
  assert.equal(typeof error.message, 'string', 'error.message must be a string');
  assert.ok(error.message.length > 0, 'error.message must not be empty');
  return error;
}

export interface WsFrame {
  type?: string;
  t?: string;
  [key: string]: unknown;
}

/** Small WebSocket client with hard timeouts and guaranteed cleanup. */
export class WsClient {
  readonly frames: WsFrame[] = [];
  readonly url: string;

  private readonly socket: WebSocket;
  private closeInfo: { code: number; reason: string } | null = null;
  private errored: Error | null = null;

  private constructor(url: string, socket: WebSocket) {
    this.url = url;
    this.socket = socket;
    socket.on('message', (data: Buffer) => {
      try {
        this.frames.push(JSON.parse(data.toString('utf8')) as WsFrame);
      } catch {
        this.frames.push({ type: '__unparseable__', raw: data.toString('utf8') });
      }
    });
    socket.on('close', (code: number, reason: Buffer) => {
      this.closeInfo = { code, reason: reason?.toString('utf8') ?? '' };
    });
    socket.on('error', (err: Error) => {
      this.errored = err;
    });
  }

  static async open(url: string, timeoutMs = 10_000): Promise<WsClient> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          socket.terminate();
        } catch {
          /* ignore */
        }
        reject(new Error(`WebSocket ${url} did not open within ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      socket.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.once('error', (err: Error) => {
        clearTimeout(timer);
        reject(new Error(`WebSocket ${url} failed to open: ${err.message}`));
      });
    });
    return new WsClient(url, socket);
  }

  get closed(): boolean {
    return this.closeInfo !== null;
  }

  get lastError(): Error | null {
    return this.errored;
  }

  send(payload: unknown): void {
    if (this.closed) throw new Error('cannot send on a closed WebSocket');
    this.socket.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
  }

  /** Waits for a frame matching `predicate` (searched across all frames received so far). */
  async waitForFrame(
    predicate: (frame: WsFrame) => boolean,
    options: WaitOptions = {},
  ): Promise<WsFrame> {
    const { label = 'websocket frame', ...rest } = options;
    try {
      return await waitFor(() => this.frames.find(predicate), {
        ...rest,
        label: `${label} (received: ${this.frames.map((f) => f.type ?? f.t).join(', ') || 'none'})`,
      });
    } catch (err) {
      if (this.errored) throw new Error(`${(err as Error).message}; socket error: ${this.errored.message}`);
      throw err;
    }
  }

  framesOfType(type: string): WsFrame[] {
    return this.frames.filter((frame) => frame.type === type || frame.t === type);
  }

  async waitForType(type: string, options: WaitOptions = {}): Promise<WsFrame> {
    return this.waitForFrame((frame) => frame.type === type || frame.t === type, {
      label: `frame of type ${type}`,
      ...options,
    });
  }

  async waitForClose(timeoutMs = 5_000): Promise<{ code: number; reason: string }> {
    return waitFor(() => this.closeInfo, { timeoutMs, label: `close of ${this.url}` });
  }

  /** Closes the socket and always resolves; terminates if the peer does not cooperate. */
  async close(timeoutMs = 3_000): Promise<void> {
    if (!this.closed) {
      try {
        this.socket.close();
      } catch {
        /* ignore */
      }
      try {
        await this.waitForClose(timeoutMs);
      } catch {
        try {
          this.socket.terminate();
        } catch {
          /* ignore */
        }
        await sleep(10);
      }
    }
    // Remove listeners so a terminated socket cannot keep the process alive.
    this.socket.removeAllListeners();
  }
}
