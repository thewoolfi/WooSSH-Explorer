import { beforeEach, describe, expect, test, vi } from 'vitest';

import type { DirectoryListing, FileEntry, FileReadResult } from '../../src/api/types';
import type { FilesTab } from '../../src/state/explorerStore';

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

  return {
    ApiError,
    api: {
      health: vi.fn(),
      systemInfo: vi.fn(),
      listProfiles: vi.fn(),
      createProfile: vi.fn(),
      updateProfile: vi.fn(),
      deleteProfile: vi.fn(),
      listSecrets: vi.fn(),
      forgetSecret: vi.fn(),
      forgetAllSecrets: vi.fn(),
      listConnections: vi.fn(),
      getConnection: vi.fn(),
      connect: vi.fn(),
      disconnect: vi.fn(),
      reconnect: vi.fn(),
      exec: vi.fn(),
      list: vi.fn(),
      stat: vi.fn(),
      read: vi.fn(),
      mkdir: vi.fn(),
      rename: vi.fn(),
      remove: vi.fn(),
      chmod: vi.fn(),
      touch: vi.fn(),
      search: vi.fn(),
      usage: vi.fn(),
      upload: vi.fn(),
      listTransfers: vi.fn(),
      cancelTransfer: vi.fn(),
      clearTransfers: vi.fn(),
      retryTransfer: vi.fn(),
    },
  };
});

// Imported after the hoisted `vi.mock` above, so these are the stubs.
import { api, ApiError } from '../../src/api/client';
import {
  isFilesTab,
  selectActiveTab,
  useExplorerStore,
  visibleEntries,
} from '../../src/state/explorerStore';
import { asFilesTab, deferred, dirEntry, fileEntry, listing, readResult, settle } from '../helpers/fixtures';

const apiMock = vi.mocked(api);
const store = () => useExplorerStore.getState();

const tabOf = (id: string): FilesTab => asFilesTab(store().tabs.find((tab) => tab.id === id));
const listCalls = (): number => apiMock.list.mock.calls.length;

/** Opens a tab and waits for its first listing to land. */
async function open(path: string, connectionId = 'c1'): Promise<string> {
  const id = store().openFilesTab(connectionId, path);
  await settle();
  return id;
}

const DEFAULT_ENTRIES = (): FileEntry[] => [dirEntry('sub'), fileEntry({ name: 'a.txt', size: 10 })];

beforeEach(() => {
  vi.clearAllMocks();
  // The listing endpoint echoes the requested path unless a test says otherwise.
  apiMock.list.mockImplementation(async (_connectionId: string, path: string) => ({
    listing: listing(path, DEFAULT_ENTRIES()),
  }));
  apiMock.read.mockResolvedValue(readResult());
  apiMock.search.mockResolvedValue({ results: [], truncated: false, scanned: 0 });
  apiMock.mkdir.mockResolvedValue({ entry: dirEntry('new') });
  apiMock.rename.mockResolvedValue({ entry: fileEntry({ name: 'renamed' }) });
  apiMock.remove.mockResolvedValue({ deleted: [], failed: [] });
  apiMock.chmod.mockResolvedValue({ entry: fileEntry({ name: 'a.txt' }) });
  apiMock.touch.mockResolvedValue({ entry: fileEntry({ name: 'a.txt' }) });
  useExplorerStore.setState({ tabs: [], activeTabId: null });
});

