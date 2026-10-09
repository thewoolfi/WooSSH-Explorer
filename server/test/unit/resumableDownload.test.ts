import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import {
  discardPartial,
  downloadResumable,
  hasPartial,
  planResume,
  responseDecision,
} from '../../../desktop/src/resumableDownload.js';

/**
 * The contract the server side of this already keeps: `fs/download` honours `Range`,
 * answers `206` and marks the transfer `resumable`. Until now nothing used it, so a
 * failed 5 GB download started again from zero.
 *
 * It lives in the server test tree because that is where `node --test` is wired up; the
 * desktop workspace has no runner of its own and the module under test is plain Node.
 */

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sshx-resume-'));
  dirs.push(dir);
  return dir;
}

const servers: { close(): void }[] = [];
after(() => {
  for (const server of servers) server.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('planResume', () => {
  const partial = { url: 'http://x/f', name: 'f', totalBytes: 100, updatedAt: 1 };

  it('starts fresh when there is nothing on disk', () => {
    assert.equal(planResume({ partBytes: 0, partial: null, url: 'http://x/f' }).mode, 'fresh');
  });

  it('resumes from the byte count already written', () => {
    const plan = planResume({ partBytes: 40, partial, url: 'http://x/f' });
    assert.equal(plan.mode, 'resume');
    assert.equal(plan.from, 40);
  });

  it('refuses to append bytes that belong to a different file', () => {
    // The dangerous case: same destination, different source. Appending would corrupt it.
    const plan = planResume({ partBytes: 40, partial, url: 'http://x/other' });
    assert.equal(plan.mode, 'fresh');
    assert.match(plan.reason, /different file/);
  });

  it('starts over when the partial is larger than the remote file', () => {
    const plan = planResume({ partBytes: 140, partial, url: 'http://x/f' });
    assert.equal(plan.mode, 'fresh');
    assert.match(plan.reason, /larger/);
  });

  it('starts over when the partial is already complete', () => {
    const plan = planResume({ partBytes: 100, partial, url: 'http://x/f' });
    assert.equal(plan.mode, 'fresh');
    assert.match(plan.reason, /already complete/);
  });

  it('resumes when the remote size is unknown but the source matches', () => {
    const unknown = { ...partial, totalBytes: null };
    assert.equal(planResume({ partBytes: 40, partial: unknown, url: 'http://x/f' }).mode, 'resume');
  });

  it('prefers the freshly reported remote size over the recorded one', () => {
    // The file shrank on the server since the partial was written.
    const plan = planResume({ partBytes: 40, partial, url: 'http://x/f', remoteBytes: 30 });
    assert.equal(plan.mode, 'fresh');
  });
});

describe('responseDecision', () => {
  it('appends only on 206', () => {
    assert.equal(responseDecision(206), 'append');
  });

  it('restarts when the server ignored the range', () => {
    // 200 carries the whole body; appending it to the partial would duplicate the start.
    assert.equal(responseDecision(200), 'restart');
  });

  it('restarts on a range it cannot satisfy', () => {
    assert.equal(responseDecision(416), 'restart');
  });

  it('fails on anything else', () => {
    for (const status of [403, 404, 500]) assert.equal(responseDecision(status), 'fail');
  });
});

describe('downloadResumable over a real socket', () => {
  /** `listen(0)` is asynchronous: the port is only known once the socket is bound. */
  function listen(server: ReturnType<typeof createServer>): Promise<string> {
    servers.push(server);
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        const port = typeof address === 'object' && address ? address.port : 0;
        resolve(`http://127.0.0.1:${port}/file`);
      });
    });
  }

  /** A server that behaves like `fs/download`: honours Range, answers 206. */
  async function startRangeServer(body: Buffer): Promise<{ url: string; requests: string[] }> {
    const requests: string[] = [];
    const server = createServer((req, res) => {
      const range = req.headers.range;
      requests.push(range ?? 'no-range');
      if (range) {
        const start = Number.parseInt(/bytes=(\d+)-/.exec(range)?.[1] ?? '0', 10);
        if (start >= body.length) {
          res.writeHead(416, { 'content-range': `bytes */${body.length}` });
          res.end();
          return;
        }
        const slice = body.subarray(start);
        res.writeHead(206, {
          'content-length': String(slice.length),
          'content-range': `bytes ${start}-${body.length - 1}/${body.length}`,
        });
        res.end(slice);
        return;
      }
      res.writeHead(200, { 'content-length': String(body.length) });
      res.end(body);
    });
    return { url: await listen(server), requests };
  }

  it('writes the file and removes the partial when nothing was kept', async () => {
    const body = Buffer.from('hello world, this is the whole file');
    const { url } = await startRangeServer(body);
    const destination = path.join(tempDir(), 'file.txt');

    const result = await downloadResumable({ url, name: 'file.txt', destination, token: null });
    assert.equal(result.bytes, body.length);
    assert.equal(result.resumedFrom, 0);
    assert.equal(result.resumed, false);
    assert.equal(readFileSync(destination, 'utf8'), body.toString());
    assert.equal(hasPartial(destination), false);
  });

  it('continues from the bytes already on disk instead of starting over', async () => {
    const body = Buffer.from('0123456789abcdefghij');
    const { url, requests } = await startRangeServer(body);
    const destination = path.join(tempDir(), 'file.bin');

    // Simulate an interrupted transfer: a partial plus the sidecar that describes it.
    writeFileSync(`${destination}.part`, body.subarray(0, 8));
    writeFileSync(
      `${destination}.part.json`,
      JSON.stringify({ url, name: 'file.bin', totalBytes: body.length, updatedAt: Date.now() }),
    );

    const result = await downloadResumable({ url, name: 'file.bin', destination, token: null });
    assert.equal(result.resumedFrom, 8, 'the first eight bytes must not be fetched again');
    assert.equal(result.resumed, true);
    assert.equal(result.bytes, body.length);
    // The exact offset was requested, and the file is byte-identical to the original.
    assert.deepEqual(requests, ['bytes=8-']);
    assert.equal(readFileSync(destination, 'utf8'), body.toString());
  });

  it('starts over when the server ignores the range, without corrupting the file', async () => {
    const body = Buffer.from('0123456789abcdefghij');
    const server = createServer((_req, res) => {
      // A server that always sends the whole body, `Range` or not.
      res.writeHead(200, { 'content-length': String(body.length) });
      res.end(body);
    });
    const url = await listen(server);
    const destination = path.join(tempDir(), 'file.bin');

    writeFileSync(`${destination}.part`, body.subarray(0, 8));
    writeFileSync(
      `${destination}.part.json`,
      JSON.stringify({ url, name: 'file.bin', totalBytes: body.length, updatedAt: Date.now() }),
    );

    const result = await downloadResumable({ url, name: 'file.bin', destination, token: null });
    assert.equal(result.resumed, false);
    // Appending would have produced "012345670123456789abcdefghij".
    assert.equal(readFileSync(destination, 'utf8'), body.toString());
  });

  it('keeps the partial when the download fails, so the next try can continue', async () => {
    const server = createServer((req, res) => {
      if (req.headers.range === undefined) {
        // First attempt: promise a long body, send half of it, then drop the connection.
        res.writeHead(200, { 'content-length': '1000' });
        res.write('partial-bytes-');
        setTimeout(() => res.destroy(), 20);
        return;
      }
      res.writeHead(500);
      res.end('nope');
    });
    const url = await listen(server);
    const destination = path.join(tempDir(), 'file.bin');

    await assert.rejects(
      downloadResumable({ url, name: 'file.bin', destination, token: null }),
      'an interrupted transfer must reject',
    );
    assert.equal(statSync(`${destination}.part`).size > 0, true, 'the partial must survive');
  });

  it('discardPartial cleans both the bytes and the sidecar', () => {
    const destination = path.join(tempDir(), 'file.bin');
    writeFileSync(`${destination}.part`, 'x');
    writeFileSync(`${destination}.part.json`, '{}');
    assert.equal(hasPartial(destination), true);
    discardPartial(destination);
    assert.equal(hasPartial(destination), false);
  });
});
