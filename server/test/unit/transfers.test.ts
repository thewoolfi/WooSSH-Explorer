import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { EventEmitter } from 'node:events';

import { PROGRESS_INTERVAL_MS, ProgressMeter, TransferManager } from '../../src/transfers/TransferManager.js';
import { silentLogger } from '../../src/logger.js';
import { ApiError } from '../../src/errors.js';
import type { Transfer } from '../../src/types.js';

/** Drives a transfer record without any I/O by exercising the private bookkeeping. */
interface Internals {
  register(params: {
    connectionId: string;
    direction: 'upload' | 'download';
    name: string;
    remotePath: string;
    localPath: string | null;
    size: number;
    batchId?: string;
  }): { snapshot: Transfer; meter: ProgressMeter; lastEmit: number; abort: (() => void) | null };
  transition(record: unknown, state: Transfer['state'], patch?: Partial<Transfer>): void;
  finish(record: unknown, state: 'done' | 'error' | 'cancelled', error?: string): void;
  maybeEmit(record: unknown): void;
}

function internals(manager: TransferManager): Internals {
  return manager as unknown as Internals;
}

function newManager(): TransferManager {
  return new TransferManager({ downloadDir: '/tmp/downloads', logger: silentLogger });
}

describe('ProgressMeter', () => {
  it('reports the instantaneous rate on the first sample', () => {
    const meter = new ProgressMeter(0);
    // 1000 bytes in 1000 ms = 1000 B/s.
    assert.equal(meter.sample(1000, 1000), 1000);
  });

  it('smooths later samples instead of jumping to the instantaneous value', () => {
    const meter = new ProgressMeter(0);
    meter.sample(1000, 1000); // 1000 B/s
    const smoothed = meter.sample(2000, 2000); // instant 1000 B/s, same as before
    assert.equal(smoothed, 1000);

    // A burst: 8000 more bytes in 1000 ms = 8000 B/s instant, smoothed stays below it.
    const afterBurst = meter.sample(10_000, 3000);
    assert.ok(afterBurst > 1000, 'rate must rise after a burst');
    assert.ok(afterBurst < 8000, 'rate must not jump to the instantaneous value');
    assert.equal(afterBurst, Math.round(1000 * 0.75 + 8000 * 0.25));
  });

  it('never reports a negative or NaN rate', () => {
    const meter = new ProgressMeter(0);
    meter.sample(5000, 1000);
    assert.ok(meter.sample(0, 2000) >= 0);
    assert.ok(Number.isFinite(meter.sample(Number.NaN, 3000)));
  });

  it('decays to zero when nothing moves for a while', () => {
    const meter = new ProgressMeter(0);
    meter.sample(10_000, 1000);
    assert.ok(meter.rate > 0);
    // Same byte count, long silence: "0 when idle".
    assert.equal(meter.sample(10_000, 1000 + ProgressMeter.IDLE_AFTER_MS + 1), 0);
    assert.equal(meter.rate, 0);
  });

  it('ignores zero-elapsed samples', () => {
    const meter = new ProgressMeter(1000);
    const rate = meter.sample(500, 1000);
    assert.ok(Number.isFinite(rate));
  });
});