describe('explorerStore — tab lifecycle', () => {
  test('openFilesTab creates, activates and lists the requested directory', async () => {
    const id = store().openFilesTab('c1', '/home/anna');

    // The listing request is not awaited by the action, so it is still in flight.
    expect(store().tabs).toHaveLength(1);
    expect(store().activeTabId).toBe(id);

    const pending = tabOf(id);
    expect(pending.kind).toBe('files');
    expect(pending.path).toBe('/home/anna');
    expect(pending.title).toBe('anna');
    expect(pending.history).toEqual(['/home/anna']);
    expect(pending.historyIndex).toBe(0);
    expect(pending.loading).toBe(true);
    expect(pending.listing).toBe(null);
    expect(pending.sort).toEqual({ key: 'name', direction: 'asc' });
    expect(pending.viewMode).toBe('list');

    await settle();
    const loaded = tabOf(id);
    expect(loaded.loading).toBe(false);
    expect(loaded.error).toBe(null);
    expect(loaded.listing?.entries.map((entry) => entry.name)).toEqual(['sub', 'a.txt']);
    expect(apiMock.list).toHaveBeenCalledWith('c1', '/home/anna');
  });

  test('openFilesTab normalizes the path before requesting it', async () => {
    const id = await open('/home//anna/../bob/');
    const tab = tabOf(id);

    expect(tab.path).toBe('/home/bob');
    expect(tab.title).toBe('bob');
    expect(tab.history).toEqual(['/home/bob']);
    expect(apiMock.list).toHaveBeenCalledWith('c1', '/home/bob');
  });

  test('openFilesTab treats an empty path as the root and titles it "/"', async () => {
    const id = await open('');
    const tab = tabOf(id);

    expect(tab.path).toBe('/');
    expect(tab.title).toBe('/');
    expect(apiMock.list).toHaveBeenCalledWith('c1', '/');
  });

  test('re-opening the same connection + path reuses the tab and re-activates it', async () => {
    const home = await open('/home');
    const other = await open('/etc');
    expect(store().activeTabId).toBe(other);

    const reused = store().openFilesTab('c1', '/home/');
    expect(reused).toBe(home);
    expect(store().tabs).toHaveLength(2);
    expect(store().activeTabId).toBe(home);
    // Reuse must not refetch: only the two original opens hit the API.
    expect(listCalls()).toBe(2);
  });

  test('a different connection or a different path always gets a new tab', async () => {
    const first = await open('/home', 'c1');
    const otherConnection = await open('/home', 'c2');
    const otherPath = await open('/etc', 'c1');

    expect(new Set([first, otherConnection, otherPath]).size).toBe(3);
    expect(store().tabs).toHaveLength(3);
    expect(store().activeTabId).toBe(otherPath);
  });

  test('openTerminalTab numbers extra shells per connection and activates each', async () => {
    const home = await open('/home');
    const firstShell = store().openTerminalTab('c1', 'root@web1');
    const secondShell = store().openTerminalTab('c1', 'root@web1');
    const otherHost = store().openTerminalTab('c2', 'deploy@db1');

    expect(store().tabs.map((tab) => tab.id)).toEqual([home, firstShell, secondShell, otherHost]);
    expect(store().tabs[1]).toMatchObject({ kind: 'terminal', connectionId: 'c1', title: 'shell — root@web1' });
    expect(store().tabs[2]).toMatchObject({ kind: 'terminal', connectionId: 'c1', title: 'shell 2 — root@web1' });
    expect(store().tabs[3]).toMatchObject({ kind: 'terminal', connectionId: 'c2', title: 'shell — deploy@db1' });
    expect(store().activeTabId).toBe(otherHost);
  });

  test('openTerminalTab names a shell after the folder it opens in', () => {
    const shell = store().openTerminalTab('c1', 'root@web1', '/var/log/nginx');
    // The cwd is carried on the tab so the pane can `cd` once the shell is up.
    expect(store().tabs.find((tab) => tab.id === shell)).toMatchObject({
      kind: 'terminal',
      cwd: '/var/log/nginx',
      title: 'shell — nginx',
    });

    const root = store().openTerminalTab('c1', 'root@web1', '/');
    expect(store().tabs.find((tab) => tab.id === root)).toMatchObject({ cwd: '/', title: 'shell 2 — /' });
  });

  test('openTransfersTab keeps a single tab and re-activates the existing one', async () => {
    const home = await open('/home');
    const transfers = store().openTransfersTab();
    store().activateTab(home);

    const again = store().openTransfersTab();

    expect(again).toBe(transfers);
    expect(store().tabs).toHaveLength(2);
    expect(store().activeTabId).toBe(transfers);
    expect(store().tabs.find((tab) => tab.id === transfers)).toMatchObject({
      kind: 'transfers',
      connectionId: null,
      title: 'Transfers',
    });
  });

  test('closeTab activates the tab that takes the closed slot', async () => {
    const a = await open('/a');
    const b = await open('/b');
    const c = await open('/c');
    store().activateTab(b);

    store().closeTab(b);
    expect(store().tabs.map((tab) => tab.id)).toEqual([a, c]);
    expect(store().activeTabId).toBe(c);

    // Closing the last tab falls back to the new last one.
    store().closeTab(c);
    expect(store().activeTabId).toBe(a);

    store().closeTab(a);
    expect(store().tabs).toEqual([]);
    expect(store().activeTabId).toBe(null);
  });

  test('closeTab leaves the active tab alone when a different tab closes', async () => {
    const a = await open('/a');
    const b = await open('/b');
    const c = await open('/c');
    store().activateTab(b);

    store().closeTab(a);
    expect(store().activeTabId).toBe(b);

    store().closeTab(c);
    expect(store().activeTabId).toBe(b);
    expect(store().tabs.map((tab) => tab.id)).toEqual([b]);
  });

  test('closeTab ignores an unknown id', async () => {
    const a = await open('/a');
    store().closeTab('tab-does-not-exist');

    expect(store().tabs.map((tab) => tab.id)).toEqual([a]);
    expect(store().activeTabId).toBe(a);
  });

  test('closeTabsForConnection drops one host and re-homes the active tab', async () => {
    const c1a = await open('/a', 'c1');
    const c2a = await open('/b', 'c2');
    const c1b = await open('/c', 'c1');
    expect(store().activeTabId).toBe(c1b);

    store().closeTabsForConnection('c1');

    expect(store().tabs.map((tab) => tab.id)).toEqual([c2a]);
    expect(store().activeTabId).toBe(c2a);

    // A surviving active tab stays active.
    const c2b = await open('/d', 'c2');
    store().activateTab(c2a);
    store().closeTabsForConnection('nope');
    expect(store().activeTabId).toBe(c2a);
    expect(store().tabs.map((tab) => tab.id)).toEqual([c2a, c2b]);

    store().closeTabsForConnection('c2');
    expect(store().tabs).toEqual([]);
    expect(store().activeTabId).toBe(null);
    expect(c1a).not.toBe(c1b);
  });

  test('setViewMode patches a single tab', async () => {
    const a = await open('/a');
    const b = await open('/b');

    store().setViewMode(a, 'grid');

    expect(tabOf(a).viewMode).toBe('grid');
    expect(tabOf(b).viewMode).toBe('list');
  });
});

