import { execFile } from 'node:child_process';
import { platform } from 'node:os';

import { badRequest } from './errors.js';

/**
 * Ping and traceroute run from the machine SSH Explorer is installed on, to the host the
 * user is looking at — which is why they work for a saved host with no session at all.
 *
 * Everything goes through `execFile` with an argument array: no shell is involved, so a
 * host name can never become a command. The host is additionally validated, because the
 * arguments reach a system binary that has its own flags.
 */

export type NetToolName = 'ping' | 'traceroute';

export interface NetProbeResult {
  tool: NetToolName;
  host: string;
  /** Raw output, line by line, as the tool printed it. */
  lines: string[];
  /** Decoded summary; every field is optional because the tools differ per platform. */
  summary: {
    transmitted: number | null;
    received: number | null;
    lossPercent: number | null;
    minMs: number | null;
    avgMs: number | null;
    maxMs: number | null;
    /** Traceroute only: how many hops answered. */
    hops: number | null;
    /** True when the tool ran but never reached the destination. */
    unreachable: boolean;
  };
  durationMs: number;
  /** Set when the binary is missing, so the UI can say so instead of showing nothing. */
  unavailable: string | null;
}

/** Hostnames, IPv4 and IPv6 — nothing that could be read as a flag or a second command. */
const HOST_PATTERN = /^[A-Za-z0-9._:[\]-]{1,255}$/;

export function assertProbeHost(host: unknown): string {
  if (typeof host !== 'string' || host.trim() === '') {
    throw badRequest('A host is required.');
  }
  const trimmed = host.trim();
  if (trimmed.startsWith('-') || !HOST_PATTERN.test(trimmed)) {
    throw badRequest('That host name contains characters a probe cannot use.', { host: trimmed });
  }
  return trimmed;
}

export function clampCount(value: unknown, fallback = 4, max = 10): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

/** Builds the argv for the platform's own tool. Exported so the shapes can be tested. */
export function probeCommand(
  tool: NetToolName,
  host: string,
  count: number,
  os: NodeJS.Platform = platform(),
): { file: string; args: string[] } {
  const windows = os === 'win32';
  if (tool === 'ping') {
    return windows
      ? { file: 'ping', args: ['-n', String(count), '-w', '2000', host] }
      : { file: 'ping', args: ['-c', String(count), '-W', '2', host] };
  }
  // `-d` and `-n` both mean "do not resolve names"; `-m` caps the hop count.
  return windows
    ? { file: 'tracert', args: ['-d', '-w', '1500', '-h', '20', host] }
    : { file: 'traceroute', args: ['-n', '-w', '2', '-m', '20', host] };
}

/** `/usr/bin/ping` is absent on plenty of slim images; that is a finding, not a failure. */
function isMissing(error: NodeJS.ErrnoException): boolean {
  return error.code === 'ENOENT' || error.code === 'EACCES';
}

/**
 * Windows ships `ping.exe` and `tracert.exe` that print in the console's OEM code page,
 * which on a Russian system is CP866 — not the UTF-8 that `execFile` assumes by default.
 * Reading the bytes as UTF-8 produced a wall of replacement characters.
 */
export function decodeOutput(buffer: Buffer, os: NodeJS.Platform = platform()): string {
  if (buffer.length === 0) return '';
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  // A valid UTF-8 stream decodes without the replacement character.
  if (!utf8.includes('\uFFFD')) return utf8;
  if (os !== 'win32') return utf8;
  try {
    return new TextDecoder('ibm866', { fatal: false }).decode(buffer);
  } catch {
    return utf8;
  }
}

export async function runNetProbe(input: {
  tool: NetToolName;
  host: string;
  count?: number;
  timeoutMs?: number;
}): Promise<NetProbeResult> {
  const host = assertProbeHost(input.host);
  const count = clampCount(input.count);
  const { file, args } = probeCommand(input.tool, host, count);
  const started = Date.now();

  const outcome = await new Promise<{ stdout: Buffer; stderr: Buffer; missing: boolean }>((resolve) => {
    execFile(
      file,
      args,
      // A probe must never outlive the request that asked for it.
      // `encoding: 'buffer'` because Windows console tools write in the OEM code page,
      // not UTF-8: decoding them as UTF-8 turned every reply into mojibake.
      { timeout: input.timeoutMs ?? 20_000, maxBuffer: 1024 * 1024, windowsHide: true, encoding: 'buffer' },
      (error, stdout, stderr) => {
        const failure = error as NodeJS.ErrnoException | null;
        resolve({
          stdout: (stdout as unknown as Buffer) ?? Buffer.alloc(0),
          stderr: (stderr as unknown as Buffer) ?? Buffer.alloc(0),
          missing: failure !== null && isMissing(failure),
        });
      },
    );
  });

  const text = `${decodeOutput(outcome.stdout)}\n${decodeOutput(outcome.stderr)}`.trim();
  const lines = text === '' ? [] : text.split('\n').map((line) => line.replace(/\s+$/, ''));

  if (outcome.missing) {
    return {
      tool: input.tool,
      host,
      lines: [],
      summary: emptySummary(),
      durationMs: Date.now() - started,
      unavailable:
        input.tool === 'traceroute'
          ? 'No traceroute on this machine. On Windows it is `tracert`, on Linux it may need `traceroute` or `tracepath` installed.'
          : 'No ping on this machine.',
    };
  }

  return {
    tool: input.tool,
    host,
    lines,
    summary: input.tool === 'ping' ? parsePing(text) : parseTraceroute(text),
    durationMs: Date.now() - started,
    unavailable: null,
  };
}

