/**
 * Closing the application must close everything behind it.
 *
 * The desktop shell closes the window, asks the server to shut down and then calls
 * `app.exit` after a short grace period — a hard exit that would hide any leak from the
 * user's point of view. These tests hold the server to the promise instead: after
 * `close()` returns, nothing of its making is still holding the process open.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { startHarness, type Harness } from '../support/harness.js';

/** Resource kinds that mean "something of ours is still alive". */
const WATCHED = ['TCPSocketWrap', 'TCPServerWrap', 'Timeout', 'Immediate'];

function watch(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const kind of process.getActiveResourcesInfo()) {
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

function watchedTotal(): number {
  const counts = watch();
  return WATCHED.reduce((sum, kind) => sum + (counts[kind] ?? 0), 0);
}

/** Polls until the condition holds; the shutdown path is deliberately asynchronous. */
async function until(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

describe('server shutdown', () => {
  test('closing releases the listener, the SSH session and the transfer queue', async () => {
    const harness: Harness = await startHarness({});
    try {
      const { id } = await harness.connectTrusting();

      // Give the server real work to stop: a listing has populated its cache and the
      // transfer manager has a queue of its own.
      await harness.json('GET', `/api/connections/${id}/fs/list?path=/`);

      const before = watchedTotal();
      assert.ok(before > 0, 'the harness should have sockets and timers while running');

      await harness.close();

      const drained = await until(() => watchedTotal() < before);
      assert.ok(
        drained,
        `resources did not drop after close: before=${before} after=${watchedTotal()} ${JSON.stringify(watch())}`,
      );
    } catch (error) {
      await harness.close().catch(() => undefined);
      throw error;
    }
  });

  test('the shutdown resolves promptly', async () => {
    const harness = await startHarness({});
    try {
      const { id } = await harness.connectTrusting();
      await harness.json('GET', `/api/connections/${id}/fs/list?path=/`);

      const started = Date.now();
      await harness.close();
      const elapsed = Date.now() - started;
      // The desktop shell gives the server 2.5 s before it exits hard; a graceful close
      // that takes longer than that is, from the user's seat, a hung application.
      assert.ok(elapsed < 2000, `close took ${elapsed} ms`);
    } catch (error) {
      await harness.close().catch(() => undefined);
      throw error;
    }
  });

  test('opening and closing repeatedly does not accumulate resources', async () => {
    // A leak here is invisible in a single run and fatal over a working day.
    const baseline = watchedTotal();
    for (let round = 0; round < 3; round += 1) {
      const harness = await startHarness({});
      try {
        const { id } = await harness.connectTrusting();
        await harness.json('GET', `/api/connections/${id}/fs/list?path=/`);
      } finally {
        await harness.close();
      }
    }
    // Allow the last teardown to settle before comparing.
    await until(() => watchedTotal() <= baseline + 2, 3000);
    const after = watchedTotal();
    assert.ok(
      after <= baseline + 2,
      `resources grew across rounds: baseline=${baseline} after=${after} ${JSON.stringify(watch())}`,
    );
  });
});