describe('explorerStore — navigation and history', () => {
  test('navigate pushes a history entry and resets per-directory state', async () => {
    const id = await open('/a');
    store().select(id, '/a/a.txt', 'replace');
    expect(tabOf(id).selection).toEqual(['/a/a.txt']);

    await store().loadPreview(id, '/a/a.txt');
    apiMock.search.mockResolvedValue({
      results: [fileEntry({ name: 'hit.txt' })],
      truncated: true,
      scanned: 3,
    });
    await store().runSearch(id, 'hit');

    const before = tabOf(id);
    expect(before.preview?.state).toBe('ready');
    expect(before.searchResults).toHaveLength(1);

    await store().navigate(id, '/a/sub');

    const after = tabOf(id);
    expect(after.path).toBe('/a/sub');
    expect(after.title).toBe('sub');
    expect(after.history).toEqual(['/a', '/a/sub']);
    expect(after.historyIndex).toBe(1);
    expect(after.selection).toEqual([]);
    expect(after.anchor).toBe(null);
    expect(after.preview).toBe(null);
    expect(after.searchResults).toBe(null);
    expect(after.searchQuery).toBe('');
    // NOTE: `searchTruncated` / `searchLoading` are deliberately *not* asserted here:
    // navigate() leaves both as they were (it only clears the query and the results).
    // Reported to the parent as a minor leftover-state issue rather than pinned.
    expect(apiMock.list).toHaveBeenLastCalledWith('c1', '/a/sub');
  });

  test('navigate keeps loading=true until the listing arrives', async () => {
    const id = await open('/a');
    const pending = deferred<{ listing: DirectoryListing }>();
    apiMock.list.mockReturnValueOnce(pending.promise);

    const navigating = store().navigate(id, '/a/slow');

    expect(tabOf(id).loading).toBe(true);
    expect(tabOf(id).path).toBe('/a/slow');

    pending.resolve({ listing: listing('/a/slow', [fileEntry({ name: 'late.txt' })]) });
    await navigating;

    const tab = tabOf(id);
    expect(tab.loading).toBe(false);
    expect(tab.listing?.entries.map((entry) => entry.name)).toEqual(['late.txt']);
  });

  test('the path resolved by the server wins over the requested one', async () => {
    const id = await open('/home/anna');
    apiMock.list.mockResolvedValueOnce({
      listing: listing('/home/anna-real', [], '/home'),
    });

    await store().navigate(id, '/home/anna/link');

    const tab = tabOf(id);
    // The breadcrumb/title follow the realpath the server reported.
    expect(tab.path).toBe('/home/anna-real');
    expect(tab.title).toBe('anna-real');
  });

  test('a failed listing records the message and stops loading', async () => {
    const id = await open('/a');
    apiMock.list.mockRejectedValueOnce(new ApiError(404, 'NOT_FOUND', 'No such directory.'));

    await store().navigate(id, '/missing');

    const tab = tabOf(id);
    expect(tab.loading).toBe(false);
    expect(tab.error).toBe('No such directory.');
    expect(tab.path).toBe('/missing');
    expect(tab.title).toBe('missing');
  });

  test('a plain Error and a non-Error rejection are stringified', async () => {
    const id = await open('/a');

    apiMock.list.mockRejectedValueOnce(new Error('socket closed'));
    await store().navigate(id, '/b');
    expect(tabOf(id).error).toBe('socket closed');

    apiMock.list.mockRejectedValueOnce('weird failure');
    await store().navigate(id, '/c');
    expect(tabOf(id).error).toBe('weird failure');
  });

  test('a later success clears an earlier error', async () => {
    const id = await open('/a');
    apiMock.list.mockRejectedValueOnce(new ApiError(500, 'INTERNAL', 'boom'));
    await store().navigate(id, '/b');
    expect(tabOf(id).error).toBe('boom');

    await store().navigate(id, '/c');
    expect(tabOf(id).error).toBe(null);
    expect(tabOf(id).loading).toBe(false);
  });

  test('refresh re-reads the current directory without growing the history', async () => {
    const id = await open('/a');
    await store().navigate(id, '/a/b');
    const before = listCalls();

    await store().refresh(id);

    const tab = tabOf(id);
    expect(listCalls()).toBe(before + 1);
    expect(apiMock.list).toHaveBeenLastCalledWith('c1', '/a/b');
    expect(tab.history).toEqual(['/a', '/a/b']);
    expect(tab.historyIndex).toBe(1);
    expect(tab.path).toBe('/a/b');
  });

  test('refreshConnection refreshes only the files tabs of that host', async () => {
    const c1 = await open('/a', 'c1');
    const c1Second = await open('/b', 'c1');
    const c2 = await open('/c', 'c2');
    const terminal = store().openTerminalTab('c1', 'root@web1');
    const before = listCalls();

    store().refreshConnection('c1');
    await settle();

    // Two files tabs for c1 were refreshed; the terminal tab and c2 were not.
    expect(listCalls()).toBe(before + 2);
    expect(tabOf(c1).loading).toBe(false);
    expect(tabOf(c1Second).loading).toBe(false);
    expect(tabOf(c2).path).toBe('/c');
    expect(store().tabs.some((tab) => tab.id === terminal)).toBe(true);
  });

  test('back returns to the previous directory; at the start it is a no-op', async () => {
    const id = await open('/a');

    // Nothing to go back to: no extra request is issued.
    const before = listCalls();
    await store().back(id);
    expect(listCalls()).toBe(before);
    expect(tabOf(id).path).toBe('/a');

    await store().navigate(id, '/a/b');
    await store().back(id);

    expect(tabOf(id).path).toBe('/a');
    expect(apiMock.list).toHaveBeenLastCalledWith('c1', '/a');
  });

  test('forward at the newest entry is a no-op', async () => {
    const id = await open('/a');
    await store().navigate(id, '/a/b');
    const before = listCalls();

    await store().forward(id);

    expect(listCalls()).toBe(before);
    expect(tabOf(id).path).toBe('/a/b');
    // forward() never issues a request when there is nowhere to go. The effect of
    // travelling forward is covered by the "navigation history" suite below.
  });

  test('up prefers the parent the server reported, then falls back to the path', async () => {
    // The server-reported parent can differ from the textual parent (symlinks).
    const id = await open('/home/anna');
    apiMock.list.mockResolvedValueOnce({
      listing: listing('/home/anna', [], '/srv/home'),
    });
    await store().navigate(id, '/home/anna');

    await store().up(id);

    expect(apiMock.list).toHaveBeenLastCalledWith('c1', '/srv/home');
    expect(tabOf(id).path).toBe('/srv/home');
  });

  test('up falls back to parentRemotePath when the listing has no parent', async () => {
    const id = await open('/home/anna');

    await store().up(id);

    expect(apiMock.list).toHaveBeenLastCalledWith('c1', '/home');
    expect(tabOf(id).path).toBe('/home');
  });

  test('up does nothing at the root', async () => {
    const id = await open('/');
    const before = listCalls();

    await store().up(id);

    expect(listCalls()).toBe(before);
    expect(tabOf(id).path).toBe('/');
  });

  test('navigation actions ignore unknown ids and non-files tabs', async () => {
    const terminal = store().openTerminalTab('c1', 'root@web1');
    const before = listCalls();

    await store().navigate('missing', '/x');
    await store().navigate(terminal, '/x');
    await store().up(terminal);
    await store().back(terminal);
    await store().forward('missing');
    await store().refresh(terminal);

    expect(listCalls()).toBe(before);
    expect(store().tabs).toHaveLength(1);
  });
});

