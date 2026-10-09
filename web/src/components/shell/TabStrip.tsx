import { useEffect, useMemo, useRef, useState } from 'react';
import { useExplorerStore, type Tab } from '../../state/explorerStore';
import { useConnectionStore } from '../../state/connectionStore';
import { useUiStore } from '../../state/uiStore';
import { useT } from '../../i18n/useT';
import { Icon, type IconName } from '../ui/Icon';
import { IconButton } from '../ui/Primitives';
import { Menu, type MenuItem } from '../ui/Overlays';
import { basenameRemotePath } from '../../lib/path';

function tabIcon(tab: Tab): IconName {
  if (tab.kind === 'terminal') return 'terminal';
  if (tab.kind === 'transfers') return 'transfer';
  return 'folder';
}

/**
 * Two hosts often share the generated `user@host` label — different ports, different
 * machines behind the same name. When that happens the chooser has to say which is which,
 * so the port is appended to every label that is not unique.
 */
function sessionLabels(connections: { id: string; label: string; host: string; port: number }[]): Map<string, string> {
  const counts = new Map<string, number>();
  for (const connection of connections) {
    counts.set(connection.label, (counts.get(connection.label) ?? 0) + 1);
  }
  const labels = new Map<string, string>();
  for (const connection of connections) {
    labels.set(
      connection.id,
      (counts.get(connection.label) ?? 0) > 1
        ? `${connection.label} · ${connection.host}:${connection.port}`
        : connection.label,
    );
  }
  return labels;
}

