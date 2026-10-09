import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DEFAULT_MAX_READ_BYTES,
  MAX_MAX_READ_BYTES,
  TEXT_SNIFF_BYTES,
  countLines,
  detectReadKind,
  extensionOf,
  isImageName,
  looksLikeText,
  mimeTypeFor,
} from '../../src/util/fileKind.js';
import { clampLimit, kindOf, modeText, parseModeString, parseDuOutput, toEpochMs } from '../../src/ssh/fsOps.js';
import { buildCopyCommand, execToolUnavailable } from '../../src/ssh/fsOps.js';
import { DEFAULT_COPY_LIMITS } from '../../src/ssh/fsCopy.js';
import { UserDirectory, parseAccountFile } from '../../src/ssh/userDirectory.js';
import { commonParent, zipEntryPath } from '../../src/transfers/TransferManager.js';

describe('modeText', () => {
  it('renders regular file permissions', () => {
    assert.equal(modeText(0o100644), '-rw-r--r--');
    assert.equal(modeText(0o100755), '-rwxr-xr-x');
    assert.equal(modeText(0o100600), '-rw-------');
    assert.equal(modeText(0o100000), '----------');
  });

  it('renders the type prefix', () => {
    assert.equal(modeText(0o040755), 'drwxr-xr-x');
    assert.equal(modeText(0o120777), 'lrwxrwxrwx');
    assert.equal(modeText(0o020666), 'crw-rw-rw-');
    assert.equal(modeText(0o060644), 'brw-r--r--');
    assert.equal(modeText(0o010644), 'prw-r--r--');
    assert.equal(modeText(0o140755), 'srwxr-xr-x');
  });

  it('renders setuid, setgid and sticky bits', () => {
    assert.equal(modeText(0o104755), '-rwsr-xr-x');
    assert.equal(modeText(0o102755), '-rwxr-sr-x');
    assert.equal(modeText(0o041777), 'drwxrwxrwt');
    // Without the execute bit the same flags render upper-case.
    assert.equal(modeText(0o104644), '-rwSr--r--');
    assert.equal(modeText(0o041776), 'drwxrwxrwT');
  });
});

describe('kindOf', () => {
  it('maps mode bits to EntryKind', () => {
    assert.equal(kindOf(0o100644), 'file');
    assert.equal(kindOf(0o040755), 'directory');
    assert.equal(kindOf(0o120777), 'symlink');
    assert.equal(kindOf(0o140755), 'other');
    assert.equal(kindOf(undefined), 'other');
  });
});

describe('toEpochMs', () => {
  it('converts UNIX seconds and Dates to epoch milliseconds', () => {
    assert.equal(toEpochMs(1_730_000_000), 1_730_000_000_000);
    assert.equal(toEpochMs(new Date(1_730_000_000_000)), 1_730_000_000_000);
    assert.equal(toEpochMs(undefined), 0);
    assert.equal(toEpochMs(Number.NaN), 0);
  });
});

describe('detectReadKind', () => {
  const text = Buffer.from('hello\nworld\n');
  const binary = Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]);
  // A realistic PNG signature followed by non-zero bytes: no NUL in the sniffing window.
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(16, 0xff)]);
  const oversizedImage = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(16, 0xff)]);
  // The same *extension* but with a NUL inside the first 8 KiB.
  const nulImage = Buffer.concat([Buffer.from([0x89, 0x50, 0x00, 0x47]), Buffer.alloc(16, 0xff)]);

  it('detects text', () => {
    assert.equal(detectReadKind(text, { name: 'notes.txt', size: 12, maxBytes: DEFAULT_MAX_READ_BYTES }), 'text');
    assert.equal(detectReadKind(text, { name: 'Makefile', size: 12, maxBytes: DEFAULT_MAX_READ_BYTES }), 'text');
  });

  it('detects binary from a NUL byte in the first 8 KiB', () => {
    assert.equal(detectReadKind(binary, { name: 'blob.bin', size: 5, maxBytes: DEFAULT_MAX_READ_BYTES }), 'binary');
    // A NUL *after* 8 KiB is not part of the sniffing window.
    const lateNul = Buffer.concat([Buffer.alloc(TEXT_SNIFF_BYTES, 0x41), Buffer.from([0])]);
    assert.equal(
      detectReadKind(lateNul, { name: 'late.bin', size: lateNul.length, maxBytes: MAX_MAX_READ_BYTES }),
      'text',
    );
  });

  it('detects images by extension', () => {
    assert.equal(detectReadKind(png, { name: 'logo.png', size: 20, maxBytes: DEFAULT_MAX_READ_BYTES }), 'image');
    assert.equal(detectReadKind(png, { name: 'photo.JPEG', size: 20, maxBytes: DEFAULT_MAX_READ_BYTES }), 'image');
    assert.equal(detectReadKind(Buffer.from('<svg/>'), { name: 'icon.svg', size: 6, maxBytes: 100 }), 'image');
  });

  it('reports tooLarge for oversized images but truncates oversized text', () => {
    assert.equal(detectReadKind(oversizedImage, { name: 'big.png', size: 10_000_000, maxBytes: 1024 }), 'tooLarge');
    assert.equal(detectReadKind(text, { name: 'big.log', size: 10_000_000, maxBytes: 1024 }), 'text');
  });

  it('lets an image extension win over NUL bytes, so previews keep working', () => {
    // Real PNGs contain NUL bytes (filter bytes, 16-bit samples); treating them as opaque
    // binary would break inline previews.
    assert.equal(detectReadKind(nulImage, { name: 'broken.png', size: 20, maxBytes: 1024 }), 'image');
    // A NUL byte in a file with no image extension is still binary.
    assert.equal(detectReadKind(nulImage, { name: 'broken.dat', size: 20, maxBytes: 1024 }), 'binary');
  });

  it('never throws on an empty sample', () => {
    assert.equal(detectReadKind(Buffer.alloc(0), { name: 'empty.txt', size: 0, maxBytes: 100 }), 'text');
    assert.equal(looksLikeText(Buffer.alloc(0)), true);
  });
});

