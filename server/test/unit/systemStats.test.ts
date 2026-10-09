/**
 * §16 remote system stats: the parser against captured sample output from a Linux host and from
 * a BSD/macOS host, plus the degradation rules (every unreadable section is `null`, never an
 * error). The samples are inline on purpose — they are the contract of this parser.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  emptySystemStats,
  parseDf,
  parseFree,
  parseLoad,
  parseSystemStats,
  parseUptimeSeconds,
  splitStatsSections,
  statsCommand,
  STATS_MARKERS,
} from '../../src/systemStats.js';

const KIB = 1024;

/** Captured from a Debian 12 host (Linux 6.1, GNU coreutils). */
const LINUX_SAMPLE = [
  STATS_MARKERS.uptime,
  ' 14:22:01 up 42 days,  3:22,  2 users,  load average: 0.42, 0.55, 0.61',
  STATS_MARKERS.load,
  '0.42 0.55 0.61 1/234 5678',
  STATS_MARKERS.free,
  '               total        used        free      shared  buff/cache   available',
  'Mem:     8589934592  4294967296  1073741824           0  3221225472  5368709120',
  'Swap:    2147483648   268435456  1879048192',
  STATS_MARKERS.cpu,
  '4',
  STATS_MARKERS.df,
  'Filesystem       1024-blocks       Used  Available Capacity Mounted on',
  '/dev/sda1          103080448  42949672   60130776      42% /',
  'tmpfs                1048576         0    1048576       0% /dev/shm',
  STATS_MARKERS.uname,
  'Linux',
  '6.1.0-13-amd64',
  'prod-web-01',
  '',
].join('\n');

/** Captured from a macOS 14 host: no /proc, BSD userland, `free`/`nproc` absent. */
const MACOS_SAMPLE = [
  STATS_MARKERS.uptime,
  '14:22  up 10 days,  3:22, 2 users, load averages: 1.42 1.55 1.61',
  STATS_MARKERS.load,
  'cat: /proc/loadavg: No such file or directory',
  STATS_MARKERS.free,
  'free: command not found',
  STATS_MARKERS.cpu,
  'nproc: command not found',
  STATS_MARKERS.df,
  'Filesystem   1024-blocks      Used Available Capacity  Mounted on',
  '/dev/disk1s1   971350180 234567890 700000000    26%   /',
  'devfs                1234      1234         0   100%   /dev',
  STATS_MARKERS.uname,
  'Darwin',
  '23.1.0',
  'macbook.local',
  '',
].join('\n');

describe('statsCommand', () => {
  it('collects everything in one round trip, delimited by markers', () => {
    const command = statsCommand();
    // Six markers, each followed by its command — still a single `exec`.
    assert.equal(command.split(';').length, 14);
    assert.ok(command.includes('uptime'));
    assert.ok(command.includes('cat /proc/loadavg'));
    assert.ok(command.includes('free -b'));
    assert.ok(command.includes('df -Pk'));
    assert.ok(command.includes('uname -sr'.replace('sr', 's')) && command.includes('uname -r'));
    for (const marker of Object.values(STATS_MARKERS)) {
      assert.ok(
        command.includes(`echo '${marker}'`),
        `the command must delimit the ${marker} section`,
      );
    }
  });

  it('quotes every marker, because `echo ###X` is a comment to a real shell', () => {
    const command = statsCommand();
    for (const marker of Object.values(STATS_MARKERS)) {
      // Unquoted, the shell discards the word and `echo` prints a blank line: the markers
      // never came back from a real host and every figure parsed as null. The mock shell
      // now implements the same comment rule, so this assertion and the e2e test agree.
      assert.ok(
        command.includes(`echo '${marker}'`),
        `${marker} must be quoted — unquoted it is a shell comment`,
      );
      assert.equal(
        command.includes(`echo ${marker};`) || command.includes(`echo ${marker} `),
        false,
        `${marker} still appears unquoted somewhere in the command`,
      );
    }
  });
});