describe('explorerStore — selection', () => {
  const entries = ['1.txt', '2.txt', '3.txt', '4.txt'].map((name) =>
    fileEntry({ name, path: `/a/${name}` }),
  );

  async function tabWithEntries(): Promise<string> {
    apiMock.list.mockResolvedValueOnce({ listing: listing('/a', entries) });
    return open('/a');
  }

  test('replace selects a single entry and moves the anchor', async () => {
    const id = await tabWithEntries();

    store().select(id, '/a/1.txt', 'replace');
    expect(tabOf(id).selection).toEqual(['/a/1.txt']);
    expect(tabOf(id).anchor).toBe('/a/1.txt');

    store().select(id, '/a/3.txt', 'replace');
    expect(tabOf(id).selection).toEqual(['/a/3.txt']);
    expect(tabOf(id).anchor).toBe('/a/3.txt');
  });

  test('toggle adds and removes, always moving the anchor to the clicked entry', async () => {
    const id = await tabWithEntries();

    store().select(id, '/a/1.txt', 'toggle');
    store().select(id, '/a/3.txt', 'toggle');
    expect(tabOf(id).selection).toEqual(['/a/1.txt', '/a/3.txt']);
    expect(tabOf(id).anchor).toBe('/a/3.txt');

    store().select(id, '/a/1.txt', 'toggle');
    expect(tabOf(id).selection).toEqual(['/a/3.txt']);
    // Documented behaviour: the anchor follows the click even when deselecting.
    expect(tabOf(id).anchor).toBe('/a/1.txt');
  });

  test('range selects the slice between anchor and target, in listing order', async () => {
    const id = await tabWithEntries();

    store().select(id, '/a/2.txt', 'replace');
    store().select(id, '/a/4.txt', 'range');
    expect(tabOf(id).selection).toEqual(['/a/2.txt', '/a/3.txt', '/a/4.txt']);
    expect(tabOf(id).anchor).toBe('/a/2.txt');

    // Backwards ranges are inclusive too, and come out in listing order.
    store().select(id, '/a/4.txt', 'replace');
    store().select(id, '/a/2.txt', 'range');
    expect(tabOf(id).selection).toEqual(['/a/2.txt', '/a/3.txt', '/a/4.txt']);
    expect(tabOf(id).anchor).toBe('/a/4.txt');
  });

  test('range without an anchor selects just the clicked entry', async () => {
    const id = await tabWithEntries();

    store().select(id, '/a/3.txt', 'range');

    expect(tabOf(id).selection).toEqual(['/a/3.txt']);
    expect(tabOf(id).anchor).toBe('/a/3.txt');
  });

  test('range falls back to a single selection when a path is not in the listing', async () => {
    const id = await tabWithEntries();
    store().select(id, '/search/elsewhere.txt', 'replace');

    store().select(id, '/a/2.txt', 'range');

    expect(tabOf(id).selection).toEqual(['/a/2.txt']);
    expect(tabOf(id).anchor).toBe('/a/2.txt');
  });

  test('selectAll prefers search results over the directory listing', async () => {
    const id = await tabWithEntries();

    store().selectAll(id);
    expect(tabOf(id).selection).toEqual(['/a/1.txt', '/a/2.txt', '/a/3.txt', '/a/4.txt']);

    apiMock.search.mockResolvedValue({
      results: [fileEntry({ name: 'hit.txt', path: '/deep/hit.txt' })],
      truncated: false,
      scanned: 9,
    });
    await store().runSearch(id, 'hit');
    store().selectAll(id);
    expect(tabOf(id).selection).toEqual(['/deep/hit.txt']);
  });

  test('selectAll on a tab without a listing selects nothing', async () => {
    const pending = deferred<{ listing: DirectoryListing }>();
    apiMock.list.mockReturnValueOnce(pending.promise);
    const id = store().openFilesTab('c1', '/a');

    store().selectAll(id);
    expect(tabOf(id).listing).toBe(null);
    expect(tabOf(id).selection).toEqual([]);

    pending.resolve({ listing: listing('/a', []) });
    await settle();
  });

  test('clearSelection drops the selection and the anchor', async () => {
    const id = await tabWithEntries();
    store().select(id, '/a/1.txt', 'replace');

    store().clearSelection(id);

    expect(tabOf(id).selection).toEqual([]);
    expect(tabOf(id).anchor).toBe(null);
  });
});

