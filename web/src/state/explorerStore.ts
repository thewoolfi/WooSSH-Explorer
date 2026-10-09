import { create } from 'zustand';
import type { DirectoryListing, FileEntry, FileReadResult } from '../api/types';
import { api, ApiError } from '../api/client';
import { basenameRemotePath, joinRemotePath, normalizeRemotePath, parentRemotePath } from '../lib/path';
import { DEFAULT_SORT, type SortSpec } from '../lib/sort';
import type { ViewMode } from './uiStore';
import { useUiStore } from './uiStore';
import { useConnectionStore } from './connectionStore';

/** How many folders a tab remembers for Back / Forward. */
const HISTORY_LIMIT = 60;

/* ------------------------------------------------------------------------ */
/*  Tab model                                                                */
/* ------------------------------------------------------------------------ */

export interface PreviewState {
  path: string;
  state: 'loading' | 'ready' | 'error';
  data?: FileReadResult;
  error?: string;
}

export interface FilesTab {
  id: string;
  kind: 'files';
  connectionId: string;
  title: string;
  path: string;
  history: string[];
  historyIndex: number;
  listing: DirectoryListing | null;
  loading: boolean;
  error: string | null;
  sort: SortSpec;
  filter: string;
  selection: string[];
  anchor: string | null;
  viewMode: ViewMode;
  searchQuery: string;
  searchResults: FileEntry[] | null;
  searchLoading: boolean;
  searchTruncated: boolean;
  preview: PreviewState | null;
  /**
   * Measured directory sizes, keyed by path. Only populated when the user asks:
   * `du` over a big tree is not something to run on every navigation.
   */
  usage: Record<string, { bytes: number; truncated: boolean }>;
  /** Paths currently being measured, so the UI can show progress. */
  measuring: string[];
}

export interface TerminalTab {
  id: string;
  kind: 'terminal';
  connectionId: string;
  title: string;
  /** Directory the shell is moved into once it is up; `cd` is sent by the pane. */
  cwd?: string;
}

export interface TransfersTab {
  id: string;
  kind: 'transfers';
  connectionId: string | null;
  title: string;
}

export type Tab = FilesTab | TerminalTab | TransfersTab;

/* ------------------------------------------------------------------------ */

interface ExplorerState {
  tabs: Tab[];
  activeTabId: string | null;

  /**
   * Opens a file tab. An existing tab on the same host and folder is reused, which is what
   * navigation wants; `force` creates another one, which is what the tab strip's "+" means.
   */
  openFilesTab: (connectionId: string, path: string, options?: { force?: boolean }) => string;
  openTerminalTab: (connectionId: string, label: string, cwd?: string) => string;
  openTransfersTab: () => string;
  closeTab: (id: string) => void;
  closeTabsForConnection: (connectionId: string) => void;
  activateTab: (id: string) => void;
  /**
   * Two panes side by side in one window, as a two-panel file manager does it. `null`
   * means the ordinary single-pane mode. `activeTabId` is always the focused pane.
   */
  split: { leftId: string; rightId: string } | null;
  /** Enters split mode with a second pane, or leaves it. */
  toggleSplit: () => void;
  /** Moves focus to the other pane; a no-op outside split mode. */
  focusOtherPane: () => void;
  /** Next (`+1`) or previous (`-1`) tab, wrapping around. */
  cycleTab: (delta: number) => void;
  setViewMode: (id: string, mode: ViewMode) => void;

  navigate: (id: string, path: string, options?: { replace?: boolean; index?: number }) => Promise<void>;
  /** Moves to an existing history entry without pushing a new one. */
  travel: (id: string, index: number) => Promise<void>;
  back: (id: string) => Promise<void>;
  forward: (id: string) => Promise<void>;
  up: (id: string) => Promise<void>;
  refresh: (id: string) => Promise<void>;
  refreshConnection: (connectionId: string) => void;

  setSort: (id: string, sort: SortSpec) => void;
  setFilter: (id: string, filter: string) => void;

