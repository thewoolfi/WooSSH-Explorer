import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';

/**
 * A download the application owns, so it can be continued.
 *
 * Chromium's own download pipeline (an `<a download>` in the renderer) was the whole
 * implementation until now. It is fine until a transfer fails: the bytes Chromium already
 * wrote are invisible, so retrying a 5 GB file starts at zero — while the server has
 * supported `Range` and advertised `resumable` the entire time.
 *
 * This streams to `<destination>.part` and keeps a sidecar describing it. A later attempt
 * for the same URL sends `Range: bytes=<already-on-disk>-` and appends. The file only
 * appears under its real name once it is complete, so a half-written file can never be
 * mistaken for a good one.
 */

export interface PartialState {
  /** The source this partial belongs to; a different file must not be appended to. */
  url: string;
  name: string;
  /** What the server said the whole file weighs, when it said anything. */
  totalBytes: number | null;
  updatedAt: number;
}

export interface ResumePlan {
  mode: 'fresh' | 'resume';
  /** Byte offset to request. */
  from: number;
  /** Why, in a few words — logged, and shown when a resume is refused. */
  reason: string;
}

/**
 * Decides whether the bytes already on disk can be kept.
 *
 * Pure on purpose: this is the part that is easy to get subtly wrong — appending to a
 * partial that belongs to a different file, or to one the server has since replaced —
 * and it can be tested without touching a socket.
 */
export function planResume(input: {
  partBytes: number;
  partial: PartialState | null;
  url: string;
  /** Size the server reports now, if the caller knows it. */
  remoteBytes?: number | null;
}): ResumePlan {
  if (input.partBytes <= 0 || input.partial === null) {
    return { mode: 'fresh', from: 0, reason: 'nothing to continue from' };
  }
  if (input.partial.url !== input.url) {
    return { mode: 'fresh', from: 0, reason: 'the partial belongs to a different file' };
  }
  const remote = input.remoteBytes ?? input.partial.totalBytes;
  if (remote !== null && remote !== undefined) {
    if (input.partBytes > remote) {
      return { mode: 'fresh', from: 0, reason: 'the partial is larger than the remote file' };
    }
    if (input.partBytes === remote) {
      return { mode: 'fresh', from: 0, reason: 'the partial is already complete' };
    }
  }
  return { mode: 'resume', from: input.partBytes, reason: `${input.partBytes} bytes already on disk` };
}

/**
 * What to do with the server's answer to a ranged request.
 *
 * A server that ignores `Range` replies `200` with the whole body; appending that to the
 * partial would silently corrupt the file, so the partial is dropped and the download
 * starts over. `416` means the offset is past the end — the same conclusion.
 */
export function responseDecision(status: number): 'append' | 'restart' | 'fail' {
  if (status === 206) return 'append';
  if (status === 200) return 'restart';
  if (status === 416) return 'restart';
  return 'fail';
}

function partialPaths(destination: string): { part: string; sidecar: string } {
  return { part: `${destination}.part`, sidecar: `${destination}.part.json` };
}

function readPartial(destination: string): { bytes: number; state: PartialState | null } {
  const { part, sidecar } = partialPaths(destination);
  let bytes = 0;
  try {
    bytes = statSync(part).size;
  } catch {
    return { bytes: 0, state: null };
  }
  try {
    return { bytes, state: JSON.parse(readFileSync(sidecar, 'utf8')) as PartialState };
  } catch {
    // A partial without its sidecar cannot be trusted; the caller will start fresh.
    return { bytes, state: null };
  }
}

export interface ResumableDownloadRequest {
  url: string;
  name: string;
  destination: string;
  token: string | null;
}

export interface ResumableDownloadEvents {
  onProgress?: (progress: { received: number; total: number | null; resumedFrom: number }) => void;
}

export interface ResumableDownloadResult {
  path: string;
  bytes: number;
  resumedFrom: number;
  /** False when the server ignored the range and the whole file came down again. */
  resumed: boolean;
}

/**
 * Streams the file to `destination`, continuing from what is already there when possible.
 * Rejects on failure and leaves the partial in place, which is the point of the exercise.
 */