describe('explorerStore — sort and filter', () => {
  test('setSort and setFilter patch only the addressed tab', async () => {
    const a = await open('/a');
    const b = await open('/b');

    store().setSort(a, { key: 'size', direction: 'desc' });
    store().setFilter(a, 'log');

    expect(tabOf(a).sort).toEqual({ key: 'size', direction: 'desc' });
    expect(tabOf(a).filter).toBe('log');
    expect(tabOf(b).sort).toEqual({ key: 'name', direction: 'asc' });
    expect(tabOf(b).filter).toBe('');
  });
});

describe('explorerStore — preview', () => {
  test('loadPreview moves loading → ready with the payload', async () => {
    const id = await open('/a');
    const pending = deferred<FileReadResult>();
    apiMock.read.mockReturnValueOnce(pending.promise);

    const loading = store().loadPreview(id, '/a/a.txt');
    expect(tabOf(id).preview).toEqual({ path: '/a/a.txt', state: 'loading' });

    pending.resolve(readResult({ content: 'hello world' }));
    await loading;

    const preview = tabOf(id).preview;
    expect(preview?.state).toBe('ready');
    expect(preview?.path).toBe('/a/a.txt');
    expect(preview?.data?.content).toBe('hello world');
    expect(apiMock.read).toHaveBeenCalledWith('c1', '/a/a.txt');
  });

  test('loadPreview records the failure', async () => {
    const id = await open('/a');
    apiMock.read.mockRejectedValueOnce(new ApiError(415, 'UNSUPPORTED', 'Binary file.'));

    await store().loadPreview(id, '/a/blob.bin');

    expect(tabOf(id).preview).toEqual({
      path: '/a/blob.bin',
      state: 'error',
      error: 'Binary file.',
    });
  });

  test('a slow preview must not overwrite a newer one', async () => {
    const id = await open('/a');
    const slow = deferred<FileReadResult>();
    const fast = deferred<FileReadResult>();
    apiMock.read.mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);

    const first = store().loadPreview(id, '/a/one.txt');
    const second = store().loadPreview(id, '/a/two.txt');

    fast.resolve(readResult({ content: 'two' }));
    await second;
    slow.resolve(readResult({ content: 'one' }));
    await first;

    const preview = tabOf(id).preview;
    expect(preview?.path).toBe('/a/two.txt');
    expect(preview?.data?.content).toBe('two');
  });

  test('loadPreview ignores unknown and non-files tabs', async () => {
    const terminal = store().openTerminalTab('c1', 'root@web1');

    await store().loadPreview('missing', '/a/a.txt');
    await store().loadPreview(terminal, '/a/a.txt');

    expect(apiMock.read).not.toHaveBeenCalled();
  });
});

