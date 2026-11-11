import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  classifyTerminalKeyAction,
  shouldHandleTerminalMousePaste,
  type TerminalKeyEventLike,
} from '../../src/lib/terminalClipboard';
import { readClipboardText, writeClipboardText } from '../../src/lib/desktop';

function keyEvent(overrides: Partial<TerminalKeyEventLike>): TerminalKeyEventLike {
  return {
    key: '',
    code: '',
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...overrides,
  };
}

describe('classifyTerminalKeyAction', () => {
  test('Shift+Insert triggers paste while bare Insert passes through to shell', () => {
    expect(
      classifyTerminalKeyAction(keyEvent({ key: 'Insert', code: 'Insert', shiftKey: true }), false),
    ).toBe('paste');
    expect(
      classifyTerminalKeyAction(keyEvent({ key: 'Insert', code: 'Numpad0', shiftKey: true }), false),
    ).toBe('paste');
    expect(classifyTerminalKeyAction(keyEvent({ key: 'Insert', code: 'Insert' }), false)).toBe('none');
  });

  test('Ctrl+Insert copies selection without clearing', () => {
    expect(
      classifyTerminalKeyAction(keyEvent({ key: 'Insert', code: 'Insert', ctrlKey: true }), true),
    ).toBe('copy');
    expect(
      classifyTerminalKeyAction(keyEvent({ key: 'Insert', code: 'Numpad0', ctrlKey: true }), true),
    ).toBe('copy');
    expect(
      classifyTerminalKeyAction(keyEvent({ key: 'Insert', code: 'Insert', ctrlKey: true }), false),
    ).toBe('copy');
  });

  test('Ctrl+C copies and clears selection only when text is selected, otherwise sends SIGINT', () => {
    expect(
      classifyTerminalKeyAction(keyEvent({ key: 'c', code: 'KeyC', ctrlKey: true }), true),
    ).toBe('copy-and-clear');
    expect(
      classifyTerminalKeyAction(keyEvent({ key: 'c', code: 'KeyC', ctrlKey: true }), false),
    ).toBe('none');
  });

  test('Ctrl+Shift+C / Ctrl+Shift+V / Ctrl+V work regardless of keyboard layout (Russian)', () => {
    // Cyrillic 'с' / 'м' with physical KeyC / KeyV codes
    expect(
      classifyTerminalKeyAction(keyEvent({ key: 'с', code: 'KeyC', ctrlKey: true }), true),
    ).toBe('copy-and-clear');
    expect(
      classifyTerminalKeyAction(keyEvent({ key: 'С', code: 'KeyC', ctrlKey: true, shiftKey: true }), true),
    ).toBe('copy');
    expect(
      classifyTerminalKeyAction(keyEvent({ key: 'м', code: 'KeyV', ctrlKey: true }), false),
    ).toBe('paste');
    expect(
      classifyTerminalKeyAction(keyEvent({ key: 'М', code: 'KeyV', ctrlKey: true, shiftKey: true }), false),
    ).toBe('paste');
  });

  test('Cmd+C / Cmd+V work on macOS and AltGr / Alt combinations pass through', () => {
    expect(
      classifyTerminalKeyAction(keyEvent({ key: 'c', code: 'KeyC', metaKey: true }), true),
    ).toBe('copy');
    expect(
      classifyTerminalKeyAction(keyEvent({ key: 'v', code: 'KeyV', metaKey: true }), false),
    ).toBe('paste');
    expect(
      classifyTerminalKeyAction(
        keyEvent({
          key: 'c',
          code: 'KeyC',
          ctrlKey: true,
          altKey: true,
          getModifierState: (mod) => mod === 'AltGraph',
        }),
        true,
      ),
    ).toBe('none');
    expect(
      classifyTerminalKeyAction(keyEvent({ key: 'Insert', code: 'Insert', shiftKey: true, altKey: true }), false),
    ).toBe('none');
  });
});

describe('shouldHandleTerminalMousePaste', () => {
  test('allows middle-click and right-click paste in normal mode', () => {
    expect(shouldHandleTerminalMousePaste({ button: 1, shiftKey: false, mouseTrackingMode: 'none' })).toBe(true);
    expect(shouldHandleTerminalMousePaste({ button: 2, shiftKey: false, mouseTrackingMode: 'none' })).toBe(true);
    expect(shouldHandleTerminalMousePaste({ button: 0, shiftKey: false, mouseTrackingMode: 'none' })).toBe(false);
  });

  test('lets TUI apps own mouse buttons unless Shift overrides mouse tracking', () => {
    expect(shouldHandleTerminalMousePaste({ button: 2, shiftKey: false, mouseTrackingMode: 'vt200' })).toBe(false);
    expect(shouldHandleTerminalMousePaste({ button: 1, shiftKey: false, mouseTrackingMode: 'any' })).toBe(false);
    expect(shouldHandleTerminalMousePaste({ button: 2, shiftKey: true, mouseTrackingMode: 'vt200' })).toBe(true);
    expect(shouldHandleTerminalMousePaste({ button: 1, shiftKey: true, mouseTrackingMode: 'drag' })).toBe(true);
  });
});

describe('clipboard helpers (browser fallback)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('readClipboardText and writeClipboardText delegate cleanly to navigator.clipboard in browser', async () => {
    const readText = vi.fn().mockResolvedValue('ls -la');
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { readText, writeText },
      configurable: true,
    });

    await expect(writeClipboardText('uname -a')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith('uname -a');
    await expect(writeClipboardText('')).resolves.toBe(false);

    await expect(readClipboardText()).resolves.toBe('ls -la');
    expect(readText).toHaveBeenCalledTimes(1);
  });
});
