import { ApiError } from './errors.js';
import type { Logger } from './logger.js';
import type { SshConnection } from './ssh/SshConnection.js';

/**
 * A one-shot report on what a connection can actually do.
 *
 * Written after a real host failed in a way that took a screenshot and an hour of
 * reasoning to explain: the status probe sent `echo ###MARKER`, which every POSIX shell
 * reads as a comment, so the markers never came back and every figure was null. The
 * application reported "not available" — true, and useless.
 *
 * This runs the same kind of probes, but *reports what each one returned*, so the answer
 * to "why is this empty" is a thing the user can copy and send rather than a guess.
 */

export interface DiagnosticCheck {
  name: string;
  /** What was run, quoted exactly as it went over the wire. */
  command: string;
  ok: boolean;
  /** Trimmed first line or two of stdout. */
  output: string;
  /** Trimmed stderr, when the host produced any. */
  error: string | null;
  durationMs: number;
}

export interface DiagnosticReport {
  collectedAt: number;
  latencyMs: number | null;
  checks: DiagnosticCheck[];
  /** One line per thing that looks wrong, in plain language. */
  findings: string[];
  /** The block a user can paste into a bug report. */
  text: string;
}

/**
 * The probes. Each is short, read-only and safe on any POSIX host; the ones that matter
 * most are the shell shape (does it strip comments?) and the presence of the tools the
 * rest of the application shells out to.
 *
 * Exported so the audit test can hold every one of them to the same rules: quoted,
 * pipeline-free and incapable of changing the host.
 */
export const DIAGNOSTIC_COMMANDS: readonly { name: string; command: string }[] = [

  { name: 'shell', command: 'echo "$0 $SHELL"' },
  // The exact construct that broke the status panel: if this prints an empty line, the
  // shell treats a word starting with `#` as a comment.
  { name: 'comment handling', command: "echo ###SSHX-DIAG; echo '###SSHX-DIAG'" },
  { name: 'identity', command: 'id -un; id -u' },
  { name: 'platform', command: 'uname -srm' },
  { name: 'home', command: 'printf "%s\\n" "$HOME"' },
  { name: 'working directory', command: 'pwd' },
  { name: 'locale', command: 'printf "%s\\n" "${LC_ALL:-${LANG:-unset}}"' },
  { name: 'read /proc', command: 'cat /proc/loadavg' },
  // No pipelines: the probe should not depend on the shell's pipe handling to answer.
  { name: 'status probe', command: 'uptime; df -Pk /' },
  { name: 'archive tools', command: 'command -v tar; command -v gzip; command -v zip; command -v unzip' },
  { name: 'file tools', command: 'command -v find; command -v du; command -v stat; command -v chmod' },
  { name: 'transfer tools', command: 'command -v rsync; command -v scp; command -v sha256sum' },
  { name: 'free memory', command: 'free -b' },
  { name: 'disk space', command: 'df -Pk' },
];

/**
 * Trims an answer for display without changing what it says.
 *
 * Blank lines are kept: the whole point of the comment probe is that the unquoted form
 * prints an *empty* line, and an earlier version of this function filtered those away —
 * the report then showed the marker it was supposed to be proving absent.
 */
function clean(text: string, maxLines = 6, maxChars = 800): string {
  const lines = (text ?? '').split('\n').map((line) => line.replace(/\s+$/, ''));
  // A single trailing newline is noise; a blank line in the middle is information.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  const head = lines.slice(0, maxLines).join('\n');
  return head.length > maxChars ? `${head.slice(0, maxChars)}…` : head;
}

