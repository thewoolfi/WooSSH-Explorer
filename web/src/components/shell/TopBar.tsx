import { useMemo, useState } from 'react';
import { activeConnection, useConnectionStore } from '../../state/connectionStore';
import { useUiStore } from '../../state/uiStore';
import { useExplorerStore } from '../../state/explorerStore';
import { useTransferStore, activeTransfers } from '../../state/transferStore';
import { Icon } from '../ui/Icon';
import { IconButton, StatusDot } from '../ui/Primitives';
import { Menu } from '../ui/Overlays';
import { formatBytes } from '../../lib/format';
import { useT } from '../../i18n/useT';
import { setLocale } from '../../i18n';

export function TopBar() {
  const { t, locale } = useT();
  const connections = useConnectionStore((s) => s.connections);
  const active = useConnectionStore(activeConnection);
  const setActive = useConnectionStore((s) => s.setActive);
  const disconnect = useConnectionStore((s) => s.disconnect);
  const reconnect = useConnectionStore((s) => s.reconnect);
  const profiles = useConnectionStore((s) => s.profiles);

  const theme = useUiStore((s) => s.theme);
  const toggleTheme = useUiStore((s) => s.toggleTheme);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const toggleInspector = useUiStore((s) => s.toggleInspector);
  const setServerStatsOpen = useUiStore((s) => s.setServerStatsOpen);
  const setKnownHostsOpen = useUiStore((s) => s.setKnownHostsOpen);
  const setDiagnosticsOpen = useUiStore((s) => s.setDiagnosticsOpen);
  const sidebarOpen = useUiStore((s) => s.sidebarOpen);
  const inspectorOpen = useUiStore((s) => s.inspectorOpen);
  const setCommandPalette = useUiStore((s) => s.setCommandPalette);
  const openConnectionDialog = useUiStore((s) => s.openConnectionDialog);
  const pushToast = useUiStore((s) => s.pushToast);

  const openFilesTab = useExplorerStore((s) => s.openFilesTab);
  const openTerminalTab = useExplorerStore((s) => s.openTerminalTab);

  const transfers = useTransferStore((s) => s.transfers);
  const live = activeTransfers(transfers);

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const statusTone = useMemo(() => {
    if (!active) return 'slate';
    if (active.status === 'authenticated') return 'mint';
    if (active.status === 'connecting') return 'amber';
    return 'danger';
  }, [active]);

  const home = active?.serverInfo?.home;

  return (
    <header className="topbar hairline-b">
      <div className="topbar__brand">
        <span className="brand__mark" aria-hidden="true">
          <Icon name="terminal" size={16} strokeWidth={1.35} />
        </span>
        <span className="brand__name">WooSSH Explorer</span>
      </div>

      <div className="topbar__connection">
        {active ? (
          <>
            <button
              type="button"
              className="conn-chip"
              onClick={(e) => setMenu({ x: e.clientX, y: e.clientY + 8 })}
              aria-haspopup="menu"
            >
              <StatusDot tone={statusTone} pulse={active.status === 'connecting'} />
              <span className="conn-chip__label truncate">{active.label}</span>
              <span className="conn-chip__host mono truncate">
                {active.username}@{active.host}:{active.port}
              </span>
              {active.latencyMs !== null && active.status === 'authenticated' ? (
                <span className="conn-chip__latency mono">{active.latencyMs} ms</span>
              ) : null}
              <Icon name="chevrons-up-down" size={13} />
            </button>
            <div className="topbar__quick">
              <IconButton
                icon="folder"
                label="Browse home directory"
                onClick={() => active.serverInfo && openFilesTab(active.id, active.serverInfo.home)}
                disabled={active.status !== 'authenticated'}
              />
              <IconButton
                icon="terminal"
                label="Open terminal"
                onClick={() => openTerminalTab(active.id, active.label)}
                disabled={active.status !== 'authenticated'}
              />
              <IconButton
                icon="transfer"
                label="Transfers"
                onClick={() => useUiStore.getState().toggleDock('transfers')}
                badge={live.length || undefined}
              />
            </div>
          </>
        ) : (
          <button type="button" className="btn btn--primary btn--md" onClick={() => openConnectionDialog()}>
            <Icon name="plug" size={14} />
            <span className="btn__label">New connection</span>
          </button>
        )}
      </div>

      <div className="topbar__actions">
        <button
          type="button"
          className="palette-trigger"
          onClick={() => setCommandPalette(true)}
          aria-label="Open command palette"
        >
          <Icon name="search" size={14} />
          <span>Search or run a command</span>
          <kbd className="kbd">Ctrl K</kbd>
        </button>
        <IconButton
          icon="panel-left"
          label={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
          active={sidebarOpen}
          onClick={toggleSidebar}
        />
        <IconButton
          icon="panel-right"
          label={t(inspectorOpen ? 'topbar.hideInspector' : 'topbar.showInspector')}
          active={inspectorOpen}
          onClick={toggleInspector}
        />
        <button
          type="button"
          className="icon-btn icon-btn--ghost topbar__lang"
          title={`${t('topbar.language')}: ${locale === 'ru' ? 'English' : 'Русский'}`}
          aria-label={`${t('topbar.language')}: ${locale === 'ru' ? 'English' : 'Русский'}`}
          onClick={() => setLocale(locale === 'ru' ? 'en' : 'ru')}
        >
          {locale.toUpperCase()}
        </button>
        <IconButton
          icon={theme === 'dark' ? 'sun' : 'moon'}
          label={t(theme === 'dark' ? 'topbar.themeToLight' : 'topbar.themeToDark')}
          onClick={toggleTheme}
        />
      </div>

      {menu && active ? (
        <Menu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          minWidth={240}
          items={[
            ...connections.map((connection) => ({
              id: `switch-${connection.id}`,
              label: `${connection.label}  ·  ${connection.username}@${connection.host}`,
              icon: 'server' as const,
              onSelect: () => {
                setActive(connection.id);
                if (connection.serverInfo) openFilesTab(connection.id, connection.serverInfo.home);
              },
            })),
            {
              id: 'sep',
              label: '-',
            },
            {
              id: 'home',
              label: home ? 'Open ~ (home directory)' : 'Open home directory',
              icon: 'home',
              disabled: !home,
              onSelect: () => home && openFilesTab(active.id, home),
            },
            {
              id: 'root',
              label: 'Open /',
              icon: 'drive',
              onSelect: () => openFilesTab(active.id, '/'),
            },
            {
              id: 'terminal',
              label: 'Open terminal',
              icon: 'terminal',
              onSelect: () => openTerminalTab(active.id, active.label),
            },
            {
              id: 'reconnect',
              label: 'Reconnect',
              icon: 'refresh',
              onSelect: () => {
                void reconnect(active.id).catch((error: unknown) =>
                  pushToast({
                    level: 'error',
                    title: 'Reconnect failed',
                    detail: error instanceof Error ? error.message : undefined,
                  }),
                );
              },
            },
            {
              id: 'stats',
              label: t('topbar.stats'),
              icon: 'server',
              separatorBefore: true,
              onSelect: () => setServerStatsOpen(true),
            },
            {
              id: 'known-hosts',
              label: t('topbar.knownHosts'),
              icon: 'shield',
              onSelect: () => setKnownHostsOpen(true),
            },
            {
              id: 'diagnostics',
              label: t('topbar.diagnostics'),
              icon: 'terminal',
              onSelect: () => setDiagnosticsOpen(true),
            },
            {
              id: 'save',
              label: 'Save as profile',
              icon: 'plus',
              separatorBefore: true,
              onSelect: () =>
                openConnectionDialog({
                  host: active.host,
                  username: active.username,
                  port: active.port,
                }),
            },
            {
              id: 'disconnect',
              label: 'Disconnect',
              icon: 'power',
              tone: 'danger',
              onSelect: () => {
                void disconnect(active.id).catch(() => undefined);
              },
            },
          ]}
        />
      ) : null}

      {profiles.length === 0 && connections.length === 0 ? null : null}
    </header>
  );
}
