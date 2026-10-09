import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertProbeHost,
  clampCount,
  decodeOutput,
  parsePing,
  parseTraceroute,
  probeCommand,
} from '../../src/netTools.js';

/**
 * The probe hands a user-supplied host to a system binary. Nothing here goes through a
 * shell — `execFile` takes an argument array — but the arguments themselves can still be
 * read as flags by `ping` and `tracert`, so the host is validated as well.
 */
describe('assertProbeHost', () => {
  it('accepts hostnames, IPv4 and IPv6', () => {
    for (const host of ['example.com', '10.0.0.1', '2001:db8::1', 'host-1.internal', '127.0.0.1']) {
      assert.equal(assertProbeHost(host), host);
    }
  });

  it('trims surrounding whitespace', () => {
    assert.equal(assertProbeHost('  example.com  '), 'example.com');
  });

  it('refuses anything that could be read as a flag', () => {
    // `ping -f host` floods; `-c` changes the count; these must never come from a host field.
    for (const host of ['-f', '--help', '-c 1']) {
      assert.throws(() => assertProbeHost(host), /characters a probe cannot use/);
    }
  });

  it('refuses shell metacharacters and whitespace', () => {
    for (const host of ['a; rm -rf /', 'a && b', 'a|b', 'a$(id)', 'a`id`', 'a b', 'a\nb', '']) {
      assert.throws(() => assertProbeHost(host));
    }
  });

  it('refuses a non-string', () => {
    for (const value of [null, undefined, 42, {}, []]) {
      assert.throws(() => assertProbeHost(value));
    }
  });
});

describe('clampCount', () => {
  it('bounds the probe length', () => {
    assert.equal(clampCount(1), 1);
    assert.equal(clampCount(50), 10);
    assert.equal(clampCount(0), 4);
    assert.equal(clampCount('7'), 7);
    assert.equal(clampCount(undefined), 4);
  });
});

describe('probeCommand', () => {
  it('uses each platform\'s own tool and flags', () => {
    assert.deepEqual(probeCommand('ping', 'h', 3, 'win32'), {
      file: 'ping',
      args: ['-n', '3', '-w', '2000', 'h'],
    });
    assert.deepEqual(probeCommand('ping', 'h', 3, 'linux'), {
      file: 'ping',
      args: ['-c', '3', '-W', '2', 'h'],
    });
    // Windows names it `tracert`; the `-d`/`-n` flag means "do not resolve names".
    assert.equal(probeCommand('traceroute', 'h', 4, 'win32').file, 'tracert');
    assert.equal(probeCommand('traceroute', 'h', 4, 'linux').file, 'traceroute');
  });
});

describe('decodeOutput', () => {
  it('keeps valid UTF-8 as it is', () => {
    const utf8 = Buffer.from('Ответ от 127.0.0.1', 'utf8');
    assert.equal(decodeOutput(utf8, 'linux'), 'Ответ от 127.0.0.1');
  });

  it('falls back to the OEM code page for Windows console output', () => {
    // Bytes a Russian `ping.exe` writes in CP866: a valid UTF-8 read produces replacement
    // characters, which is exactly the mojibake this fallback exists to remove. The
    // assertion is about readability, not about one particular glyph table.
    const cp866 = Buffer.from([0x8e, 0xe2, 0xe2, 0xe5, 0xe2, 0x20, 0xee, 0xe2]);
    const decoded = decodeOutput(cp866, 'win32');
    assert.equal(decoded.includes('\uFFFD'), false, 'no replacement characters');
    assert.equal(decoded.length, 8, 'one character per byte');
  });

  it('does not apply the OEM fallback on other platforms', () => {
    const cp866 = Buffer.from([0x8e, 0xe2, 0xe2]);
    // On Linux the bytes really are invalid UTF-8 and the caller should see that.
    assert.equal(decodeOutput(cp866, 'linux').includes('\uFFFD'), true);
  });

  it('returns an empty string for no output', () => {
    assert.equal(decodeOutput(Buffer.alloc(0), 'win32'), '');
  });
});

