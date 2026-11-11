export type TerminalKeyAction = 'copy' | 'copy-and-clear' | 'paste' | 'none';

export interface TerminalKeyEventLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  getModifierState?: (keyArg: string) => boolean;
}

export interface TerminalMousePasteInput {
  button: number;
  shiftKey: boolean;
  mouseTrackingMode: 'none' | 'x10' | 'vt200' | 'drag' | 'any' | string;
}

function isInsertKey(event: TerminalKeyEventLike): boolean {
  return event.code === 'Insert' || event.key === 'Insert';
}

function isLetterKey(event: TerminalKeyEventLike, upper: 'C' | 'V'): boolean {
  if (event.code === `Key${upper}`) return true;
  return event.key.toUpperCase() === upper;
}

/**
 * Classifies PuTTY and standard terminal clipboard shortcuts, independent of
 * the active keyboard layout (uses physical `KeyboardEvent.code` alongside `key`).
 *
 * Returns `'none'` when xterm should handle the key normally (bare `Insert` stays
 * `\x1b[2~`, and `Ctrl+C` without a selection keeps sending `SIGINT` `\x03`).
 */
export function classifyTerminalKeyAction(
  event: TerminalKeyEventLike,
  hasSelection: boolean,
): TerminalKeyAction {
  const altGraph = typeof event.getModifierState === 'function' && event.getModifierState('AltGraph');
  if (altGraph || event.altKey) return 'none';

  // PuTTY / Windows CUA Insert shortcuts: Shift+Insert pastes, Ctrl+Insert copies.
  if (isInsertKey(event)) {
    if (event.shiftKey && !event.ctrlKey && !event.metaKey) return 'paste';
    if (event.ctrlKey && !event.shiftKey && !event.metaKey) return 'copy';
    return 'none';
  }

  // Copy shortcuts.
  if (isLetterKey(event, 'C')) {
    if (event.ctrlKey && event.shiftKey && !event.metaKey) return 'copy';
    if (event.ctrlKey && !event.shiftKey && !event.metaKey) {
      return hasSelection ? 'copy-and-clear' : 'none';
    }
    if (event.metaKey && !event.ctrlKey && !event.shiftKey) return 'copy';
    return 'none';
  }

  // Paste shortcuts.
  if (isLetterKey(event, 'V')) {
    if (event.ctrlKey && !event.metaKey) return 'paste';
    if (event.metaKey && !event.ctrlKey && !event.shiftKey) return 'paste';
    return 'none';
  }

  return 'none';
}

/**
 * Returns true when a mouse button click should trigger PuTTY-style clipboard paste:
 * middle-click (`button === 1`) or right-click (`button === 2`) while mouse reporting
 * is off, or when `Shift` overrides an active TUI mouse-tracking mode (`vim`/`htop`/`mc`).
 */
export function shouldHandleTerminalMousePaste(input: TerminalMousePasteInput): boolean {
  if (input.button !== 1 && input.button !== 2) return false;
  return input.mouseTrackingMode === 'none' || input.shiftKey;
}
