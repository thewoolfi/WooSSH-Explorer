import { ApiError } from './errors.js';
import type { Logger } from './logger.js';
import type { SshConnection } from './ssh/SshConnection.js';
import type { DiskUsage, MemoryUsage, SwapUsage, SystemNote, SystemStats } from './types.js';

/**
 * Remote system stats (contract §16): ONE `exec` for the whole status panel, parsed
 * defensively — every section that cannot be read is `null` and the route never fails.
 *
 * The command is the one the contract describes, separated by `echo` markers instead of bare
 * `;`. Both are a single round trip; the markers are what make each section independently
 * parseable, which is the difference between "degrades to null" and "silently mis-parses
 * `free` output as `df` rows" on a system that has only some of the tools.
 */

export const STATS_MARKERS = {
  uptime: '###SSHX-UPTIME',
  load: '###SSHX-LOAD',
  free: '###SSHX-FREE',
  cpu: '###SSHX-CPU',
  df: '###SSHX-DF',
  uname: '###SSHX-UNAME',
} as const;

/**
 * The one command the panel runs.
 *
 * The markers are **quoted**: `echo ###SSHX-UPTIME` is a comment to every POSIX shell —
 * the `#` starts a word, so the whole thing is discarded and `echo` prints a blank line.
 * Unquoted, the markers never came back from a real host and every figure parsed as null.
 * The mock shell in the test suite now implements the same comment rule, so this cannot
 * regress silently again.
 */
export function statsCommand(): string {
  const marker = (name: string): string => `echo '${name}'`;
  return [
    marker(STATS_MARKERS.uptime),
    'uptime',
    marker(STATS_MARKERS.load),
    'cat /proc/loadavg',
    marker(STATS_MARKERS.free),
    'free -b',
    marker(STATS_MARKERS.cpu),
    'nproc',
    marker(STATS_MARKERS.df),
    'df -Pk',
    marker(STATS_MARKERS.uname),
    'uname -s',
    'uname -r',
    'uname -n',
  ].join('; ');
}

const KIB = 1024;

/** Splits the marker-delimited output into its sections. */
export function splitStatsSections(stdout: string): Record<string, string> {
  const sections: Record<string, string> = {};
  let current = '';
  let buffer: string[] = [];

  const flush = (): void => {
    if (current !== '') sections[current] = buffer.join('\n');
    buffer = [];
  };

  for (const line of (stdout ?? '').split('\n')) {
    const marker = line.trim();
    if (marker.startsWith('###SSHX-')) {
      flush();
      current = marker;
      continue;
    }
    buffer.push(line);
  }
  flush();
  return sections;
}

/**
 * "up 10 days,  3:22", "up 5 min", "up  1:22", "up 3 days, 4 min", "up 12:34" →
 * seconds. Returns `null` when the text does not contain an uptime phrase.
 */
export function parseUptimeSeconds(text: string): number | null {
  const match = /up\s+(?:(\d+)\s+days?[,\s]+)?(?:(\d+):(\d{2})|(\d+)\s+min(?:ute)?s?)/i.exec(text ?? '');
  if (match === null) return null;

  const days = match[1] === undefined ? 0 : Number.parseInt(match[1], 10);
  let seconds = days * 86_400;
  if (match[2] !== undefined && match[3] !== undefined) {
    seconds += Number.parseInt(match[2], 10) * 3600 + Number.parseInt(match[3], 10) * 60;
  } else if (match[4] !== undefined) {
    seconds += Number.parseInt(match[4], 10) * 60;
  }
  return Number.isFinite(seconds) ? seconds : null;
}