export async function runDiagnostics(
  connection: SshConnection,
  logger: Logger,
): Promise<DiagnosticReport> {
  const collectedAt = Date.now();
  const checks: DiagnosticCheck[] = [];

  for (const probe of DIAGNOSTIC_COMMANDS) {
    const started = Date.now();
    try {
      const result = await connection.exec(probe.command, { timeoutMs: 10_000, maxBytes: 256 * 1024 });
      checks.push({
        name: probe.name,
        command: probe.command,
        // `code` is null when the host closed the channel without reporting one.
        ok: result.code === 0 || result.code === null,
        output: clean(result.stdout),
        error: result.stderr.trim() === '' ? null : clean(result.stderr, 2, 300),
        durationMs: Date.now() - started,
      });
    } catch (err) {
      // A refused probe is a finding, not a crash: the report is the thing being built.
      const detail = err instanceof ApiError ? err.code : err instanceof Error ? err.message : 'failed';
      checks.push({
        name: probe.name,
        command: probe.command,
        ok: false,
        output: '',
        error: detail,
        durationMs: Date.now() - started,
      });
      if (err instanceof ApiError && err.code === 'CONNECT_FAILED') {
        // Nothing else will work either; stop before producing thirteen identical rows.
        break;
      }
    }
  }

  const findings = analyse(checks);
  const report: DiagnosticReport = {
    collectedAt,
    latencyMs: connection.latencyMs ?? null,
    checks,
    findings,
    text: '',
  };
  report.text = render(report, connection);
  logger.debug('diagnostics collected', { checks: checks.length, findings: findings.length });
  return report;
}

function analyse(checks: DiagnosticCheck[]): string[] {
  const findings: string[] = [];
  const byName = new Map(checks.map((check) => [check.name, check]));

  const comments = byName.get('comment handling');
  if (comments) {
    const lines = comments.output.split('\n');
    // A POSIX shell prints a blank line for the unquoted form and the marker for the quoted one.
    const unquotedBlank = lines[0]?.trim() === '';
    if (!unquotedBlank) {
      findings.push(
        'This shell does not treat `#` as a comment, which no POSIX shell does — probes that ' +
          'rely on quoting may behave unexpectedly.',
      );
    }
  }

  if (byName.get('read /proc')?.ok === false) {
    findings.push('Cannot read /proc/loadavg: the load average will always be empty on this host.');
  }

  const archives = byName.get('archive tools');
  if (archives) {
    const available = archives.output.split('\n').filter((line) => line.trim() !== '');
    for (const tool of ['tar', 'zip', 'unzip']) {
      if (!available.some((line) => line.endsWith(`/${tool}`) || line.trim() === tool)) {
        findings.push(`\`${tool}\` is not installed: packing and unpacking archives will not work here.`);
      }
    }
  }

  const files = byName.get('file tools');
  if (files) {
    for (const tool of ['du', 'find', 'stat']) {
      if (!files.output.includes(tool)) {
        findings.push(`\`${tool}\` is not installed: folder sizes or search may be degraded.`);
      }
    }
  }

  if (byName.get('free memory')?.ok === false) {
    findings.push('`free` is not available: memory and swap will stay empty.');
  }

  const failed = checks.filter((check) => !check.ok && check.error !== null);
  for (const check of failed.slice(0, 4)) {
    findings.push(`\`${check.name}\` failed: ${check.error?.split('\n')[0] ?? 'unknown error'}`);
  }

  if (findings.length === 0 && checks.length > 0) {
    findings.push('Nothing looks wrong: every probe answered as expected.');
  }
  return findings;
}

function render(report: DiagnosticReport, connection: SshConnection): string {
  const info = connection.serverInfo;
  const lines: string[] = [
    'SSH Explorer — connection diagnostics',
    `collected: ${new Date(report.collectedAt).toISOString()}`,
    `host: ${connection.username}@${connection.host}:${connection.port}`,
    `label: ${connection.label}`,
    `latency: ${report.latencyMs ?? '?'} ms`,
    info ? `server: ${info.platform} ${info.release} ${info.arch}, shell ${info.shell}` : 'server: unknown',
    '',
    'Findings',
  ];
  for (const finding of report.findings) lines.push(`  - ${finding}`);
  lines.push('', 'Probes');
  for (const check of report.checks) {
    lines.push(`  [${check.ok ? 'ok' : '!!'}] ${check.name} (${check.durationMs} ms)`);
    lines.push(`      $ ${check.command}`);
    if (check.output !== '') {
      for (const line of check.output.split('\n')) lines.push(`      | ${line}`);
    }
    if (check.error !== null) lines.push(`      ! ${check.error}`);
  }
  return lines.join('\n');
}
