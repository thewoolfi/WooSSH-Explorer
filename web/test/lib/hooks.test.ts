import { describe, expect, test } from 'vitest';

import { isTextTarget, matchesCombo } from '../../src/lib/hooks';

interface KeyInit {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  code?: string;
}

/** Only the fields `matchesCombo` reads; the cast keeps the test self-contained. */
function keydown(init: KeyInit): KeyboardEvent {
  return {
    key: init.key,
    ctrlKey: init.ctrlKey ?? false,
    metaKey: init.metaKey ?? false,
    shiftKey: init.shiftKey ?? false,
    altKey: init.altKey ?? false,
    code: init.code ?? '',
  } as KeyboardEvent;
}

describe('matchesCombo', () => {
  test('`mod` accepts either Control or Command', () => {
    expect(matchesCombo(keydown({ key: 'k', ctrlKey: true }), 'mod+k')).toBe(true);
    expect(matchesCombo(keydown({ key: 'k', metaKey: true }), 'mod+k')).toBe(true);
  });

  test('modifiers must match exactly, not merely be a superset', () => {
    expect(matchesCombo(keydown({ key: 'k' }), 'mod+k')).toBe(false);
    expect(matchesCombo(keydown({ key: 'k', ctrlKey: true, shiftKey: true }), 'mod+k')).toBe(false);
    expect(matchesCombo(keydown({ key: 'k', ctrlKey: true, altKey: true }), 'mod+k')).toBe(false);
    expect(matchesCombo(keydown({ key: 'k', shiftKey: true }), 'shift+k')).toBe(true);
    expect(matchesCombo(keydown({ key: 'k', shiftKey: true }), 'k')).toBe(false);
  });

  test('the key comparison is case-insensitive', () => {
    expect(matchesCombo(keydown({ key: 'K', ctrlKey: true }), 'mod+k')).toBe(true);
    expect(matchesCombo(keydown({ key: 'F5' }), 'f5')).toBe(true);
    expect(matchesCombo(keydown({ key: 'F2' }), 'f2')).toBe(true);
    expect(matchesCombo(keydown({ key: 'F2' }), 'f3')).toBe(false);
  });

  test('accepts a three-part combo in any order', () => {
    const event = keydown({ key: 'n', ctrlKey: true, shiftKey: true });
    expect(matchesCombo(event, 'shift+mod+n')).toBe(true);
    expect(matchesCombo(event, 'mod+shift+n')).toBe(true);
    expect(matchesCombo(keydown({ key: 'n', ctrlKey: true }), 'shift+mod+n')).toBe(false);
  });

  test('escape matches with no modifier and nothing else', () => {
    expect(matchesCombo(keydown({ key: 'Escape' }), 'escape')).toBe(true);
    expect(matchesCombo(keydown({ key: 'Escape', ctrlKey: true }), 'escape')).toBe(false);
    expect(matchesCombo(keydown({ key: 'Esc' }), 'escape')).toBe(false);
  });

  test('space accepts both " " and the Space code', () => {
    expect(matchesCombo(keydown({ key: ' ' }), 'space')).toBe(true);
    expect(matchesCombo(keydown({ key: 'Spacebar', code: 'Space' }), 'space')).toBe(true);
    expect(matchesCombo(keydown({ key: 'Spacebar', code: 'KeyS' }), 'space')).toBe(false);
  });

  test('delete also accepts Backspace', () => {
    expect(matchesCombo(keydown({ key: 'Delete', shiftKey: true }), 'shift+delete')).toBe(true);
    expect(matchesCombo(keydown({ key: 'Backspace', shiftKey: true }), 'shift+delete')).toBe(true);
    expect(matchesCombo(keydown({ key: 'Delete' }), 'shift+delete')).toBe(false);
  });

  test('navigation keys use their own spelling', () => {
    expect(matchesCombo(keydown({ key: 'Home' }), 'home')).toBe(true);
    expect(matchesCombo(keydown({ key: 'End' }), 'end')).toBe(true);
    expect(matchesCombo(keydown({ key: 'PageUp' }), 'pageup')).toBe(true);
    expect(matchesCombo(keydown({ key: 'PageDown' }), 'pagedown')).toBe(true);
    expect(matchesCombo(keydown({ key: 'enter' }), 'enter')).toBe(true);
  });

  test('the combo is matched whole, not as a substring of the key', () => {
    expect(matchesCombo(keydown({ key: 'mod+k' }), 'k')).toBe(false);
    expect(matchesCombo(keydown({ key: 'kk' }), 'k')).toBe(false);
  });
});

describe('isTextTarget', () => {
  test('recognizes the elements the user types into', () => {
    expect(isTextTarget(document.createElement('input'))).toBe(true);
    expect(isTextTarget(document.createElement('textarea'))).toBe(true);
    expect(isTextTarget(document.createElement('select'))).toBe(true);
  });

  test('ignores everything else', () => {
    expect(isTextTarget(document.createElement('div'))).toBe(false);
    expect(isTextTarget(document.createElement('button'))).toBe(false);
    expect(isTextTarget(document.body)).toBe(false);
  });

  test('tolerates null and non-element targets', () => {
    expect(isTextTarget(null)).toBe(false);
    expect(isTextTarget({} as unknown as EventTarget)).toBe(false);
  });
});