describe('splitStatsSections', () => {
  it('keeps every line inside its section', () => {
    const sections = splitStatsSections(LINUX_SAMPLE);
    assert.equal(sections[STATS_MARKERS.cpu]?.trim(), '4');
    assert.ok(sections[STATS_MARKERS.df]?.includes('/dev/sda1'));
    assert.equal(sections[STATS_MARKERS.uname]?.trim().split('\n').length, 3);
  });
});

describe('parseUptimeSeconds', () => {
  it('parses the formats GNU and BSD uptime print', () => {
    assert.equal(parseUptimeSeconds(' 14:22:01 up 42 days,  3:22,  2 users'), 42 * 86_400 + 3 * 3600 + 22 * 60);
    assert.equal(parseUptimeSeconds('14:22  up 10 days,  3:22, 2 users'), 10 * 86_400 + 3 * 3600 + 22 * 60);
    assert.equal(parseUptimeSeconds(' 09:00:00 up 5 min,  1 user'), 5 * 60);
    assert.equal(parseUptimeSeconds(' 09:00:00 up  1:22,  1 user'), 1 * 3600 + 22 * 60);
    assert.equal(parseUptimeSeconds(' 09:00:00 up 3 days, 4 min,  1 user'), 3 * 86_400 + 4 * 60);
    assert.equal(parseUptimeSeconds(' 09:00:00 up 1 day,  0:05,  1 user'), 86_400 + 5 * 60);
  });

  it('returns null for anything it cannot read', () => {
    for (const text of ['', 'garbage', 'uptime: command not found', ' 14:22:01 up']) {
      assert.equal(parseUptimeSeconds(text), null, `expected null for ${JSON.stringify(text)}`);
    }
  });
});

describe('parseLoad', () => {
  it('prefers /proc/loadavg and falls back to the uptime line', () => {
    assert.deepEqual(parseLoad('0.42 0.55 0.61 1/234 5678'), [0.42, 0.55, 0.61]);
    assert.deepEqual(parseLoad(' 14:22  up 10 days, 2 users, load averages: 1.42 1.55 1.61'), [1.42, 1.55, 1.61]);
    assert.deepEqual(parseLoad('load average: 0.42, 0.55, 0.61'), [0.42, 0.55, 0.61]);
    assert.equal(parseLoad('cat: /proc/loadavg: No such file or directory'), null);
    assert.equal(parseLoad(''), null);
  });
});

describe('parseFree', () => {
  it('reads the modern Linux columns', () => {
    const { memory, swap } = parseFree(
      '               total        used        free      shared  buff/cache   available\n' +
        'Mem:     8589934592  4294967296  1073741824           0  3221225472  5368709120\n' +
        'Swap:    2147483648   268435456  1879048192\n',
    );
    assert.deepEqual(memory, {
      totalBytes: 8_589_934_592,
      usedBytes: 4_294_967_296,
      availableBytes: 5_368_709_120,
    });
    assert.deepEqual(swap, { totalBytes: 2_147_483_648, usedBytes: 268_435_456 });
  });

  it('falls back to the free column on an older `free`', () => {
    const { memory } = parseFree('Mem: 1000 400 500 100\n');
    assert.deepEqual(memory, { totalBytes: 1000, usedBytes: 400, availableBytes: 500 });
  });

  it('yields nulls when the tool is missing or the output is nonsense', () => {
    assert.deepEqual(parseFree('free: command not found\n'), { memory: null, swap: null });
    assert.deepEqual(parseFree(''), { memory: null, swap: null });
    assert.deepEqual(parseFree('Mem: abc def\n'), { memory: null, swap: null });
  });
});