function emptySummary(): NetProbeResult['summary'] {
  return {
    transmitted: null,
    received: null,
    lossPercent: null,
    minMs: null,
    avgMs: null,
    maxMs: null,
    hops: null,
    unreachable: false,
  };
}

/**
 * Reads the tail of a ping run. Windows and Linux word the summary differently, so the
 * numbers are pulled out by shape rather than by matching a whole sentence.
 */
export function parsePing(text: string): NetProbeResult['summary'] {
  const summary = emptySummary();
  if (text.trim() === '') return summary;

  // Windows: "Packets: Sent = 4, Received = 4, Lost = 0 (0% loss)"
  // Linux:   "4 packets transmitted, 4 received, 0% packet loss, time 3004ms"
  const sent = /(?:Sent\s*=\s*|packets transmitted,\s*)(\d+)/i.exec(text);
  const received = /(?:Received\s*=\s*|,\s*)(\d+)\s*(?:received|,)/i.exec(text);
  const loss = /(\d+(?:\.\d+)?)%\s*(?:packet )?loss/i.exec(text);
  if (sent) summary.transmitted = Number.parseInt(sent[1] as string, 10);
  if (received) summary.received = Number.parseInt(received[1] as string, 10);
  if (loss) summary.lossPercent = Number.parseFloat(loss[1] as string);

  // Windows: "Minimum = 1ms, Maximum = 2ms, Average = 1ms"
  const winMin = /Minimum\s*=\s*(\d+)ms/i.exec(text);
  const winMax = /Maximum\s*=\s*(\d+)ms/i.exec(text);
  const winAvg = /Average\s*=\s*(\d+)ms/i.exec(text);
  // Linux/macOS: "rtt min/avg/max/mdev = 0.031/0.042/0.061/0.012 ms"
  const unix = /=\s*([\d.]+)\/([\d.]+)\/([\d.]+)\//.exec(text);

  if (winMin) summary.minMs = Number.parseFloat(winMin[1] as string);
  if (winMax) summary.maxMs = Number.parseFloat(winMax[1] as string);
  if (winAvg) summary.avgMs = Number.parseFloat(winAvg[1] as string);
  if (unix) {
    summary.minMs = Number.parseFloat(unix[1] as string);
    summary.avgMs = Number.parseFloat(unix[2] as string);
    summary.maxMs = Number.parseFloat(unix[3] as string);
  }

  // The summary is localised: Russian Windows says "Среднее = 1мс", not "Average = 1ms".
  // Falling back to the per-reply numbers makes the figures work in any language.
  if (summary.avgMs === null) {
    const replies = [...text.matchAll(/(?:time|время)\s*[=<]\s*(\d+(?:[.,]\d+)?)\s*(?:ms|мс)/gi)].map(
      (match) => Number.parseFloat((match[1] as string).replace(',', '.')),
    );
    const all = [...text.matchAll(/[=<]\s*(\d+(?:[.,]\d+)?)\s*(?:ms|мс)\b/gi)].map((match) =>
      Number.parseFloat((match[1] as string).replace(',', '.')),
    );
    const values = replies.length > 0 ? replies : all;
    if (values.length > 0) {
      summary.minMs = Math.min(...values);
      summary.maxMs = Math.max(...values);
      summary.avgMs = values.reduce((sum, value) => sum + value, 0) / values.length;
    }
  }
  if (summary.received === null) {
    // Count the reply lines themselves; every locale prints one per answer.
    const answered = (text.match(/(?:TTL|ttl)\s*[=:]\s*\d+/g) ?? []).length;
    if (answered > 0) summary.received = answered;
  }
  if (summary.transmitted === null && summary.received !== null) {
    summary.transmitted = summary.received;
  }
  // The percent sign survives translation even when the words around it do not.
  if (summary.lossPercent === null) {
    const loss = /(\d+(?:[.,]\d+)?)\s*%/.exec(text);
    if (loss) summary.lossPercent = Number.parseFloat((loss[1] as string).replace(',', '.'));
  }

  summary.unreachable =
    summary.received === 0 ||
    /100%\s*(?:packet )?loss/i.test(text) ||
    /could not find host|unknown host|name or service not known|destination host unreachable/i.test(
      text,
    );
  return summary;
}

/**
 * Counts the hops that answered, which is what a person reads the table for.
 *
 * The count is taken from the *shape* of the line, not from its words: `tracert` on a
 * Russian Windows prints `<1 мс`, not `<1 ms`, and matching the English unit reported
 * "0 hops, host did not answer" for a trace that had plainly succeeded.
 *
 * A hop line is a line that begins with the hop number. The headers do not — "Трассировка
 * маршрута к 192.168.1.31 с максимальным числом прыжков 20" begins with a letter, and the
 * closing line likewise — so the rule holds in every language the tools ship in.
 */
export function parseTraceroute(text: string): NetProbeResult['summary'] {
  const summary = emptySummary();
  if (text.trim() === '') return summary;

  let hops = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    // "  1    <1 мс    <1 мс    <1 мс   192.168.1.31" / "1  10.0.0.1  0.5 ms  0.4 ms"
    if (/^\d+\s+\S/.test(trimmed)) hops += 1;
  }
  summary.hops = hops;
  // If any hop answered, the probe reached something. Only an empty table is a failure,
  // and that needs no vocabulary to detect.
  summary.unreachable = hops === 0;
  return summary;
}