export function TabStrip() {
  const tabs = useExplorerStore((s) => s.tabs);
  const activeTabId = useExplorerStore((s) => s.activeTabId);
  const activateTab = useExplorerStore((s) => s.activateTab);
  const closeTab = useExplorerStore((s) => s.closeTab);
  const split = useExplorerStore((s) => s.split);
  const toggleSplit = useExplorerStore((s) => s.toggleSplit);
  const openTransfersTab = useExplorerStore((s) => s.openTransfersTab);
  const openTerminalTab = useExplorerStore((s) => s.openTerminalTab);
  const openFilesTab = useExplorerStore((s) => s.openFilesTab);
  const activeConnectionId = useConnectionStore((s) => s.activeId);
  const connections = useConnectionStore((s) => s.connections);
  const profiles = useConnectionStore((s) => s.profiles);
  const setActive = useConnectionStore((s) => s.setActive);
  const openConnectionDialog = useUiStore((s) => s.openConnectionDialog);
  const { t } = useT();

  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const newTabRef = useRef<HTMLButtonElement | null>(null);

  // `Ctrl T` asks the same question as the "+" does, anchored to it.
  useEffect(() => {
    const open = (): void => {
      const rect = newTabRef.current?.getBoundingClientRect();
      setMenu(rect ? { x: rect.left, y: rect.bottom + 4 } : { x: 120, y: 90 });
    };
    window.addEventListener('ssh-explorer:new-tab', open);
    return () => window.removeEventListener('ssh-explorer:new-tab', open);
  }, []);

  const connection = connections.find((c) => c.id === activeConnectionId) ?? null;
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null;

  /**
   * Which colour a tab's dot gets.
   *
   * Colours are remembered as they are seen: a tab outlives its connection (it stays open
   * and shows the error), and losing the dot at exactly that moment would be when it is
   * most useful.
   */
  const colourCache = useRef(new Map<string, string>());
  const colourOf = (connectionId: string | null): string | null => {
    if (!connectionId) return null;
    const live = connections.find((c) => c.id === connectionId);
    if (live?.color) colourCache.current.set(connectionId, live.color);
    return colourCache.current.get(connectionId) ?? null;
  };
  const nameOf = (connectionId: string | null): string | null =>
    connectionId ? (connections.find((c) => c.id === connectionId)?.label ?? null) : null;

  /** Where "in this session" lands: the folder you are already looking at. */
  const currentPath =
    activeTab?.kind === 'files'
      ? activeTab.path
      : (connection?.serverInfo?.home ?? '/');

  /**
   * The chooser behind "+": the current session first, then every other host that is
   * already connected, then the saved ones that still need dialling.
   */
  const items = useMemo<MenuItem[]>(() => {
    const list: MenuItem[] = [];
    const live = connections.filter((c) => c.status === 'authenticated');
    const labels = sessionLabels(live);

    if (connection && connection.status === 'authenticated') {
      list.push({
        id: 'this-session',
        label: t('tabs.inThisSession', { label: labels.get(connection.id) ?? connection.label }),
        icon: 'folder',
        onSelect: () => openFilesTab(connection.id, currentPath, { force: true }),
      });
    }

    const others = live.filter((c) => c.id !== connection?.id);
    if (others.length > 0) {
      if (list.length > 0) list.push({ id: 'sep-live', label: '-' });
      for (const other of others) {
        list.push({
          id: `session-${other.id}`,
          label: `${t('tabs.inSession')} — ${labels.get(other.id) ?? other.label}`,
          icon: 'server',
          onSelect: () => {
            setActive(other.id);
            openFilesTab(other.id, other.serverInfo?.home ?? '/', { force: true });
          },
        });
      }
    }

    // Saved hosts that are not up: choosing one starts the connection, which is the
    // only way a new session can come into existence.
    const offline = profiles.filter(
      (profile) =>
        !live.some(
          (c) => c.host === profile.host && c.port === profile.port && c.username === profile.username,
        ),
    );
    if (offline.length > 0) {
      list.push({ id: 'sep-offline', label: '-' });
      for (const profile of offline) {
        list.push({
          id: `profile-${profile.id}`,
          label: t('tabs.connectTo', { label: profile.label || `${profile.username}@${profile.host}` }),
          icon: 'plug',
          onSelect: () =>
            openConnectionDialog({
              profile,
              host: profile.host,
              username: profile.username,
              port: profile.port,
            }),
        });
      }
    }

    list.push({ id: 'sep-actions', label: '-' });
    list.push({
      id: 'new-connection',
      label: t('tabs.newConnection'),
      icon: 'plus',
      onSelect: () => openConnectionDialog(),
    });
    list.push({
      id: 'terminal',
      label: t('tabs.newTerminal'),
      icon: 'terminal',
      disabled: !connection || connection.status !== 'authenticated',
      onSelect: () => connection && openTerminalTab(connection.id, connection.label, currentPath),
    });
    list.push({
      id: 'transfers',
      label: t('tabs.transferManager'),
      icon: 'transfer',
      onSelect: () => openTransfersTab(),
    });

    return list;
  }, [
    connection,
    connections,
    currentPath,
    openConnectionDialog,
    openFilesTab,
    openTerminalTab,
    openTransfersTab,
    profiles,
    setActive,
    t,
  ]);

  return (
    <div className="tabstrip hairline-b">
      <div className="tabstrip__tabs" role="tablist" aria-label={t('tabs.openViews')}>
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const label = tab.kind === 'files' ? tab.title || basenameRemotePath(tab.path) : tab.title;
          const colour = colourOf(tab.connectionId);
          const owner = nameOf(tab.connectionId);
          const tooltip = [
            owner ? `${owner}` : null,
            tab.kind === 'files' ? tab.path : label,
          ]
            .filter(Boolean)
            .join('\n');
          return (
            <div
              key={tab.id}
              role="tab"
              tabIndex={isActive ? 0 : -1}
              aria-selected={isActive}
              className={`tab${isActive ? ' is-active' : ''} tab--${tab.kind}`}
              onClick={() => activateTab(tab.id)}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  closeTab(tab.id);
                }
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  activateTab(tab.id);
                }
              }}
              title={tooltip}
            >
              {/* Which host this tab belongs to, in that host's colour. */}
              {colour ? (
                <span
                  className={`tab__dot tab__dot--${colour}`}
                  aria-hidden="true"
                  data-connection-color={colour}
                />
              ) : null}
              <Icon name={tabIcon(tab)} size={13} className="tab__icon" />
              <span className="tab__label truncate">{label}</span>
              <button
                type="button"
                className="tab__close"
                aria-label={t('tabs.close', { name: label })}
                onClick={(event) => {
                  event.stopPropagation();
                  closeTab(tab.id);
                }}
              >
                <Icon name="close" size={11} />
              </button>
            </div>
          );
        })}

        {/* Follows the last tab, the way a browser does it. */}
        <button
          type="button"
          ref={newTabRef}
          className="tab__new"
          aria-label={t('tabs.newTab')}
          aria-haspopup="menu"
          title={`${t('tabs.newTabTitle')} (Ctrl T)`}
          data-testid="new-tab"
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setMenu({ x: rect.left, y: rect.bottom + 4 });
          }}
        >
          <Icon name="plus" size={14} />
        </button>
      </div>

      <div className="tabstrip__actions">
        {/* Two folders at once. Tab then moves between the panes instead of the tabs. */}
        <IconButton
          icon="grid"
          label={split ? t('tabs.exitSplit') : t('tabs.split')}
          size={14}
          active={split !== null}
          disabled={tabs.length === 0}
          onClick={() => toggleSplit()}
        />
        <IconButton
          icon="terminal"
          label={t('tabs.newTerminal')}
          size={14}
          disabled={!connection || connection.status !== 'authenticated'}
          onClick={() => connection && openTerminalTab(connection.id, connection.label, currentPath)}
        />
        <IconButton
          icon="transfer"
          label={t('tabs.transferManager')}
          size={14}
          onClick={() => openTransfersTab()}
        />
      </div>

      {menu ? (
        <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={items} minWidth={250} />
      ) : null}
    </div>
  );
}