describe('parsePing', () => {
  it('reads the English summary', () => {
    const text = [
      'Pinging example.com [93.184.216.34] with 32 bytes of data:',
      'Reply from 93.184.216.34: bytes=32 time=11ms TTL=56',
      'Packets: Sent = 4, Received = 4, Lost = 0 (0% loss),',
      'Approximate round trip times in milli-seconds:',
      '    Minimum = 10ms, Maximum = 14ms, Average = 11ms',
    ].join('\n');
    const summary = parsePing(text);
    assert.equal(summary.transmitted, 4);
    assert.equal(summary.received, 4);
    assert.equal(summary.lossPercent, 0);
    assert.equal(summary.avgMs, 11);
    assert.equal(summary.unreachable, false);
  });

  it('reads a localised summary by the shape of the numbers', () => {
    // Russian Windows: the words differ, the numbers and the percent sign do not.
    const text = [
      'Обмен пакетами с 127.0.0.1 по с 32 байтами данных:',
      'Ответ от 127.0.0.1: число байт=32 время<1мс TTL=128',
      'Ответ от 127.0.0.1: число байт=32 время<1мс TTL=128',
      'Статистика Ping для 127.0.0.1:',
      '    Пакетов: отправлено = 2, получено = 2, потеряно = 0',
      '    (0% потерь)',
    ].join('\n');
    const summary = parsePing(text);
    assert.equal(summary.received, 2, 'the replies are counted by their TTL field');
    assert.equal(summary.lossPercent, 0, 'the percent sign survives translation');
  });

  it('reads the Linux summary', () => {
    const text = [
      'PING example.com (93.184.216.34) 56(84) bytes of data.',
      '--- example.com ping statistics ---',
      '4 packets transmitted, 4 received, 0% packet loss, time 3004ms',
      'rtt min/avg/max/mdev = 10.031/11.042/14.061/1.012 ms',
    ].join('\n');
    const summary = parsePing(text);
    assert.equal(summary.transmitted, 4);
    assert.equal(summary.minMs, 10.031);
    assert.equal(summary.avgMs, 11.042);
    assert.equal(summary.maxMs, 14.061);
  });

  it('flags a host that never answered', () => {
    const summary = parsePing('Request timed out.\nPackets: Sent = 4, Received = 0, Lost = 4 (100% loss),');
    assert.equal(summary.received, 0);
    assert.equal(summary.unreachable, true);
  });

  it('an empty answer is not an error', () => {
    assert.equal(parsePing('').unreachable, false);
  });
});

describe('parseTraceroute', () => {
  it('counts the hops that answered', () => {
    const text = [
      'Tracing route to example.com [93.184.216.34]',
      'over a maximum of 20 hops:',
      '',
      '  1     1 ms     1 ms     1 ms  192.168.1.1',
      '  2    10 ms    11 ms    10 ms  10.0.0.1',
      '  3     *        *        *     Request timed out.',
    ].join('\n');
    const summary = parseTraceroute(text);
    assert.equal(summary.hops, 3);
    assert.equal(summary.unreachable, false);
  });

  it('counts a Russian trace, whose units are `мс` and not `ms`', () => {
    // The exact output that reported "0 hops, the host did not answer" for a trace that
    // had obviously succeeded: one hop, straight to the destination.
    const text = [
      'Трассировка маршрута к 192.168.1.31 с максимальным числом прыжков 20',
      '',
      '  1    <1 мс    <1 мс    <1 мс   192.168.1.31',
      '',
      'Трассировка завершена.',
    ].join('\n');
    const summary = parseTraceroute(text);
    assert.equal(summary.hops, 1, 'the numbered line is a hop, whatever the unit is called');
    assert.equal(summary.unreachable, false, 'a completed trace did not fail');
  });

  it('does not count the header or the closing line as hops', () => {
    const text = [
      'Трассировка маршрута к example.com [93.184.216.34]',
      'с максимальным числом прыжков 30:',
      '  1    10 ms    10 ms    10 ms  10.0.0.1',
      '  2    20 ms    20 ms    20 ms  93.184.216.34',
      'Трассировка завершена.',
    ].join('\n');
    // The header ends with a number ("прыжков 30") but does not begin with one.
    assert.equal(parseTraceroute(text).hops, 2);
  });

  it('counts hops that all timed out, because the hop is still known', () => {
    const text = ['  1     *        *        *     Request timed out.', '  2     *        *        *     Request timed out.'].join('\n');
    assert.equal(parseTraceroute(text).hops, 2);
  });

  it('reports a host that never answered anything', () => {
    const summary = parseTraceroute('Unable to resolve target system name nope.invalid.');
    assert.equal(summary.hops, 0);
    assert.equal(summary.unreachable, true);
  });

  it('an empty answer is not a failure either', () => {
    const summary = parseTraceroute('');
    // Nothing came back at all, so the count is unknown rather than zero.
    assert.equal(summary.hops, null);
    assert.equal(summary.unreachable, false);
  });
});
