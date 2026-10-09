import { MAX_MAX_CONCURRENT, MIN_MAX_CONCURRENT } from '../store/settingsStore.js';

/** A held concurrency slot. Releasing twice is a no-op. */
export interface TransferSlot {
  release(): void;
}

/**
 * Bounded concurrency for transfers (contract §7: `maxConcurrent`).
 *
 * The manager awaits {@link acquire} before it starts any I/O, so a transfer beyond the limit
 * stays `queued` until an earlier one finishes. The queue is FIFO, and changing the limit takes
 * effect immediately: raising it wakes queued waiters, lowering it lets running transfers
 * finish and simply starts nothing new until the count drops.
 */
export class TransferQueue {
  private limit: number;
  private active = 0;
  private closed = false;
  private readonly waiters: ((slot: TransferSlot) => void)[] = [];

  constructor(limit: number) {
    this.limit = clampConcurrency(limit);
  }

  get maxConcurrent(): number {
    return this.limit;
  }

  get activeCount(): number {
    return this.active;
  }

  get queuedCount(): number {
    return this.waiters.length;
  }

  setLimit(limit: number): void {
    this.limit = clampConcurrency(limit);
    this.drain();
  }

  /** Resolves once a slot is free (or immediately when the queue is closed/shut down). */
  acquire(): Promise<TransferSlot> {
    if (this.closed) return Promise.resolve(freeSlot());
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve(this.slot());
    }
    return new Promise<TransferSlot>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /**
   * Wakes every waiter with an already-released slot so a shutdown cannot leave a request
   * hanging forever; callers see "no concurrency" and abandon their work.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(freeSlot());
  }

  private slot(): TransferSlot {
    let released = false;
    return {
      release: (): void => {
        if (released) return;
        released = true;
        this.active = Math.max(0, this.active - 1);
        this.drain();
      },
    };
  }

  private drain(): void {
    while (!this.closed && this.waiters.length > 0 && this.active < this.limit) {
      const next = this.waiters.shift();
      if (next === undefined) return;
      this.active += 1;
      next(this.slot());
    }
  }
}

function freeSlot(): TransferSlot {
  return { release: (): void => undefined };
}

export function clampConcurrency(value: number): number {
  if (!Number.isFinite(value)) return MIN_MAX_CONCURRENT;
  return Math.min(MAX_MAX_CONCURRENT, Math.max(MIN_MAX_CONCURRENT, Math.round(value)));
}
