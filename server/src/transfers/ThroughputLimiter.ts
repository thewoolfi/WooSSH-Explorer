/** The minimum a stream must expose to be throttled by {@link ThroughputLimiter}. */
export interface ThrottleableStream {
  pause(): void;
  resume(): void;
}

export interface ThroughputLimiterOptions {
  /** Accounting window; the budget is `limit` bytes per window. */
  windowMs?: number;
  now?: () => number;
  /** Schedules the resume; returns a cancel function. Injectable so tests are deterministic. */
  schedule?: (callback: () => void, delayMs: number) => () => void;
}

/**
 * Combined-throughput ceiling for every active transfer (contract §7: `speedLimitKbps`).
 *
 * The limiter never drops or buffers data: the transfers report the bytes they read and, once a
 * window's budget is spent, every registered *read* stream is paused. The remote side therefore
 * sees real backpressure (its send window fills up) instead of a torn-down connection. When the
 * window elapses the streams are resumed.
 *
 * It is deliberately free of I/O so the mechanism can be unit tested with fake streams, a fake
 * clock and an immediate scheduler.
 */
export class ThroughputLimiter {
  static readonly DEFAULT_WINDOW_MS = 100;

  private limitKbps: number | null;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, delayMs: number) => () => void;

  private readonly streams = new Set<ThrottleableStream>();
  private windowStartedAt: number;
  private windowBytes = 0;
  private paused = false;
  private cancelResume: (() => void) | null = null;

  constructor(limitKbps: number | null, options: ThroughputLimiterOptions = {}) {
    this.limitKbps = normalizeLimit(limitKbps);
    this.windowMs = options.windowMs ?? ThroughputLimiter.DEFAULT_WINDOW_MS;
    this.now = options.now ?? ((): number => Date.now());
    this.schedule =
      options.schedule ??
      ((callback, delayMs) => {
        const timer = setTimeout(callback, delayMs);
        // A limiter must never keep the process (or a test) alive on its own.
        timer.unref?.();
        return () => clearTimeout(timer);
      });
    this.windowStartedAt = this.now();
  }

  get limit(): number | null {
    return this.limitKbps;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Applies a new ceiling immediately; `null` lifts it and resumes everything. */
  setLimit(limitKbps: number | null): void {
    this.limitKbps = normalizeLimit(limitKbps);
    if (this.limitKbps === null) {
      this.cancelResume?.();
      this.cancelResume = null;
      this.windowBytes = 0;
      this.windowStartedAt = this.now();
      this.resumeAll();
    }
  }

  track(stream: ThrottleableStream): void {
    this.streams.add(stream);
    // A stream that joins while the budget is overspent starts paused too.
    if (this.paused) {
      try {
        stream.pause();
      } catch {
        /* already gone */
      }
    }
  }

  untrack(stream: ThrottleableStream): void {
    this.streams.delete(stream);
  }

  /**
   * Records `bytes` that just arrived from a tracked stream. Returns `true` when the budget for
   * this window is spent — the caller may keep reporting, but the flow has been paused.
   */
  report(bytes: number, now: number = this.now()): boolean {
    if (this.limitKbps === null || !Number.isFinite(bytes) || bytes <= 0) return false;

    if (now - this.windowStartedAt >= this.windowMs || now < this.windowStartedAt) {
      this.windowStartedAt = now;
      this.windowBytes = 0;
    }
    this.windowBytes += bytes;
    if (this.windowBytes <= this.budget()) return false;

    this.pauseAll(now);
    return true;
  }

  /** Stops the timer and forgets every stream. Used when the server shuts down. */
  dispose(): void {
    this.cancelResume?.();
    this.cancelResume = null;
    this.paused = false;
    this.streams.clear();
  }

  private budget(): number {
    const limit = this.limitKbps;
    if (limit === null) return Number.POSITIVE_INFINITY;
    return Math.max(1, Math.floor((limit * 1024 * this.windowMs) / 1000));
  }

  private pauseAll(now: number): void {
    if (!this.paused) {
      this.paused = true;
      for (const stream of this.streams) {
        try {
          stream.pause();
        } catch {
          /* a closed stream needs no pausing */
        }
      }
    }
    if (this.cancelResume !== null) return;

    const delayMs = Math.max(1, this.windowMs - (now - this.windowStartedAt));
    this.cancelResume = this.schedule(() => {
      this.cancelResume = null;
      this.windowStartedAt = this.now();
      this.windowBytes = 0;
      this.resumeAll();
    }, delayMs);
  }

  private resumeAll(): void {
    if (!this.paused) return;
    this.paused = false;
    for (const stream of this.streams) {
      try {
        stream.resume();
      } catch {
        /* already gone */
      }
    }
  }
}

function normalizeLimit(limitKbps: number | null | undefined): number | null {
  if (limitKbps === null || limitKbps === undefined) return null;
  if (!Number.isFinite(limitKbps) || limitKbps <= 0) return null;
  return limitKbps;
}
