import { describe, expect, test } from 'vitest';

import {
  clipboardAsText,
  isPendingCut,
  planPaste,
  type ClipboardEntry,
} from '../../src/state/clipboardStore';

function clip(overrides: Partial<ClipboardEntry> = {}): ClipboardEntry {
  return { connectionId: 'c1', paths: ['/src/a.txt'], mode: 'copy', ...overrides };
}

describe('planPaste — routing', () => {
  test('an empty clipboard is refused', () => {
    expect(planPaste({ clipboard: null, targetConnectionId: 'c1', targetDir: '/dst' })).toEqual({
      ok: false,
      reason: 'empty',
    });
    expect(
      planPaste({ clipboard: clip({ paths: [] }), targetConnectionId: 'c1', targetDir: '/dst' }),
    ).toEqual({ ok: false, reason: 'empty' });
  });

  test('paste copies within one host', () => {
    const decision = planPaste({
      clipboard: clip({ paths: ['/src/a.txt', '/src/b.txt'] }),
      targetConnectionId: 'c1',
      targetDir: '/dst',
    });
    expect(decision).toEqual({
      ok: true,
      plan: {
        kind: 'copy',
        sources: ['/src/a.txt', '/src/b.txt'],
        alreadyHere: [],
      },
    });
  });

  test('a cut turns the same paste into a move', () => {
    const decision = planPaste({
      clipboard: clip({ mode: 'cut' }),
      targetConnectionId: 'c1',
      targetDir: '/dst',
    });
    expect(decision.ok && decision.plan.kind).toBe('move');
  });

  test('another host routes through the relay and keeps the source host', () => {
    const decision = planPaste({
      clipboard: clip({ connectionId: 'c9', paths: ['/other/c.txt'] }),
      targetConnectionId: 'c1',
      targetDir: '/dst',
    });
    expect(decision).toEqual({
      ok: true,
      plan: {
        kind: 'relay',
        sources: ['/other/c.txt'],
        sourceConnectionId: 'c9',
        alreadyHere: [],
      },
    });
  });

  test('a cross-host paste carries directories too', () => {
    // The relay mirrors whole trees, so a project folder is one request.
    const decision = planPaste({
      clipboard: clip({ connectionId: 'c9', paths: ['/src/lib', '/other/c.txt'] }),
      targetConnectionId: 'c1',
      targetDir: '/dst',
    });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.plan.sources).toEqual(['/src/lib', '/other/c.txt']);
    expect(decision.plan.kind).toBe('relay');
  });
});

describe('planPaste — refusals', () => {
  test('pasting into the folder the files already live in is refused, not attempted', () => {
    // The server answers "source and destination are the same path"; say it first.
    const decision = planPaste({
      clipboard: clip({ paths: ['/src/a.txt', '/src/b.txt'] }),
      targetConnectionId: 'c1',
      targetDir: '/src',
    });
    expect(decision).toEqual({ ok: false, reason: 'already-here' });
  });

  test('a mixed selection keeps the ones from elsewhere and reports the rest', () => {
    const decision = planPaste({
      clipboard: clip({ paths: ['/src/a.txt', '/other/c.txt'] }),
      targetConnectionId: 'c1',
      targetDir: '/src',
    });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.plan.sources).toEqual(['/other/c.txt']);
    expect(decision.plan.alreadyHere).toEqual(['/src/a.txt']);
  });

  test('an unknown entry is relayed rather than silently dropped', () => {
    const decision = planPaste({
      clipboard: clip({ connectionId: 'c9', paths: ['/mystery'] }),
      targetConnectionId: 'c1',
      targetDir: '/dst',
    });
    expect(decision.ok && decision.plan.sources).toEqual(['/mystery']);
  });

  test('the root is a valid destination and its children are "already here"', () => {
    const decision = planPaste({
      clipboard: clip({ paths: ['/a.txt'] }),
      targetConnectionId: 'c1',
      targetDir: '/',
    });
    expect(decision).toEqual({ ok: false, reason: 'already-here' });
  });
});

describe('clipboard helpers', () => {
  test('the text form is one path per line, which is what a shell wants', () => {
    expect(clipboardAsText(clip({ paths: ['/a b/c.txt', '/d.txt'] }))).toBe('/a b/c.txt\n/d.txt');
  });

  test('only a pending cut on the same host marks a row', () => {
    const cut = clip({ mode: 'cut', connectionId: 'c1', paths: ['/src/a.txt'] });
    expect(isPendingCut(cut, 'c1', '/src/a.txt')).toBe(true);
    // A copy never dims, and a cut on another host is not ours to dim.
    expect(isPendingCut(clip({ mode: 'copy' }), 'c1', '/src/a.txt')).toBe(false);
    expect(isPendingCut(cut, 'c2', '/src/a.txt')).toBe(false);
    expect(isPendingCut(cut, 'c1', '/src/other.txt')).toBe(false);
    expect(isPendingCut(null, 'c1', '/src/a.txt')).toBe(false);
  });
});