describe('extensionOf / mimeTypeFor / isImageName', () => {
  it('extracts extensions safely', () => {
    assert.equal(extensionOf('archive.tar.gz'), 'gz');
    assert.equal(extensionOf('/etc/nginx.conf'), 'conf');
    assert.equal(extensionOf('.bashrc'), '');
    assert.equal(extensionOf('no-extension'), '');
    assert.equal(extensionOf('trailing.'), '');
  });

  it('maps mime types', () => {
    assert.equal(mimeTypeFor('a.txt', 'text'), 'text/plain');
    assert.equal(mimeTypeFor('a.json', 'text'), 'application/json');
    assert.equal(mimeTypeFor('a.png', 'image'), 'image/png');
    assert.equal(mimeTypeFor('a.svg', 'image'), 'image/svg+xml');
    assert.equal(mimeTypeFor('a.bin', 'binary'), 'application/octet-stream');
    assert.equal(mimeTypeFor('no-extension', 'text'), 'text/plain');
  });

  it('recognises image names case-insensitively', () => {
    assert.equal(isImageName('A.PNG'), true);
    assert.equal(isImageName('a.webp'), true);
    assert.equal(isImageName('a.txt'), false);
  });
});

describe('countLines', () => {
  it('does not count a trailing newline as an extra line', () => {
    assert.equal(countLines(''), 0);
    assert.equal(countLines('one'), 1);
    assert.equal(countLines('one\n'), 1);
    assert.equal(countLines('one\ntwo'), 2);
    assert.equal(countLines('one\ntwo\n'), 2);
    assert.equal(countLines('\n'), 1);
    assert.equal(countLines('a\n\nb'), 3);
  });
});

describe('clampLimit', () => {
  it('applies defaults and caps', () => {
    assert.equal(clampLimit(undefined, 5000, 20_000), 5000);
    assert.equal(clampLimit(0, 5000, 20_000), 5000);
    assert.equal(clampLimit(-3, 5000, 20_000), 5000);
    assert.equal(clampLimit(10, 5000, 20_000), 10);
    assert.equal(clampLimit(10.9, 5000, 20_000), 10);
    assert.equal(clampLimit(999_999, 5000, 20_000), 20_000);
    assert.equal(clampLimit(Number.NaN, 5000, 20_000), 5000);
  });
});

describe('parseModeString', () => {
  it('accepts the documented forms', () => {
    assert.equal(parseModeString('644'), 0o644);
    assert.equal(parseModeString('0755'), 0o755);
    assert.equal(parseModeString('0o755'), 0o755);
    assert.equal(parseModeString('0x1ed'), 0o755);
    assert.equal(parseModeString(' 600 '), 0o600);
    assert.equal(parseModeString('4755'), 0o4755);
  });

  it('rejects nonsense', () => {
    for (const bad of ['', 'rwx', '99999', '-1', '0o9']) {
      assert.throws(() => parseModeString(bad), /Invalid mode/);
    }
  });
});

describe('parseDuOutput', () => {
  it('parses kibibyte lines into bytes', () => {
    const parsed = parseDuOutput('4\t/home/user\n1024\t/var/log\n');
    assert.equal(parsed.get('/home/user'), 4096);
    assert.equal(parsed.get('/var/log'), 1024 * 1024);
  });

  it('handles the trailing-slash and multi-space forms', () => {
    const parsed = parseDuOutput('8\t/tmp/\n16    /srv\n');
    assert.equal(parsed.get('/tmp'), 8192);
    assert.equal(parsed.get('/srv'), 16384);
  });

  it('ignores unparseable lines', () => {
    assert.equal(parseDuOutput('du: cannot access x\n\n').size, 0);
  });
});

