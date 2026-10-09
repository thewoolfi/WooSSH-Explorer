import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { EditEvent } from '../../src/lib/desktop';

vi.mock('../../src/api/client', () => {
  class ApiError extends Error {
    readonly code: string;
    readonly status: number;
    readonly details: Record<string, unknown>;
    readonly requestId: string | null;

    constructor(
      status: number,
      code: string,
      message: string,
      details: Record<string, unknown> = {},
      requestId: string | null = null,
    ) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
      this.details = details;
      this.requestId = requestId;
    }
  }

  const stub = () => vi.fn();
  return {
    ApiError,
    api: {
      health: stub(),
      systemInfo: stub(),
      listProfiles: stub(),
      createProfile: stub(),
      updateProfile: stub(),
      deleteProfile: stub(),
      listSecrets: stub(),
      forgetSecret: stub(),
      forgetAllSecrets: stub(),
      listConnections: stub(),
      getConnection: stub(),
      connect: stub(),
      disconnect: stub(),
      reconnect: stub(),
      exec: stub(),
      list: stub(),
      stat: stub(),
      read: stub(),
      mkdir: stub(),
      rename: stub(),
      remove: stub(),
      chmod: stub(),
      touch: stub(),
      search: stub(),
      usage: stub(),
      upload: stub(),
      listTransfers: stub(),
      cancelTransfer: stub(),
      clearTransfers: stub(),
      retryTransfer: stub(),
    },
  };
});

import { useEditStore, suggestSaveAs, type EditSession } from '../../src/state/editStore';
import { useExplorerStore } from '../../src/state/explorerStore';
import { useUiStore } from '../../src/state/uiStore';
import { settle } from '../helpers/fixtures';

const store = () => useEditStore.getState();

function session(sessionId: string, overrides: Partial<EditSession> = {}): EditSession {
  return {
    sessionId,
    connectionId: 'c1',
    name: 'a.txt',
    remotePath: '/home/a.txt',
    localPath: '/tmp/a.txt',
    state: 'opened',
    suggestedPath: '/home/a (edited).txt',
    ...overrides,
  };
}

beforeEach(() => {
  useEditStore.setState({ sessions: [], prompting: null, busy: false, starting: false });
  useUiStore.setState({ toasts: [] });
});

/* -------------------------------------------------------------------------- */

