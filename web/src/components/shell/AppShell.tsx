import { useEffect, lazy, Suspense, useRef, useState } from 'react';
import { useConnectionStore } from '../../state/connectionStore';
import { useExplorerStore } from '../../state/explorerStore';
import { useTransferStore } from '../../state/transferStore';
import { useUiStore } from '../../state/uiStore';
import { useEditStore } from '../../state/editStore';
import { eventBus } from '../../state/eventBus';
import { api } from '../../api/client';
import { useHotkey } from '../../lib/hooks';
import { hasDropFiles } from '../../lib/drop';
import { useT } from '../../i18n/useT';
import { useUpdateWatch } from '../../lib/updates';
import { onDownloadDone, onMenuAction, revealInFileManager, desktopInfo, isDesktop } from '../../lib/desktop';
import { TopBar } from './TopBar';
import { Sidebar } from './Sidebar';
import { TabStrip } from './TabStrip';
import { StatusBar } from './StatusBar';
import { CommandPalette } from './CommandPalette';
import { Toasts } from './Toasts';
import { ConnectionDialog } from '../connections/ConnectionDialog';
import { KnownHostsDialog } from '../connections/KnownHostsDialog';
import { ServerStatsDialog } from '../system/ServerStatsDialog';
import { DiagnosticsDialog } from '../system/DiagnosticsDialog';
import { NetworkToolsDialog } from '../system/NetworkToolsDialog';
import { FilePane } from '../files/FilePane';
import { EditPromptDialog } from '../files/EditPromptDialog';
import { TransferDock, TransferView } from '../transfers/Transfers';
import { Button, Spinner } from '../ui/Primitives';
import { Icon } from '../ui/Icon';
import { Menu } from '../ui/Overlays';

// xterm is only needed once a terminal tab exists, so it is fetched on demand.
const TerminalPane = lazy(() =>
  import('../terminal/TerminalPane').then((module) => ({ default: module.TerminalPane })),
);