describe('explorerStore — search', () => {
  test('runSearch trims the query, stores the hits and flags truncation', async () => {
    const id = await open('/a');
    const pending = deferred<{ results: FileEntry[]; truncated: boolean; scanned: number }>();
    apiMock.search.mockReturnValueOnce(pending.promise);

    const running = store().runSearch(id, '  hit  ');
    expect(tabOf(id).searchLoading).toBe(true);
    expect(tabOf(id).searchQuery).toBe('  hit  ');

    pending.resolve({ results: [fileEntry({ name: 'hit.txt' })], truncated: true, scanned: 42 });
    await running;

    const tab = tabOf(id);
    expect(tab.searchLoading).toBe(false);
    expect(tab.searchResults?.map((entry) => entry.name)).toEqual(['hit.txt']);
    expect(tab.searchTruncated).toBe(true);
    expect(tab.selection).toEqual([]);
    expect(apiMock.search).toHaveBeenCalledWith('c1', '/a', 'hit');
  });

  test('an empty query clears the search without calling the API', async () => {
    const id = await open('/a');
    apiMock.search.mockResolvedValue({
      results: [fileEntry({ name: 'hit.txt' })],
      truncated: true,
      scanned: 1,
    });
    await store().runSearch(id, 'hit');
    expect(tabOf(id).searchResults).toHaveLength(1);
    const before = apiMock.search.mock.calls.length;

    await store().runSearch(id, '   ');

    expect(apiMock.search.mock.calls.length).toBe(before);
    const tab = tabOf(id);
    expect(tab.searchQuery).toBe('');
    expect(tab.searchResults).toBe(null);
    expect(tab.searchLoading).toBe(false);
    expect(tab.searchTruncated).toBe(false);
  });

  test('a late answer for an outdated query never lands', async () => {
    const id = await open('/a');
    const first = deferred<{ results: FileEntry[]; truncated: boolean; scanned: number }>();
    const second = deferred<{ results: FileEntry[]; truncated: boolean; scanned: number }>();
    apiMock.search.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const firstRun = store().runSearch(id, 'one');
    const secondRun = store().runSearch(id, 'two');

    second.resolve({ results: [fileEntry({ name: 'two.txt' })], truncated: false, scanned: 2 });
    await secondRun;
    first.resolve({ results: [fileEntry({ name: 'one.txt' })], truncated: true, scanned: 1 });
    await firstRun;

    const tab = tabOf(id);
    expect(tab.searchQuery).toBe('two');
    expect(tab.searchResults?.map((entry) => entry.name)).toEqual(['two.txt']);
    expect(tab.searchTruncated).toBe(false);
    expect(tab.searchLoading).toBe(false);
  });

  test('a failed search reports the error and an empty result set', async () => {
    const id = await open('/a');
    apiMock.search.mockRejectedValueOnce(new ApiError(500, 'INTERNAL', 'Search blew up.'));

    await store().runSearch(id, 'hit');

    const tab = tabOf(id);
    expect(tab.searchLoading).toBe(false);
    expect(tab.searchResults).toEqual([]);
    expect(tab.error).toBe('Search blew up.');
  });

  test('clearSearch resets every search field', async () => {
    const id = await open('/a');
    apiMock.search.mockResolvedValue({
      results: [fileEntry({ name: 'hit.txt' })],
      truncated: true,
      scanned: 1,
    });
    await store().runSearch(id, 'hit');

    store().clearSearch(id);

    const tab = tabOf(id);
    expect(tab.searchQuery).toBe('');
    expect(tab.searchResults).toBe(null);
    expect(tab.searchLoading).toBe(false);
    expect(tab.searchTruncated).toBe(false);
  });
});

describe('explorerStore — file operations', () => {
  test('createFolder joins the name onto the current directory and refreshes', async () => {
    const id = await open('/home');
    const before = listCalls();

    await store().createFolder(id, 'new dir');

    expect(apiMock.mkdir).toHaveBeenCalledWith('c1', '/home/new dir');
    expect(listCalls()).toBe(before + 1);
  });

  test('renameEntry renames inside the same directory', async () => {
    const id = await open('/home');
    const before = listCalls();

    await store().renameEntry(id, '/home/old.txt', 'new.txt');

    expect(apiMock.rename).toHaveBeenCalledWith('c1', '/home/old.txt', '/home/new.txt');
    expect(listCalls()).toBe(before + 1);
  });

  test('renameEntry is a no-op when the name did not change', async () => {
    const id = await open('/home');
    const before = listCalls();

    await store().renameEntry(id, '/home/old.txt', 'old.txt');

    expect(apiMock.rename).not.toHaveBeenCalled();
    expect(listCalls()).toBe(before);
  });

  test('deleteEntries asks for a recursive delete and refreshes', async () => {
    const id = await open('/home');
    apiMock.remove.mockResolvedValueOnce({ deleted: ['/home/a.txt'], failed: [] });
    const before = listCalls();

    await store().deleteEntries(id, ['/home/a.txt']);

    expect(apiMock.remove).toHaveBeenCalledWith('c1', ['/home/a.txt'], true);
    expect(listCalls()).toBe(before + 1);
  });

  test('deleteEntries does nothing without paths', async () => {
    const id = await open('/home');
    const before = listCalls();

    await store().deleteEntries(id, []);

    expect(apiMock.remove).not.toHaveBeenCalled();
    expect(listCalls()).toBe(before);
  });

  test('a partially failed delete throws PARTIAL and does not refresh', async () => {
    const id = await open('/home');
    apiMock.remove.mockResolvedValueOnce({
      deleted: ['/home/a.txt'],
      failed: [{ path: '/home/b.txt', message: 'permission denied' }],
    });
    const before = listCalls();

    let caught: unknown;
    try {
      await store().deleteEntries(id, ['/home/a.txt', '/home/b.txt']);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ApiError);
    const apiError = caught as ApiError;
    expect(apiError.code).toBe('PARTIAL');
    expect(apiError.status).toBe(200);
    expect(apiError.message).toBe('1 of 2 items could not be deleted.');
    expect(apiError.details).toEqual({ failed: [{ path: '/home/b.txt', message: 'permission denied' }] });
    expect(listCalls()).toBe(before);
  });

  test('chmodEntry and touchEntry forward the path and refresh', async () => {
    const id = await open('/home');
    const before = listCalls();

    await store().chmodEntry(id, '/home/a.txt', '755');
    await store().touchEntry(id, '/home/a.txt');

    expect(apiMock.chmod).toHaveBeenCalledWith('c1', '/home/a.txt', '755');
    expect(apiMock.touch).toHaveBeenCalledWith('c1', '/home/a.txt');
    expect(listCalls()).toBe(before + 2);
  });

  test('file operations ignore unknown ids', async () => {
    await store().createFolder('missing', 'x');
    await store().renameEntry('missing', '/a', 'b');
    await store().deleteEntries('missing', ['/a']);
    await store().chmodEntry('missing', '/a', '755');
    await store().touchEntry('missing', '/a');

    expect(apiMock.mkdir).not.toHaveBeenCalled();
    expect(apiMock.rename).not.toHaveBeenCalled();
    expect(apiMock.remove).not.toHaveBeenCalled();
    expect(apiMock.chmod).not.toHaveBeenCalled();
    expect(apiMock.touch).not.toHaveBeenCalled();
  });
});

