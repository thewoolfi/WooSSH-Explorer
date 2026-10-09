/**
 * The archive format layer that backs §6 `fs/archive` and `fs/extract` when the remote host has
 * no `tar`/`zip`: the USTAR writer/parser, the ZIP central-directory reader, the extract plan
 * (which is where path traversal is refused) and the remote command builders.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import zlib from 'node:zlib';
import * as yazl from 'yazl';

import {
  buildTarArchiveCommand,
  buildTarExtractCommand,
  buildUnzipCommand,
  buildZipArchiveCommand,
  validateExtractItems,
} from '../../src/ssh/archive.js';
import type { ArchiveRawEntry } from '../../src/ssh/archive.js';
import {
  TAR_BLOCK_SIZE,
  gnuLongNameBlocks,
  looksLikeTarHeader,
  parseTarHeader,
  splitUstarName,
  tarHeaderBlock,
  tarPadding,
} from '../../src/ssh/tarFormat.js';
import {
  ZIP_METHOD_DEFLATE,
  findZipEndRecord,
  parseZipCentralDirectory,
  parseZipLocalHeader,
  readZipDirectory,
} from '../../src/ssh/zipFormat.js';
import { ApiError } from '../../src/errors.js';

/** Builds a tar image in memory with the same primitives the server writes. */
function buildTar(entries: { name: string; data?: Buffer; mode?: number; mtimeMs?: number; target?: string; typeflag?: '0' | '2' | '5' }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const typeflag = entry.typeflag ?? (entry.data === undefined ? '5' : '0');
    const size = typeflag === '0' ? (entry.data?.length ?? 0) : 0;
    blocks.push(
      tarHeaderBlock({
        name: entry.name,
        mode: entry.mode ?? 0o644,
        size,
        mtimeMs: entry.mtimeMs ?? 1_700_000_000_000,
        typeflag,
        ...(entry.target !== undefined ? { linkname: entry.target } : {}),
      }),
    );
    if (size > 0) {
      blocks.push(entry.data as Buffer);
      const padding = tarPadding(size);
      if (padding > 0) blocks.push(Buffer.alloc(padding));
    }
  }
  blocks.push(Buffer.alloc(TAR_BLOCK_SIZE * 2));
  return Buffer.concat(blocks);
}