describe('parseAccountFile / UserDirectory', () => {
  it('parses passwd-style lines', () => {
    const { byId } = parseAccountFile('root:x:0:0:root:/root:/bin/bash\n# comment\ndeploy:x:1000:1000::/home/deploy:/bin/sh\n');
    assert.equal(byId.get(0), 'root');
    assert.equal(byId.get(1000), 'deploy');
  });

  it('falls back to the numeric id', () => {
    const users = UserDirectory.fromContents('root:x:0:0::/root:/bin/bash\n', 'root:x:0:\n');
    assert.equal(users.owner(0), 'root');
    assert.equal(users.owner(4242), '4242');
    assert.equal(users.group(4242), '4242');
    assert.equal(UserDirectory.empty().owner(1), '1');
  });
});

describe('commonParent / zipEntryPath', () => {
  it('finds the shared directory', () => {
    assert.equal(commonParent(['/a/b/c.txt', '/a/b/d.txt']), '/a/b');
    assert.equal(commonParent(['/a/b.txt', '/c/d.txt']), '/');
    assert.equal(commonParent(['/single/file.txt']), '/single');
    assert.equal(commonParent([]), '/');
  });

  it('stores zip entries relative to the shared parent', () => {
    assert.equal(zipEntryPath('/a/b', '/a/b/c.txt'), 'c.txt');
    assert.equal(zipEntryPath('/a/b', '/a/b/sub/c.txt'), 'sub/c.txt');
    assert.equal(zipEntryPath('/', '/a/b/c.txt'), 'a/b/c.txt');
    assert.equal(zipEntryPath('/a/b', '/other/c.txt'), 'other/c.txt');
  });
});

describe('buildCopyCommand (§6 copy/move)', () => {
  it('builds a quoted cp -a / mv command', () => {
    assert.equal(buildCopyCommand('cp', ['/a/b.txt'], '/c/b.txt'), "cp -a -- '/a/b.txt' '/c/b.txt'");
    assert.equal(
      buildCopyCommand('mv', ['/a/b.txt', '/a/c.txt'], '/dest'),
      "mv -- '/a/b.txt' '/a/c.txt' '/dest'",
    );
  });

  it('escapes single quotes the POSIX way', () => {
    assert.equal(buildCopyCommand('cp', ["/tmp/it's here"], '/dest'), "cp -a -- '/tmp/it'\\''s here' '/dest'");
  });

  it('keeps shell metacharacters inert', () => {
    const command = buildCopyCommand('cp', ['/tmp/$(rm -rf /)'], '/dest') as string;
    assert.equal(command, "cp -a -- '/tmp/$(rm -rf /)' '/dest'");
    // The substitution characters survive, but only inside single quotes — a shell that sees
    // this command treats the whole thing as one literal path.
    assert.ok(command.includes("'/tmp/$(rm -rf /)'"), 'the path must be single-quoted');
    assert.ok(!command.includes('`') && !command.includes(';'), 'no other shell syntax is introduced');
  });

  it('refuses paths that cannot be passed safely', () => {
    assert.equal(buildCopyCommand('cp', ['/a\0b'], '/dest'), null);
    assert.equal(buildCopyCommand('cp', [''], '/dest'), null);
    assert.equal(buildCopyCommand('cp', ['/a'], ''), null);
  });
});

describe('execToolUnavailable', () => {
  it('recognises a missing or unusable binary so the SFTP path can take over', () => {
    assert.equal(execToolUnavailable({ code: 127, stdout: '', stderr: 'sh: cp: not found\n' }), true);
    assert.equal(execToolUnavailable({ code: 126, stdout: '', stderr: '' }), true);
    assert.equal(execToolUnavailable({ code: 1, stdout: '', stderr: 'cp: illegal option -- a\n' }), true);
    assert.equal(execToolUnavailable({ code: 1, stdout: '', stderr: 'cp: unknown option\n' }), true);
    assert.equal(execToolUnavailable({ code: 1, stdout: '', stderr: 'cp: Operation not permitted\n' }), true);
  });

  it('does not disguise a real failure', () => {
    assert.equal(execToolUnavailable({ code: 1, stdout: '', stderr: 'cp: Permission denied\n' }), false);
    assert.equal(execToolUnavailable({ code: 1, stdout: '', stderr: 'cp: No space left on device\n' }), false);
    assert.equal(execToolUnavailable({ code: 0, stdout: '', stderr: '' }), false);
  });
});

describe('copy limits', () => {
  it('bounds the walk so a symlink loop or a huge tree cannot hang a request', () => {
    assert.ok(DEFAULT_COPY_LIMITS.maxDepth > 0 && DEFAULT_COPY_LIMITS.maxDepth <= 1024);
    assert.ok(DEFAULT_COPY_LIMITS.maxNodes >= 10_000);
  });
});