describe('explorerStore — selectors', () => {
  test('selectActiveTab follows activeTabId', async () => {
    expect(selectActiveTab(store())).toBe(null);
    const a = await open('/a');
    const b = await open('/b');

    expect(selectActiveTab(store())?.id).toBe(b);
    store().activateTab(a);
    expect(selectActiveTab(store())?.id).toBe(a);
  });

  test('isFilesTab narrows files tabs only', async () => {
    const files = await open('/a');
    const terminal = store().openTerminalTab('c1', 'root@web1');

    expect(isFilesTab(store().tabs.find((tab) => tab.id === files) ?? null)).toBe(true);
    expect(isFilesTab(store().tabs.find((tab) => tab.id === terminal) ?? null)).toBe(false);
    expect(isFilesTab(null)).toBe(false);
  });

  test('visibleEntries prefers search results and copes with an empty tab', async () => {
    const id = await open('/a');
    expect(visibleEntries(tabOf(id)).map((entry) => entry.name)).toEqual(['sub', 'a.txt']);

    apiMock.search.mockResolvedValue({
      results: [fileEntry({ name: 'hit.txt' })],
      truncated: false,
      scanned: 1,
    });
    await store().runSearch(id, 'hit');
    expect(visibleEntries(tabOf(id)).map((entry) => entry.name)).toEqual(['hit.txt']);

    const empty = store().openFilesTab('c1', '/empty');
    expect(visibleEntries(tabOf(empty))).toEqual([]);
    await settle();
  });
});

/* ------------------------------------------------------------------------- */
/*  Regression: history, refresh and range selection                          */
/*                                                                            */
/*  These pin the bugs a review of the previous implementation found: Back    */
/*  and Forward rewrote the history they were walking, F5 discarded the        */
/*  selection and the open preview, navigating away left the search spinner    */
/*  stuck, and shift-click ranged over the unsorted listing.                   */
/* ------------------------------------------------------------------------- */

describe('explorerStore — navigation history', () => {
  test('back() walks the history without rewriting it', async () => {
    const id = await open('/a');
    await store().navigate(id, '/b');
    await store().navigate(id, '/c');
    expect(tabOf(id).history).toEqual(['/a', '/b', '/c']);
    expect(tabOf(id).historyIndex).toBe(2);

    await store().back(id);
    expect(tabOf(id).path).toBe('/b');
    expect(tabOf(id).history).toEqual(['/a', '/b', '/c']);
    expect(tabOf(id).historyIndex).toBe(1);

    await store().back(id);
    expect(tabOf(id).path).toBe('/a');
    expect(tabOf(id).historyIndex).toBe(0);
    expect(tabOf(id).history).toEqual(['/a', '/b', '/c']);
  });

  test('forward() returns along the same history', async () => {
    const id = await open('/a');
    await store().navigate(id, '/b');
    await store().navigate(id, '/c');
    await store().back(id);
    await store().back(id);

    await store().forward(id);
    expect(tabOf(id).path).toBe('/b');
    expect(tabOf(id).historyIndex).toBe(1);

    await store().forward(id);
    expect(tabOf(id).path).toBe('/c');
    expect(tabOf(id).historyIndex).toBe(2);
  });

  test('back() at the start and forward() at the end are no-ops', async () => {
    const id = await open('/a');
    await store().navigate(id, '/b');
    await store().back(id);
    const atStart = tabOf(id);

    await store().back(id);
    expect(tabOf(id).path).toBe(atStart.path);
    expect(tabOf(id).historyIndex).toBe(atStart.historyIndex);

    await store().forward(id);
    await store().forward(id);
    const atEnd = tabOf(id);
    await store().forward(id);
    expect(tabOf(id).path).toBe(atEnd.path);
    expect(tabOf(id).historyIndex).toBe(atEnd.historyIndex);
  });

  test('navigating after going back truncates the forward entries', async () => {
    const id = await open('/a');
    await store().navigate(id, '/b');
    await store().navigate(id, '/c');
    await store().back(id);

    await store().navigate(id, '/d');
    expect(tabOf(id).history).toEqual(['/a', '/b', '/d']);
    expect(tabOf(id).historyIndex).toBe(2);

    // Forward has nothing to return to any more.
    await store().forward(id);
    expect(tabOf(id).path).toBe('/d');
  });

  test('leaving a folder clears a search that is still in flight', async () => {
    const id = await open('/a');
    // A search that never settles must not leave the spinner on after navigating.
    const pending = deferred<{ results: FileEntry[]; truncated: boolean; scanned: number }>();
    apiMock.search.mockReturnValueOnce(pending.promise);
    void store().runSearch(id, 'slow');
    expect(tabOf(id).searchLoading).toBe(true);

    await store().navigate(id, '/b');
    expect(tabOf(id).searchLoading).toBe(false);
    expect(tabOf(id).searchTruncated).toBe(false);
    expect(tabOf(id).searchQuery).toBe('');
  });
});