describe('tarFormat', () => {
  it('round-trips a file header through the writer and the parser', () => {
    const data = Buffer.from('hello tar\n', 'utf8');
    const block = tarHeaderBlock({
      name: 'dir/hello.txt',
      mode: 0o640,
      size: data.length,
      mtimeMs: 1_700_000_000_000,
      typeflag: '0',
    });
    assert.ok(looksLikeTarHeader(block), 'the writer must produce a valid USTAR header');

    const parsed = parseTarHeader(block);
    assert.ok(parsed);
    assert.equal(parsed.name, 'dir/hello.txt');
    assert.equal(parsed.mode, 0o640);
    assert.equal(parsed.size, data.length);
    assert.equal(parsed.mtimeMs, 1_700_000_000_000);
    assert.equal(parsed.isFile, true);
    assert.equal(parsed.isDirectory, false);
  });

  it('round-trips directories and symlinks', () => {
    const dir = parseTarHeader(tarHeaderBlock({ name: 'app/', mode: 0o755, size: 0, mtimeMs: 0, typeflag: '5' }));
    assert.ok(dir?.isDirectory);
    assert.equal(dir.size, 0, 'a directory entry never carries a size');

    const link = parseTarHeader(
      tarHeaderBlock({ name: 'app/link', mode: 0o777, size: 0, mtimeMs: 0, typeflag: '2', linkname: '../lib/x.js' }),
    );
    assert.ok(link?.isSymlink);
    assert.equal(link.linkname, '../lib/x.js');
    assert.equal(link.size, 0);
  });

  it('rejects a block whose checksum does not match', () => {
    const block = tarHeaderBlock({ name: 'a.txt', mode: 0o644, size: 3, mtimeMs: 0, typeflag: '0' });
    block.write('9', 0, 1, 'ascii');
    assert.equal(parseTarHeader(block), null);
    assert.equal(looksLikeTarHeader(block), false);
  });

  it('treats the all-zero block as the end of the archive', () => {
    assert.equal(parseTarHeader(Buffer.alloc(TAR_BLOCK_SIZE)), null);
  });

  it('splits long names into the USTAR prefix field', () => {
    const long = `${'d'.repeat(100)}/${'f'.repeat(90)}.txt`;
    const split = splitUstarName(long);
    assert.ok(split, 'a 191-byte name fits the 100/155 USTAR fields');
    assert.equal(split.name.length, 94);
    assert.equal(split.prefix.length, 100);

    const parsed = parseTarHeader(tarHeaderBlock({ name: long, mode: 0o644, size: 0, mtimeMs: 0, typeflag: '0' }));
    assert.equal(parsed?.name, long);
  });

  it('uses a GNU long-name entry when the name cannot be split', () => {
    const name = 'x'.repeat(200);
    assert.equal(splitUstarName(name), null);
    const { header, data } = gnuLongNameBlocks(name);
    const parsed = parseTarHeader(header);
    assert.equal(parsed?.typeflag, 'L');
    assert.equal(parsed?.isMetadata, true);
    assert.equal(parsed?.size, name.length + 1);
    assert.equal(data.subarray(0, name.length).toString('utf8'), name);
  });

  it('pads every entry to a 512-byte boundary', () => {
    assert.equal(tarPadding(0), 0);
    assert.equal(tarPadding(1), 511);
    assert.equal(tarPadding(512), 0);
    assert.equal(tarPadding(513), 511);
  });

  it('parses a full archive image written by the writer', () => {
    const image = buildTar([
      { name: 'app/', mode: 0o755, typeflag: '5' },
      { name: 'app/a.txt', data: Buffer.from('aaa', 'utf8') },
      { name: 'app/link', target: 'a.txt', typeflag: '2' },
    ]);

    const seen: string[] = [];
    let offset = 0;
    for (;;) {
      const header = parseTarHeader(image.subarray(offset, offset + TAR_BLOCK_SIZE));
      if (header === null) break;
      seen.push(`${header.typeflag}:${header.name}`);
      offset += TAR_BLOCK_SIZE + header.size + tarPadding(header.size);
    }
    assert.deepEqual(seen, ['5:app/', '0:app/a.txt', '2:app/link']);
  });

  it('gzip round-trips, which is what tar.gz detection relies on', () => {
    const image = buildTar([{ name: 'a.txt', data: Buffer.from('payload', 'utf8') }]);
    const gzipped = zlib.gzipSync(image);
    assert.equal(gzipped[0], 0x1f);
    assert.equal(gzipped[1], 0x8b);
    assert.ok(zlib.gunzipSync(gzipped).equals(image));
  });
});

