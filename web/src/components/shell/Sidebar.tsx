import { useMemo, useState } from 'react';
import { useConnectionStore } from '../../state/connectionStore';
import { useExplorerStore } from '../../state/explorerStore';
import { useUiStore } from '../../state/uiStore';
import { activeTransfers, totalSpeed, useTransferStore } from '../../state/transferStore';
import { Icon } from '../ui/Icon';
import { IconButton, Progress, StatusDot } from '../ui/Primitives';
import { Menu, type MenuItem } from '../ui/Overlays';
import { formatBytes, formatSpeed } from '../../lib/format';
import { planProfileConnect, secretIdFor } from '../../lib/connectProfile';
import { useT, type Translator } from '../../i18n/useT';
import type { ConnectionSummary, SavedProfile } from '../../api/types';

interface SidebarRow {
  key: string;
  profile: SavedProfile | null;
  connection: ConnectionSummary | null;
  label: string;
  sub: string;
  color: string;
  status: 'online' | 'connecting' | 'offline' | 'error';
  /** Set when the vault holds a credential for this host triple. */
  secretId: string | null;
}

export function Sidebar() {
  const connections = useConnectionStore((s) => s.connections);
  const profiles = useConnectionStore((s) => s.profiles);
  const activeId = useConnectionStore((s) => s.activeId);
  const setActive = useConnectionStore((s) => s.setActive);
  const disconnect = useConnectionStore((s) => s.disconnect);
  const reconnect = useConnectionStore((s) => s.reconnect);
  const deleteProfile = useConnectionStore((s) => s.deleteProfile);
  const secrets = useConnectionStore((s) => s.secrets);
  const forgetSecret = useConnectionStore((s) => s.forgetSecret);
  const connect = useConnectionStore((s) => s.connect);
  /** Row currently being dialled, so a double-click cannot start two handshakes. */
  const [busyRow, setBusyRow] = useState<string | null>(null);
  /** Selected row; a saved host that is not connected has no connection to highlight. */
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  const openFilesTab = useExplorerStore((s) => s.openFilesTab);
  const openTerminalTab = useExplorerStore((s) => s.openTerminalTab);

  const openConnectionDialog = useUiStore((s) => s.openConnectionDialog);
  const toggleDock = useUiStore((s) => s.toggleDock);
  const pushToast = useUiStore((s) => s.pushToast);
  const setNetToolsOpen = useUiStore((s) => s.setNetToolsOpen);

  const transfers = useTransferStore((s) => s.transfers);
  const cancelTransfer = useTransferStore((s) => s.cancel);
  const clearFinished = useTransferStore((s) => s.clearFinished);

  const [menu, setMenu] = useState<{ x: number; y: number; row: SidebarRow } | null>(null);
  const { t } = useT();

  const rows = useMemo<SidebarRow[]>(() => {
    const secretFor = (host: string, port: number, username: string): string | null =>
      secrets.find((s) => s.host === host && s.port === port && s.username === username)?.id ?? null;

    const byProfile = new Map<string, ConnectionSummary>();
    const orphans: ConnectionSummary[] = [];
    for (const connection of connections) {
      const match = profiles.find(
        (p) => p.host === connection.host && p.port === connection.port && p.username === connection.username,
      );
      if (match) byProfile.set(match.id, connection);
      else orphans.push(connection);
    }

    const list: SidebarRow[] = [];
    for (const profile of profiles) {
      const connection = byProfile.get(profile.id) ?? null;
      const rawLabel = connection?.label ?? profile.label ?? '';
      list.push({
        key: profile.id,
        profile,
        connection,
        // The generated label already repeats the credentials, so fall back to
        // the bare host instead of printing "user@host" twice.
        label: displayLabel(rawLabel, profile.username, profile.host),
        sub: `${profile.username}@${profile.host}:${profile.port}`,
        color: profile.color ?? 'slate',
        status: statusOf(connection, activeId === connection?.id),
        secretId: secretFor(profile.host, profile.port, profile.username),
      });
    }
    for (const connection of orphans) {
      list.push({
        key: connection.id,
        profile: null,
        connection,
        label: displayLabel(connection.label, connection.username, connection.host),
        sub: `${connection.username}@${connection.host}:${connection.port}`,
        color: connection.color ?? 'slate',
        status: statusOf(connection, activeId === connection.id),
        secretId: secretFor(connection.host, connection.port, connection.username),
      });
    }
    return list;
  }, [connections, profiles, activeId, secrets]);

  /**
   * Connects a saved host without opening the dialog, using the credential the vault
   * already holds. Falls back to the dialog when there is nothing usable to connect with,
   * so a double-click never ends in an authentication error the user cannot explain.
   */
  const connectRow = async (row: SidebarRow) => {
    if (!row.profile || row.connection?.status === 'authenticated') {
      openRow(row);
      return;
    }
    if (busyRow !== null) return;

    const hasStoredSecret =
      secretIdFor(secrets, row.profile.host, row.profile.port, row.profile.username) !== null;
    const plan = planProfileConnect({ profile: row.profile, hasStoredSecret });
    if (plan.kind === 'needs-dialog') {
      openConnectionDialog({
        profile: row.profile,
        host: row.profile.host,
        username: row.profile.username,
        port: row.profile.port,
      });
      pushToast({ level: 'info', title: t('sidebar.credentialsNeeded') });
      return;
    }

    setBusyRow(row.key);
    try {
      const { connection } = await connect(plan.request);
      setActive(connection.id);
    } catch (error) {
      pushToast({
        level: 'error',
        title: t('conn.connectFailed'),
        detail: error instanceof Error ? error.message : undefined,
      });
    } finally {
      setBusyRow(null);
    }
  };

  const openRow = (row: SidebarRow) => {
    // A connected host is worth acting on immediately: one click puts you in its files.
    if (row.connection && row.connection.status === 'authenticated') {
      setActive(row.connection.id);
      openFilesTab(row.connection.id, row.connection.serverInfo?.home ?? '/');
      return;
    }
    if (row.connection) {
      setActive(row.connection.id);
      return;
    }
    // A saved host that is not connected is only selected here. Connecting is the
    // double-click (or the menu), because a single click that opened a dialog made the
    // double-click impossible to perform.
  };

  const live = activeTransfers(transfers);
  const finished = transfers.filter((t) => t.state !== 'active' && t.state !== 'queued');
  const speed = totalSpeed(transfers);

  return (
    <aside className="sidebar hairline-r">
      <div className="sidebar__scroll scroll-y">
        <section className="side-section">
          <header className="side-section__head">
            <h2 className="label">{t('sidebar.connections')}</h2>
            <span className="side-section__count mono">{rows.length}</span>
            <IconButton
              icon="plus"
              label={t('topbar.newConnection')}
              size={14}
              onClick={() => openConnectionDialog()}
            />
          </header>

          {rows.length === 0 ? null : (
            <ul className="host-list">
              {rows.map((row) => (
                <li key={row.key}>
                  <button
                    type="button"
                    className={`host-row${row.connection && row.connection.id === activeId ? ' is-active' : ''}${
                      row.status === 'offline' ? ' is-offline' : ''
                    }${selectedKey === row.key ? ' is-selected' : ''}${
                      busyRow === row.key ? ' is-busy' : ''
                    }`}
                    onClick={() => {
                      setSelectedKey(row.key);
                      openRow(row);
                    }}
                    onDoubleClick={() => void connectRow(row)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      setMenu({ x: event.clientX, y: event.clientY, row });
                    }}
                    title={`${row.sub}${row.connection?.statusDetail ? ` — ${row.connection.statusDetail}` : ''}`}
                  >
                    <span className={`host-row__dot host-row__dot--${row.color}`}>
                      <StatusDot tone={dotTone(row.status, row.color)} pulse={row.status === 'connecting'} />
                    </span>
                    <span className="host-row__text">
                      <span className="host-row__label truncate">{row.label}</span>
                      <span className="host-row__sub mono truncate">{row.sub}</span>
                    </span>
                    {row.secretId ? (
                      <span className="host-row__badge" title={t('sidebar.savedCredentials')}>
                        <Icon name="shield" size={12} />
                      </span>
                    ) : null}
                    {row.connection?.latencyMs != null && row.connection.status === 'authenticated' ? (
                      <span className="host-row__meta mono">{row.connection.latencyMs} ms</span>
                    ) : null}
                    <span
                      className="host-row__more"
                      role="presentation"
                      onClick={(event) => {
                        event.stopPropagation();
                        setMenu({ x: event.clientX, y: event.clientY, row });
                      }}
                    >
                      <Icon name="dots" size={14} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <button type="button" className="side-add" onClick={() => openConnectionDialog()}>
            <Icon name="plus" size={14} />
            <span>{t('topbar.newConnection')}</span>
          </button>
        </section>

        <section className="side-section">
          <header className="side-section__head">
            <button type="button" className="side-section__toggle" onClick={() => toggleDock('transfers')}>
              <h2 className="label">{t('sidebar.transfers')}</h2>
              {live.length ? <span className="side-section__count mono">{live.length}</span> : null}
            </button>
            {finished.length ? (
              <IconButton
                icon="trash"
                label={t('sidebar.clearFinished')}
                size={14}
                onClick={() => void clearFinished().catch(() => undefined)}
              />
            ) : null}
          </header>

          {live.length === 0 && finished.length === 0 ? (
            <p className="side-empty">{t('sidebar.nothingTransferring')}</p>
          ) : (
            <ul className="mini-queue">
              {[...live, ...finished].slice(0, 6).map((transfer) => (
                <li key={transfer.id} className={`mini-xfer is-${transfer.state}`}>
                  <div className="mini-xfer__top">
                    <Icon
                      name={transfer.direction === 'upload' ? 'upload' : 'download'}
                      size={12}
                      className="mini-xfer__dir"
                    />
                    <span className="mini-xfer__name truncate">{transfer.name}</span>
                    {transfer.state === 'active' ? (
                      <span className="mini-xfer__speed mono">{formatSpeed(transfer.bytesPerSecond)}</span>
                    ) : transfer.state === 'done' ? (
                      <Icon name="check" size={12} className="mini-xfer__ok" />
                    ) : transfer.state === 'error' ? (
                      <Icon name="alert" size={12} className="mini-xfer__err" />
                    ) : (
                      <button
                        type="button"
                        className="mini-xfer__cancel"
                        aria-label={`${t('xfer.cancel')} — ${transfer.name}`}
                        onClick={() => void cancelTransfer(transfer.id).catch(() => undefined)}
                      >
                        <Icon name="close" size={11} />
                      </button>
                    )}
                  </div>
                  {transfer.state === 'active' || transfer.state === 'queued' ? (
                    <Progress value={transfer.transferred} max={transfer.size > 0 ? transfer.size : 100} />
                  ) : null}
                </li>
              ))}
              {speed > 0 ? (
                <li className="mini-queue__total mono">
                  {t('xfer.totalSpeed', { speed: formatBytes(speed, 1) })}
                </li>
              ) : null}
            </ul>
          )}
        </section>
      </div>

      <footer className="sidebar__foot">
        <button
          type="button"
          className="sidebar__foot-btn"
          onClick={() => useUiStore.getState().setCommandPalette(true)}
        >
          <Icon name="command" size={13} />
          <span>{t('sidebar.commands')}</span>
          <kbd className="kbd">Ctrl K</kbd>
        </button>
      </footer>

      {menu ? (
        <Menu
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
          items={hostMenuItems(menu.row, t, {
            onOpen: () => void connectRow(menu.row),
    onPing: () => setNetToolsOpen(true, menu.row.connection?.host ?? menu.row.profile?.host ?? null, 'ping'),
    onTraceroute: () =>
      setNetToolsOpen(true, menu.row.connection?.host ?? menu.row.profile?.host ?? null, 'traceroute'),
            onTerminal: () => {
              const id = menu.row.connection?.id;
              if (id) openTerminalTab(id, menu.row.label);
            },
            onReconnect: () => {
              const id = menu.row.connection?.id;
              if (!id) return;
              void reconnect(id).catch((error: unknown) =>
                pushToast({
                  level: 'error',
                  title: t('conn.reconnectFailed'),
                  detail: error instanceof Error ? error.message : undefined,
                }),
              );
            },
            onEdit: () =>
              openConnectionDialog({
                profile: menu.row.profile,
                host: menu.row.profile?.host ?? menu.row.connection?.host,
                username: menu.row.profile?.username ?? menu.row.connection?.username,
                port: menu.row.profile?.port ?? menu.row.connection?.port,
              }),
            onDisconnect: () => {
              const id = menu.row.connection?.id;
              if (id) void disconnect(id).catch(() => undefined);
            },
            onDelete: () => {
              const id = menu.row.profile?.id;
              if (!id) return;
              void deleteProfile(id).catch((error: unknown) =>
                pushToast({
                  level: 'error',
                  title: t('sidebar.deleteProfileFailed'),
                  detail: error instanceof Error ? error.message : undefined,
                }),
              );
            },
            onForgetSecret: () => {
              const id = menu.row.secretId;
              if (!id) return;
              void forgetSecret(id)
                .then(() => pushToast({ level: 'success', title: t('sidebar.secretRemoved') }))
                .catch((error: unknown) =>
                  pushToast({
                    level: 'error',
                    title: t('sidebar.secretRemoveFailed'),
                    detail: error instanceof Error ? error.message : undefined,
                  }),
                );
            },
          })}
        />
      ) : null}
    </aside>
  );
}

function displayLabel(label: string, username: string, host: string): string {
  const trimmed = label.trim();
  if (!trimmed) return host;
  const generated = `${username}@${host}`;
  if (trimmed === generated || trimmed === host) return host;
  if (trimmed.startsWith(generated)) {
    const rest = trimmed.slice(generated.length).replace(/^[\s·:—-]+/, '');
    return rest || host;
  }
  return trimmed;
}

function statusOf(connection: ConnectionSummary | null, _active: boolean): SidebarRow['status'] {
  if (!connection) return 'offline';
  if (connection.status === 'authenticated') return 'online';
  if (connection.status === 'connecting') return 'connecting';
  if (connection.status === 'error') return 'error';
  return 'offline';
}

function dotTone(status: SidebarRow['status'], color: string): string {
  if (status === 'online') return color;
  if (status === 'connecting') return 'amber';
  if (status === 'error') return 'danger';
  return 'slate';
}

function hostMenuItems(
  row: SidebarRow,
  t: Translator['t'],
  handlers: {
    onOpen: () => void;
    onPing: () => void;
    onTraceroute: () => void;
    onTerminal: () => void;
    onReconnect: () => void;
    onEdit: () => void;
    onDisconnect: () => void;
    onDelete: () => void;
    onForgetSecret: () => void;
  },
): MenuItem[] {
  const connected = row.connection?.status === 'authenticated';
  return [
    { id: 'open', label: connected ? t('sidebar.browseFiles') : t('sidebar.connect'), icon: 'folder', onSelect: handlers.onOpen },
    {
      id: 'terminal',
      label: t('sidebar.openTerminal'),
      icon: 'terminal',
      disabled: !connected,
      onSelect: handlers.onTerminal,
    },
    {
      id: 'reconnect',
      label: t('sidebar.reconnect'),
      icon: 'refresh',
      disabled: !row.connection,
      onSelect: handlers.onReconnect,
    },
    {
      id: 'ping',
      label: t('sidebar.ping'),
      icon: 'activity',
      separatorBefore: true,
      onSelect: handlers.onPing,
    },
    {
      id: 'traceroute',
      label: t('sidebar.traceroute'),
      icon: 'signal',
      onSelect: handlers.onTraceroute,
    },
    { id: 'edit', label: row.profile ? t('sidebar.editConnection') : t('sidebar.saveAsProfile'), icon: 'pencil', separatorBefore: true, onSelect: handlers.onEdit },
    {
      id: 'disconnect',
      label: t('sidebar.disconnect'),
      icon: 'power',
      disabled: !connected,
      onSelect: handlers.onDisconnect,
    },
    {
      id: 'forget-secret',
      label: t('sidebar.forgetSecret'),
      icon: 'shield',
      disabled: row.secretId === null,
      onSelect: handlers.onForgetSecret,
    },
    {
      id: 'delete',
      label: t('sidebar.deleteProfile'),
      icon: 'trash',
      tone: 'danger',
      disabled: !row.profile,
      separatorBefore: true,
      onSelect: handlers.onDelete,
    },
  ];
}
