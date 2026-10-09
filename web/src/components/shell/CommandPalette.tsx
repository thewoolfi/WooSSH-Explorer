import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useConnectionStore } from '../../state/connectionStore';
import { useExplorerStore } from '../../state/explorerStore';
import { useUiStore } from '../../state/uiStore';
import { useTransferStore } from '../../state/transferStore';
import { Icon, type IconName } from '../ui/Icon';
import { isTextTarget } from '../../lib/hooks';
import { normalizeRemotePath } from '../../lib/path';
import { useT } from '../../i18n/useT';
import { setLocale } from '../../i18n';
import { desktopInfo, openWithOs } from '../../lib/desktop';

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: IconName;
  group: string;
  shortcut?: string;
  run: () => void;
}

export function CommandPalette() {
  const open = useUiStore((s) => s.commandPaletteOpen);
  const setOpen = useUiStore((s) => s.setCommandPalette);
  const openConnectionDialog = useUiStore((s) => s.openConnectionDialog);
  const toggleTheme = useUiStore((s) => s.toggleTheme);
  const setShowHidden = useUiStore((s) => s.setShowHidden);
  const showHidden = useUiStore((s) => s.showHidden);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const toggleInspector = useUiStore((s) => s.toggleInspector);
  const setDockView = useUiStore((s) => s.setDockView);
  const setServerStatsOpen = useUiStore((s) => s.setServerStatsOpen);
  const setKnownHostsOpen = useUiStore((s) => s.setKnownHostsOpen);
  const setDiagnosticsOpen = useUiStore((s) => s.setDiagnosticsOpen);
  const { t, locale } = useT();

  const connections = useConnectionStore((s) => s.connections);
  const setActive = useConnectionStore((s) => s.setActive);
  const profiles = useConnectionStore((s) => s.profiles);

  const tabs = useExplorerStore((s) => s.tabs);
  const activeTabId = useExplorerStore((s) => s.activeTabId);
  const openFilesTab = useExplorerStore((s) => s.openFilesTab);
  const openTerminalTab = useExplorerStore((s) => s.openTerminalTab);
  const openTransfersTab = useExplorerStore((s) => s.openTransfersTab);

  const clearFinished = useTransferStore((s) => s.clearFinished);

  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  const activeConnection =
    connections.find((c) => c.id === useConnectionStore.getState().activeId) ?? null;
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null;
  const currentPath = activeTab?.kind === 'files' ? activeTab.path : null;

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [];
    const connected = activeConnection?.status === 'authenticated' ? activeConnection : null;
    const home = connected?.serverInfo?.home ?? null;

    for (const connection of connections) {
      const isConnected = connection.status === 'authenticated';
      list.push({
        id: `open-${connection.id}`,
        label: `Open ${connection.label}`,
        hint: `${connection.username}@${connection.host}:${connection.port}`,
        icon: 'server',
        group: 'Hosts',
        run: () => {
          setActive(connection.id);
          if (isConnected) openFilesTab(connection.id, connection.serverInfo?.home ?? '/');
        },
      });
      if (isConnected) {
        list.push({
          id: `terminal-${connection.id}`,
          label: `Terminal on ${connection.label}`,
          icon: 'terminal',
          group: 'Hosts',
          run: () => openTerminalTab(connection.id, connection.label),
        });
      }
    }

    for (const profile of profiles) {
      if (connections.some((c) => c.host === profile.host && c.username === profile.username)) continue;
      list.push({
        id: `profile-${profile.id}`,
        label: `Connect to ${profile.label || profile.host}`,
        hint: `${profile.username}@${profile.host}:${profile.port}`,
        icon: 'plug',
        group: 'Hosts',
        run: () =>
          openConnectionDialog({
            profile,
            host: profile.host,
            username: profile.username,
            port: profile.port,
          }),
      });
    }

    if (connected) {
      list.push(
        {
          id: 'go-home',
          label: 'Go to home directory',
          hint: home ?? undefined,
          icon: 'home',
          group: 'Navigate',
          run: () => home && openFilesTab(connected.id, home),
        },
        {
          id: 'go-root',
          label: 'Go to root',
          hint: '/',
          icon: 'drive',
          group: 'Navigate',
          run: () => openFilesTab(connected.id, '/'),
        },
        {
          id: 'go-tmp',
          label: 'Go to /tmp',
          icon: 'folder',
          group: 'Navigate',
          run: () => openFilesTab(connected.id, '/tmp'),
        },
        {
          id: 'go-var-log',
          label: 'Go to /var/log',
          icon: 'folder',
          group: 'Navigate',
          run: () => openFilesTab(connected.id, '/var/log'),
        },
      );
    }

    if (activeTab?.kind === 'files') {
      const tabId = activeTab.id;
      list.push(
        {
          id: 'refresh',
          label: 'Refresh this folder',
          icon: 'refresh',
          group: 'View',
          shortcut: 'F5',
          run: () => void useExplorerStore.getState().refresh(tabId),
        },
        {
          id: 'mkdir',
          label: 'New folder…',
          icon: 'folder-plus',
          group: 'File',
          shortcut: 'Ctrl ⇧ N',
          run: () => window.dispatchEvent(new CustomEvent('ssh-explorer:new-folder')),
        },
        {
          id: 'upload',
          label: 'Upload files…',
          icon: 'upload',
          group: 'File',
          run: () => window.dispatchEvent(new CustomEvent('ssh-explorer:upload')),
        },
      );
    }

    list.push(
      {
        id: 'new-connection',
        label: 'New connection…',
        icon: 'plug',
        group: 'Actions',
        shortcut: 'Ctrl N',
        run: () => openConnectionDialog(),
      },
      {
        id: 'transfers',
        label: 'Open transfer manager',
        icon: 'transfer',
        group: 'Actions',
        run: () => openTransfersTab(),
      },
      {
        id: 'dock',
        label: 'Toggle transfer queue panel',
        icon: 'layers',
        group: 'Actions',
        run: () => setDockView('transfers'),
      },
      {
        id: 'theme',
        label: 'Toggle light / dark theme',
        icon: 'sun',
        group: 'View',
        run: () => toggleTheme(),
      },
      {
        id: 'dotfiles',
        label: showHidden ? 'Hide dotfiles' : 'Show dotfiles',
        icon: 'eye',
        group: 'View',
        run: () => setShowHidden(!showHidden),
      },
      {
        id: 'sidebar',
        label: 'Toggle sidebar',
        icon: 'panel-left',
        group: 'View',
        shortcut: 'Ctrl B',
        run: () => toggleSidebar(),
      },
      {
        id: 'inspector',
        label: 'Toggle inspector',
        icon: 'panel-right',
        group: 'View',
        shortcut: 'Ctrl I',
        run: () => toggleInspector(),
      },
      {
        id: 'clear-transfers',
        label: 'Clear finished transfers',
        icon: 'trash',
        group: 'Actions',
        run: () => void clearFinished(),
      },
      {
        id: 'server-stats',
        label: t('palette.serverStats'),
        icon: 'server',
        group: 'Actions',
        run: () => setServerStatsOpen(true),
      },
      {
        id: 'known-hosts',
        label: t('palette.knownHosts'),
        icon: 'shield',
        group: 'Actions',
        run: () => setKnownHostsOpen(true),
      },
      {
        id: 'diagnostics',
        label: t('topbar.diagnostics'),
        icon: 'terminal',
        group: 'Actions',
        run: () => setDiagnosticsOpen(true),
      },
      {
        id: 'language',
        label: t('palette.switchLanguage'),
        icon: 'command',
        group: 'View',
        run: () => setLocale(locale === 'ru' ? 'en' : 'ru'),
      },
      // The native menu used to hold these; on Windows and Linux it is gone, because the
      // system draws it and it cannot be themed to match the application.
      {
        id: 'open-downloads',
        label: t('palette.openDownloads'),
        icon: 'folder',
        group: 'Actions',
        run: () => void desktopInfo().then((info) => info && openWithOs(info.downloadDir)),
      },
      {
        id: 'open-config',
        label: t('palette.openConfig'),
        icon: 'settings',
        group: 'Actions',
        run: () => void desktopInfo().then((info) => info && openWithOs(info.stateDir)),
      },
      {
        id: 'open-logs',
        label: t('palette.openLogs'),
        icon: 'file',
        group: 'Actions',
        run: () =>
          void desktopInfo().then((info) => info && openWithOs(info.logFilePath ?? info.logDir)),
      },
    );

    return list;
  }, [
    connections,
    profiles,
    activeConnection,
    activeTab,
    showHidden,
    clearFinished,
    locale,
    openConnectionDialog,
    openFilesTab,
    openTerminalTab,
    openTransfersTab,
    setActive,
    setDockView,
    setKnownHostsOpen,
    setServerStatsOpen,
    setShowHidden,
    t,
    toggleInspector,
    toggleSidebar,
    toggleTheme,
  ]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return commands;
    const scored = commands
      .map((command) => ({ command, score: score(command, needle) }))
      .filter((row) => row.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.map((row) => row.command);
  }, [commands, query]);

  const trimmed = query.trim();
  const looksLikePath = trimmed.startsWith('/') || trimmed.startsWith('~');

  useEffect(() => {
    if (!open) {
      setQuery('');
      setIndex(0);
      return;
    }
    const id = window.setTimeout(() => inputRef.current?.focus(), 10);
    return () => window.clearTimeout(id);
  }, [open]);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  useEffect(() => {
    const node = listRef.current?.children[index] as HTMLElement | undefined;
    node?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  if (!open) return null;

  const commit = (command: Command) => {
    setOpen(false);
    command.run();
  };

  const commitPath = () => {
    if (!activeConnection || !trimmed) return;
    setOpen(false);
    openFilesTab(activeConnection.id, normalizeRemotePath(trimmed));
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setIndex((i) => Math.min(i + 1, Math.max(0, filtered.length - 1)));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setIndex((i) => Math.max(0, i - 1));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (looksLikePath && activeConnection) commitPath();
      else {
        const command = filtered[index];
        if (command) commit(command);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setOpen(false);
    }
  };

  const groups = groupBy(filtered);

  return createPortal(
    <div className="scrim scrim--palette" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onKeyDown={onKeyDown}>
        <div className="palette__input">
          <Icon name="search" size={15} />
          <input
            ref={inputRef}
            value={query}
            placeholder="Type a command, a host, or an absolute path…"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (isTextTarget(event.target)) return;
            }}
            aria-label="Command"
          />
          <kbd className="kbd">Esc</kbd>
        </div>

        <div className="palette__body scroll-y">
          {looksLikePath && activeConnection ? (
            <button type="button" className="palette__path" onClick={commitPath}>
              <Icon name="folder-open" size={15} />
              <span className="palette__path-label">
                Go to <code className="mono">{normalizeRemotePath(trimmed)}</code>
              </span>
              <kbd className="kbd">Enter</kbd>
            </button>
          ) : null}

          {filtered.length === 0 && !looksLikePath ? (
            <p className="palette__empty">No matching command.</p>
          ) : (
            <ul ref={listRef} className="palette__list">
              {groups.map(([group, items]) => (
                <li key={group} className="palette__group">
                  <p className="palette__group-label label">{group}</p>
                  <ul>
                    {items.map((command) => {
                      const flatIndex = filtered.indexOf(command);
                      return (
                        <li key={command.id}>
                          <button
                            type="button"
                            className={`palette__item${flatIndex === index ? ' is-active' : ''}`}
                            onMouseEnter={() => setIndex(flatIndex)}
                            onClick={() => commit(command)}
                          >
                            <Icon name={command.icon} size={15} />
                            <span className="palette__item-label truncate">{command.label}</span>
                            {command.hint ? (
                              <span className="palette__item-hint mono truncate">{command.hint}</span>
                            ) : null}
                            {command.shortcut ? <kbd className="kbd">{command.shortcut}</kbd> : null}
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function groupBy(commands: Command[]): [string, Command[]][] {
  const map = new Map<string, Command[]>();
  for (const command of commands) {
    const bucket = map.get(command.group);
    if (bucket) bucket.push(command);
    else map.set(command.group, [command]);
  }
  return [...map.entries()];
}

/** Light subsequence scoring — enough for a palette. */
function score(command: Command, needle: string): number {
  const label = command.label.toLowerCase();
  if (label.startsWith(needle)) return 100;
  if (label.includes(needle)) return 60;
  const hint = (command.hint ?? '').toLowerCase();
  if (hint.includes(needle)) return 40;
  let i = 0;
  for (const char of label) {
    if (char === needle[i]) i += 1;
    if (i === needle.length) return 20;
  }
  return 0;
}