export function AppShell() {
  const bootError = useConnectionStore((s) => s.bootError);
  const systemInfo = useConnectionStore((s) => s.systemInfo);
  const bootstrap = useConnectionStore((s) => s.bootstrap);
  const connections = useConnectionStore((s) => s.connections);
  const activeConnectionId = useConnectionStore((s) => s.activeId);

  const tabs = useExplorerStore((s) => s.tabs);
  const activeTabId = useExplorerStore((s) => s.activeTabId);
  const split = useExplorerStore((s) => s.split);
  const setPaneTab = useExplorerStore((s) => s.setPaneTab);
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const openFilesTab = useExplorerStore((s) => s.openFilesTab);
  const refresh = useExplorerStore((s) => s.refresh);

  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const setCommandPalette = useUiStore((s) => s.setCommandPalette);
  const openConnectionDialog = useUiStore((s) => s.openConnectionDialog);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const toggleInspector = useUiStore((s) => s.toggleInspector);
  const setTheme = useUiStore((s) => s.setTheme);

  /* ------------------------------------------------------------- bootstrap */
  useEffect(() => {
    void bootstrap();
    eventBus.start();
    void api
      .listTransfers()
      .then(({ transfers }) => useTransferStore.getState().setAll(transfers))
      .catch(() => undefined);
    return () => eventBus.stop();
  }, [bootstrap]);

  useEffect(() => {
    const stored = window.localStorage.getItem('ssh-explorer.theme');
    if (stored === 'light' || stored === 'dark') setTheme(stored);
  }, [setTheme]);

  /* --------------------------------------------------- desktop shell menu */
  useEffect(() => {
    return onMenuAction({
      'new-connection': () => openConnectionDialog(),
      'new-terminal': () => {
        const connection = useConnectionStore
          .getState()
          .connections.find((c) => c.id === useConnectionStore.getState().activeId);
        if (connection?.status === 'authenticated') {
          useExplorerStore.getState().openTerminalTab(connection.id, connection.label);
        }
      },
      'close-tab': () => {
        const id = useExplorerStore.getState().activeTabId;
        if (id) useExplorerStore.getState().closeTab(id);
      },
      'new-folder': () => window.dispatchEvent(new CustomEvent('ssh-explorer:new-folder')),
      upload: () => window.dispatchEvent(new CustomEvent('ssh-explorer:upload')),
      refresh: () => {
        const tab = useExplorerStore.getState();
        const active = tab.tabs.find((t) => t.id === tab.activeTabId);
        if (active?.kind === 'files') void tab.refresh(active.id);
      },
      'focus-filter': () => window.dispatchEvent(new CustomEvent('ssh-explorer:focus-search')),
      'edit-path': () => window.dispatchEvent(new CustomEvent('ssh-explorer:edit-path')),
      'command-palette': () => useUiStore.getState().setCommandPalette(true),
      'toggle-theme': () => useUiStore.getState().toggleTheme(),
      'toggle-dotfiles': () => useUiStore.getState().setShowHidden(!useUiStore.getState().showHidden),
      'toggle-sidebar': () => useUiStore.getState().toggleSidebar(),
      'toggle-inspector': () => useUiStore.getState().toggleInspector(),
      'open-home': () => {
        const connection = useConnectionStore
          .getState()
          .connections.find((c) => c.id === useConnectionStore.getState().activeId);
        if (connection?.serverInfo) {
          useExplorerStore.getState().openFilesTab(connection.id, connection.serverInfo.home);
        }
      },
      'open-root': () => {
        const connection = useConnectionStore
          .getState()
          .connections.find((c) => c.id === useConnectionStore.getState().activeId);
        if (connection?.status === 'authenticated') {
          useExplorerStore.getState().openFilesTab(connection.id, '/');
        }
      },
      reconnect: () => {
        const id = useConnectionStore.getState().activeId;
        if (id) void useConnectionStore.getState().reconnect(id).catch(() => undefined);
      },
      disconnect: () => {
        const id = useConnectionStore.getState().activeId;
        if (id) void useConnectionStore.getState().disconnect(id).catch(() => undefined);
      },
      'open-transfers': () => useExplorerStore.getState().openTransfersTab(),
      'server-stats': () => useUiStore.getState().setServerStatsOpen(true),
      'known-hosts': () => useUiStore.getState().setKnownHostsOpen(true),
      diagnostics: () => useUiStore.getState().setDiagnosticsOpen(true),
      'clear-transfers': () => void useTransferStore.getState().clearFinished(),
    });
  }, [openConnectionDialog]);

  /* --------------------------------------------------- native downloads */
  useEffect(() => {
    return onDownloadDone(({ path, state, name }) => {
      const ui = useUiStore.getState();
      if (state === 'completed') {
        ui.pushToast({
          level: 'success',
          title: `Saved ${name}`,
          detail: path,
          action: { label: 'Show in folder', run: () => revealInFileManager(path) },
        });
      } else if (state === 'interrupted' || state === 'cancelled') {
        ui.pushToast({ level: 'warn', title: `Download ${state}`, detail: name });
      } else {
        ui.pushToast({ level: 'error', title: 'Download failed', detail: name });
      }
    });
  }, []);

  /* ------------------------------------------- edit-in-default-app events */
  useEffect(() => useEditStore.getState().attach(), []);

  /* ------------------------------------------------------ newer releases */
  const { checkNow } = useUpdateWatch();

  /* ------------------------------------------- open a tab once connected */
  const activeConnection = connections.find((c) => c.id === activeConnectionId) ?? null;
  /**
   * Connections whose first tab has already been opened.
   *
   * Without this the effect below ran again every time the tab list became empty, so
   * closing the last tab of the active connection reopened it instantly — the tab looked
   * like it refused to close.
   */
  const autoOpened = useRef(new Set<string>());
  useEffect(() => {
    if (!activeConnection || activeConnection.status !== 'authenticated') return;
    if (autoOpened.current.has(activeConnection.id)) return;
    const hasTab = tabs.some((tab) => tab.connectionId === activeConnection.id);
    if (hasTab) {
      autoOpened.current.add(activeConnection.id);
      return;
    }
    autoOpened.current.add(activeConnection.id);
    openFilesTab(activeConnection.id, activeConnection.serverInfo?.home ?? '/');
  }, [activeConnection, openFilesTab, tabs]);

  /* ------------------------------------------------------------- hotkeys */
  useHotkey('mod+k', (event) => {
    event.preventDefault();
    setCommandPalette(true);
  });
  useHotkey('mod+b', (event) => {
    event.preventDefault();
    toggleSidebar();
  });
  useHotkey('mod+i', (event) => {
    event.preventDefault();
    toggleInspector(activeTabId ?? undefined);
  });
  useHotkey('mod+n', (event) => {
    event.preventDefault();
    openConnectionDialog();
  });
  useHotkey('mod+t', (event) => {
    event.preventDefault();
    // The tab strip owns the chooser; it anchors the menu to its own "+".
    window.dispatchEvent(new CustomEvent('ssh-explorer:new-tab'));
  });
  useHotkey('mod+l', (event) => {
    event.preventDefault();
    window.dispatchEvent(new CustomEvent('ssh-explorer:edit-path'));
  });
  useHotkey('mod+f', (event) => {
    event.preventDefault();
    window.dispatchEvent(new CustomEvent('ssh-explorer:focus-search'));
  });
  useHotkey('shift+mod+n', (event) => {
    event.preventDefault();
    window.dispatchEvent(new CustomEvent('ssh-explorer:new-folder'));
  });
  useHotkey('f5', (event) => {
    event.preventDefault();
    if (activeTab?.kind === 'files') void refresh(activeTab.id);
  });
  useHotkey('escape', () => {
    const ui = useUiStore.getState();
    if (ui.commandPaletteOpen) ui.setCommandPalette(false);
  }, { allowInInput: true });

  /* ------------------------------------------------------------------------
   * The accelerators the native menu used to own.
   *
   * That menu is gone on Windows and Linux — it is drawn by the system and could not be
   * themed — so every shortcut it provided has to live here or it is lost.
   */
  useHotkey('shift+mod+s', (event) => {
    event.preventDefault();
    useUiStore.getState().setServerStatsOpen(true);
  });
  useHotkey('shift+mod+k', (event) => {
    event.preventDefault();
    useUiStore.getState().setKnownHostsOpen(true);
  });
  useHotkey('shift+mod+d', (event) => {
    event.preventDefault();
    useUiStore.getState().setDiagnosticsOpen(true);
  });
  useHotkey('mod+j', (event) => {
    event.preventDefault();
    useExplorerStore.getState().openTransfersTab();
  });
  useHotkey('mod+w', (event) => {
    const tab = useExplorerStore.getState().activeTabId;
    if (tab === null) return;
    event.preventDefault();
    useExplorerStore.getState().closeTab(tab);
  });

  /* Prevent default browser/Electron drop handling on window so file drops are accepted smoothly */
  useEffect(() => {
    const handleDragOver = (e: DragEvent) => {
      if (hasDropFiles(e.dataTransfer)) {
        e.preventDefault();
      }
    };
    const handleDrop = (e: DragEvent) => {
      if (hasDropFiles(e.dataTransfer)) {
        e.preventDefault();
      }
    };
    window.addEventListener('dragover', handleDragOver);
    window.addEventListener('drop', handleDrop);
    return () => {
      window.removeEventListener('dragover', handleDragOver);
      window.removeEventListener('drop', handleDrop);
    };
  }, []);

  /* --------------------------------------------------------------- Tab key ---
   * In split mode Tab moves between the two panes, exactly as a two-panel file manager
   * does. In the ordinary mode it walks the tabs. Both are suppressed while the user is
   * typing or a dialog is open, because Tab is how a keyboard user reaches the next
   * control and hijacking it there would break the form they are filling in.
   */
  useHotkey('tab', (event) => {
    // A modal on screen means the user is filling something in, and Tab is how they reach
    // the next control. Read from the DOM rather than from a store flag: a dialog that
    // closed without clearing its flag would otherwise disable this shortcut for good.
    if (document.querySelector('.modal, .palette, .menu') !== null) return;
    const explorer = useExplorerStore.getState();
    event.preventDefault();
    if (explorer.split) explorer.focusOtherPane();
    else explorer.cycleTab(event.shiftKey ? -1 : 1);
  });
  useHotkey('shift+tab', (event) => {
    if (document.querySelector('.modal, .palette, .menu') !== null) return;
    const explorer = useExplorerStore.getState();
    event.preventDefault();
    if (explorer.split) explorer.focusOtherPane();
    else explorer.cycleTab(-1);
  });
  useHotkey('mod+\\', (event) => {
    event.preventDefault();
    useExplorerStore.getState().toggleSplit();
  });
  // `mod+tab`, not `ctrl+tab`: the combo parser knows `mod`, and `ctrl` never matches.
  useHotkey('mod+tab', (event) => {
    event.preventDefault();
    useExplorerStore.getState().cycleTab(event.shiftKey ? -1 : 1);
  });

  /* ---------------------------------------------------------------- render */

  if (bootError) {
    return (
      <div className="boot">
        <div className="boot__card">
          <span className="boot__icon boot__icon--error">
            <Icon name="plug" size={22} />
          </span>
          <h1>WooSSH service unavailable</h1>
          <p>{bootError}</p>
          <p className="boot__hint mono">Start the API with: npm run dev</p>
          <Button variant="primary" icon="refresh" onClick={() => void bootstrap()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }

  if (!systemInfo) {
    return (
      <div className="boot">
        <div className="boot__card boot__card--quiet">
          <Spinner size={22} />
          <p>Starting WooSSH…</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`app${sidebarOpen ? '' : ' app--no-sidebar'}`}>
      <TopBar />

      <div className="app__body">
        {sidebarOpen ? <Sidebar /> : null}

        <main className="workbench">
          <TabStrip />

          <div className={`workbench__content${split ? ' is-split' : ''}`}>
            {tabs.map((tab) => {
              // In split mode two tabs are on screen at once; otherwise just the active one.
              // Every tab stays mounted either way, so a terminal keeps its scrollback and
              // a folder keeps its listing while it is out of sight.
              const paneSide = split
                ? tab.id === split.leftId
                  ? 'left'
                  : tab.id === split.rightId
                    ? 'right'
                    : null
                : null;
              const visible = split ? paneSide !== null : tab.id === activeTabId;
              return (
                <div
                  key={tab.id}
                  className={`workbench__view${
                    split && tab.id === activeTabId ? ' is-focused' : ''
                  }`}
                  hidden={!visible}
                  aria-hidden={!visible}
                  // The grid fills in document order, so the pane a tab occupies is decided
                  // here rather than by where the tab happens to sit in the strip.
                  style={paneSide === null ? undefined : { order: paneSide === 'left' ? 0 : 1 }}
                >
                  {split ? (
                    <PaneHeader
                      tab={tab}
                      side={tab.id === split.leftId ? 'left' : 'right'}
                      focused={tab.id === activeTabId}
                      connection={connections.find((c) => c.id === tab.connectionId) ?? null}
                      tabs={tabs}
                      onPickTab={(tabId) =>
                        setPaneTab(tab.id === split.leftId ? 'left' : 'right', tabId)
                      }
                    />
                  ) : null}
                  {tab.kind === 'files' ? <FilePane tabId={tab.id} /> : null}
                  {tab.kind === 'terminal' ? (
                    <Suspense
                      fallback={
                        <div className="tpane tpane--loading">
                          <Spinner size={18} />
                        </div>
                      }
                    >
                      <TerminalPane connectionId={tab.connectionId} title={tab.title} cwd={tab.cwd} tabId={tab.id} />
                    </Suspense>
                  ) : null}
                  {tab.kind === 'transfers' ? <TransferView /> : null}
                </div>
              );
            })}
            {tabs.length === 0 ? <WelcomePane /> : null}
          </div>

          <TransferDock />
        </main>
      </div>

      <StatusBar />
      <CommandPalette />
      <ConnectionDialog />
      <KnownHostsDialog />
      <ServerStatsDialog />
      <DiagnosticsDialog />
      <NetworkToolsDialog />
      <EditPromptDialog />
      <Toasts />
    </div>
  );
}

/**
 * Which host a split pane is looking at, which tab fills it, and whether it has the focus.
 *
 * Two panes side by side are only useful if you can tell them apart at a glance: the
 * colour is the same tag the sidebar and the tab dots use, so a pane reads as belonging
 * to a host rather than being an anonymous list. The name doubles as the control that
 * decides *which* tab sits in this pane — the alternative was dragging tabs across a
 * divider, which is a lot of machinery for a two-pane layout.
 */
function PaneHeader({
  tab,
  side,
  focused,
  connection,
  tabs,
  onPickTab,
}: {
  tab: { id: string; kind: string; title?: string; path?: string; connectionId: string | null };
  side: 'left' | 'right';
  focused: boolean;
  connection: { label: string; color?: string | null; host: string; port: number } | null;
  tabs: { id: string; kind: string; title?: string; path?: string }[];
  onPickTab: (tabId: string) => void;
}) {
  const { t } = useT();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const colour = connection?.color ?? 'slate';
  const name = connection?.label ?? t('pane.noConnection');
  const detail =
    tab.kind === 'files' && typeof tab.path === 'string'
      ? tab.path
      : (tab.title ?? connection?.host ?? '');

  const label = (candidate: { kind: string; title?: string; path?: string }): string => {
    if (candidate.kind === 'files') return candidate.path ?? '/';
    if (candidate.kind === 'transfers') return t('tabs.transferManager');
    return candidate.title ?? candidate.kind;
  };

  return (
    <div className={`pane-head${focused ? ' is-focused' : ''}`} data-pane={side}>
      <span className={`pane-head__dot host-row__dot--${colour}`} aria-hidden="true" />
      <button
        type="button"
        className="pane-head__choose"
        aria-haspopup="menu"
        title={t('pane.chooseTab')}
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          setMenu({ x: rect.left, y: rect.bottom + 4 });
        }}
      >
        <span className="pane-head__name truncate">{name}</span>
        <Icon name="chevron-down" size={12} />
      </button>
      <span className="pane-head__path mono truncate" title={detail}>
        {detail}
      </span>
      {focused ? <span className="pane-head__badge">{t('pane.active')}</span> : null}

      {menu ? (
        <Menu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          minWidth={260}
          items={tabs.map((candidate) => ({
            id: candidate.id,
            label: label(candidate),
            icon: candidate.kind === 'files' ? 'folder' : candidate.kind === 'terminal' ? 'terminal' : 'transfer',
            selected: candidate.id === tab.id,
            onSelect: () => onPickTab(candidate.id),
          }))}
        />
      ) : null}
    </div>
  );
}

