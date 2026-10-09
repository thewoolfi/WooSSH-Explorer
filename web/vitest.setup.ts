import { afterEach, beforeEach, vi } from 'vitest';

/**
 * jsdom already provides `window.localStorage`, `document` and `history`, which is
 * everything the zustand stores touch at import time — except for three globals
 * jsdom does not implement: `matchMedia`, `ResizeObserver` and `WebSocket`
 * (jsdom *does* ship a real `WebSocket`, which would open a socket, so it is
 * replaced by an inert stub below).
 *
 * Every stub here is deliberately passive: it records nothing, schedules no timers,
 * fires no callbacks and performs no I/O. Importing a store must never connect.
 */

/* ------------------------------------------------------------------ matchMedia */

interface MediaQueryListStub {
  matches: boolean;
  media: string;
  onchange: ((event: unknown) => void) | null;
  addEventListener: (type: string, listener: (event: unknown) => void) => void;
  removeEventListener: (type: string, listener: (event: unknown) => void) => void;
  addListener: (listener: (event: unknown) => void) => void;
  removeListener: (listener: (event: unknown) => void) => void;
  dispatchEvent: (event: unknown) => boolean;
}

function createMatchMedia(query: string): MediaQueryListStub {
  return {
    // Tests that care about a media query override this stub themselves; the
    // default is the "no preference" answer.
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => true,
  };
}

if (typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: createMatchMedia,
  });
}

/* --------------------------------------------------------------- ResizeObserver */

class ResizeObserverStub {
  observe(): void {
    /* inert */
  }

  unobserve(): void {
    /* inert */
  }

  disconnect(): void {
    /* inert */
  }
}

if (typeof globalThis.ResizeObserver !== 'function') {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    writable: true,
    configurable: true,
    value: ResizeObserverStub,
  });
}

/* -------------------------------------------------------------------- WebSocket */

/**
 * Minimal stand-in for the browser `WebSocket`.
 *
 * The constructor only remembers the URL: it never dials, never queues a timer and
 * never invokes a handler, so a module that eagerly creates a socket (see
 * `src/state/eventBus.ts`) cannot reach the network or schedule a reconnect loop
 * during a test run. `readyState` stays `CONNECTING` until `close()` is called.
 */
class InertWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly url: string;
  readonly protocol = '';
  readonly extensions = '';
  binaryType = 'blob';
  bufferedAmount = 0;
  readyState: number = InertWebSocket.CONNECTING;

  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: unknown) => void) | null = null;
  onclose: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(url: string | URL) {
    this.url = String(url);
  }

  send(): void {
    /* inert */
  }

  close(): void {
    this.readyState = InertWebSocket.CLOSED;
  }

  addEventListener(): void {
    /* inert */
  }

  removeEventListener(): void {
    /* inert */
  }

  dispatchEvent(): boolean {
    return true;
  }
}

Object.defineProperty(globalThis, 'WebSocket', {
  writable: true,
  configurable: true,
  value: InertWebSocket,
});

/* ------------------------------------------------------------------------ hooks */

beforeEach(() => {
  // The stores persist preferences and the API token in localStorage; leaking that
  // between specs would make "reads the stored value" tests order-dependent.
  window.localStorage.clear();
});

afterEach(() => {
  // Safety net for specs that freeze time; harmless when no fake timers are active.
  vi.useRealTimers();
});