describe('zipFormat', () => {
  function buildZip(entries: { name: string; content?: Buffer; directory?: boolean; mode?: number }[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const zip = new yazl.ZipFile();
      const chunks: Buffer[] = [];
      (zip.outputStream as NodeJS.ReadableStream).on('data', (chunk: Buffer) => chunks.push(chunk));
      (zip.outputStream as NodeJS.ReadableStream).on('end', () => resolve(Buffer.concat(chunks)));
      (zip.outputStream as NodeJS.ReadableStream).on('error', reject);
      for (const entry of entries) {
        if (entry.directory === true) zip.addEmptyDirectory(entry.name, { mode: entry.mode ?? 0o755 });
        else zip.addBuffer(entry.content ?? Buffer.alloc(0), entry.name, { mode: entry.mode ?? 0o644 });
      }
      zip.end();
    });
  }

  it('lists entries, sizes, methods and modes from the central directory', async () => {
    const archive = await buildZip([
      { name: 'app/', directory: true },
      { name: 'app/a.txt', content: Buffer.from('hello zip\n', 'utf8') },
    ]);

    const end = findZipEndRecord(archive);
    assert.equal(end.totalEntries, 2);
    const central = archive.subarray(end.centralOffset, end.centralOffset + end.centralSize);
    const directory = parseZipCentralDirectory(central, end.totalEntries);

    assert.equal(directory.entries.length, 2);
    assert.equal(directory.entries[0]?.name, 'app/');
    assert.equal(directory.entries[0]?.directory, true);
    assert.equal(directory.entries[1]?.name, 'app/a.txt');
    assert.equal(directory.entries[1]?.directory, false);
    assert.equal(directory.entries[1]?.uncompressedSize, 10);
    assert.equal(directory.entries[1]?.method, ZIP_METHOD_DEFLATE);
    assert.equal(directory.entries[1]?.mode & 0o777, 0o644);
  });

  it('reads the directory through ranged reads only (no whole-file buffering)', async () => {
    // Deterministic pseudo-random payload, so deflate cannot shrink the archive to nothing.
    const payload = Buffer.allocUnsafe(200_000);
    let state = 0x12345678;
    for (let index = 0; index < payload.length; index += 1) {
      state = (state * 1664525 + 1013904223) >>> 0;
      payload[index] = (state >>> 16) & 0xff;
    }

    const archive = await buildZip([{ name: 'a/b/c.bin', content: payload }]);
    const ranges: { start: number; end: number }[] = [];
    const directory = await readZipDirectory(async (start, end) => {
      ranges.push({ start, end });
      return archive.subarray(start, end + 1);
    }, archive.length);

    assert.equal(directory.entries.length, 1);
    assert.equal(directory.entries[0]?.name, 'a/b/c.bin');
    // Two reads: the tail (EOCD) and the central directory. The payload is never read.
    assert.equal(ranges.length, 2);
    const bytesRead = ranges.reduce((sum, range) => sum + (range.end - range.start + 1), 0);
    assert.ok(
      bytesRead < archive.length,
      `expected a ranged listing to read less than the ${archive.length}-byte archive, read ${bytesRead}`,
    );
  });

  it('locates the compressed payload through the local header', async () => {
    const archive = await buildZip([{ name: 'only.txt', content: Buffer.from('payload-bytes', 'utf8') }]);
    const directory = await readZipDirectory(
      async (start, end) => archive.subarray(start, end + 1),
      archive.length,
    );
    const entry = directory.entries[0];
    assert.ok(entry);
    const local = parseZipLocalHeader(
      await Promise.resolve(archive.subarray(entry.localHeaderOffset, entry.localHeaderOffset + 30)),
      entry.localHeaderOffset,
    );
    const raw = archive.subarray(local.dataOffset, local.dataOffset + entry.compressedSize);
    assert.equal(zlib.inflateRawSync(raw).toString('utf8'), 'payload-bytes');
  });

  it('reports a truncated central directory instead of reading past the cap', () => {
    const central = Buffer.alloc(46 * 3);
    for (let index = 0; index < 3; index += 1) {
      central.writeUInt32LE(0x02014b50, index * 46);
    }
    const directory = parseZipCentralDirectory(central, 3, { maxEntries: 2 });
    assert.equal(directory.entries.length, 2);
    assert.equal(directory.truncated, true);
  });
});