/** First three floats of `/proc/loadavg`, or of the `load average(s):` suffix of `uptime`. */
export function parseLoad(text: string): [number, number, number] | null {
  const direct = /^\s*(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s/.exec(text ?? '');
  if (direct !== null) {
    return [Number(direct[1]), Number(direct[2]), Number(direct[3])];
  }
  // BSD/macOS: "load averages: 1.42 1.55 1.61" — the values live on the uptime line.
  const wrapped = /load\s+average[s]?:\s*(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)/i.exec(text ?? '');
  if (wrapped !== null) {
    return [Number(wrapped[1]), Number(wrapped[2]), Number(wrapped[3])];
  }
  return null;
}

function firstInteger(text: string): number | null {
  const match = /-?\d+/.exec(text ?? '');
  if (match === null) return null;
  const value = Number.parseInt(match[0], 10);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** `free -b` → `Mem:` / `Swap:` rows. Any missing or unparseable row stays `null`. */
export function parseFree(stdout: string): { memory: MemoryUsage | null; swap: SwapUsage | null } {
  let memory: MemoryUsage | null = null;
  let swap: SwapUsage | null = null;

  for (const line of (stdout ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const fields = trimmed.split(/\s+/);
    const label = (fields[0] ?? '').replace(/:$/, '').toLowerCase();
    if (label !== 'mem' && label !== 'swap') continue;

    const numbers = fields
      .slice(1)
      .map((field) => (/^\d+$/.test(field) ? Number.parseInt(field, 10) : Number.NaN))
      .filter((value) => Number.isFinite(value));
    if (numbers.length < 2) continue;

    const total = numbers[0] as number;
    const used = numbers[1] as number;
    if (label === 'mem') {
      // Linux: total used free shared buff/cache available — the last column is the real
      // "available"; older `free` (total used free shared buffers cached) stops earlier, and
      // there the free column is the best figure we have.
      const free = numbers[2] ?? 0;
      const last = numbers[numbers.length - 1] as number;
      const available = numbers.length >= 6 && last <= total ? last : free;
      memory = { totalBytes: total, usedBytes: used, availableBytes: available };
    } else {
      swap = { totalBytes: total, usedBytes: used };
    }
  }

  return { memory, swap };
}

/** `df -Pk` → one row per mount. The KiB figures are converted to bytes. */
export function parseDf(stdout: string): DiskUsage[] {
  const disks: DiskUsage[] = [];
  for (const line of (stdout ?? '').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const fields = trimmed.split(/\s+/);
    if (fields.length < 6) continue;
    if (fields[0] === 'Filesystem') continue;

    const size = Number.parseInt(fields[1] as string, 10);
    const used = Number.parseInt(fields[2] as string, 10);
    const available = Number.parseInt(fields[3] as string, 10);
    if (!Number.isFinite(size) || !Number.isFinite(used) || !Number.isFinite(available)) continue;

    disks.push({
      filesystem: fields[0] as string,
      sizeBytes: size * KIB,
      usedBytes: used * KIB,
      availableBytes: available * KIB,
      // A mount point may contain spaces; `-P` keeps it in the remaining columns.
      mount: fields.slice(5).join(' '),
    });
  }
  return disks;
}

/** An all-`null` result: what an unreachable or non-POSIX host degrades to. */
export function emptySystemStats(collectedAt = Date.now(), hostname: string | null = null): SystemStats {
  return {
    collectedAt,
    uptimeSeconds: null,
    load: null,
    cpuCount: null,
    memory: null,
    swap: null,
    disks: [],
    hostname,
    kernel: null,
    notes: [],
  };
}

/** Parses the marker-delimited output of {@link statsCommand}. Never throws. */
export function parseSystemStats(stdout: string, collectedAt = Date.now(), stderr = ''): SystemStats {
  const sections = splitStatsSections(stdout);
  const uptime = sections[STATS_MARKERS.uptime] ?? '';
  const loadText = sections[STATS_MARKERS.load] ?? '';
  const freeText = sections[STATS_MARKERS.free] ?? '';
  const cpuText = sections[STATS_MARKERS.cpu] ?? '';
  const dfText = sections[STATS_MARKERS.df] ?? '';
  const unameText = sections[STATS_MARKERS.uname] ?? '';

  const unameLines = unameText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.includes('command not found'));
  const sysname = unameLines[0] ?? '';
  const release = unameLines[1] ?? '';
  const hostname = unameLines[2] ?? '';

  const { memory, swap } = parseFree(freeText);

  const uptimeSeconds = parseUptimeSeconds(uptime);
  const load = parseLoad(loadText) ?? parseLoad(uptime);
  const cpuCount = firstInteger(cpuText);
  const disks = parseDf(dfText);
  const notes = explainMissing({
    sectionsFound: Object.keys(sections).length,
    stderr,
    uptime: uptimeSeconds,
    load,
    cpu: cpuCount,
    memory,
    swap,
    disks: disks.length,
    kernel: sysname === '' ? null : sysname,
  });

  return {
    collectedAt,
    uptimeSeconds,
    // `/proc/loadavg` first; `uptime` carries the same numbers on BSD/macOS.
    load,
    cpuCount,
    memory,
    swap,
    disks,
    hostname: hostname === '' ? null : hostname,
    kernel: sysname === '' ? null : `${sysname}${release === '' ? '' : ` ${release}`}`,
    notes,
  };
}

/** Section names as a person would say them. */
const SECTION_LABEL: Record<string, string> = {
  uptime: 'uptime',
  load: 'the load average',
  cpu: 'the CPU count',
  memory: 'memory',
  swap: 'swap',
  disks: 'the disk list',
  kernel: 'the kernel version',
};

/**
 * Turns "this came back null" into something a person can act on.
 *
 * The distinction that matters: a host that lacks a tool is fine and expected, while a
 * command that produced no markers at all means the probe itself did not run — and that
 * is a bug somewhere, not a property of the host.
 */
function explainMissing(input: {
  sectionsFound: number;
  stderr: string;
  uptime: number | null;
  load: unknown;
  cpu: number | null;
  memory: unknown;
  swap: unknown;
  disks: number;
  kernel: string | null;
}): SystemNote[] {
  const notes: SystemNote[] = [];

  if (input.sectionsFound === 0) {
    notes.push({
      scope: 'markers',
      detail:
        'The probe returned none of its section markers, so nothing could be read. The ' +
        'remote shell may not be POSIX-compatible, or it refused the command.',
    });
    return notes;
  }

  const missing = (value: unknown): boolean => value === null || value === undefined;
  const sections: [SystemNote['scope'], boolean][] = [
    ['uptime', missing(input.uptime)],
    ['load', missing(input.load)],
    ['cpu', missing(input.cpu)],
    ['memory', missing(input.memory)],
    ['swap', missing(input.swap)],
    ['disks', input.disks === 0],
    ['kernel', input.kernel === null],
  ];

  const absent: string[] = [];
  for (const [scope, isMissing] of sections) {
    if (isMissing) absent.push(SECTION_LABEL[scope] ?? scope);
  }
  if (absent.length === 0) return notes;

  // "command not found" on stderr is the difference between "not installed" and "unreadable".
  const notFound = /command not found|not found/i.test(input.stderr);
  notes.push({
    scope: 'markers',
    detail: notFound
      ? `The host is missing a tool this probe needs: ${absent.join(', ')} unavailable.`
      : `Could not read ${absent.join(', ')}. The tools exist but produced nothing usable.`,
  });

  for (const scope of ['uptime', 'load', 'cpu', 'memory', 'swap', 'disks', 'kernel'] as const) {
    const isMissing = sections.find(([name]) => name === scope)?.[1] ?? false;
    if (isMissing) notes.push({ scope, detail: `No ${SECTION_LABEL[scope]} in the answer.` });
  }

  return notes;
}

/**
 * Runs the single §16 command. A connection that refuses `exec`, a timeout or a host with none
 * of the tools all degrade to an all-`null` result — the route is a status panel, not a probe
 * that may fail.
 */
export async function collectSystemStats(connection: SshConnection, logger: Logger): Promise<SystemStats> {
  const collectedAt = Date.now();
  const fallbackHostname = connection.serverInfo?.hostname ?? null;
  try {
    const result = await connection.exec(statsCommand(), { timeoutMs: 15_000, maxBytes: 1024 * 1024 });
    const parsed = parseSystemStats(result.stdout, collectedAt, result.stderr);
    return { ...parsed, hostname: parsed.hostname ?? fallbackHostname };
  } catch (err) {
    // A refused exec is an ApiError; anything else is unexpected. Neither is fatal here.
    const detail =
      err instanceof ApiError
        ? `The host refused the probe (${err.code}).`
        : `The probe could not run: ${err instanceof Error ? err.message : String(err)}`;
    if (!(err instanceof ApiError)) logger.debug('system stats failed', { error: err });
    else logger.debug('system stats unavailable', { code: err.code });
    return { ...emptySystemStats(collectedAt, fallbackHostname), notes: [{ scope: 'command', detail }] };
  }
}
