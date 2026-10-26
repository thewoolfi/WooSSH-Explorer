import { create } from 'zustand';
import type { HostKeyChallenge, Protocol, SavedProfile } from '../api/types';

export type Theme = 'dark' | 'light';
export type ViewMode = 'list' | 'grid';
export type DockView = 'transfers' | 'terminal';

const THEME_KEY = 'ssh-explorer.theme';
const PREFS_KEY = 'ssh-explorer.prefs';

/** Inspector width bounds, shared by the drag handle and persistence. */
export const INSPECTOR_MIN_WIDTH = 240;
export const INSPECTOR_MAX_WIDTH = 680;
export const INSPECTOR_DEFAULT_WIDTH = 292;

/**
 * Where the application stands with respect to a newer release.
 *
 * A toast would not do: it disappears after five seconds, and an update that waits for a
 * restart is exactly the kind of notice someone needs to find an hour later.
 */
export type UpdatePhase =
  | { phase: 'idle' }
  | { phase: 'checking' }
  /** Newer release exists. `canInstall` is false for the portable build and the browser. */
  | { phase: 'available'; version: string | null; canInstall: boolean; url: string | null }
  | { phase: 'downloading'; version: string | null; percent: number }
  | { phase: 'ready'; version: string | null }
  | { phase: 'error'; message: string };

export interface Toast {
  id: string;
  level: 'info' | 'success' | 'warn' | 'error';
  title: string;
  detail?: string;
  /** Optional inline action, e.g. "Show in folder" after a desktop download. */
  action?: { label: string; run: () => void };
  persistent?: boolean;
  createdAt: number;
}

export interface ConnectionDialogState {  open: boolean;
  profile: SavedProfile | null;
  protocol?: Protocol;
  host?: string;
  username?: string;
  port?: number;
}

interface UiState {
  theme: Theme;
  sidebarOpen: boolean;
  inspectorOpen: boolean;
  inspectorOpenByTab: Record<string, boolean>;
  isInspectorOpen: (tabId?: string | null) => boolean;
  /** Width of the right-hand inspector, in pixels. */
  inspectorWidth: number;
  dockOpen: boolean;
  dockView: DockView;
  dockHeight: number;
  showHidden: boolean;
  /** Terminal font size in pixels; the pane refits when it changes. */
  terminalFontSize: number;
  copyOnSelect: boolean;
  commandPaletteOpen: boolean;
  /** The pinned-host-key manager. */
  knownHostsOpen: boolean;
  /** The `df`/`free`/`uptime` panel for the active connection. */
  serverStatsOpen: boolean;
  /** The per-host probe report. */
  diagnosticsOpen: boolean;
  /** Newer-release state; see {@link UpdatePhase}. */
  update: UpdatePhase;
  /** Ping / traceroute from this machine to a host. */
  netToolsOpen: boolean;
  /** Host the tools open on; the sidebar passes the row's host. */
  netToolsHost: string | null;
  /** Which probe to run the moment the panel opens. */
  netToolsTool: 'ping' | 'traceroute';
  connectionDialog: ConnectionDialogState;
  hostKeyChallenge: HostKeyChallenge | null;
  toasts: Toast[];

  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  toggleSidebar: () => void;
  toggleInspector: (tabId?: string | null) => void;
  setInspector: (open: boolean, tabId?: string | null) => void;
  /** Clamped to the allowed range and to 60% of the window. */
  setInspectorWidth: (width: number) => void;
  resetInspectorWidth: () => void;
  toggleDock: (view?: DockView) => void;
  setDockView: (view: DockView) => void;
  setDockHeight: (height: number) => void;
  setShowHidden: (value: boolean) => void;
  setTerminalFontSize: (size: number) => void;
  setCopyOnSelect: (value: boolean) => void;
  setCommandPalette: (open: boolean) => void;
  setKnownHostsOpen: (open: boolean) => void;
  setServerStatsOpen: (open: boolean) => void;
  setDiagnosticsOpen: (open: boolean) => void;
  setUpdate: (next: UpdatePhase) => void;
  setNetToolsOpen: (open: boolean, host?: string | null, tool?: 'ping' | 'traceroute') => void;
  /** True while a modal owns the screen; global shortcuts stand down. */
  anyOverlayOpen: () => boolean;
  openConnectionDialog: (init?: Partial<ConnectionDialogState>) => void;
  closeConnectionDialog: () => void;
  setHostKeyChallenge: (challenge: HostKeyChallenge | null) => void;
  pushToast: (toast: Omit<Toast, 'id' | 'createdAt'>) => string;
  dismissToast: (id: string) => void;
}