  /**
   * Selects an entry. `order` is the list of paths exactly as the view shows them,
   * and range selection runs over it — so shift-click selects the run the user can
   * see whether the list is sorted, filtered or a set of search hits.
   */
  select: (id: string, path: string, mode: 'replace' | 'toggle' | 'range', order?: string[]) => void;
  /** Selects exactly the rows the view is showing. */
  selectAll: (id: string, order?: string[]) => void;
  clearSelection: (id: string) => void;

  loadPreview: (id: string, path: string) => Promise<void>;
  /**
   * Measures the given directories with `fs/usage` and caches the answers on the tab.
   * One request for the whole batch, so "how big is everything in this folder" costs one
   * round trip rather than one per row.
   */
  measureUsage: (id: string, paths: string[]) => Promise<void>;

  runSearch: (id: string, query: string) => Promise<void>;
  clearSearch: (id: string) => void;

  createFolder: (id: string, name: string) => Promise<void>;
  renameEntry: (id: string, from: string, newName: string) => Promise<void>;
  deleteEntries: (id: string, paths: string[]) => Promise<void>;
  chmodEntry: (id: string, path: string, mode: string) => Promise<void>;
  touchEntry: (id: string, path: string) => Promise<void>;
}

let seq = 0;
function nextId(prefix: string): string {
  seq += 1;
  return `${prefix}-${seq}`;
}

function makeFilesTab(connectionId: string, path: string): FilesTab {
  const normalized = normalizeRemotePath(path || '/');
  return {
    id: nextId('tab'),
    kind: 'files',
    connectionId,
    title: basenameRemotePath(normalized),
    path: normalized,
    history: [normalized],
    historyIndex: 0,
    listing: null,
    loading: false,
    error: null,
    sort: { ...DEFAULT_SORT },
    filter: '',
    selection: [],
    anchor: null,
    viewMode: 'list',
    searchQuery: '',
    searchResults: null,
    searchLoading: false,
    searchTruncated: false,
    preview: null,
    usage: {},
    measuring: [],
  };
}

/** Immutably patches one tab, leaving the rest untouched. */
function patchTab<T extends Tab>(tabs: Tab[], id: string, patch: (tab: T) => T): Tab[] {
  return tabs.map((tab) => (tab.id === id ? patch(tab as T) : tab));
}

function toMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

