import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildTarArchiveCommand,
  buildTarExtractCommand,
  buildUnzipCommand,
  buildZipArchiveCommand,
} from '../../src/ssh/archive.js';
import { buildCopyCommand, shellQuote } from '../../src/ssh/fsOps.js';
import { statsCommand } from '../../src/systemStats.js';
import { DIAGNOSTIC_COMMANDS } from '../../src/diagnostics.js';

/**
 * Everything this server sends to a remote shell, in one place.
 *
 * A test double is only as good as its fidelity, and ours lied once: it echoed
 * `###MARKER` where every POSIX shell treats the word as a comment, so a command that
 * could never work on a real host passed the whole suite. The stats probe now has its
 * own regression test; this file exists so the *next* command added here has to be
 * looked at rather than assumed.
 *
 * For each command the questions are:
 *   1. is every path quoted, so a space or a quote cannot become a second command?
 *   2. does the mock implement the same semantics, or is this covered by a real host only?
 */

/** The narrowest quoting a shell needs: no bare metacharacter escapes from the argument. */
function isQuotedForShell(value: string): boolean {
  return shellQuote(value) === `'${value.replace(/'/g, `'\\''`)}'`;
}

/** A path that would run a second command if it were ever interpolated unquoted. */
const HOSTILE = "/tmp/it's here; rm -rf /";

/**
 * Splits a command line the way a POSIX shell would, honouring the `'\''` escape that
 * `shellQuote` emits. Checking the string for stray `;` is not enough — the quote can
 * legitimately contain one — so the arguments are reconstructed and compared instead.
 */
function shellWords(command: string): string[] {
  const words: string[] = [];
  let current = '';
  let inQuotes = false;
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] as string;
    // Outside quotes a backslash escapes the next character — that is how `'\''` puts a
    // literal apostrophe back between two quoted runs.
    if (!inQuotes && char === '\\') {
      current += command[index + 1] ?? '';
      index += 1;
      started = true;
      continue;
    }
    if (char === "'") {
      inQuotes = !inQuotes;
      started = true;
      continue;
    }
    if (!inQuotes && (char === ' ' || char === '\t')) {
      if (started) words.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started) words.push(current);
  return words;
}

describe('commands sent to a remote shell', () => {
  it('quotes every path in a copy or move', () => {
    const command = buildCopyCommand('cp', [HOSTILE], '/dest dir');
    assert.ok(command !== null);
    // The shell sees exactly four arguments: nothing escaped into a second command.
    assert.deepEqual(shellWords(command), ['cp', '-a', '--', HOSTILE, '/dest dir']);
  });

  it('refuses paths it cannot quote safely', () => {
    assert.equal(buildCopyCommand('cp', ['/a\0b'], '/dest'), null);
    assert.equal(buildCopyCommand('cp', [''], '/dest'), null);
  });

  it('quotes the archive destination, the parent and every base name', () => {
    const tar = buildTarArchiveCommand('tar.gz', HOSTILE, [{ parent: '/tmp/a b', base: 'src' }]);
    assert.ok(tar !== null);
    assert.deepEqual(shellWords(tar), ['tar', '-czf', HOSTILE, '-C', '/tmp/a b', 'src']);

    const zip = buildZipArchiveCommand(HOSTILE, '/tmp/a b', ['src', 'docs']);
    assert.ok(zip !== null);
    // `cd` and `zip` are two commands joined by `&&`; both halves are quoted.
    const [first, second] = zip.split(' && ');
    assert.deepEqual(shellWords(first as string), ['cd', '/tmp/a b']);
    assert.deepEqual(shellWords(second as string), ['zip', '-r', '-q', HOSTILE, 'src', 'docs']);
  });

  it('refuses a base name that would be read as a flag', () => {
    // `tar -czf out -C /tmp --checkpoint-action=exec=sh` is the shape being refused.
    assert.equal(buildTarArchiveCommand('tar', '/out.tar', [{ parent: '/tmp', base: '-x' }]), null);
    assert.equal(buildZipArchiveCommand('/out.zip', '/tmp', ['-x']), null);
  });

  it('quotes extraction paths', () => {
    assert.equal(
      buildTarExtractCommand('tar.gz', HOSTILE, '/tmp/a b'),
      `tar -xzf '${HOSTILE.replace(/'/g, `'\\''`)}' -C '/tmp/a b'`,
    );
    assert.equal(
      buildUnzipCommand(HOSTILE, '/tmp/a b', true),
      `unzip -o -q '${HOSTILE.replace(/'/g, `'\\''`)}' -d '/tmp/a b'`,
    );
  });

  it('shellQuote round-trips a single quote', () => {
    for (const value of ["it's", "a'b'c", 'plain', 'with space', '$HOME', '`whoami`']) {
      assert.ok(isQuotedForShell(value), `${value} must survive quoting`);
    }
  });

  it('quotes every marker in the status probe', () => {
    const command = statsCommand();
    // Covered by a real shell: the mock now implements the comment rule.
    for (const marker of command.match(/###SSHX-[A-Z]+/g) ?? []) {
      assert.ok(command.includes(`echo '${marker}'`), `${marker} must be quoted`);
    }
  });

  it('uses no pipelines, so a probe cannot depend on pipe handling', () => {
    for (const probe of DIAGNOSTIC_COMMANDS) {
      assert.equal(probe.command.includes('|'), false, `${probe.name} uses a pipeline`);
    }
  });

  it('keeps the diagnostics probes read-only', () => {
    // A probe that can change the host is not a probe.
    const mutating = /(^|[;&|]\s*)(rm|mv|cp|dd|truncate|chmod|chown|mkdir|touch|tee|>)\b/;
    for (const probe of DIAGNOSTIC_COMMANDS) {
      assert.equal(mutating.test(probe.command), false, `${probe.name} may modify the host`);
    }
  });
});