interface Prefs {
  sidebarOpen: boolean;
  inspectorOpen: boolean;
  inspectorWidth: number;
  dockOpen: boolean;
  dockView: DockView;
  dockHeight: number;
  showHidden: boolean;
  terminalFontSize: number;
  copyOnSelect: boolean;
}

function loadPrefs(): Partial<Prefs> {
  try {
    const raw = window.localStorage.getItem(PREFS_KEY);
    return raw ? (JSON.parse(raw) as Partial<Prefs>) : {};
  } catch {
    return {};
  }
}

function savePrefs(state: UiState): void {
  try {
    const prefs: Prefs = {
      sidebarOpen: state.sidebarOpen,
      inspectorOpen: state.inspectorOpen,
      inspectorWidth: state.inspectorWidth,
      dockOpen: state.dockOpen,
      dockView: state.dockView,
      dockHeight: state.dockHeight,
      showHidden: state.showHidden,
      terminalFontSize: state.terminalFontSize,
      copyOnSelect: state.copyOnSelect,
    };
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* private mode */
  }
}

/** Keeps the inspector usable on small windows without letting it eat the table. */
export function clampInspectorWidth(width: number): number {
  const ceiling = Math.min(
    INSPECTOR_MAX_WIDTH,
    Math.max(INSPECTOR_MIN_WIDTH, Math.round(window.innerWidth * 0.6)),
  );
  return Math.min(ceiling, Math.max(INSPECTOR_MIN_WIDTH, Math.round(width)));
}

function initialTheme(): Theme {
  const attr = document.documentElement.dataset.theme;
  if (attr === 'light' || attr === 'dark') return attr;
  return 'dark';
}

const prefs = loadPrefs();

let toastSeq = 0;