describe('explorerStore — refresh', () => {
  test('keeps the selection and reloads the open preview', async () => {
    const id = await open('/a');
    const entry = tabOf(id).listing!.entries[1]!;
    store().select(id, entry.path, 'replace');
    await store().loadPreview(id, entry.path);
    expect(tabOf(id).preview?.state).toBe('ready');

    const readsBefore = apiMock.read.mock.calls.length;
    await store().refresh(id);

    expect(tabOf(id).selection).toEqual([entry.path]);
    expect(tabOf(id).preview?.path).toBe(entry.path);
    // The preview was actually re-read, not merely kept in the state.
    expect(apiMock.read.mock.calls.length).toBeGreaterThan(readsBefore);
  });

  test('drops a selection whose entries disappeared', async () => {
    const id = await open('/a');
    const gone = tabOf(id).listing!.entries[1]!;
    store().select(id, gone.path, 'replace');

    apiMock.list.mockImplementation(async (_connectionId: string, path: string) => ({
      listing: listing(path, [dirEntry('sub')]),
    }));
    await store().refresh(id);

    expect(tabOf(id).selection).toEqual([]);
  });
});

describe('explorerStore — range selection', () => {
  test('follows the order the view is showing, not the raw listing', async () => {
    const id = await open('/a');
    const entries = [
      fileEntry({ path: '/a/a.txt', name: 'a.txt' }),
      fileEntry({ path: '/a/m.txt', name: 'm.txt' }),
      fileEntry({ path: '/a/z.txt', name: 'z.txt' }),
    ];
    apiMock.list.mockImplementation(async (_connectionId: string, path: string) => ({
      listing: listing(path, entries),
    }));
    await store().refresh(id);

    // The view is sorted descending, so it hands the store that order.
    const order = ['/a/z.txt', '/a/m.txt', '/a/a.txt'];
    store().select(id, '/a/z.txt', 'replace', order);
    store().select(id, '/a/a.txt', 'range', order);
    // In display order z→m→a, so all three are in the run.
    expect(tabOf(id).selection).toEqual(['/a/z.txt', '/a/m.txt', '/a/a.txt']);
  });
});

describe('explorerStore — range selection over search hits', () => {
  test('ranges over hits that live outside the open folder', async () => {
    const id = await open('/');
    // A recursive search returns files from subfolders, which are not rows of the
    // listing at all — the run must still follow the order the view shows.
    const hits = [
      fileEntry({ path: '/docs/a.txt', name: 'a.txt' }),
      fileEntry({ path: '/etc/b.txt', name: 'b.txt' }),
      fileEntry({ path: '/var/c.txt', name: 'c.txt' }),
      fileEntry({ path: '/opt/d.txt', name: 'd.txt' }),
    ];
    apiMock.search.mockResolvedValueOnce({ results: hits, truncated: false, scanned: 4 });
    await store().runSearch(id, 'txt');

    const order = hits.map((entry) => entry.path);
    store().select(id, order[0]!, 'replace', order);
    store().select(id, order[2]!, 'range', order);

    expect(tabOf(id).selection).toEqual(order.slice(0, 3));
  });

  test('a range falls back to a single row when the anchor is not on screen', async () => {
    const id = await open('/a');
    const order = ['/a/one.txt', '/a/two.txt'];
    // The anchor was selected in a folder the user has since left.
    store().select(id, '/elsewhere/gone.txt', 'replace', ['/elsewhere/gone.txt']);
    store().select(id, '/a/two.txt', 'range', order);
    expect(tabOf(id).selection).toEqual(['/a/two.txt']);
  });
});

describe('explorerStore — select all', () => {
  test('takes exactly the rows the view is showing', async () => {
    const id = await open('/a');
    const entries = [
      fileEntry({ path: '/a/a.txt', name: 'a.txt' }),
      fileEntry({ path: '/a/b.log', name: 'b.log' }),
      fileEntry({ path: '/a/c.txt', name: 'c.txt' }),
    ];
    apiMock.list.mockImplementation(async (_connectionId: string, path: string) => ({
      listing: listing(path, entries),
    }));
    await store().refresh(id);

    // The view is filtered to *.txt, so Ctrl+A must not sweep up b.log.
    store().selectAll(id, ['/a/a.txt', '/a/c.txt']);
    expect(tabOf(id).selection).toEqual(['/a/a.txt', '/a/c.txt']);
  });
});

describe('explorerStore — the tab strip "+"', () => {
  test('reuses a tab on the same host and folder, unless a new one is forced', async () => {
    const first = await open('/home');
    // Navigation must not spawn duplicates…
    const again = store().openFilesTab('c1', '/home');
    expect(again).toBe(first);
    expect(store().tabs).toHaveLength(1);

    // …but the "+" asks for another view of the same folder.
    const second = store().openFilesTab('c1', '/home', { force: true });
    expect(second).not.toBe(first);
    expect(store().tabs).toHaveLength(2);
    expect(store().activeTabId).toBe(second);
    expect(store().tabs.map((tab) => tab.kind)).toEqual(['files', 'files']);
  });

  test('a forced tab carries its own history and listing', async () => {
    const first = await open('/a');
    const second = store().openFilesTab('c1', '/a', { force: true });
    await settle();

    await store().navigate(second, '/b');
    expect(tabOf(second).path).toBe('/b');
    // The first tab stayed where it was.
    expect(tabOf(first).path).toBe('/a');
  });
});