describe('validateExtractItems', () => {
  const DEST = '/tmp/restore';
  const file = (name: string): ArchiveRawEntry => ({ name, kind: 'file', size: 1, mode: 0o644 });

  it('plans safe entries with absolute destination paths', () => {
    const items = validateExtractItems([file('app/a.txt'), { name: 'app/', kind: 'directory', size: 0, mode: 0o755 }], DEST);
    assert.equal(items[0]?.path, '/tmp/restore/app/a.txt');
    assert.equal(items[0]?.relative, 'app/a.txt');
    assert.equal(items[1]?.path, '/tmp/restore/app');
  });

  it('refuses a traversal entry with a 400 naming the offending entry', () => {
    assert.throws(
      () => validateExtractItems([file('ok.txt'), file('../../etc/passwd')], DEST),
      (err: unknown) => {
        assert.ok(err instanceof ApiError, `expected an ApiError, got ${String(err)}`);
        assert.equal(err.code, 'BAD_REQUEST');
        assert.match(err.message, /\.\.\/\.\.\/etc\/passwd/, 'the message must name the entry');
        assert.equal(err.details?.['entry'], '../../etc/passwd');
        return true;
      },
    );
  });

  it('refuses an absolute entry', () => {
    assert.throws(
      () => validateExtractItems([file('/etc/shadow')], DEST),
      (err: unknown) => err instanceof ApiError && err.code === 'BAD_REQUEST' && /\/etc\/shadow/.test(err.message),
    );
  });

  it('refuses a symlink that points outside the destination', () => {
    assert.throws(
      () =>
        validateExtractItems(
          [{ name: 'escape', kind: 'symlink', size: 0, mode: 0o777, linkTarget: '../../etc' }],
          DEST,
        ),
      (err: unknown) => err instanceof ApiError && err.code === 'BAD_REQUEST' && /escape/.test(err.message),
    );
  });

  it('accepts a symlink that stays inside the destination', () => {
    const items = validateExtractItems(
      [{ name: 'app/link', kind: 'symlink', size: 0, mode: 0o777, linkTarget: '../lib/x.js' }],
      DEST,
    );
    assert.equal(items[0]?.linkTarget, '../lib/x.js');
  });

  it('keeps "skip" entries out of the extraction plan', () => {
    const items = validateExtractItems([{ name: 'dev/null', kind: 'skip', size: 0, mode: 0 }], DEST);
    assert.equal(items[0]?.kind, 'skip');
  });
});

describe('remote command builders', () => {
  it('quotes every path of a tar archive command', () => {
    const command = buildTarArchiveCommand('tar.gz', '/backups/a b.tar.gz', [
      { parent: '/var/www', base: 'app' },
      { parent: "/tmp/it's", base: 'x' },
    ]);
    assert.equal(
      command,
      `tar -czf '/backups/a b.tar.gz' -C '/var/www' 'app' -C '/tmp/it'\\''s' 'x'`,
    );
    assert.match(buildTarArchiveCommand('tar', '/b.tar', [{ parent: '/x', base: 'y' }]) ?? '', /^tar -cf /);
  });

  it('refuses to build a command for a name that looks like a flag', () => {
    assert.equal(buildTarArchiveCommand('tar', '/b.tar', [{ parent: '/x', base: '-rf' }]), null);
    assert.equal(buildZipArchiveCommand('/b.zip', '/x', ['-rf']), null);
    assert.equal(buildZipArchiveCommand('/b.zip', '/x', []), null);
  });

  it('builds zip and extraction commands with the documented flags', () => {
    assert.equal(
      buildZipArchiveCommand('/b.zip', '/srv', ['app', 'docs']),
      "cd '/srv' && zip -r -q '/b.zip' 'app' 'docs'",
    );
    assert.equal(buildTarExtractCommand('tar.gz', '/a.tgz', '/tmp/x'), "tar -xzf '/a.tgz' -C '/tmp/x'");
    assert.equal(buildTarExtractCommand('tar', '/a.tar', '/tmp/x'), "tar -xf '/a.tar' -C '/tmp/x'");
    assert.equal(buildUnzipCommand('/a.zip', '/tmp/x', true), "unzip -o -q '/a.zip' -d '/tmp/x'");
    assert.equal(buildUnzipCommand('/a.zip', '/tmp/x', false), "unzip -n -q '/a.zip' -d '/tmp/x'");
  });
});