export const useExplorerStore = create<ExplorerState>((set, get) => ({
  tabs: [],
  activeTabId: null,
  split: null,

  openFilesTab: (connectionId, path, options) => {
    const normalized = normalizeRemotePath(path || '/');
    // Reuse an existing tab that already points at this connection + path.
    const existing = options?.force
      ? undefined
      : get().tabs.find(
          (tab): tab is FilesTab =>
            tab.kind === 'files' && tab.connectionId === connectionId && tab.path === normalized,
        );
    if (existing) {
      set({ activeTabId: existing.id });
      return existing.id;
    }
    const tab = makeFilesTab(connectionId, normalized);
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
    void get().navigate(tab.id, normalized, { replace: true });
    return tab.id;
  },

  openTerminalTab: (connectionId, label, cwd) => {
    const existing = get().tabs.filter(
      (tab) => tab.kind === 'terminal' && tab.connectionId === connectionId,
    ).length;
    // A shell opened "here" is named after the folder, so several of them are
    // distinguishable in the tab strip.
    const where = cwd ? (cwd === '/' ? '/' : (cwd.split('/').filter(Boolean).pop() ?? '/')) : null;
    const suffix = where ? ` — ${where}` : ` — ${label}`;
    const tab: TerminalTab = {
      id: nextId('term'),
      kind: 'terminal',
      connectionId,
      title: existing === 0 ? `shell${suffix}` : `shell ${existing + 1}${suffix}`,
      ...(cwd ? { cwd } : {}),
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
    return tab.id;
  },

  openTransfersTab: () => {
    const existing = get().tabs.find((tab) => tab.kind === 'transfers');
    if (existing) {
      set({ activeTabId: existing.id });
      return existing.id;
    }
    const tab: TransfersTab = {
      id: nextId('xfer'),
      kind: 'transfers',
      connectionId: null,
      title: 'Transfers',
    };
    set((s) => ({ tabs: [...s.tabs, tab], activeTabId: tab.id }));
    return tab.id;
  },

  closeTab: (id) => {
    set((s) => {
      const index = s.tabs.findIndex((tab) => tab.id === id);
      if (index < 0) return s;
      const tabs = s.tabs.filter((tab) => tab.id !== id);
      let activeTabId = s.activeTabId;
      if (activeTabId === id) {
        const neighbour = tabs[Math.min(index, tabs.length - 1)];
        activeTabId = neighbour ? neighbour.id : null;
      }
      // A split cannot outlive one of its panes: closing a member drops back to one view.
      let split = s.split;
      if (split && (split.leftId === id || split.rightId === id)) split = null;
      return { tabs, activeTabId, split };
    });
  },

  closeTabsForConnection: (connectionId) => {
    set((s) => {
      const tabs = s.tabs.filter((tab) => tab.connectionId !== connectionId);
      const activeTabId = tabs.some((t) => t.id === s.activeTabId)
        ? s.activeTabId
        : (tabs[0]?.id ?? null);
      const split =
        s.split && tabs.some((t) => t.id === s.split?.leftId) && tabs.some((t) => t.id === s.split?.rightId)
          ? s.split
          : null;
      return { tabs, activeTabId, split };
    });
  },

  activateTab: (id) =>
    set((s) => {
      const tab = s.tabs.find((candidate) => candidate.id === id);
      // A tab belongs to a host, and the whole window context follows it: the status bar,
      // the inspector's "Folder on …" and the host menu all read the active connection.
      // Switching tabs without switching hosts left them describing the wrong server.
      if (tab && tab.connectionId !== null) {
        const connection = useConnectionStore.getState();
        if (connection.activeId !== tab.connectionId) connection.setActive(tab.connectionId);
      }
      // In split mode a click on a tab outside the pair replaces the focused pane's tab,
      // which is what a two-panel file manager does; a click on either member just focuses it.
      if (s.split && id !== s.split.leftId && id !== s.split.rightId) {
        const focusedIsLeft = s.activeTabId === s.split.leftId;
        return {
          activeTabId: id,
          split: focusedIsLeft ? { leftId: id, rightId: s.split.rightId } : { leftId: s.split.leftId, rightId: id },
        };
      }
      return { activeTabId: id };
    }),

  toggleSplit: () => {
    const state = get();
    if (state.split) {
      set({ split: null });
      return;
    }
    const active = state.tabs.find((tab) => tab.id === state.activeTabId);
    if (!active) return;

    // Prefer a tab that already exists — seeing two folders at once is the point.
    const partner =
      state.tabs.find((tab) => tab.id !== active.id && tab.kind === 'files') ??
      state.tabs.find((tab) => tab.id !== active.id);
    if (partner) {
      set({ split: { leftId: active.id, rightId: partner.id } });
      return;
    }

    // Nothing else is open: give the second pane the same folder, ready to be navigated
    // away from. Splitting an empty workspace into one pane would be pointless.
    if (active.kind !== 'files' || active.connectionId === null) {
      set({ split: null });
      return;
    }
    const connectionId = active.connectionId;
    const path = active.path;
    const previousId = active.id;
    // `openFilesTab` focuses the tab it creates, so the original pane is re-focused after.
    const createdId = get().openFilesTab(connectionId, path, { force: true });
    set({ activeTabId: previousId, split: { leftId: previousId, rightId: createdId } });
  },

  focusOtherPane: () =>
    set((s) => {
      if (!s.split) return s;
      const next = s.activeTabId === s.split.leftId ? s.split.rightId : s.split.leftId;
      // The other pane belongs to a host as well, so the window context follows the focus.
      const tab = s.tabs.find((candidate) => candidate.id === next);
      if (tab && tab.connectionId !== null) {
        const connection = useConnectionStore.getState();
        if (connection.activeId !== tab.connectionId) connection.setActive(tab.connectionId);
      }
      return { activeTabId: next };
    }),

  cycleTab: (delta) =>
    set((s) => {
      if (s.tabs.length < 2 || s.activeTabId === null) return s;
      const index = s.tabs.findIndex((tab) => tab.id === s.activeTabId);
      if (index < 0) return s;
      const next = s.tabs[(index + delta + s.tabs.length) % s.tabs.length];
      const tab = next;
      if (tab && tab.connectionId !== null) {
        const connection = useConnectionStore.getState();
        if (connection.activeId !== tab.connectionId) connection.setActive(tab.connectionId);
      }
      return { activeTabId: tab ? tab.id : s.activeTabId };
    }),

  setViewMode: (id, mode) => set((s) => ({ tabs: patchTab<FilesTab>(s.tabs, id, (t) => ({ ...t, viewMode: mode })) })),

  navigate: async (id, path, options) => {
    const target = normalizeRemotePath(path);
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab || tab.kind !== 'files') return;

    set((s) => ({
      tabs: patchTab<FilesTab>(s.tabs, id, (t) => {
        // Three distinct cases, and conflating them is what used to corrupt the
        // history: `index` travels to an existing entry without touching the
        // array, `replace` overwrites the current entry (refresh), and a plain
        // navigation truncates the forward entries and appends.
        let history = t.history;
        let historyIndex = t.historyIndex;
        if (options?.index !== undefined) {
          historyIndex = Math.max(0, Math.min(options.index, t.history.length - 1));
        } else if (options?.replace) {
          history = [...t.history];
          history[historyIndex] = target;
        } else {
          history = [...t.history.slice(0, t.historyIndex + 1), target];
          if (history.length > HISTORY_LIMIT) {
            history = history.slice(history.length - HISTORY_LIMIT);
          }
          historyIndex = history.length - 1;
        }
        return {
          ...t,
          path: target,
          title: basenameRemotePath(target),
          loading: true,
          error: null,
          selection: [],
          anchor: null,
          preview: null,
          searchResults: null,
          searchQuery: '',
          searchLoading: false,
          searchTruncated: false,
          history,
          historyIndex,
        };
      }),
    }));

    try {
      const { listing } = await api.list(tab.connectionId, target);
      set((s) => ({
        tabs: patchTab<FilesTab>(s.tabs, id, (t) => ({
          ...t,
          listing,
          path: listing.path,
          title: basenameRemotePath(listing.path),
          loading: false,
          error: null,
        })),
      }));
    } catch (error) {
      set((s) => ({
        tabs: patchTab<FilesTab>(s.tabs, id, (t) => ({
          ...t,
          loading: false,
          error: toMessage(error),
        })),
      }));
    }
  },

  /** Moves to another entry of the history without rewriting it. */
  travel: async (id, index) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab || tab.kind !== 'files') return;
    if (index < 0 || index >= tab.history.length || index === tab.historyIndex) return;
    const target = tab.history[index];
    if (!target) return;
    await get().navigate(id, target, { index });
  },

  back: async (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab || tab.kind !== 'files') return;
    await get().travel(id, tab.historyIndex - 1);
  },

  forward: async (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab || tab.kind !== 'files') return;
    await get().travel(id, tab.historyIndex + 1);
  },

  up: async (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab || tab.kind !== 'files') return;
    const parent = tab.listing?.parent ?? parentRemotePath(tab.path);
    if (!parent) return;
    await get().navigate(id, parent);
  },

  refresh: async (id) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab || tab.kind !== 'files') return;
    // A refresh reloads the listing in place: history, path, selection and the
    // open preview all survive, which is what F5 is expected to do.
    set((s) => ({ tabs: patchTab<FilesTab>(s.tabs, id, (t) => ({ ...t, loading: true, error: null })) }));

    try {
      const { listing } = await api.list(tab.connectionId, tab.path);
      set((s) => ({
        tabs: patchTab<FilesTab>(s.tabs, id, (t) => {
          const present = new Set(listing.entries.map((entry) => entry.path));
          const preview =
            t.preview && present.has(t.preview.path) ? t.preview : null;
          return {
            ...t,
            listing,
            path: listing.path,
            title: basenameRemotePath(listing.path),
            loading: false,
            error: null,
            // Keep whatever is still there rather than dropping the selection.
            selection: t.selection.filter((p) => present.has(p)),
            preview,
          };
        }),
      }));

      const refreshed = get().tabs.find((t) => t.id === id);
      if (refreshed?.kind === 'files') {
        if (refreshed.preview) void get().loadPreview(id, refreshed.preview.path);
        if (refreshed.searchQuery) {
          void get().runSearch(id, refreshed.searchQuery);
        }
      }
    } catch (error) {
      set((s) => ({
        tabs: patchTab<FilesTab>(s.tabs, id, (t) => ({ ...t, loading: false, error: toMessage(error) })),
      }));
    }
  },

  refreshConnection: (connectionId) => {
    for (const tab of get().tabs) {
      if (tab.kind === 'files' && tab.connectionId === connectionId) {
        void get().refresh(tab.id);
      }
    }
  },

  setSort: (id, sort) => set((s) => ({ tabs: patchTab<FilesTab>(s.tabs, id, (t) => ({ ...t, sort })) })),
  setFilter: (id, filter) => set((s) => ({ tabs: patchTab<FilesTab>(s.tabs, id, (t) => ({ ...t, filter })) })),


  select: (id, path, mode, order) => {
    set((s) => ({
      tabs: patchTab<FilesTab>(s.tabs, id, (tab) => {
        if (mode === 'replace') return { ...tab, selection: [path], anchor: path };
        if (mode === 'toggle') {
          const has = tab.selection.includes(path);
          return {
            ...tab,
            selection: has ? tab.selection.filter((p) => p !== path) : [...tab.selection, path],
            anchor: path,
          };
        }
        // Range over the order the view is showing. The view passes it in, so a
        // sorted, filtered or searched list ranges exactly as it reads; the stored
        // order (and then the raw listing) are only fallbacks for callers that
        // have no view yet.
        const sequence = order && order.length > 0 ? order : null;
        const anchor = tab.anchor ?? path;
        const list = sequence;
        if (list) {
          const from = list.indexOf(anchor);
          const to = list.indexOf(path);
          if (from < 0 || to < 0) return { ...tab, selection: [path], anchor: path };
          const [lo, hi] = from <= to ? [from, to] : [to, from];
          return { ...tab, selection: list.slice(lo, hi + 1), anchor };
        }

        const entries = tab.listing?.entries ?? [];
        const from = entries.findIndex((e) => e.path === anchor);
        const to = entries.findIndex((e) => e.path === path);
        if (from < 0 || to < 0) return { ...tab, selection: [path], anchor: path };
        const [lo, hi] = from <= to ? [from, to] : [to, from];
        return {
          ...tab,
          selection: entries.slice(lo, hi + 1).map((e) => e.path),
          anchor,
        };
      }),
    }));
  },

  selectAll: (id, order) => {
    set((s) => ({
      tabs: patchTab<FilesTab>(s.tabs, id, (tab) => ({
        ...tab,
        // Whatever the view is showing: Ctrl+A must not sweep up rows the filter
        // or the dotfile toggle is hiding.
        selection:
          order && order.length > 0
            ? [...order]
            : (tab.searchResults ?? tab.listing?.entries ?? []).map((e) => e.path),
      })),
    }));
  },

  clearSelection: (id) =>
    set((s) => ({ tabs: patchTab<FilesTab>(s.tabs, id, (t) => ({ ...t, selection: [], anchor: null })) })),

  loadPreview: async (id, path) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab || tab.kind !== 'files') return;
    set((s) => ({
      tabs: patchTab<FilesTab>(s.tabs, id, (t) => ({
        ...t,
        preview: { path, state: 'loading' },
      })),
    }));
    try {
      const data = await api.read(tab.connectionId, path);
      set((s) => ({
        tabs: patchTab<FilesTab>(s.tabs, id, (t) =>
          t.preview?.path === path ? { ...t, preview: { path, state: 'ready', data } } : t,
        ),
      }));
    } catch (error) {
      set((s) => ({
        tabs: patchTab<FilesTab>(s.tabs, id, (t) =>
          t.preview?.path === path
            ? { ...t, preview: { path, state: 'error', error: toMessage(error) } }
            : t,
        ),
      }));
    }
  },

  measureUsage: async (id, paths) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab || tab.kind !== 'files' || paths.length === 0) return;

    set((s) => ({
      tabs: patchTab<FilesTab>(s.tabs, id, (t) => ({ ...t, measuring: [...new Set([...t.measuring, ...paths])] })),
    }));

    try {
      const { usage } = await api.usage(tab.connectionId, paths);
      set((s) => ({
        tabs: patchTab<FilesTab>(s.tabs, id, (t) => {
          const next = { ...t.usage };
          for (const item of usage) next[item.path] = { bytes: item.bytes, truncated: item.truncated };
          return { ...t, usage: next, measuring: t.measuring.filter((p) => !paths.includes(p)) };
        }),
      }));
    } catch (error) {
      set((s) => ({
        tabs: patchTab<FilesTab>(s.tabs, id, (t) => ({
          ...t,
          measuring: t.measuring.filter((p) => !paths.includes(p)),
        })),
      }));
      useUiStore.getState().pushToast({
        level: 'error',
        title: 'Could not measure the folder size',
        detail: toMessage(error),
      });
    }
  },

  runSearch: async (id, query) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab || tab.kind !== 'files') return;
    if (!query.trim()) {
      get().clearSearch(id);
      return;
    }
    set((s) => ({
      tabs: patchTab<FilesTab>(s.tabs, id, (t) => ({ ...t, searchLoading: true, searchQuery: query })),
    }));
    try {
      const result = await api.search(tab.connectionId, tab.path, query.trim());
      set((s) => ({
        tabs: patchTab<FilesTab>(s.tabs, id, (t) =>
          t.searchQuery === query
            ? {
                ...t,
                searchResults: result.results,
                searchTruncated: result.truncated,
                searchLoading: false,
                selection: [],
              }
            : t,
        ),
      }));
    } catch (error) {
      set((s) => ({
        tabs: patchTab<FilesTab>(s.tabs, id, (t) => ({
          ...t,
          searchLoading: false,
          searchResults: [],
          error: toMessage(error),
        })),
      }));
    }
  },

  clearSearch: (id) =>
    set((s) => ({
      tabs: patchTab<FilesTab>(s.tabs, id, (t) => ({
        ...t,
        searchQuery: '',
        searchResults: null,
        searchLoading: false,
        searchTruncated: false,
      })),
    })),

  createFolder: async (id, name) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab || tab.kind !== 'files') return;
    const target = joinRemotePath(tab.path, name);
    await api.mkdir(tab.connectionId, target);
    await get().refresh(id);
  },

  renameEntry: async (id, from, newName) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab || tab.kind !== 'files') return;
    const parent = parentRemotePath(from) ?? tab.path;
    const target = joinRemotePath(parent, newName);
    if (target === from) return;
    await api.rename(tab.connectionId, from, target);
    await get().refresh(id);
  },

  deleteEntries: async (id, paths) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab || tab.kind !== 'files' || paths.length === 0) return;
    const result = await api.remove(tab.connectionId, paths, true);
    if (result.failed.length > 0) {
      throw new ApiError(
        200,
        'PARTIAL',
        `${result.failed.length} of ${paths.length} items could not be deleted.`,
        { failed: result.failed },
      );
    }
    await get().refresh(id);
  },

  chmodEntry: async (id, path, mode) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab || tab.kind !== 'files') return;
    await api.chmod(tab.connectionId, path, mode);
    await get().refresh(id);
  },

  touchEntry: async (id, path) => {
    const tab = get().tabs.find((t) => t.id === id);
    if (!tab || tab.kind !== 'files') return;
    await api.touch(tab.connectionId, path);
    await get().refresh(id);
  },
}));

export function selectActiveTab(state: ExplorerState): Tab | null {
  return state.tabs.find((tab) => tab.id === state.activeTabId) ?? null;
}

export function isFilesTab(tab: Tab | null): tab is FilesTab {
  return tab?.kind === 'files';
}

/** Entries currently visible in a tab, after search takes over. */
export function visibleEntries(tab: FilesTab): FileEntry[] {
  return tab.searchResults ?? tab.listing?.entries ?? [];
}
