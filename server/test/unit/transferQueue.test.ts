/**
 * §7 queue and throttle mechanics.
 *
 * `maxConcurrent` is a slot semaphore and `speedLimitKbps` works by pausing the read streams —
 * both are tested here as *mechanisms* (who gets a slot, which stream got paused), never as a
 * wall-clock rate, so the suite stays deterministic.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ThroughputLimiter } from '../../src/transfers/ThroughputLimiter.js';
import { TransferQueue, clampConcurrency } from '../../src/transfers/TransferQueue.js';

/** Minimal stand-in for a read stream, counting pause/resume calls. */
class FakeStream {
  pauses = 0;
  resumes = 0;

  pause(): void {
    this.pauses += 1;
  }

  resume(): void {
    this.resumes += 1;
  }
}

describe('clampConcurrency', () => {
  it('keeps the value inside the contract range', () => {
    assert.equal(clampConcurrency(0), 1);
    assert.equal(clampConcurrency(-3), 1);
    assert.equal(clampConcurrency(3), 3);
    assert.equal(clampConcurrency(99), 8);
    assert.equal(clampConcurrency(Number.NaN), 1);
  });
});

describe('TransferQueue', () => {
  it('hands out slots immediately while the limit allows it', async () => {
    const queue = new TransferQueue(2);
    const a = await queue.acquire();
    const b = await queue.acquire();
    assert.equal(queue.activeCount, 2);
    assert.equal(queue.queuedCount, 0);

    const c = queue.acquire();
    assert.equal(queue.queuedCount, 1, 'the third transfer waits');
    b.release();
    await c;
    assert.equal(queue.activeCount, 2);
    assert.equal(queue.queuedCount, 0);
    a.release();
    (await c).release();
    assert.equal(queue.activeCount, 0);
  });

  it('wakes waiters in FIFO order', async () => {
    const queue = new TransferQueue(1);
    const first = await queue.acquire();

    const order: number[] = [];
    const second = queue.acquire().then((slot) => {
      order.push(2);
      return slot;
    });
    const third = queue.acquire().then((slot) => {
      order.push(3);
      return slot;
    });

    first.release();
    const secondSlot = await second;
    assert.deepEqual(order, [2], 'the oldest waiter goes first');
    secondSlot.release();
    const thirdSlot = await third;
    assert.deepEqual(order, [2, 3]);
    thirdSlot.release();
  });

  it('ignores a double release', async () => {
    const queue = new TransferQueue(1);
    const slot = await queue.acquire();
    slot.release();
    slot.release();
    assert.equal(queue.activeCount, 0);
    const next = await queue.acquire();
    assert.equal(queue.activeCount, 1);
    next.release();
  });

  it('raising the limit starts queued work immediately', async () => {
    const queue = new TransferQueue(1);
    const held = await queue.acquire();
    const waiting = queue.acquire();
    assert.equal(queue.queuedCount, 1);

    queue.setLimit(4);
    const slot = await waiting;
    assert.equal(queue.activeCount, 2);
    assert.equal(queue.queuedCount, 0);
    held.release();
    slot.release();
  });

  it('lowering the limit lets running work finish and starts nothing new', async () => {
    const queue = new TransferQueue(3);
    const running = [await queue.acquire(), await queue.acquire(), await queue.acquire()];
    queue.setLimit(1);

    const extra = queue.acquire();
    assert.equal(queue.queuedCount, 1, 'the new transfer must wait for the closer limit');
    for (const slot of running) slot.release();
    const slot = await extra;
    assert.equal(queue.activeCount, 1);
    slot.release();
  });

  it('close() wakes every waiter so a shutdown cannot hang a request', async () => {
    const queue = new TransferQueue(1);
    const held = await queue.acquire();
    const waiting = queue.acquire();
    assert.equal(queue.queuedCount, 1);

    queue.close();
    const slot = await waiting;
    assert.equal(queue.queuedCount, 0);
    // The woken slot is already released, so releasing it again is harmless.
    slot.release();
    assert.equal(queue.activeCount, 1, 'only the still-held slot counts');
    held.release();
    assert.equal(queue.activeCount, 0);
    await queue.acquire();
    assert.equal(queue.activeCount, 0, 'a closed queue never grants real concurrency');
  });
});