describe('parseDf', () => {
  it('parses Linux rows and converts KiB to bytes', () => {
    const disks = parseDf(
      'Filesystem       1024-blocks       Used  Available Capacity Mounted on\n' +
        '/dev/sda1          103080448  42949672   60130776      42% /\n' +
        'tmpfs                1048576         0    1048576       0% /dev/shm\n',
    );
    assert.equal(disks.length, 2);
    assert.deepEqual(disks[0], {
      filesystem: '/dev/sda1',
      sizeBytes: 103_080_448 * KIB,
      usedBytes: 42_949_672 * KIB,
      availableBytes: 60_130_776 * KIB,
      mount: '/',
    });
    assert.equal(disks[1]?.mount, '/dev/shm');
  });

  it('parses BSD rows and keeps a mount point that contains spaces', () => {
    const disks = parseDf(
      'Filesystem   1024-blocks      Used Available Capacity  Mounted on\n' +
        '/dev/disk1s1   971350180 234567890 700000000    26%   /\n' +
        '/dev/disk2s1          0         0         0   100%   /System/Volumes/Data/home\n',
    );
    assert.equal(disks.length, 2);
    assert.equal(disks[0]?.mount, '/');
    assert.equal(disks[0]?.sizeBytes, 971_350_180 * KIB);
    assert.equal(disks[1]?.mount, '/System/Volumes/Data/home');
  });

  it('ignores headers and unparseable lines', () => {
    assert.deepEqual(parseDf('Filesystem 1024-blocks Used Available Capacity Mounted on\n'), []);
    assert.deepEqual(parseDf('df: command not found\n'), []);
    assert.deepEqual(parseDf(''), []);
  });
});

describe('parseSystemStats', () => {
  it('parses the Linux sample completely', () => {
    const stats = parseSystemStats(LINUX_SAMPLE, 1_730_000_000_000);
    assert.equal(stats.collectedAt, 1_730_000_000_000);
    assert.equal(stats.uptimeSeconds, 42 * 86_400 + 3 * 3600 + 22 * 60);
    assert.deepEqual(stats.load, [0.42, 0.55, 0.61]);
    assert.equal(stats.cpuCount, 4);
    assert.deepEqual(stats.memory, {
      totalBytes: 8_589_934_592,
      usedBytes: 4_294_967_296,
      availableBytes: 5_368_709_120,
    });
    assert.deepEqual(stats.swap, { totalBytes: 2_147_483_648, usedBytes: 268_435_456 });
    assert.equal(stats.disks.length, 2);
    assert.equal(stats.hostname, 'prod-web-01');
    assert.equal(stats.kernel, 'Linux 6.1.0-13-amd64');
  });

  it('parses the BSD/macOS sample, leaving what BSD cannot report as null', () => {
    const stats = parseSystemStats(MACOS_SAMPLE, 0);
    assert.equal(stats.uptimeSeconds, 10 * 86_400 + 3 * 3600 + 22 * 60);
    // No /proc/loadavg, but `uptime` carries the same numbers.
    assert.deepEqual(stats.load, [1.42, 1.55, 1.61]);
    assert.equal(stats.cpuCount, null);
    assert.equal(stats.memory, null);
    assert.equal(stats.swap, null);
    assert.equal(stats.disks.length, 2);
    assert.equal(stats.disks[0]?.mount, '/');
    assert.equal(stats.hostname, 'macbook.local');
    assert.equal(stats.kernel, 'Darwin 23.1.0');
  });

  it('never throws, whatever the remote printed', () => {
    for (const sample of ['', 'command not found\n', '\0\0\0', 'Mem: 1 2 3 4 5 6\n']) {
      const stats = parseSystemStats(sample, 7);
      assert.equal(stats.collectedAt, 7);
      assert.ok(Array.isArray(stats.disks));
    }
  });

  it('reports an all-null result when the exec itself is unavailable', () => {
    const stats = emptySystemStats(5, 'from-the-handshake');
    assert.deepEqual(stats, {
      collectedAt: 5,
      uptimeSeconds: null,
      load: null,
      cpuCount: null,
      memory: null,
      swap: null,
      disks: [],
      hostname: 'from-the-handshake',
      kernel: null,
      // The route adds a note when the exec is what failed; the bare helper has none.
      notes: [],
    });
  });

  it('still reports the kernel when only the release is missing', () => {
    const stats = parseSystemStats(`${STATS_MARKERS.uname}\nLinux\n`, 0);
    assert.equal(stats.kernel, 'Linux');
    assert.equal(stats.hostname, null);
  });
});
