import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  INSPECTOR_DEFAULT_WIDTH,
  INSPECTOR_MAX_WIDTH,
  INSPECTOR_MIN_WIDTH,
  clampInspectorWidth,
  useUiStore,
} from '../../src/state/uiStore';

const store = () => useUiStore.getState();

/** jsdom windows are 1024×768 by default; each test picks its own width. */
function setWindowSize(width: number, height = 768): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true });
}

const prefs = (): Record<string, unknown> =>
  JSON.parse(window.localStorage.getItem('ssh-explorer.prefs') ?? '{}') as Record<string, unknown>;

beforeEach(() => {
  setWindowSize(1024);
  delete document.documentElement.dataset.theme;
  useUiStore.setState({
    theme: 'dark',
    sidebarOpen: true,
    inspectorOpen: true,
    inspectorWidth: INSPECTOR_DEFAULT_WIDTH,
    dockOpen: false,
    dockView: 'transfers',
    dockHeight: 200,
    showHidden: false,
    commandPaletteOpen: false,
    connectionDialog: { open: false, profile: null },
    hostKeyChallenge: null,
    toasts: [],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('clampInspectorWidth', () => {
  test('exposes the documented bounds', () => {
    expect(INSPECTOR_MIN_WIDTH).toBe(240);
    expect(INSPECTOR_MAX_WIDTH).toBe(680);
    expect(INSPECTOR_DEFAULT_WIDTH).toBeGreaterThanOrEqual(INSPECTOR_MIN_WIDTH);
    expect(INSPECTOR_DEFAULT_WIDTH).toBeLessThanOrEqual(INSPECTOR_MAX_WIDTH);
  });

  test('a comfortable width passes through unchanged', () => {
    expect(clampInspectorWidth(400)).toBe(400);
    expect(clampInspectorWidth(INSPECTOR_DEFAULT_WIDTH)).toBe(INSPECTOR_DEFAULT_WIDTH);
  });

  test('clamps at the minimum end', () => {
    expect(clampInspectorWidth(0)).toBe(INSPECTOR_MIN_WIDTH);
    expect(clampInspectorWidth(-500)).toBe(INSPECTOR_MIN_WIDTH);
    expect(clampInspectorWidth(1)).toBe(INSPECTOR_MIN_WIDTH);
    expect(clampInspectorWidth(239)).toBe(INSPECTOR_MIN_WIDTH);
    expect(clampInspectorWidth(INSPECTOR_MIN_WIDTH)).toBe(INSPECTOR_MIN_WIDTH);
  });

  test('clamps at the maximum end', () => {
    // A wide window pushes the 60% ceiling past the hard maximum, which then binds.
    setWindowSize(2000);
    expect(clampInspectorWidth(INSPECTOR_MAX_WIDTH)).toBe(INSPECTOR_MAX_WIDTH);
    expect(clampInspectorWidth(INSPECTOR_MAX_WIDTH + 1)).toBe(INSPECTOR_MAX_WIDTH);
    expect(clampInspectorWidth(5000)).toBe(INSPECTOR_MAX_WIDTH);
  });

  test('rounds fractional widths', () => {
    expect(clampInspectorWidth(300.4)).toBe(300);
    expect(clampInspectorWidth(300.6)).toBe(301);
  });

  test('never exceeds 60% of the window on a narrow screen', () => {
    // 800 × 0.6 = 480, which is below the 680 hard maximum.
    setWindowSize(800);
    expect(clampInspectorWidth(700)).toBe(480);
    expect(clampInspectorWidth(481)).toBe(480);
    expect(clampInspectorWidth(300)).toBe(300);
  });

  test('the 60% ceiling is rounded, not floored', () => {
    // 1001 × 0.6 = 600.6 → 601.
    setWindowSize(1001);
    expect(clampInspectorWidth(700)).toBe(601);
  });

  test('a tiny window leaves only the minimum width', () => {
    // 300 × 0.6 = 180, which is below the minimum, so the ceiling becomes the floor.
    setWindowSize(300);
    expect(clampInspectorWidth(600)).toBe(INSPECTOR_MIN_WIDTH);
    expect(clampInspectorWidth(10)).toBe(INSPECTOR_MIN_WIDTH);
  });

  test('the ceiling never drops below the minimum', () => {
    // 401 × 0.6 = 240.6 → 241: still above the minimum.
    setWindowSize(401);
    expect(clampInspectorWidth(1000)).toBe(241);
    expect(clampInspectorWidth(100)).toBe(INSPECTOR_MIN_WIDTH);
  });

  test('the hard maximum wins over a very wide window', () => {
    setWindowSize(4000);
    expect(clampInspectorWidth(2000)).toBe(INSPECTOR_MAX_WIDTH);
    expect(clampInspectorWidth(679)).toBe(679);
  });
});

describe('setInspectorWidth', () => {
  test('stores a clamped width and persists the preferences', () => {
    store().setInspectorWidth(700);

    expect(store().inspectorWidth).toBe(614); // 1024 × 0.6
    expect(prefs().inspectorWidth).toBe(614);
  });

  test('resetInspectorWidth returns to the default', () => {
    store().setInspectorWidth(500);
    store().resetInspectorWidth();

    expect(store().inspectorWidth).toBe(INSPECTOR_DEFAULT_WIDTH);
    expect(prefs().inspectorWidth).toBe(INSPECTOR_DEFAULT_WIDTH);
  });

  test('clamping follows the current window size', () => {
    setWindowSize(2000);
    store().setInspectorWidth(700);
    expect(store().inspectorWidth).toBe(680);

    setWindowSize(500);
    store().setInspectorWidth(700);
    expect(store().inspectorWidth).toBe(300); // 500 × 0.6
  });
});

describe('uiStore preferences', () => {
  test('toggles the inspector and sidebar and persists them', () => {
    store().toggleInspector();
    expect(store().inspectorOpen).toBe(false);
    expect(prefs().inspectorOpen).toBe(false);

    store().setInspector(true);
    expect(store().inspectorOpen).toBe(true);

    store().toggleSidebar();
    expect(store().sidebarOpen).toBe(false);
    expect(prefs().sidebarOpen).toBe(false);
  });

  test('showHidden is persisted so the choice survives a reload', () => {
    store().setShowHidden(true);

    expect(store().showHidden).toBe(true);
    expect(prefs().showHidden).toBe(true);
  });

  test('the theme is written to the document and to storage', () => {
    store().setTheme('light');

    expect(store().theme).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(window.localStorage.getItem('ssh-explorer.theme')).toBe('light');

    store().toggleTheme();
    expect(store().theme).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(window.localStorage.getItem('ssh-explorer.theme')).toBe('dark');
  });

  test('the connection dialog opens with defaults and closes clean', () => {
    store().openConnectionDialog();
    expect(store().connectionDialog).toEqual({
      open: true,
      profile: null,
      host: undefined,
      username: undefined,
      port: undefined,
    });

    store().openConnectionDialog({ host: 'web1', username: 'root', port: 2222 });
    expect(store().connectionDialog).toMatchObject({
      open: true,
      profile: null,
      host: 'web1',
      username: 'root',
      port: 2222,
    });

    store().closeConnectionDialog();
    expect(store().connectionDialog).toEqual({ open: false, profile: null });
  });
});

describe('dock state', () => {
  test('toggleDock opens the requested view and closes it when already showing', () => {
    store().toggleDock('terminal');
    expect(store()).toMatchObject({ dockOpen: true, dockView: 'terminal' });

    // Toggling the same view again closes the dock but remembers the view.
    store().toggleDock('terminal');
    expect(store()).toMatchObject({ dockOpen: false, dockView: 'terminal' });

    // A different view opens the dock on that view.
    store().toggleDock('transfers');
    expect(store()).toMatchObject({ dockOpen: true, dockView: 'transfers' });
  });

  test('toggleDock without an argument just flips visibility', () => {
    store().toggleDock();
    expect(store().dockOpen).toBe(true);
    expect(store().dockView).toBe('transfers');

    store().toggleDock();
    expect(store().dockOpen).toBe(false);
  });

  test('setDockView switches the view and opens the dock', () => {
    store().setDockView('terminal');

    expect(store()).toMatchObject({ dockOpen: true, dockView: 'terminal' });
  });

  test('dock height is clamped to 120px and to the window', () => {
    setWindowSize(1024, 768);

    store().setDockHeight(50);
    expect(store().dockHeight).toBe(120);

    store().setDockHeight(10_000);
    expect(store().dockHeight).toBe(508); // 768 - 260

    store().setDockHeight(300.6);
    expect(store().dockHeight).toBe(301);
  });
});

describe('toasts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0));
  });

  test('a toast gets a unique id and the frozen creation time', () => {
    const first = store().pushToast({ level: 'info', title: 'Hello' });
    const second = store().pushToast({ level: 'success', title: 'Done', detail: 'all good' });

    expect(first).toMatch(/^toast-\d+-\d+$/);
    expect(second).not.toBe(first);

    const toasts = store().toasts;
    expect(toasts.map((toast) => toast.title)).toEqual(['Hello', 'Done']);
    expect(toasts[0]?.createdAt).toBe(new Date(2026, 0, 1, 12, 0, 0).getTime());
    expect(toasts[1]?.detail).toBe('all good');
  });

  test('keeps at most five toasts, dropping the oldest', () => {
    for (let index = 1; index <= 6; index += 1) {
      store().pushToast({ level: 'info', title: `toast ${index}` });
    }

    expect(store().toasts.map((toast) => toast.title)).toEqual([
      'toast 2',
      'toast 3',
      'toast 4',
      'toast 5',
      'toast 6',
    ]);
  });

  test('an info toast disappears after five seconds', () => {
    const id = store().pushToast({ level: 'info', title: 'Hello' });

    vi.advanceTimersByTime(4_999);
    expect(store().toasts.map((toast) => toast.id)).toEqual([id]);

    vi.advanceTimersByTime(1);
    expect(store().toasts).toEqual([]);
  });

  test('an error toast is given longer to be read', () => {
    const id = store().pushToast({ level: 'error', title: 'Broken' });

    vi.advanceTimersByTime(5_000);
    expect(store().toasts.map((toast) => toast.id)).toEqual([id]);

    vi.advanceTimersByTime(4_000);
    expect(store().toasts).toEqual([]);
  });

  test('dismissToast removes exactly one toast', () => {
    const first = store().pushToast({ level: 'info', title: 'one' });
    const second = store().pushToast({ level: 'warn', title: 'two' });

    store().dismissToast(first);

    expect(store().toasts.map((toast) => toast.id)).toEqual([second]);

    // Dismissing an unknown or already-dismissed id is harmless.
    store().dismissToast(first);
    expect(store().toasts.map((toast) => toast.id)).toEqual([second]);
  });
});