describe('ThroughputLimiter', () => {
  /** A limiter whose resume callback the test drives by hand. */
  function manualLimiter(limitKbps: number | null): { limiter: ThroughputLimiter; fire: () => void; scheduled: () => number } {
    let pending: (() => void) | null = null;
    let scheduledCount = 0;
    const limiter = new ThroughputLimiter(limitKbps, {
      windowMs: 100,
      now: () => 1_000,
      schedule: (callback) => {
        pending = callback;
        scheduledCount += 1;
        return () => {
          pending = null;
        };
      },
    });
    return {
      limiter,
      fire: () => {
        const callback = pending;
        pending = null;
        callback?.();
      },
      scheduled: () => scheduledCount,
    };
  }

  it('does nothing at all without a limit', () => {
    const { limiter } = manualLimiter(null);
    const stream = new FakeStream();
    limiter.track(stream);
    for (let index = 0; index < 100; index += 1) {
      assert.equal(limiter.report(1_000_000), false);
    }
    assert.equal(stream.pauses, 0);
    limiter.dispose();
  });

  it('pauses every tracked stream once the window budget is spent, then resumes', () => {
    // 1 KB/s over a 100 ms window = 102 bytes per window.
    const { limiter, fire, scheduled } = manualLimiter(1);
    const a = new FakeStream();
    const b = new FakeStream();
    limiter.track(a);
    limiter.track(b);

    assert.equal(limiter.report(60), false, 'inside the budget');
    assert.equal(limiter.isPaused, false);
    assert.equal(limiter.report(60), true, 'past the budget');
    assert.equal(limiter.isPaused, true);
    assert.equal(a.pauses, 1);
    assert.equal(b.pauses, 1, 'the ceiling is shared by every active transfer');
    assert.equal(scheduled(), 1, 'exactly one resume is scheduled');

    // Further reports while paused do not pause again.
    limiter.report(500);
    assert.equal(a.pauses, 1);

    fire();
    assert.equal(limiter.isPaused, false);
    assert.equal(a.resumes, 1);
    assert.equal(b.resumes, 1);

    // The next window has its budget back.
    assert.equal(limiter.report(60), false);
    limiter.dispose();
  });

  it('pauses a stream that joins while the budget is overspent', () => {
    const { limiter, fire } = manualLimiter(1);
    limiter.report(500);
    assert.equal(limiter.isPaused, true);

    const late = new FakeStream();
    limiter.track(late);
    assert.equal(late.pauses, 1, 'a new stream must start paused, not blow the budget');

    fire();
    assert.equal(late.resumes, 1);
    limiter.dispose();
  });

  it('lifting the limit resumes everything immediately', () => {
    const { limiter } = manualLimiter(1);
    const stream = new FakeStream();
    limiter.track(stream);
    limiter.report(500);
    assert.equal(stream.pauses, 1);

    limiter.setLimit(null);
    assert.equal(limiter.isPaused, false);
    assert.equal(stream.resumes, 1);
    assert.equal(limiter.limit, null);
    limiter.dispose();
  });

  it('tightening the limit takes effect immediately', () => {
    // 1000 KB/s over 100 ms = 102 400 bytes per window.
    const { limiter } = manualLimiter(1000);
    const stream = new FakeStream();
    limiter.track(stream);
    assert.equal(limiter.report(102_400), false, 'exactly the budget is still fine');

    limiter.setLimit(1); // now only 102 bytes fit in the same window
    assert.equal(limiter.report(1), true);
    assert.equal(stream.pauses, 1);
    limiter.dispose();
  });

  it('stops pausing once a stream is untracked', () => {
    const { limiter, fire } = manualLimiter(1);
    const stream = new FakeStream();
    limiter.track(stream);
    limiter.untrack(stream);
    limiter.report(500);
    assert.equal(limiter.isPaused, true, 'the budget is still spent');
    assert.equal(stream.pauses, 0, 'but a finished transfer is no longer touched');
    fire();
    assert.equal(stream.resumes, 0);
    limiter.dispose();
  });
});