function WelcomePane() {
  const openConnectionDialog = useUiStore((s) => s.openConnectionDialog);
  const profiles = useConnectionStore((s) => s.profiles);
  const systemInfo = useConnectionStore((s) => s.systemInfo);
  const [desktopVersion, setDesktopVersion] = useState<string | null>(null);

  useEffect(() => {
    if (!isDesktop) return;
    let cancelled = false;
    void desktopInfo().then((info) => {
      if (!cancelled && info) setDesktopVersion(info.version);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="welcome">
      <div className="welcome__inner">
        <span className="welcome__mark">
          <Icon name="terminal" size={26} strokeWidth={1.3} />
        </span>
        <h1 className="welcome__title">
          {isDesktop ? 'Remote files, without leaving your desktop' : 'Remote files, without leaving the browser'}
        </h1>
        <p className="welcome__lead">
          Connect to a host over SSH and browse its filesystem the way you would a local disk —
          multi-select, drag &amp; drop uploads, live transfer progress and an integrated terminal.
        </p>

        <div className="welcome__actions">
          <Button variant="primary" size="lg" icon="plug" onClick={() => openConnectionDialog()}>
            New connection
          </Button>
          <Button
            variant="ghost"
            size="lg"
            icon="command"
            onClick={() => useUiStore.getState().setCommandPalette(true)}
          >
            Command palette
          </Button>
        </div>

        <dl className="welcome__facts">
          <div>
            <dt className="label">Saved hosts</dt>
            <dd className="mono">{profiles.length}</dd>
          </div>
          <div>
            <dt className="label">Local keys</dt>
            <dd className="mono">{systemInfo?.keys.length ?? 0}</dd>
          </div>
          <div>
            <dt className="label">Known hosts file</dt>
            <dd className="mono truncate" title={systemInfo?.knownHostsPath}>
              {systemInfo?.knownHostsPath ?? '—'}
            </dd>
          </div>
          {desktopVersion ? (
            <div>
              <dt className="label">Desktop app</dt>
              <dd className="mono">v{desktopVersion}</dd>
            </div>
          ) : null}
        </dl>

        {profiles.length > 0 ? (
          <ul className="welcome__hosts">
            {profiles.slice(0, 4).map((profile) => (
              <li key={profile.id}>
                <button
                  type="button"
                  className="welcome__host"
                  onClick={() =>
                    openConnectionDialog({
                      profile,
                      host: profile.host,
                      username: profile.username,
                      port: profile.port,
                    })
                  }
                >
                  <span className={`welcome__host-dot host-row__dot--${profile.color}`} />
                  <span className="welcome__host-name truncate">{profile.label || profile.host}</span>
                  <span className="mono truncate">
                    {profile.username}@{profile.host}:{profile.port}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
