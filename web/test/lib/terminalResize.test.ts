import { describe, expect, test } from 'vitest';
import {
  clampTerminalDimension,
  resolveTerminalSize,
  shouldSendTerminalResize,
} from '../../src/lib/terminalResize';

describe('terminalResize', () => {
  test('clamps invalid and out-of-range dimensions', () => {
    expect(clampTerminalDimension(Number.NaN, 80)).toBe(80);
    expect(clampTerminalDimension(0, 24)).toBe(24);
    expect(clampTerminalDimension(-10, 24)).toBe(24);
    expect(clampTerminalDimension(180.6, 80)).toBe(181);
    expect(clampTerminalDimension(5000, 80)).toBe(1000);
  });

  test('resolves initial size with sensible fallbacks', () => {
    expect(resolveTerminalSize(142, 41)).toEqual({ cols: 142, rows: 41 });
    expect(resolveTerminalSize(0, 0)).toEqual({ cols: 80, rows: 24 });
  });

  test('deduplicates identical consecutive sizes unless forced', () => {
    expect(shouldSendTerminalResize({ cols: 80, rows: 24 }, null)).toBe(true);
    expect(shouldSendTerminalResize({ cols: 80, rows: 24 }, { cols: 80, rows: 24 })).toBe(false);
    expect(shouldSendTerminalResize({ cols: 80, rows: 24 }, { cols: 80, rows: 24 }, true)).toBe(true);
    expect(shouldSendTerminalResize({ cols: 180, rows: 45 }, { cols: 80, rows: 24 })).toBe(true);
    expect(shouldSendTerminalResize({ cols: 180, rows: 46 }, { cols: 180, rows: 45 })).toBe(true);
  });
});