export async function downloadResumable(
  request: ResumableDownloadRequest,
  events: ResumableDownloadEvents = {},
): Promise<ResumableDownloadResult> {
  mkdirSync(path.dirname(request.destination), { recursive: true });

  const { part, sidecar } = partialPaths(request.destination);
  const existing = readPartial(request.destination);
  const plan = planResume({ partBytes: existing.bytes, partial: existing.state, url: request.url });

  if (plan.mode === 'fresh' && existing.bytes > 0) {
    // The offset is unusable: drop it rather than append to something we cannot vouch for.
    rmSync(part, { force: true });
    rmSync(sidecar, { force: true });
  }

  const headers: Record<string, string> = {};
  if (request.token !== null) headers['x-ssh-explorer-token'] = request.token;
  if (plan.mode === 'resume') headers.Range = `bytes=${plan.from}-`;

  const first = await open(request.url, headers);
  const decision = responseDecision(first.status);
  if (decision === 'fail') {
    first.resume();
    throw new Error(`The download was refused (HTTP ${first.status}).`);
  }

  if (plan.mode === 'resume' && decision === 'restart') {
    // The server sent the whole file despite the range. Appending it to what is already
    // on disk would corrupt the result, so the partial goes and the file comes down again.
    first.resume();
    rmSync(part, { force: true });
    rmSync(sidecar, { force: true });
    const retry = await open(request.url, request.token !== null ? { 'x-ssh-explorer-token': request.token } : {});
    if (responseDecision(retry.status) === 'fail') {
      retry.resume();
      throw new Error(`The download was refused (HTTP ${retry.status}).`);
    }
    return drain(retry, request, { mode: 'fresh', from: 0, reason: 'the server ignored the range' }, events);
  }

  return drain(first, request, plan, events);
}

function open(url: string, headers: Record<string, string>): Promise<http.IncomingMessage & { status: number }> {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https:') ? https : http;
    const request = client.get(url, { headers }, (response) => {
      // `statusCode` is optional in the type but always present for a response.
      resolve(Object.assign(response, { status: response.statusCode ?? 0 }));
    });
    request.on('error', reject);
  });
}

function drain(
  response: http.IncomingMessage,
  request: ResumableDownloadRequest,
  plan: ResumePlan,
  events: ResumableDownloadEvents,
): Promise<ResumableDownloadResult> {
  const { part, sidecar } = partialPaths(request.destination);
  const from = plan.mode === 'resume' ? plan.from : 0;
  const contentLength = Number(response.headers['content-length'] ?? Number.NaN);
  const total = Number.isFinite(contentLength) ? contentLength + from : null;

  const state: PartialState = {
    url: request.url,
    name: request.name,
    totalBytes: total,
    updatedAt: Date.now(),
  };
  writeFileSync(sidecar, JSON.stringify(state), 'utf8');

  return new Promise((resolve, reject) => {
    const out = createWriteStream(part, { flags: from > 0 ? 'a' : 'w' });
    let received = from;

    response.on('data', (chunk: Buffer) => {
      received += chunk.length;
      events.onProgress?.({ received, total, resumedFrom: from });
    });
    response.on('error', (error) => {
      out.destroy();
      reject(error);
    });
    out.on('error', (error) => {
      response.destroy();
      reject(error);
    });
    out.on('finish', () => {
      // Only now does the file earn its real name.
      try {
        renameSync(part, request.destination);
        rmSync(sidecar, { force: true });
      } catch (error) {
        reject(error);
        return;
      }
      resolve({ path: request.destination, bytes: received, resumedFrom: from, resumed: from > 0 });
    });

    response.pipe(out);
  });
}

/** Removes the leftovers of a download the user gave up on. */
export function discardPartial(destination: string): void {
  const { part, sidecar } = partialPaths(destination);
  rmSync(part, { force: true });
  rmSync(sidecar, { force: true });
}

/** Whether a resumable partial exists for this destination. */
export function hasPartial(destination: string): boolean {
  const { part } = partialPaths(destination);
  return existsSync(part) && statSync(part).size > 0;
}
