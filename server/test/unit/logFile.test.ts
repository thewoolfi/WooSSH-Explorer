import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { RotatingFileSink } from '../../src/logFile.js';
import { createLogger } from '../../src/logger.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sshx-log-'));
  dirs.push(dir);
  return dir;
}

after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('RotatingFileSink', () => {
  it('creates the directory and appends every line', () => {
    const file = path.join(tempDir(), 'nested', 'logs', 'app.log');
    const sink = new RotatingFileSink({ filePath: file });
    sink.write('first\n');
    sink.write('second\n');
    assert.equal(readFileSync(file, 'utf8'), 'first\nsecond\n');
    assert.equal(sink.available, true);
  });

  it('rotates once the file passes its limit, keeping the newest archives', () => {
    const dir = tempDir();
    const file = path.join(dir, 'app.log');
    // Each line is 10 bytes; a 25-byte cap lets two lines in and rotates before the third.
    const sink = new RotatingFileSink({ filePath: file, maxBytes: 25, keep: 2 });
    sink.write('aaaaaaaaa\n');
    sink.write('bbbbbbbbb\n');
    sink.write('ccccccccc\n');
    sink.write('ddddddddd\n');

    const files = readdirSync(dir).sort();
    assert.deepEqual(files, ['app.log', 'app.log.1']);
    // The two lines written before the rotate moved out; nothing was lost.
    assert.equal(readFileSync(`${file}.1`, 'utf8'), 'aaaaaaaaa\nbbbbbbbbb\n');
    assert.equal(readFileSync(file, 'utf8'), 'ccccccccc\nddddddddd\n');
  });

  it('keeps only the requested number of archives', () => {
    const dir = tempDir();
    const file = path.join(dir, 'app.log');
    const sink = new RotatingFileSink({ filePath: file, maxBytes: 10, keep: 2 });
    for (const line of ['one', 'two', 'three', 'four', 'five']) sink.write(`${line}\n`);
    // Three rotations happened but only two archives survive; nothing accumulates forever.
    assert.deepEqual(readdirSync(dir).sort(), ['app.log', 'app.log.1', 'app.log.2']);
  });

  it('counts an existing file towards the limit instead of restarting the count', () => {
    const dir = tempDir();
    const file = path.join(dir, 'app.log');
    writeFileSync(file, 'x'.repeat(30));
    const sink = new RotatingFileSink({ filePath: file, maxBytes: 40, keep: 2 });
    sink.write('y'.repeat(20));
    // 30 + 20 > 40, so the old content was rotated out before this line landed.
    assert.equal(readFileSync(file, 'utf8'), 'y'.repeat(20));
    assert.equal(readFileSync(`${file}.1`, 'utf8'), 'x'.repeat(30));
  });

  it('gives up quietly when the file cannot be written', () => {
    // A file where a directory should be: the sink must not throw into the caller.
    const dir = tempDir();
    writeFileSync(path.join(dir, 'blocker'), 'not a directory');
    const sink = new RotatingFileSink({ filePath: path.join(dir, 'blocker', 'app.log') });
    assert.doesNotThrow(() => sink.write('anything\n'));
    assert.equal(sink.available, false);
  });
});

describe('createLogger with a file', () => {
  it('mirrors every line to disk and still redacts secrets', () => {
    const file = path.join(tempDir(), 'app.log');
    const logger = createLogger('debug', { filePath: file });
    logger.info('connected', { host: 'example.com' });
    logger.error('auth failed', { password: 'hunter2' });
    const written = readFileSync(file, 'utf8');
    assert.ok(written.includes('connected'));
    assert.ok(written.includes('host=example.com'));
    assert.equal(written.includes('hunter2'), false);
  });

  it('a child logger keeps writing to the same file', () => {
    const file = path.join(tempDir(), 'app.log');
    const logger = createLogger('info', { filePath: file });
    logger.child({ connectionId: 'conn_1' }).info('child line');
    assert.ok(readFileSync(file, 'utf8').includes('connectionId=conn_1'));
  });

  it('writes nothing below the configured level', () => {
    const file = path.join(tempDir(), 'app.log');
    const logger = createLogger('error', { filePath: file });
    logger.debug('not interesting');
    // The file is not even created: the sink only opens on the first line that passes.
    assert.equal(existsSync(file), false);
  });
});
