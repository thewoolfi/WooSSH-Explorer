export interface TerminalSize {
  cols: number;
  rows: number;
}

export function clampTerminalDimension(value: number, fallback: number): number {
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.max(Math.round(value), 1), 1000);
}

export function resolveTerminalSize(cols: number, rows: number): TerminalSize {
  return {
    cols: clampTerminalDimension(cols, 80),
    rows: clampTerminalDimension(rows, 24),
  };
}

export function shouldSendTerminalResize(
  next: TerminalSize,
  lastSent: TerminalSize | null,
  force = false,
): boolean {
  if (next.cols < 1 || next.rows < 1) return false;
  if (force || lastSent === null) return true;
  return next.cols !== lastSent.cols || next.rows !== lastSent.rows;
}
