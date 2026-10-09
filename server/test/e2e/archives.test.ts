/**
 * §6 `fs/archive` and `fs/extract`.
 *
 * The mock host has neither `tar` nor `zip`/`unzip` (they answer `command not found`), so these
 * tests drive the SFTP writers and readers in `ssh/archive.ts` end to end: create → extract →
 * compare bytes. The traversal refusals are covered from real archive images.
 */
import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import * as yazl from 'yazl';

import { HELLO_FILE, README_FILE } from '../support/fixtures.js';
import { expectErrorEnvelope, startHarness, type Harness } from '../support/harness.js';
import { TAR_BLOCK_SIZE, tarHeaderBlock, tarPadding } from '../../src/ssh/tarFormat.js';

let h!: Harness;
let connectionId!: string;

before(async () => {
  h = await startHarness();
  const trusted = await h.connectTrusting();
  connectionId = trusted.id;
});

after(async () => {
  await h?.close();
});

const fsPath = (suffix: string): string => `/api/connections/${connectionId}${suffix}`;

async function removeTree(path: string): Promise<void> {
  await h.json('POST', fsPath('/fs/delete'), { paths: [path], recursive: true });
}

async function download(path: string): Promise<Buffer> {
  const res = await h.stream(fsPath(`/fs/download?path=${encodeURIComponent(path)}`));
  assert.equal(res.status, 200, `download ${path}: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

async function upload(path: string, name: string, body: Buffer): Promise<void> {
  const res = await h.request('POST', fsPath(`/fs/upload?path=${encodeURIComponent(path)}&name=${name}`), {
    headers: { 'content-type': 'application/octet-stream' },
    body,
  });
  assert.equal(res.status, 200, `upload ${name}: ${res.status} ${res.text.slice(0, 200)}`);
}

async function entryOf(path: string): Promise<any> {
  const res = await h.json('GET', fsPath(`/fs/stat?path=${encodeURIComponent(path)}`));
  assert.equal(res.status, 200, `stat ${path}: ${res.status} ${res.text.slice(0, 200)}`);
  return res.json.entry;
}

/** A small tree to archive: two nested files, one of them with a non-default mode. */
async function makeSourceTree(root: string): Promise<void> {
  await removeTree(root);
  assert.equal((await h.json('POST', fsPath('/fs/mkdir'), { path: root })).status, 201);
  assert.equal((await h.json('POST', fsPath('/fs/mkdir'), { path: `${root}/nested` })).status, 201);
  await upload(root, 'readme.txt', README_FILE.content);
  await upload(`${root}/nested`, 'hello.txt', HELLO_FILE.content);
  assert.equal((await h.json('POST', fsPath('/fs/chmod'), { path: `${root}/nested/hello.txt`, mode: '600' })).status, 200);
}

describe('fs/archive → fs/extract round trip', () => {
  for (const format of ['tar.gz', 'tar', 'zip'] as const) {
    test(`round-trips a directory through ${format}`, async () => {
      const root = '/e2e-archive-src';
      const archivePath = `/e2e-archive.${format === 'tar.gz' ? 'tgz' : format}`;
      const restoreDir = '/e2e-archive-out';
      await removeTree(archivePath);
      await removeTree(restoreDir);
      await makeSourceTree(root);

      const created = await h.json('POST', fsPath('/fs/archive'), {
        paths: [root],
        destination: archivePath,
        format,
      });
      assert.equal(created.status, 201, created.text.slice(0, 300));
      assert.equal(created.json.entry.path, archivePath);
      assert.equal(typeof created.json.bytes, 'number');
      assert.ok(created.json.bytes > 0, 'the archive must not be empty');
      assert.equal(created.json.entry.size, created.json.bytes, 'bytes must be the archive size');

      const extracted = await h.json('POST', fsPath('/fs/extract'), {
        path: archivePath,
        destinationDir: restoreDir,
      });
      assert.equal(extracted.status, 201, extracted.text.slice(0, 400));
      assert.equal(extracted.json.truncated, false);
      assert.ok(Array.isArray(extracted.json.entries));
      assert.deepEqual(
        extracted.json.entries.map((entry: any) => entry.path),
        [`${restoreDir}/e2e-archive-src`],
        'the single top-level entry of the archive is the source directory',
      );

      // The root entry keeps the source basename, and the bytes survive the round trip.
      assert.ok((await download(`${restoreDir}/e2e-archive-src/readme.txt`)).equals(README_FILE.content));
      assert.ok(
        (await download(`${restoreDir}/e2e-archive-src/nested/hello.txt`)).equals(HELLO_FILE.content),
        `${format}: nested file must round-trip byte-exactly`,
      );
      if (format === 'tar') {
        assert.equal(
          (await entryOf(`${restoreDir}/e2e-archive-src/nested/hello.txt`)).mode & 0o777,
          0o600,
          'tar stores and restores modes',
        );
      }

      await removeTree(root);
      await removeTree(archivePath);
      await removeTree(restoreDir);
    });
  }

  test('archives several paths, each with its own basename as the root entry', async () => {
    const archivePath = '/e2e-multi.tar';
    const restoreDir = '/e2e-multi-out';
    await removeTree(archivePath);
    await removeTree(restoreDir);

    const created = await h.json('POST', fsPath('/fs/archive'), {
      paths: [HELLO_FILE.path, README_FILE.path],
      destination: archivePath,
      format: 'tar',
    });
    assert.equal(created.status, 201, created.text.slice(0, 300));

    const extracted = await h.json('POST', fsPath('/fs/extract'), {
      path: archivePath,
      destinationDir: restoreDir,
    });
    assert.equal(extracted.status, 201, extracted.text.slice(0, 300));
    assert.deepEqual(
      extracted.json.entries.map((entry: any) => entry.path).sort(),
      [`${restoreDir}/hello.txt`, `${restoreDir}/readme.txt`],
    );
    assert.ok((await download(`${restoreDir}/readme.txt`)).equals(README_FILE.content));

    await removeTree(archivePath);
    await removeTree(restoreDir);
  });

  test('detects the format from the bytes, not the file name', async () => {
    const archivePath = '/e2e-misnamed.zip';
    const restoreDir = '/e2e-misnamed-out';
    await removeTree(archivePath);
    await removeTree(restoreDir);

    // A real gzip tar, deliberately named `.zip`.
    const created = await h.json('POST', fsPath('/fs/archive'), {
      paths: [HELLO_FILE.path],
      destination: archivePath,
      format: 'tar.gz',
    });
    assert.equal(created.status, 201, created.text.slice(0, 300));

    const extracted = await h.json('POST', fsPath('/fs/extract'), {
      path: archivePath,
      destinationDir: restoreDir,
    });
    assert.equal(extracted.status, 201, extracted.text.slice(0, 300));
    assert.ok((await download(`${restoreDir}/hello.txt`)).equals(HELLO_FILE.content));

    await removeTree(archivePath);
    await removeTree(restoreDir);
  });

  test('honours overwrite: false by keeping the existing file', async () => {
    const archivePath = '/e2e-overwrite.tar';
    const restoreDir = '/e2e-overwrite-out';
    await removeTree(archivePath);
    await removeTree(restoreDir);
    assert.equal((await h.json('POST', fsPath('/fs/mkdir'), { path: restoreDir })).status, 201);
    const stale = Buffer.from('stale content that must survive\n', 'utf8');
    await upload(restoreDir, 'hello.txt', stale);

    assert.equal(
      (
        await h.json('POST', fsPath('/fs/archive'), {
          paths: [HELLO_FILE.path],
          destination: archivePath,
          format: 'tar',
        })
      ).status,
      201,
    );

    const kept = await h.json('POST', fsPath('/fs/extract'), {
      path: archivePath,
      destinationDir: restoreDir,
      overwrite: false,
    });
    assert.equal(kept.status, 201, kept.text.slice(0, 300));
    assert.ok((await download(`${restoreDir}/hello.txt`)).equals(stale), 'overwrite:false must not replace');

    const replaced = await h.json('POST', fsPath('/fs/extract'), {
      path: archivePath,
      destinationDir: restoreDir,
      overwrite: true,
    });
    assert.equal(replaced.status, 201, replaced.text.slice(0, 300));
    assert.ok((await download(`${restoreDir}/hello.txt`)).equals(HELLO_FILE.content), 'overwrite:true replaces');

    await removeTree(archivePath);
    await removeTree(restoreDir);
  });

  test('rejects a file that is not an archive, and an empty one', async () => {
    await upload('/', 'not-an-archive.bin', Buffer.from('just some bytes, definitely not an archive\n', 'utf8'));
    const res = await h.json('POST', fsPath('/fs/extract'), {
      path: '/not-an-archive.bin',
      destinationDir: '/e2e-not-archive-out',
    });
    assert.equal(res.status, 400, res.text.slice(0, 200));
    assert.equal(expectErrorEnvelope(res).code, 'BAD_REQUEST');

    const empty = await h.json('POST', fsPath('/fs/extract'), {
      path: '/bin/zero.bin',
      destinationDir: '/e2e-not-archive-out',
    });
    assert.equal(empty.status, 400);
    expectErrorEnvelope(empty);

    await removeTree('/not-an-archive.bin');
    await removeTree('/e2e-not-archive-out');
  });

  test('refuses an archive destination inside one of its own sources', async () => {
    const root = '/e2e-archive-inside';
    await makeSourceTree(root);
    const res = await h.json('POST', fsPath('/fs/archive'), {
      paths: [root],
      destination: `${root}/self.tar`,
      format: 'tar',
    });
    assert.equal(res.status, 400, res.text.slice(0, 200));
    assert.equal(expectErrorEnvelope(res).code, 'BAD_REQUEST');
    await removeTree(root);
  });
});

describe('fs/extract refuses path traversal (§6)', () => {
  /** A tar image the caller controls completely, including hostile entry names. */
  function buildTarImage(entries: { name: string; data?: Buffer; target?: string; typeflag?: '0' | '2' | '5' }[]): Buffer {
    const blocks: Buffer[] = [];
    for (const entry of entries) {
      const typeflag = entry.typeflag ?? '0';
      const data = entry.data ?? Buffer.alloc(0);
      blocks.push(
        tarHeaderBlock({
          name: entry.name,
          mode: typeflag === '2' ? 0o777 : 0o644,
          size: typeflag === '0' ? data.length : 0,
          mtimeMs: 1_700_000_000_000,
          typeflag,
          ...(entry.target !== undefined ? { linkname: entry.target } : {}),
        }),
      );
      if (data.length > 0) {
        blocks.push(data);
        const padding = tarPadding(data.length);
        if (padding > 0) blocks.push(Buffer.alloc(padding));
      }
    }
    blocks.push(Buffer.alloc(TAR_BLOCK_SIZE * 2));
    return Buffer.concat(blocks);
  }

  async function buildZipImage(entries: { name: string; data: Buffer }[]): Promise<Buffer> {
    return await new Promise<Buffer>((resolve, reject) => {
      const zip = new yazl.ZipFile();
      const chunks: Buffer[] = [];
      (zip.outputStream as NodeJS.ReadableStream).on('data', (chunk: Buffer) => chunks.push(chunk));
      (zip.outputStream as NodeJS.ReadableStream).on('end', () => resolve(Buffer.concat(chunks)));
      (zip.outputStream as NodeJS.ReadableStream).on('error', reject);
      for (const entry of entries) zip.addBuffer(entry.data, entry.name);
      zip.end();
    });
  }

  /**
   * yazl refuses to write a `..` entry name (it validates metadata paths), so a hostile zip is
   * built from a safe one and its name field is patched in place — both in the local header and
   * in the central directory. The replacement has to be the same length.
   */
  function renameZipEntry(archive: Buffer, from: string, to: string): Buffer {
    assert.equal(from.length, to.length, 'the patched name must keep the record lengths intact');
    const before = Buffer.from(from, 'utf8');
    const after = Buffer.from(to, 'utf8');
    const patched = Buffer.from(archive);
    let replacements = 0;
    for (let index = 0; index + before.length <= patched.length; index += 1) {
      if (!patched.subarray(index, index + before.length).equals(before)) continue;
      after.copy(patched, index);
      replacements += 1;
      index += before.length - 1;
    }
    assert.ok(replacements >= 2, `expected the name in both the local and central headers, patched ${replacements}`);
    return patched;
  }

  const hostile: { name: string; label: string }[] = [
    { name: '../escaped.txt', label: 'a ".." name' },
    { name: 'nested/../../escaped.txt', label: 'a nested ".." name' },
    { name: '/etc/escaped.txt', label: 'an absolute name' },
  ];

  for (const { name, label } of hostile) {
    test(`refuses ${label} in a tar archive, naming the entry`, async () => {
      const archivePath = '/evil.tar';
      const destinationDir = '/e2e-evil-out';
      await removeTree(archivePath);
      await removeTree(destinationDir);
      await upload(
        '/',
        'evil.tar',
        buildTarImage([
          { name: 'fine.txt', data: Buffer.from('fine\n', 'utf8') },
          { name, data: Buffer.from('escaped\n', 'utf8') },
        ]),
      );

      const res = await h.json('POST', fsPath('/fs/extract'), {
        path: archivePath,
        destinationDir,
      });
      assert.equal(res.status, 400, `expected 400 for ${name}, got ${res.status}: ${res.text.slice(0, 200)}`);
      const error = expectErrorEnvelope(res);
      assert.equal(error.code, 'BAD_REQUEST');
      assert.ok(
        error.message.includes(name),
        `the message must name the offending entry (${name}), got: ${error.message}`,
      );

      // Nothing was written: validation happens before the first byte.
      const out = await h.json('GET', fsPath(`/fs/stat?path=${encodeURIComponent(destinationDir)}`));
      assert.ok(out.status >= 400, 'the destination directory must not even be created');

      await removeTree(archivePath);
    });
  }

  test('refuses an absolute symlink target inside a tar archive', async () => {
    const archivePath = '/evil-link.tar';
    await removeTree(archivePath);
    await upload(
      '/',
      'evil-link.tar',
      buildTarImage([{ name: 'escape', typeflag: '2', target: '/etc/passwd' }]),
    );

    const res = await h.json('POST', fsPath('/fs/extract'), {
      path: archivePath,
      destinationDir: '/e2e-evil-link-out',
    });
    assert.equal(res.status, 400, res.text.slice(0, 200));
    const error = expectErrorEnvelope(res);
    assert.equal(error.code, 'BAD_REQUEST');
    assert.match(error.message, /escape/);
    assert.match(error.message, /absolute/);

    await removeTree(archivePath);
    await removeTree('/e2e-evil-link-out');
  });

  test('refuses a symlink that climbs out of the destination', async () => {
    const archivePath = '/evil-relative-link.tar';
    await removeTree(archivePath);
    await upload(
      '/',
      'evil-relative-link.tar',
      buildTarImage([{ name: 'sub/escape', typeflag: '2', target: '../../../etc' }]),
    );

    const res = await h.json('POST', fsPath('/fs/extract'), {
      path: archivePath,
      destinationDir: '/e2e-evil-relative-out',
    });
    assert.equal(res.status, 400, res.text.slice(0, 200));
    const error = expectErrorEnvelope(res);
    assert.match(error.message, /sub\/escape/);
    assert.match(error.message, /outside/);

    await removeTree(archivePath);
    await removeTree('/e2e-evil-relative-out');
  });

  test('refuses a zip-slip entry in a zip archive', async () => {
    const archivePath = '/evil.zip';
    await removeTree(archivePath);
    // `@@@@@/` and `../../` are both six bytes, so the record lengths stay valid.
    const safe = await buildZipImage([
      { name: 'fine.txt', data: Buffer.from('fine\n', 'utf8') },
      { name: '@@@@@/zip-slip.txt', data: Buffer.from('escaped\n', 'utf8') },
    ]);
    await upload('/', 'evil.zip', renameZipEntry(safe, '@@@@@/', '../../'));

    const res = await h.json('POST', fsPath('/fs/extract'), {
      path: archivePath,
      destinationDir: '/e2e-zip-slip-out',
    });
    assert.equal(res.status, 400, `expected 400, got ${res.status}: ${res.text.slice(0, 300)}`);
    const error = expectErrorEnvelope(res);
    assert.equal(error.code, 'BAD_REQUEST');
    assert.ok(error.message.includes('../../zip-slip.txt'), `message must name the entry: ${error.message}`);

    await removeTree(archivePath);
    await removeTree('/e2e-zip-slip-out');
  });

  test('extracts a safe archive that walks up but stays inside the destination', async () => {
    const archivePath = '/safe-relative.tar';
    const destinationDir = '/e2e-safe-relative-out';
    await removeTree(archivePath);
    await removeTree(destinationDir);
    await upload(
      '/',
      'safe-relative.tar',
      buildTarImage([
        { name: 'sub/inner.txt', data: Buffer.from('inner\n', 'utf8') },
        { name: 'sub/link', typeflag: '2', target: '../shared.txt' },
        { name: 'shared.txt', data: Buffer.from('shared\n', 'utf8') },
      ]),
    );

    const res = await h.json('POST', fsPath('/fs/extract'), { path: archivePath, destinationDir });
    assert.equal(res.status, 201, res.text.slice(0, 300));
    assert.equal((await entryOf(`${destinationDir}/sub/link`)).kind, 'symlink');
    assert.equal((await entryOf(`${destinationDir}/sub/link`)).target, '../shared.txt');
    assert.ok((await download(`${destinationDir}/shared.txt`)).equals(Buffer.from('shared\n')));

    await removeTree(archivePath);
    await removeTree(destinationDir);
  });
});
