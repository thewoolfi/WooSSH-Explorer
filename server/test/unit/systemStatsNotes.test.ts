import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { STATS_MARKERS, parseSystemStats } from '../../src/systemStats.js';

/**
 * The notes exist because a real host answered this probe with nothing and the panel
 * could only say "not available" — true, and impossible to act on.
 */
describe('parseSystemStats notes', () => {
  it('says the probe produced no markers when nothing came back', () => {
    const stats = parseSystemStats('');
    assert.equal(stats.notes.length, 1);
    assert.equal(stats.notes[0]?.scope, 'markers');
    assert.match(stats.notes[0]?.detail ?? '', /none of its section markers/);
  });

  it('blames the shell when every marker is missing from a non-empty answer', () => {
    // Exactly what a real shell does with `echo ###MARKER`: it prints a blank line.
    const stdout = ['', '', ' 12:00 up 3 days', '0.1 0.2 0.3', 'Linux box 6.1 x86_64'].join('\n');
    const stats = parseSystemStats(stdout);
    assert.equal(stats.notes[0]?.scope, 'markers');
    assert.match(stats.notes[0]?.detail ?? '', /may not be POSIX-compatible/);
  });

  it('names the tools that are missing when stderr says so', () => {
    const stdout = [STATS_MARKERS.uptime, 'up 3 days, 4:05', STATS_MARKERS.uname, 'Linux', '6.1.0', 'box'].join('\n');
    const stats = parseSystemStats(stdout, Date.now(), 'sh: 1: free: not found');
    const detail = stats.notes.map((note) => note.detail).join(' ');
    assert.match(detail, /missing a tool/);
    assert.match(detail, /memory/);
  });

  it('marks each empty section individually', () => {
    const stdout = [STATS_MARKERS.uptime, 'up 3 days, 4:05', STATS_MARKERS.uname, 'Linux', '6.1.0', 'box'].join('\n');
    const stats = parseSystemStats(stdout, Date.now(), '');
    const scopes = stats.notes.map((note) => note.scope);
    assert.ok(scopes.includes('memory'));
    assert.ok(scopes.includes('disks'));
    // The figures that did parse must not be reported as missing.
    assert.equal(scopes.includes('uptime'), false);
    assert.equal(scopes.includes('kernel'), false);
  });

  it('stays quiet when the answer is complete', () => {
    const stdout = [
      STATS_MARKERS.uptime,
      ' 12:00:00 up 10 days,  3:21,  2 users,  load average: 0.42, 0.55, 0.61',
      STATS_MARKERS.load,
      '0.42 0.55 0.61 1/234 5678',
      STATS_MARKERS.free,
      '              total        used        free      shared  buff/cache   available',
      'Mem:     8589934592  4294967296  2147483648           0  2147483648  4294967296',
      'Swap:    2147483648   268435456  1879048192',
      STATS_MARKERS.cpu,
      '4',
      STATS_MARKERS.df,
      'Filesystem     1024-blocks      Used Available Capacity Mounted on',
      '/dev/sda1        103080896  44040192  53799936      46% /',
      STATS_MARKERS.uname,
      'Linux',
      '6.1.0-generic',
      'ubuntu-meb',
    ].join('\n');
    const stats = parseSystemStats(stdout);
    assert.deepEqual(stats.notes, []);
    assert.equal(stats.hostname, 'ubuntu-meb');
    assert.equal(stats.kernel, 'Linux 6.1.0-generic');
    assert.equal(stats.cpuCount, 4);
    assert.equal(stats.memory?.totalBytes, 8589934592);
    assert.equal(stats.disks.length, 1);
  });
});