describe('suggestSaveAs', () => {
  test('inserts " (edited)" before the extension', () => {
    expect(suggestSaveAs('/home/anna/report.txt')).toBe('/home/anna/report (edited).txt');
    expect(suggestSaveAs('/var/log/app.log')).toBe('/var/log/app (edited).log');
    expect(suggestSaveAs('/tmp/photo.JPG')).toBe('/tmp/photo (edited).JPG');
  });

  test('keeps only the last extension of a multi-dot name', () => {
    expect(suggestSaveAs('/a/archive.tar.gz')).toBe('/a/archive.tar (edited).gz');
    expect(suggestSaveAs('/a/component.test.tsx')).toBe('/a/component.test (edited).tsx');
  });

  test('handles files without an extension', () => {
    expect(suggestSaveAs('/a/README')).toBe('/a/README (edited)');
    expect(suggestSaveAs('/a/notes.')).toBe('/a/notes (edited).');
  });

  test('a dotfile keeps its dot in the stem', () => {
    // The leading dot is not an extension separator.
    expect(suggestSaveAs('/home/anna/.bashrc')).toBe('/home/anna/.bashrc (edited)');
  });

  test('files directly under the root keep a single slash', () => {
    expect(suggestSaveAs('/report.txt')).toBe('/report (edited).txt');
    expect(suggestSaveAs('/report')).toBe('/report (edited)');
  });

  test('the suggestion always sits next to the original', () => {
    for (const path of ['/a/b/c.txt', '/a/b/c', '/x/.env', '/deep/nested/f.tar.gz']) {
      const suggested = suggestSaveAs(path);
      const directory = path.slice(0, path.lastIndexOf('/'));
      expect(suggested.startsWith(`${directory}/`)).toBe(true);
      expect(suggested).not.toBe(path);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe('editStore in a plain browser', () => {
  test('start() is a no-op without the desktop shell', async () => {
    await store().start({ connectionId: 'c1', remotePath: '/home/a.txt', name: 'a.txt' });

    expect(store().sessions).toEqual([]);
    expect(store().starting).toBe(false);
    expect(useUiStore.getState().toasts).toEqual([]);
  });

  test('attach() returns an inert unsubscribe helper', () => {
    const detach = store().attach();

    expect(typeof detach).toBe('function');
    expect(() => detach()).not.toThrow();
  });

  test('apply() never leaves the store busy', async () => {
    const applying = store().apply('session-1', { action: 'cancel' });
    expect(store().busy).toBe(true);

    await applying;
    expect(store().busy).toBe(false);
  });

  test('dismiss() removes a session and clears the prompt it owned', () => {
    useEditStore.setState({ sessions: [session('s1'), session('s2')], prompting: 's1' });

    store().dismiss('s1');

    expect(store().sessions.map((entry) => entry.sessionId)).toEqual(['s2']);
    expect(store().prompting).toBe(null);
  });

  test('dismiss() of another session leaves the current prompt alone', () => {
    useEditStore.setState({ sessions: [session('s1'), session('s2')], prompting: 's2' });

    store().dismiss('s1');

    expect(store().sessions.map((entry) => entry.sessionId)).toEqual(['s2']);
    expect(store().prompting).toBe('s2');
  });
});

/* -------------------------------------------------------------------------- */
/*  The desktop path: lib/desktop is replaced and the stores are re-imported   */
/*  in a fresh module registry so `isDesktop` is true.                        */
/* -------------------------------------------------------------------------- */

interface DesktopHarness {
  editStore: typeof useEditStore;
  uiStore: typeof useUiStore;
  explorerStore: typeof useExplorerStore;
  api: typeof import('../../src/api/client').api;
  emit: (event: EditEvent) => void;
  listenerCount: () => number;
  reveal: ReturnType<typeof vi.fn>;
}

async function loadDesktopHarness(): Promise<DesktopHarness> {
  vi.resetModules();
  const listeners: Array<(event: EditEvent) => void> = [];
  const reveal = vi.fn();

  vi.doMock('../../src/lib/desktop', () => ({
    isDesktop: true,
    desktopBridge: {},
    onMenuAction: () => () => undefined,
    onDownloadDone: () => () => undefined,
    revealInFileManager: reveal,
    desktopInfo: async () => null,
    openForEdit: async () => ({ sessionId: 's1', localPath: '/tmp/a.txt' }),
    resolveEdit: async () => undefined,
    onEditEvent: (handler: (event: EditEvent) => void) => {
      listeners.push(handler);
      return () => {
        const index = listeners.indexOf(handler);
        if (index >= 0) listeners.splice(index, 1);
      };
    },
  }));

  const apiModule = await import('../../src/api/client');
  vi.mocked(apiModule.api).list.mockImplementation(async (_connectionId: string, path: string) => ({
    listing: { path, parent: null, entries: [], truncated: false },
  }));

  const editModule = await import('../../src/state/editStore');
  const uiModule = await import('../../src/state/uiStore');
  const explorerModule = await import('../../src/state/explorerStore');

  return {
    editStore: editModule.useEditStore,
    uiStore: uiModule.useUiStore,
    explorerStore: explorerModule.useExplorerStore,
    api: apiModule.api,
    reveal,
    emit: (event) => {
      for (const listener of [...listeners]) listener(event);
    },
    listenerCount: () => listeners.length,
  };
}

const event = (overrides: Partial<EditEvent> & { sessionId: string; state: EditEvent['state'] }): EditEvent => ({
  name: 'a.txt',
  remotePath: '/home/a.txt',
  localPath: '/tmp/a.txt',
  connectionId: 'c1',
  ...overrides,
});

describe('editStore with the desktop shell', () => {
  test('start() records the session with a save-as suggestion', async () => {
    const harness = await loadDesktopHarness();

    await harness.editStore.getState().start({
      connectionId: 'c1',
      remotePath: '/home/a.txt',
      name: 'a.txt',
    });

    const session = harness.editStore.getState().sessions[0];
    expect(session).toMatchObject({
      sessionId: 's1',
      connectionId: 'c1',
      name: 'a.txt',
      remotePath: '/home/a.txt',
      localPath: '/tmp/a.txt',
      state: 'opened',
      suggestedPath: '/home/a (edited).txt',
    });
    expect(harness.editStore.getState().starting).toBe(false);
    expect(harness.uiStore.getState().toasts.map((toast) => toast.title)).toEqual([
      'Opened a.txt in the default application',
    ]);
  });

  test('a "changed" event raises the prompt and explains what to do', async () => {
    const harness = await loadDesktopHarness();
    harness.editStore.getState().attach();

    harness.emit(
      event({ sessionId: 's9', state: 'changed', name: 'notes.md', remotePath: '/home/notes.md' }),
    );

    const state = harness.editStore.getState();
    expect(state.prompting).toBe('s9');
    expect(state.sessions).toHaveLength(1);
    expect(state.sessions[0]).toMatchObject({
      sessionId: 's9',
      state: 'changed',
      remotePath: '/home/notes.md',
      suggestedPath: '/home/notes (edited).md',
      // The shell reports the connection with every event, so a session that was
      // never created by start() is still attributed to its host.
      connectionId: 'c1',
    });
    expect(harness.uiStore.getState().toasts.map((toast) => toast.title)).toEqual([
      'notes.md changed',
    ]);
  });

  test('an "uploaded" event refreshes only the tabs of that connection', async () => {
    const harness = await loadDesktopHarness();
    harness.editStore.getState().attach();
    await harness.editStore.getState().start({
      connectionId: 'c1',
      remotePath: '/home/a.txt',
      name: 'a.txt',
    });
    harness.explorerStore.getState().openFilesTab('c1', '/home');
    harness.explorerStore.getState().openFilesTab('c2', '/home');
    harness.explorerStore.getState().openTerminalTab('c1', 'root@web1');
    await settle();

    const list = vi.mocked(harness.api).list;
    list.mockClear();

    harness.emit(event({ sessionId: 's1', state: 'uploaded', bytes: 12, target: '/home/a.txt' }));
    await settle();

    // Only the c1 files tab was refreshed — not c2, not the terminal.
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith('c1', '/home');

    const toasts = harness.uiStore.getState().toasts;
    const last = toasts[toasts.length - 1];
    expect(last?.title).toBe('Saved a.txt to the server');
    expect(last?.detail).toBe('/home/a.txt');
    expect(last?.action?.label).toBe('Show local copy');

    last?.action?.run();
    expect(harness.reveal).toHaveBeenCalledWith('/tmp/a.txt');
  });

  test('an "error" event reports the failure message', async () => {
    const harness = await loadDesktopHarness();
    harness.editStore.getState().attach();

    harness.emit(
      event({ sessionId: 's2', state: 'error', message: 'permission denied', target: undefined }),
    );

    const toasts = harness.uiStore.getState().toasts;
    expect(toasts.map((toast) => toast.level)).toEqual(['error']);
    expect(toasts[0]?.title).toBe('Could not save a.txt');
    expect(toasts[0]?.detail).toBe('permission denied');
  });

  test('events for the same session update one entry instead of appending', async () => {
    const harness = await loadDesktopHarness();
    harness.editStore.getState().attach();

    harness.emit(event({ sessionId: 's3', state: 'changed' }));
    harness.emit(event({ sessionId: 's3', state: 'uploading' }));
    harness.emit(event({ sessionId: 's3', state: 'uploaded', target: '/home/a.txt' }));

    const sessions = harness.editStore.getState().sessions;
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.state).toBe('uploaded');
    // The prompt stays until it is answered or dismissed.
    expect(harness.editStore.getState().prompting).toBe('s3');
  });

  test('a "cancelled" event is recorded without a toast', async () => {
    const harness = await loadDesktopHarness();
    harness.editStore.getState().attach();

    harness.emit(event({ sessionId: 's4', state: 'cancelled' }));

    expect(harness.editStore.getState().sessions[0]?.state).toBe('cancelled');
    expect(harness.uiStore.getState().toasts).toEqual([]);
  });

  test('the unsubscribe function returned by attach() stops delivery', async () => {
    const harness = await loadDesktopHarness();
    const detach = harness.editStore.getState().attach();
    expect(harness.listenerCount()).toBe(1);

    detach();
    expect(harness.listenerCount()).toBe(0);

    harness.emit(event({ sessionId: 's5', state: 'changed' }));
    expect(harness.editStore.getState().sessions).toEqual([]);
  });
});