export const useUiStore = create<UiState>((set, get) => ({
  theme: initialTheme(),
  sidebarOpen: prefs.sidebarOpen ?? true,
  inspectorOpen: prefs.inspectorOpen ?? true,
  inspectorOpenByTab: {},
  isInspectorOpen: (tabId) => {
    if (tabId && get().inspectorOpenByTab[tabId] !== undefined) {
      return get().inspectorOpenByTab[tabId]!;
    }
    return get().inspectorOpen;
  },
  inspectorWidth:
    typeof prefs.inspectorWidth === 'number'
      ? clampInspectorWidth(prefs.inspectorWidth)
      : INSPECTOR_DEFAULT_WIDTH,
  dockOpen: prefs.dockOpen ?? false,
  dockView: prefs.dockView ?? 'transfers',
  dockHeight: prefs.dockHeight ?? 200,
  showHidden: prefs.showHidden ?? false,
  terminalFontSize: prefs.terminalFontSize ?? 12.5,
  copyOnSelect: prefs.copyOnSelect ?? false,
  commandPaletteOpen: false,
  knownHostsOpen: false,
  serverStatsOpen: false,
  diagnosticsOpen: false,
  update: { phase: 'idle' },
  netToolsOpen: false,
  netToolsHost: null,
  netToolsTool: 'ping',
  connectionDialog: { open: false, profile: null },
  hostKeyChallenge: null,
  toasts: [],

  setTheme: (theme) => {
    document.documentElement.dataset.theme = theme;
    try {
      window.localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* private mode */
    }
    set({ theme });
  },

  toggleTheme: () => get().setTheme(get().theme === 'dark' ? 'light' : 'dark'),

  toggleSidebar: () => {
    set((s) => ({ sidebarOpen: !s.sidebarOpen }));
    savePrefs(get());
  },

  toggleInspector: (tabId) => {
    const s = get();
    if (tabId) {
      const current = s.isInspectorOpen(tabId);
      const next = !current;
      set({
        inspectorOpenByTab: { ...s.inspectorOpenByTab, [tabId]: next },
      });
    } else {
      set((s) => ({ inspectorOpen: !s.inspectorOpen }));
    }
    savePrefs(get());
  },

  setInspector: (open, tabId) => {
    const s = get();
    if (tabId) {
      set({
        inspectorOpenByTab: { ...s.inspectorOpenByTab, [tabId]: open },
      });
    } else {
      set({ inspectorOpen: open });
    }
    savePrefs(get());
  },

  setInspectorWidth: (width) => {
    set({ inspectorWidth: clampInspectorWidth(width) });
    savePrefs(get());
  },

  resetInspectorWidth: () => {
    // Clamped like every other write, so a narrow window cannot end up with an
    // inspector wider than the documented 60% ceiling.
    set({ inspectorWidth: clampInspectorWidth(INSPECTOR_DEFAULT_WIDTH) });
    savePrefs(get());
  },

  toggleDock: (view) => {
    set((s) => ({
      dockOpen: view ? (s.dockOpen && s.dockView === view ? false : true) : !s.dockOpen,
      dockView: view ?? s.dockView,
    }));
    savePrefs(get());
  },

  setDockView: (view) => {
    set({ dockView: view, dockOpen: true });
    savePrefs(get());
  },

  setDockHeight: (height) => {
    set({ dockHeight: Math.max(120, Math.min(window.innerHeight - 260, Math.round(height))) });
    savePrefs(get());
  },

  setShowHidden: (value) => {
    set({ showHidden: value });
    savePrefs(get());
  },

  setTerminalFontSize: (size) => {
    set({ terminalFontSize: Math.min(24, Math.max(9, Math.round(size * 2) / 2)) });
    savePrefs(get());
  },

  setCopyOnSelect: (value) => {
    set({ copyOnSelect: value });
    savePrefs(get());
  },

  setCommandPalette: (open) => set({ commandPaletteOpen: open }),

  setKnownHostsOpen: (open) => set({ knownHostsOpen: open }),

  setServerStatsOpen: (open) => set({ serverStatsOpen: open }),

  setDiagnosticsOpen: (open) => set({ diagnosticsOpen: open }),

  setUpdate: (next) => set({ update: next }),

  setNetToolsOpen: (open, host, tool) =>
    set((s) => ({
      netToolsOpen: open,
      netToolsHost: host === undefined ? s.netToolsHost : host,
      netToolsTool: tool ?? s.netToolsTool,
    })),

  /**
   * True while any modal owns the screen.
   *
   * The Tab key is a global shortcut for walking tabs and panes, but Tab is also how a
   * keyboard user moves between controls — hijacking it inside a dialog would trap them
   * in the first field.
   */
  anyOverlayOpen: () => {
    const s = get();
    return (
      s.commandPaletteOpen ||
      s.knownHostsOpen ||
      s.serverStatsOpen ||
      s.diagnosticsOpen ||
      s.netToolsOpen ||
      s.connectionDialog.open ||
      s.hostKeyChallenge !== null
    );
  },

  openConnectionDialog: (init) =>
    set({
      connectionDialog: {
        open: true,
        profile: init?.profile ?? null,
        protocol: init?.protocol ?? init?.profile?.protocol,
        host: init?.host,
        username: init?.username,
        port: init?.port,
      },
    }),

  closeConnectionDialog: () => set({ connectionDialog: { open: false, profile: null } }),

  setHostKeyChallenge: (challenge) => set({ hostKeyChallenge: challenge }),

  pushToast: (toast) => {
    toastSeq += 1;
    const id = `toast-${Date.now()}-${toastSeq}`;
    set((s) => ({
      toasts: [...s.toasts.slice(-4), { ...toast, id, createdAt: Date.now() }],
    }));
    if (!toast.persistent) {
      const ttl = toast.level === 'error' ? 9000 : 5000;
      window.setTimeout(() => get().dismissToast(id), ttl);
    }
    return id;
  },

  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));
