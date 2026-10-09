import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

import { silentLogger } from '../../src/logger.js';
import {
  KnownHostsStore,
  classifyHostKey,
  computeFingerprint,
  fingerprintOfBase64,
  formatHostPattern,
  hostPatternMatches,
  parseKnownHosts,
  removeKnownHostLines,
} from '../../src/ssh/hostKeys.js';

/** A real ed25519 host key blob, so fingerprints are the ones ssh-keygen would print. */
function hostKeyBlob(): Buffer {
  const { publicKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  // The OpenSSH wire format for an ed25519 key: string "ssh-ed25519" + string <32 raw bytes>.
  const type = Buffer.from('ssh-ed25519', 'utf8');
  const raw = der.subarray(der.length - 32);
  const parts = Buffer.concat([
    Buffer.from([0, 0, 0, type.length]),
    type,
    Buffer.from([0, 0, 0, raw.length]),
    raw,
  ]);
  return parts;
}

function line(hosts: string, blob: Buffer, keyType = 'ssh-ed25519', comment?: string): string {
  const fields = [hosts, keyType, blob.toString('base64')];
  if (comment !== undefined) fields.push(comment);
  return fields.join(' ');
}

describe('computeFingerprint', () => {
  it('produces the OpenSSH SHA256:<base64-no-padding> format', () => {
    const fingerprint = computeFingerprint(hostKeyBlob());
    assert.match(fingerprint, /^SHA256:[A-Za-z0-9+/]+$/);
    assert.ok(!fingerprint.includes('='), 'padding must be stripped');
    // 32 bytes base64 is 43 characters without padding.
    assert.equal(fingerprint.length, 'SHA256:'.length + 43);
  });

  it('agrees with fingerprintOfBase64', () => {
    const blob = hostKeyBlob();
    assert.equal(fingerprintOfBase64(blob.toString('base64')), computeFingerprint(blob));
  });

  it('changes when a single byte changes', () => {
    const blob = hostKeyBlob();
    const other = Buffer.from(blob);
    other[other.length - 1] = (other[other.length - 1] as number) ^ 0xff;
    assert.notEqual(computeFingerprint(blob), computeFingerprint(other));
  });
});

describe('parseKnownHosts', () => {
  it('parses hosts, markers, comments and skips junk', () => {
    const a = hostKeyBlob();
    const b = hostKeyBlob();
    const content = [
      '# a comment',
      '',
      line('example.com,10.0.0.1', a, 'ssh-ed25519', 'user@laptop'),
      `@revoked ${line('bad.example', b)}`,
      line('[example.com]:2222', a, 'ssh-rsa'),
      'this line is broken',
      line('weird.example', a, 'ssh-ed25519', 'extra words here'),
      `@cert-authority ${line('ca.example', b)}`,
      '',
    ].join('\n');

    // Structurally valid lines are parsed even when the host is nonsense (that is the caller's
    // problem); blank, comment and prose lines are dropped by the parser itself.
    const entries = parseKnownHosts(content);
    assert.equal(entries.length, 5);

    const first = entries[0];
    assert.ok(first);
    assert.deepEqual(first.hosts, ['example.com', '10.0.0.1']);
    assert.equal(first.keyType, 'ssh-ed25519');
    assert.equal(first.keyBlob, a.toString('base64'));
    assert.equal(first.comment, 'user@laptop');
    assert.equal(first.line, 3);
    assert.equal(first.marker, undefined);

    const revoked = entries[1];
    assert.ok(revoked);
    assert.equal(revoked.marker, 'revoked');
    assert.deepEqual(revoked.hosts, ['bad.example']);

    const ported = entries[2];
    assert.ok(ported);
    assert.deepEqual(ported.hosts, ['[example.com]:2222']);
    assert.equal(ported.keyType, 'ssh-rsa');

    const commented = entries[3];
    assert.ok(commented);
    assert.equal(commented.comment, 'extra words here');

    const ca = entries[4];
    assert.ok(ca);
    assert.equal(ca.marker, 'cert-authority');
    assert.deepEqual(ca.hosts, ['ca.example']);
  });

  it('drops lines that cannot yield a plausible host/keytype/blob triple', () => {
    const content = [
      'only two fields',
      'one',
      'host keytype not-base64!!',
      'host ssh-ed25519 shortish',
      `${hostKeyBlob().toString('base64')} ssh-ed25519 host`,
      `${' '.repeat(3)}`,
    ].join('\n');
    // Prose that happens to split into three tokens is not mistaken for a key line: a real
    // base64 blob is long and the key type is ssh-* or *-*.
    assert.deepEqual(parseKnownHosts(content), []);
  });

  it('tolerates an empty file', () => {
    assert.deepEqual(parseKnownHosts(''), []);
    assert.deepEqual(parseKnownHosts('\n\n'), []);
  });
});

describe('formatHostPattern / hostPatternMatches', () => {
  it('uses the bare host for the default port and [host]:port otherwise', () => {
    assert.equal(formatHostPattern('example.com', 22), 'example.com');
    assert.equal(formatHostPattern('example.com', 2222), '[example.com]:2222');
    assert.equal(formatHostPattern('10.0.0.1', 22), '10.0.0.1');
  });

  it('only matches entries for the same host and port', () => {
    assert.equal(hostPatternMatches('example.com', 'example.com', 22), true);
    assert.equal(hostPatternMatches('example.com', 'example.com', 2222), false);
    assert.equal(hostPatternMatches('[example.com]:2222', 'example.com', 2222), true);
    // Hashed entries are deliberately never matched.
    assert.equal(hostPatternMatches('|1|abcd|efgh', 'example.com', 22), false);
  });
});

describe('classifyHostKey', () => {
  const mine = hostKeyBlob();
  const other = hostKeyBlob();

  it('reports unknown for an empty file', () => {
    const result = classifyHostKey({ host: 'h', port: 22, keyBlob: mine, content: '' });
    assert.equal(result.status, 'unknown');
  });

  it('matches an identical stored key', () => {
    const result = classifyHostKey({ host: 'h', port: 22, keyBlob: mine, content: line('h', mine) });
    assert.equal(result.status, 'match');
    if (result.status === 'match') assert.equal(result.fingerprint, computeFingerprint(mine));
  });

  it('matches an entry that also lists other hosts', () => {
    const content = line('a.example,b.example,h', mine);
    assert.equal(classifyHostKey({ host: 'h', port: 22, keyBlob: mine, content }).status, 'match');
  });

  it('reports mismatch when the stored key differs', () => {
    const result = classifyHostKey({ host: 'h', port: 22, keyBlob: mine, content: line('h', other) });
    assert.equal(result.status, 'mismatch');
    if (result.status === 'mismatch') {
      assert.equal(result.expected, computeFingerprint(other));
      assert.equal(result.fingerprint, computeFingerprint(mine));
    }
  });

  it('ignores entries for other hosts and other ports', () => {
    assert.equal(classifyHostKey({ host: 'h', port: 22, keyBlob: mine, content: line('other', other) }).status, 'unknown');
    assert.equal(
      classifyHostKey({ host: 'h', port: 22, keyBlob: mine, content: line('[h]:2222', other) }).status,
      'unknown',
    );
  });

  it('accepts a rotated key when both old and new are stored', () => {
    const content = `${line('h', other)}\n${line('h', mine)}`;
    assert.equal(classifyHostKey({ host: 'h', port: 22, keyBlob: mine, content }).status, 'match');
  });

  it('treats a matching @revoked entry as revoked', () => {
    const result = classifyHostKey({ host: 'h', port: 22, keyBlob: mine, content: `@revoked ${line('h', mine)}` });
    assert.equal(result.status, 'revoked');
  });

  it('does not let a @cert-authority entry cause a mismatch', () => {
    const content = `@cert-authority ${line('h', other)}`;
    assert.equal(classifyHostKey({ host: 'h', port: 22, keyBlob: mine, content }).status, 'unknown');
  });
});

describe('KnownHostsStore', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ssh-explorer-kh-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips through write and read', async () => {
    const readPath = path.join(dir, 'seed', 'known_hosts');
    const writePath = path.join(dir, 'state', 'known_hosts');
    const store = new KnownHostsStore({ readPath, writePath, logger: silentLogger });

    const blob = hostKeyBlob();
    assert.deepEqual(await store.readContent(), '');
    assert.equal((await store.verify('example.com', 22, blob)).status, 'unknown');

    const appended = await store.append('example.com', 22, 'ssh-ed25519', blob.toString('base64'), 'user@host');
    assert.equal(appended, true);

    // A second identical append is a no-op, never a duplicate line.
    assert.equal(await store.append('example.com', 22, 'ssh-ed25519', blob.toString('base64')), false);

    const content = await readFile(writePath, 'utf8');
    assert.equal(content.split('\n').filter((l) => l.trim() !== '').length, 1);
    assert.match(content, /^example\.com ssh-ed25519 /);
    assert.match(content, /user@host\n$/);

    const result = await store.verify('example.com', 22, blob);
    assert.equal(result.status, 'match');

    // A different key for the same host is a mismatch and does not overwrite anything.
    const other = hostKeyBlob();
    const mismatch = await store.verify('example.com', 22, other);
    assert.equal(mismatch.status, 'mismatch');
    assert.equal(await readFile(writePath, 'utf8'), content);
  });

  it('writes non-default ports in [host]:port form', async () => {
    const writePath = path.join(dir, 'ports', 'known_hosts');
    const store = new KnownHostsStore({ readPath: path.join(dir, 'none'), writePath, logger: silentLogger });
    const blob = hostKeyBlob();
    await store.append('example.com', 2222, 'ssh-ed25519', blob.toString('base64'));
    const content = await readFile(writePath, 'utf8');
    assert.match(content, /^\[example\.com\]:2222 ssh-ed25519 /);
    assert.equal((await store.verify('example.com', 2222, blob)).status, 'match');
    assert.equal((await store.verify('example.com', 22, blob)).status, 'unknown');
  });

  it('sets mode 0600 where the platform supports it', async () => {
    if (process.platform === 'win32') return;
    const writePath = path.join(dir, 'mode', 'known_hosts');
    const store = new KnownHostsStore({ readPath: path.join(dir, 'none'), writePath, logger: silentLogger });
    await store.append('example.com', 22, 'ssh-ed25519', hostKeyBlob().toString('base64'));
    const info = await stat(writePath);
    assert.equal(info.mode & 0o777, 0o600);
  });

  it('degrades to "unknown" when both files are missing', async () => {
    const store = new KnownHostsStore({
      readPath: path.join(dir, 'missing-a'),
      writePath: path.join(dir, 'missing-b'),
      logger: silentLogger,
    });
    assert.equal((await store.verify('h', 22, hostKeyBlob())).status, 'unknown');
    assert.equal(await store.exists(), false);
  });

  it('skips malformed lines instead of throwing', async () => {
    const readPath = path.join(dir, 'malformed', 'known_hosts');
    await mkdir(path.dirname(readPath), { recursive: true });
    await writeFile(readPath, 'not a known_hosts line\n\0\0binary junk\n', { encoding: 'utf8' });
    const store = new KnownHostsStore({ readPath, writePath: readPath, logger: silentLogger });
    const blob = hostKeyBlob();
    assert.equal((await store.verify('example.com', 22, blob)).status, 'unknown');
    assert.equal(await store.append('example.com', 22, 'ssh-ed25519', blob.toString('base64')), true);
    await chmod(readPath, 0o600).catch(() => undefined);
    assert.equal((await store.verify('example.com', 22, blob)).status, 'match');
  });

  it('can remove a host (used only for an explicit replace)', async () => {
    const writePath = path.join(dir, 'remove', 'known_hosts');
    const store = new KnownHostsStore({ readPath: path.join(dir, 'none'), writePath, logger: silentLogger });
    const blob = hostKeyBlob();
    await store.append('example.com', 22, 'ssh-ed25519', blob.toString('base64'));
    await store.append('other.example', 22, 'ssh-ed25519', blob.toString('base64'));
    assert.equal(await store.removeHost('example.com', 22), 1);
    const content = await readFile(writePath, 'utf8');
    assert.ok(!content.includes('example.com ssh-'));
    assert.ok(content.includes('other.example'));
    // §15: an unknown host removes nothing and reports it, which the route turns into 404.
    assert.equal(await store.removeHost('nope.example', 22), 0);
  });

  it('removes while preserving every other line byte for byte (§15)', async () => {
    const writePath = path.join(dir, 'preserve', 'known_hosts');
    await mkdir(path.dirname(writePath), { recursive: true });
    const blob = hostKeyBlob();
    const keepOne = line('keep-one.example', blob, 'ssh-ed25519', 'a comment');
    const keepTwo = line('[kept]:2222', blob, 'ssh-rsa');
    const original = [
      '# leading comment',
      '',
      line('drop.example', blob),
      keepOne,
      '   ',
      line('other.example', blob),
      keepTwo,
      '',
    ].join('\n');
    await writeFile(writePath, original, { encoding: 'utf8' });

    const store = new KnownHostsStore({ readPath: path.join(dir, 'none'), writePath, logger: silentLogger });
    assert.equal(await store.removeHost('drop.example', 22), 1);
    assert.equal(await store.removeHost('other.example', 22), 1);

    const after = await readFile(writePath, 'utf8');
    const expected = ['# leading comment', '', keepOne, '   ', keepTwo, ''].join('\n');
    assert.equal(after, expected, 'comments, blank lines and the trailing newline must survive');
  });

  it('preserves CRLF endings when removing a line', async () => {
    const writePath = path.join(dir, 'crlf', 'known_hosts');
    await mkdir(path.dirname(writePath), { recursive: true });
    const blob = hostKeyBlob();
    const keep = line('keep.example', blob);
    await writeFile(writePath, `# comment\r\n${line('drop.example', blob)}\r\n${keep}\r\n`, { encoding: 'utf8' });

    const store = new KnownHostsStore({ readPath: path.join(dir, 'none'), writePath, logger: silentLogger });
    assert.equal(await store.removeHost('drop.example', 22), 1);
    assert.equal(await readFile(writePath, 'utf8'), `# comment\r\n${keep}\r\n`);
  });

  it('lists the writable file in the §15 wire shape', async () => {
    const writePath = path.join(dir, 'listing', 'known_hosts');
    await mkdir(path.dirname(writePath), { recursive: true });
    const blob = hostKeyBlob();
    await writeFile(
      writePath,
      ['# a comment', line('a.example,b.example', blob), `@revoked ${line('revoked.example', blob)}`, ''].join('\n'),
      { encoding: 'utf8' },
    );

    const store = new KnownHostsStore({ readPath: path.join(dir, 'none'), writePath, logger: silentLogger });
    const entries = await store.listEntries();
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], {
      host: 'a.example,b.example',
      keyType: 'ssh-ed25519',
      fingerprint: computeFingerprint(blob),
      line: 2,
    });
    assert.equal(entries[1]?.marker, 'revoked');
    assert.equal(entries[1]?.line, 3);
    assert.ok(entries[1]?.fingerprint.startsWith('SHA256:'));
  });

  it('lists nothing when the writable file does not exist', async () => {
    const store = new KnownHostsStore({
      readPath: path.join(dir, 'none'),
      writePath: path.join(dir, 'absent', 'known_hosts'),
      logger: silentLogger,
    });
    assert.deepEqual(await store.listEntries(), []);
  });
});

describe('removeKnownHostLines', () => {
  it('returns the content untouched when nothing is doomed', () => {
    const content = 'a\nb\n';
    assert.equal(removeKnownHostLines(content, new Set()), content);
  });

  it('removes exactly the given 1-based lines', () => {
    assert.equal(removeKnownHostLines('a\nb\nc\n', new Set([2])), 'a\nc\n');
    assert.equal(removeKnownHostLines('a\nb\nc\n', new Set([1, 3])), 'b\n');
    assert.equal(removeKnownHostLines('a\nb\nc\n', new Set([1, 2, 3])), '');
  });

  it('preserves a file without a trailing newline', () => {
    assert.equal(removeKnownHostLines('a\nb', new Set([1])), 'b');
  });
});