describe('TransferManager bookkeeping', () => {
  it('registers a queued transfer with the contract shape', () => {
    const manager = newManager();
    const record = internals(manager).register({
      connectionId: 'c1',
      direction: 'download',
      name: 'a.txt',
      remotePath: '/a.txt',
      localPath: '/tmp/a.txt',
      size: 100,
    });

    const transfer = record.snapshot;
    assert.equal(transfer.state, 'queued');
    assert.equal(transfer.transferred, 0);
    assert.equal(transfer.bytesPerSecond, 0);
    assert.equal(transfer.finishedAt, null);
    assert.equal(transfer.localPath, '/tmp/a.txt');
    assert.equal(transfer.size, 100);
    assert.ok(transfer.id.startsWith('tx_'));
    assert.ok(Number.isFinite(transfer.startedAt));
    // §7 added the two resumable-download fields to every Transfer.
    assert.equal(transfer.resumable, true, 'a download can be re-requested with a Range header');
    assert.equal(transfer.resumedFrom, 0);
    assert.deepEqual(Object.keys(transfer).sort(), [
      'bytesPerSecond',
      'connectionId',
      'direction',
      'finishedAt',
      'id',
      'localPath',
      'name',
      'remotePath',
      'resumable',
      'resumedFrom',
      'size',
      'startedAt',
      'state',
      'transferred',
    ]);
  });

  it('marks uploads and relays as not resumable (§7)', () => {
    const manager = newManager();
    for (const direction of ['upload', 'relay'] as const) {
      const record = internals(manager).register({
        connectionId: 'c1',
        direction,
        name: 'x',
        remotePath: '/x',
        localPath: null,
        size: 1,
      });
      assert.equal(record.snapshot.resumable, false, `${direction} must not claim to be resumable`);
    }
  });

  it('applies the §7 settings to the live queue and limiter', () => {
    const manager = new TransferManager({
      downloadDir: '/tmp',
      logger: silentLogger,
      maxConcurrent: 1,
      speedLimitKbps: 128,
    });
    assert.deepEqual(manager.settings, { maxConcurrent: 1, speedLimitKbps: 128 });
    assert.deepEqual(manager.queueDepth, { active: 0, queued: 0 });

    manager.applySettings({ maxConcurrent: 5, speedLimitKbps: 512 });
    assert.deepEqual(manager.settings, { maxConcurrent: 5, speedLimitKbps: 512 });

    manager.applySettings({ maxConcurrent: 3, speedLimitKbps: null });
    assert.deepEqual(manager.settings, { maxConcurrent: 3, speedLimitKbps: null });
    manager.shutdown();
  });

  it('attaches batchId only for batches', () => {
    const manager = newManager();
    const single = internals(manager).register({
      connectionId: 'c1',
      direction: 'download',
      name: 'a',
      remotePath: '/a',
      localPath: null,
      size: -1,
    });
    assert.ok(!('batchId' in single.snapshot));

    const batched = internals(manager).register({
      connectionId: 'c1',
      direction: 'download',
      name: 'b',
      remotePath: '/b',
      localPath: null,
      size: -1,
      batchId: 'batch_1',
    });
    assert.equal(batched.snapshot.batchId, 'batch_1');
  });

  it('emits a transfer:update for every state change', () => {
    const manager = newManager();
    const seen: Transfer[] = [];
    manager.on('transfer:update', (transfer: Transfer) => seen.push({ ...transfer }));

    const record = internals(manager).register({
      connectionId: 'c1',
      direction: 'download',
      name: 'a.txt',
      remotePath: '/a.txt',
      localPath: null,
      size: 10,
    });
    internals(manager).transition(record, 'active', { startedAt: 123 });
    record.snapshot.transferred = 10;
    internals(manager).finish(record, 'done');

    assert.deepEqual(seen.map((t) => t.state), ['queued', 'active', 'done']);
    assert.equal(seen[0]?.finishedAt, null);
    assert.equal(seen[2]?.finishedAt !== null, true);
  });

  it('throttles byte-progress updates to about ten per second', () => {
    const manager = newManager();
    const emitted: number[] = [];
    manager.on('transfer:update', (transfer: Transfer) => emitted.push(transfer.transferred));

    const record = internals(manager).register({
      connectionId: 'c1',
      direction: 'upload',
      name: 'a.bin',
      remotePath: '/a.bin',
      localPath: null,
      size: 1000,
    });
    internals(manager).transition(record, 'active');
    const baseline = emitted.length;

    // 50 chunks inside the throttle window: at most one extra emit is allowed.
    for (let index = 1; index <= 50; index += 1) {
      record.snapshot.transferred = index * 10;
      internals(manager).maybeEmit(record);
    }
    assert.ok(emitted.length - baseline <= 2, `expected <=2 progress frames, got ${emitted.length - baseline}`);
  });

  it('rejects an unknown transfer id with NOT_FOUND', () => {
    const manager = newManager();
    assert.throws(() => manager.get('nope'), (err: unknown) => err instanceof ApiError && err.code === 'NOT_FOUND');
    assert.throws(() => manager.cancel('nope'), (err: unknown) => err instanceof ApiError && err.code === 'NOT_FOUND');
  });

  it('moves an active transfer to cancelled and stops the byte flow exactly once', () => {
    const manager = newManager();
    let aborts = 0;
    const record = internals(manager).register({
      connectionId: 'c1',
      direction: 'download',
      name: 'a',
      remotePath: '/a',
      localPath: null,
      size: 100,
    });
    record.abort = () => {
      aborts += 1;
    };
    internals(manager).transition(record, 'active');

    const cancelled = manager.cancel(record.snapshot.id);
    assert.equal(cancelled.state, 'cancelled');
    assert.equal(cancelled.bytesPerSecond, 0);
    assert.equal(cancelled.finishedAt !== null, true);
    assert.equal(aborts, 1);

    // Idempotent: a second cancel must not fire the abort hook again.
    assert.equal(manager.cancel(record.snapshot.id).state, 'cancelled');
    assert.equal(aborts, 1);
  });

  it('clearFinished keeps active transfers and returns the removed count', () => {
    const manager = newManager();
    const active = internals(manager).register({
      connectionId: 'c1',
      direction: 'download',
      name: 'a',
      remotePath: '/a',
      localPath: null,
      size: 1,
    });
    internals(manager).transition(active, 'active');
    const done = internals(manager).register({
      connectionId: 'c1',
      direction: 'download',
      name: 'b',
      remotePath: '/b',
      localPath: null,
      size: 1,
    });
    internals(manager).finish(done, 'done');
    const failed = internals(manager).register({
      connectionId: 'c2',
      direction: 'download',
      name: 'c',
      remotePath: '/c',
      localPath: null,
      size: 1,
    });
    internals(manager).finish(failed, 'error', 'boom');

    assert.equal(manager.clearFinished(), 2);
    const remaining = manager.list();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0]?.id, active.snapshot.id);
  });

  it('filters the listing by connection', () => {
    const manager = newManager();
    for (const connectionId of ['c1', 'c2', 'c1']) {
      internals(manager).register({
        connectionId,
        direction: 'download',
        name: connectionId,
        remotePath: `/${connectionId}`,
        localPath: null,
        size: 1,
      });
    }
    assert.equal(manager.list().length, 3);
    assert.equal(manager.list('c1').length, 2);
    assert.equal(manager.list('missing').length, 0);
  });

  it('cancels every in-flight transfer for a connection', () => {
    const manager = newManager();
    const records = ['c1', 'c1', 'c2'].map((connectionId, index) =>
      internals(manager).register({
        connectionId,
        direction: 'download',
        name: `f${index}`,
        remotePath: `/f${index}`,
        localPath: null,
        size: 1,
      }),
    );
    for (const record of records) internals(manager).transition(record, 'active');

    manager.cancelForConnection('c1');
    assert.deepEqual(manager.list('c1').map((t) => t.state), ['cancelled', 'cancelled']);
    assert.deepEqual(manager.list('c2').map((t) => t.state), ['active']);
  });

  it('refuses to retry an upload and returns a running transfer unchanged', () => {
    const manager = newManager();
    const upload = internals(manager).register({
      connectionId: 'c1',
      direction: 'upload',
      name: 'u',
      remotePath: '/u',
      localPath: null,
      size: 1,
    });
    internals(manager).finish(upload, 'error', 'nope');
    assert.throws(
      () => manager.retry(upload.snapshot.id),
      (err: unknown) => err instanceof ApiError && err.code === 'CONFLICT',
    );

    const active = internals(manager).register({
      connectionId: 'c1',
      direction: 'download',
      name: 'd',
      remotePath: '/d',
      localPath: null,
      size: 1,
    });
    internals(manager).transition(active, 'active');
    const result = manager.retry(active.snapshot.id);
    assert.equal(result.transfer.state, 'active');
  });

  it('re-queues a cancelled download for a later request', () => {
    const manager = newManager();
    const record = internals(manager).register({
      connectionId: 'c1',
      direction: 'download',
      name: 'big',
      remotePath: '/big',
      localPath: null,
      size: 4096,
    });
    internals(manager).transition(record, 'active');
    record.snapshot.transferred = 512;
    internals(manager).finish(record, 'cancelled');

    const { transfer } = manager.retry(record.snapshot.id);
    assert.equal(transfer.id, record.snapshot.id);
    assert.equal(transfer.state, 'queued');
    assert.equal(transfer.transferred, 0);
    assert.equal(transfer.bytesPerSecond, 0);
    assert.equal(transfer.error, undefined);
    assert.equal(transfer.finishedAt, null);
  });

  it('resolves local destinations under the default download dir', () => {
    const manager = new TransferManager({ downloadDir: process.platform === 'win32' ? 'C:\\dl' : '/dl', logger: silentLogger });
    const resolved = manager.resolveLocalPath(null, 'file.txt');
    assert.ok(resolved.endsWith('file.txt'));
    assert.ok(resolved.includes('dl'));
  });

  it('is an EventEmitter so the hub can subscribe', () => {
    assert.ok(newManager() instanceof EventEmitter);
  });
});
