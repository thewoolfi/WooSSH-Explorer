import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useT } from '../../i18n/useT';
import type { MessageKey } from '../../i18n';
import { Icon, type IconName } from '../ui/Icon';
import { Button, IconButton } from '../ui/Primitives';
import { useSystemStatsStore } from '../../state/systemStatsStore';
import { useUiStore } from '../../state/uiStore';
import { useCommandHistoryStore } from '../../state/commandHistoryStore';
import { formatRelativeTime } from '../../lib/terminalHistory';

export type PkgManager = 'apt' | 'dnf' | 'pacman' | 'apk' | 'auto';

export interface CommandItem {
  id: string;
  category: 'updates' | 'monitor' | 'network' | 'system';
  icon: IconName;
  titleKey: MessageKey;
  descKey: MessageKey;
  getCommand: (pkg: PkgManager) => string;
}

export const COMMAND_DEFINITIONS: CommandItem[] = [
  // Updates & Packages
  {
    id: 'check-updates',
    category: 'updates',
    icon: 'refresh',
    titleKey: 'term.cmdCheckUpdates',
    descKey: 'term.cmdCheckUpdatesDesc',
    getCommand: (pkg) => {
      switch (pkg) {
        case 'dnf':
          return 'sudo dnf check-update';
        case 'pacman':
          return 'sudo pacman -Sy';
        case 'apk':
          return 'sudo apk update';
        case 'auto':
          return 'if command -v apt >/dev/null 2>&1; then sudo apt update; elif command -v dnf >/dev/null 2>&1; then sudo dnf check-update; elif command -v pacman >/dev/null 2>&1; then sudo pacman -Sy; elif command -v apk >/dev/null 2>&1; then sudo apk update; fi';
        case 'apt':
        default:
          return 'sudo apt update';
      }
    },
  },
  {
    id: 'upgrade-packages',
    category: 'updates',
    icon: 'arrow-up',
    titleKey: 'term.cmdUpgrade',
    descKey: 'term.cmdUpgradeDesc',
    getCommand: (pkg) => {
      switch (pkg) {
        case 'dnf':
          return 'sudo dnf upgrade -y';
        case 'pacman':
          return 'sudo pacman -Syu --noconfirm';
        case 'apk':
          return 'sudo apk upgrade';
        case 'auto':
          return 'if command -v apt >/dev/null 2>&1; then sudo apt upgrade -y; elif command -v dnf >/dev/null 2>&1; then sudo dnf upgrade -y; elif command -v pacman >/dev/null 2>&1; then sudo pacman -Syu --noconfirm; elif command -v apk >/dev/null 2>&1; then sudo apk upgrade; fi';
        case 'apt':
        default:
          return 'sudo apt upgrade -y';
      }
    },
  },
  {
    id: 'clean-packages',
    category: 'updates',
    icon: 'trash',
    titleKey: 'term.cmdClean',
    descKey: 'term.cmdCleanDesc',
    getCommand: (pkg) => {
      switch (pkg) {
        case 'dnf':
          return 'sudo dnf autoremove -y && sudo dnf clean all';
        case 'pacman':
          return 'sudo pacman -Sc --noconfirm';
        case 'apk':
          return 'sudo apk cache clean';
        case 'auto':
          return 'if command -v apt >/dev/null 2>&1; then sudo apt autoremove -y && sudo apt clean; elif command -v dnf >/dev/null 2>&1; then sudo dnf autoremove -y && sudo dnf clean all; elif command -v pacman >/dev/null 2>&1; then sudo pacman -Sc --noconfirm; elif command -v apk >/dev/null 2>&1; then sudo apk cache clean; fi';
        case 'apt':
        default:
          return 'sudo apt autoremove -y && sudo apt clean';
      }
    },
  },

  // Monitoring & Resources
  {
    id: 'process-monitor',
    category: 'monitor',
    icon: 'activity',
    titleKey: 'term.cmdHtop',
    descKey: 'term.cmdHtopDesc',
    getCommand: () => 'htop || top',
  },
  {
    id: 'disk-usage',
    category: 'monitor',
    icon: 'drive',
    titleKey: 'term.cmdDisk',
    descKey: 'term.cmdDiskDesc',
    getCommand: () => 'df -h -x tmpfs -x devtmpfs -x squashfs',
  },
  {
    id: 'memory-usage',
    category: 'monitor',
    icon: 'sliders',
    titleKey: 'term.cmdMemory',
    descKey: 'term.cmdMemoryDesc',
    getCommand: () => 'free -h',
  },

  // Network & Services
  {
    id: 'failed-services',
    category: 'network',
    icon: 'alert',
    titleKey: 'term.cmdFailedServices',
    descKey: 'term.cmdFailedServicesDesc',
    getCommand: () => 'systemctl --failed',
  },
  {
    id: 'listening-ports',
    category: 'network',
    icon: 'plug',
    titleKey: 'term.cmdPorts',
    descKey: 'term.cmdPortsDesc',
    getCommand: () => 'sudo ss -tulpn',
  },

  // System & Logs
  {
    id: 'system-logs',
    category: 'system',
    icon: 'file-text',
    titleKey: 'term.cmdLogs',
    descKey: 'term.cmdLogsDesc',
    getCommand: () => 'journalctl -xe -n 50 --no-pager',
  },
  {
    id: 'system-info',
    category: 'system',
    icon: 'info',
    titleKey: 'term.cmdSysInfo',
    descKey: 'term.cmdSysInfoDesc',
    getCommand: () => 'uname -a && cat /etc/os-release',
  },
];

export interface TerminalInspectorProps {
  connectionId: string;
  width: number;
  onWidthChange: (width: number) => void;
  onWidthReset: () => void;
  onClose: () => void;
  onRunCommand: (command: string) => void;
  onInsertCommand?: (command: string) => void;
}

export function TerminalInspector({
  connectionId,
  width,
  onWidthChange,
  onWidthReset,
  onClose,
  onRunCommand,
  onInsertCommand,
}: TerminalInspectorProps) {
  const { t } = useT();
  const activeTab = useUiStore((s) => s.inspectorTab);
  const setActiveTab = useUiStore((s) => s.setInspectorTab);

  const [pkgManager, setPkgManager] = useState<PkgManager>('apt');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [executedId, setExecutedId] = useState<string | null>(null);

  // History state
  const [historySearch, setHistorySearch] = useState('');
  const [showConfirmClear, setShowConfirmClear] = useState(false);

  const historyCommands = useCommandHistoryStore((s) => s.commands);
  const removeHistoryCommand = useCommandHistoryStore((s) => s.removeCommand);
  const clearHistoryStore = useCommandHistoryStore((s) => s.clearHistory);

  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const stats = useSystemStatsStore((s) => (connectionId ? s.byConnection[connectionId]?.stats : undefined));

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      onWidthChange(drag.startWidth - (event.clientX - drag.startX));
    },
    [onWidthChange],
  );

  const endDrag = useCallback(() => {
    dragRef.current = null;
    document.body.classList.remove('is-resizing-x');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', endDrag);
  }, [onPointerMove]);

  useEffect(() => () => endDrag(), [endDrag]);

  const handleRun = (id: string, cmd: string) => {
    onRunCommand(cmd);
    setExecutedId(id);
    window.setTimeout(() => {
      setExecutedId((curr) => (curr === id ? null : curr));
    }, 1500);
  };

  const handleCopy = (id: string, cmd: string, e: React.MouseEvent) => {
    e.stopPropagation();
    void navigator.clipboard?.writeText(cmd).catch(() => undefined);
    setCopiedId(id);
    window.setTimeout(() => {
      setCopiedId((curr) => (curr === id ? null : curr));
    }, 1500);
  };

  const handleInsert = (cmd: string, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (onInsertCommand) {
      onInsertCommand(cmd);
    } else {
      onRunCommand(cmd);
    }
  };

  const filteredHistory = useMemo(() => {
    let list = historyCommands;
    const q = historySearch.trim().toLowerCase();
    if (q) {
      list = list.filter((item) => item.command.toLowerCase().includes(q));
    }
    return list;
  }, [historyCommands, historySearch]);

  const categories = [
    { key: 'updates', title: t('term.catUpdates') },
    { key: 'monitor', title: t('term.catMonitor') },
    { key: 'network', title: t('term.catNetwork') },
    { key: 'system', title: t('term.catSystem') },
  ] as const;

  return (
    <aside className="inspector" style={{ width: `${width}px` }}>
      <div
        className="inspector__resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label={t('inspector.resize')}
        title={t('inspector.resizeHint')}
        onPointerDown={(event) => {
          event.preventDefault();
          dragRef.current = { startX: event.clientX, startWidth: width };
          document.body.classList.add('is-resizing-x');
          window.addEventListener('pointermove', onPointerMove);
          window.addEventListener('pointerup', endDrag);
        }}
        onDoubleClick={() => {
          endDrag();
          onWidthReset();
        }}
      />

      <header className="inspector__head hairline-b">
        <Icon name="terminal" size={14} />
        <h2 className="label" style={{ marginLeft: 'var(--sp-2)' }}>
          {t('term.inspectorTitle')}
        </h2>
        <span className="spacer" />
        {activeTab === 'presets' ? (
          <select
            className="tpane__font"
            value={pkgManager}
            onChange={(e) => setPkgManager(e.target.value as PkgManager)}
            aria-label={t('term.pkgManager')}
            title={t('term.pkgManager')}
            style={{ marginRight: 'var(--sp-2)' }}
          >
            <option value="apt">APT (Ubuntu/Debian)</option>
            <option value="dnf">DNF (RHEL/Fedora)</option>
            <option value="pacman">Pacman (Arch)</option>
            <option value="apk">APK (Alpine)</option>
            <option value="auto">Auto (Smart)</option>
          </select>
        ) : null}
        <IconButton icon="close" label={t('topbar.hideInspector')} size={14} onClick={onClose} />
      </header>

      <div className="tinsp__tabs hairline-b">
        <button
          type="button"
          className={`tinsp__tab ${activeTab === 'presets' ? 'tinsp__tab--active' : ''}`}
          onClick={() => setActiveTab('presets')}
        >
          <Icon name="sliders" size={13} />
          <span>{t('term.presetsTitle')}</span>
        </button>
        <button
          type="button"
          className={`tinsp__tab ${activeTab === 'history' ? 'tinsp__tab--active' : ''}`}
          onClick={() => setActiveTab('history')}
        >
          <Icon name="clock" size={13} />
          <span>{t('term.historyTitle')}</span>
          {historyCommands.length > 0 ? (
            <span className="tinsp__tab-badge">{historyCommands.length}</span>
          ) : null}
        </button>
      </div>

      {activeTab === 'presets' && stats ? (
        <div className="tinsp__stats-banner">
          <div className="tinsp__stats-row">
            <span>{t('inspector.owner')}</span>
            <span className="tinsp__stats-val">{stats.hostname || '—'}</span>
          </div>
          {stats.kernel ? (
            <div className="tinsp__stats-row">
              <span>Linux</span>
              <span className="tinsp__stats-val truncate" style={{ maxWidth: '200px' }} title={stats.kernel}>
                {stats.kernel}
              </span>
            </div>
          ) : null}
          {Array.isArray(stats.load) && stats.load.length > 0 ? (
            <div className="tinsp__stats-row">
              <span>Load avg</span>
              <span className="tinsp__stats-val">{stats.load.join(', ')}</span>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="inspector__scroll scroll-y">
        {activeTab === 'presets' ? (
          categories.map((cat) => {
            const items = COMMAND_DEFINITIONS.filter((cmd) => cmd.category === cat.key);
            if (items.length === 0) return null;

            return (
              <section key={cat.key} className="tinsp__section">
                <div className="tinsp__section-title">
                  <span>{cat.title}</span>
                </div>

                {items.map((item) => {
                  const cmdStr = item.getCommand(pkgManager);
                  const isExecuted = executedId === item.id;
                  const isCopied = copiedId === item.id;

                  return (
                    <div
                      key={item.id}
                      className={`tinsp__card ${isExecuted ? 'tinsp__card--executed' : ''}`}
                      onClick={() => handleRun(item.id, cmdStr)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          handleRun(item.id, cmdStr);
                        }
                      }}
                      title={`${t('term.run')}: ${cmdStr}`}
                    >
                      <div className="tinsp__card-header">
                        <span className="tinsp__card-icon">
                          <Icon name={item.icon} size={14} />
                        </span>
                        <span className="tinsp__card-title">{t(item.titleKey)}</span>
                        {isExecuted ? (
                          <span className="status-badge status-badge--mint mono" style={{ fontSize: '10px' }}>
                            ✓ {t('term.sent')}
                          </span>
                        ) : null}
                      </div>

                      <p className="tinsp__card-desc">{t(item.descKey)}</p>

                      <div className="tinsp__card-cmd">
                        <code className="tinsp__card-code" title={cmdStr}>
                          {cmdStr}
                        </code>
                        <div className="tinsp__card-actions">
                          <IconButton
                            icon="copy"
                            size={12}
                            label={isCopied ? t('term.copied') : t('term.copyCmd')}
                            active={isCopied}
                            onClick={(e) => handleCopy(item.id, cmdStr, e)}
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            icon="terminal"
                            style={{ height: '20px', padding: '0 6px', fontSize: '11px' }}
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRun(item.id, cmdStr);
                            }}
                          >
                            {t('term.run')}
                          </Button>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </section>
            );
          })
        ) : (
          <div className="tinsp__history-panel">
            <div className="tinsp__history-toolbar">
              <div className="tinsp__history-search">
                <Icon name="search" size={13} />
                <input
                  type="text"
                  className="tinsp__history-input mono"
                  placeholder={t('term.searchHistory')}
                  value={historySearch}
                  onChange={(e) => setHistorySearch(e.target.value)}
                />
                {historySearch ? (
                  <button
                    type="button"
                    className="tinsp__history-clear-btn"
                    onClick={() => setHistorySearch('')}
                    title={t('common.close')}
                  >
                    <Icon name="close" size={11} />
                  </button>
                ) : null}
              </div>

              {historyCommands.length > 0 ? (
                showConfirmClear ? (
                  <div className="tinsp__history-confirm">
                    <span className="tinsp__history-confirm-text">{t('term.clearHistoryTitle')}</span>
                    <div className="tinsp__history-confirm-btns">
                      <Button
                        variant="secondary"
                        size="sm"
                        style={{ height: '20px', padding: '0 6px', fontSize: '11px' }}
                        onClick={() => {
                          clearHistoryStore();
                          setShowConfirmClear(false);
                        }}
                      >
                        {t('common.yes')}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        style={{ height: '20px', padding: '0 6px', fontSize: '11px' }}
                        onClick={() => setShowConfirmClear(false)}
                      >
                        {t('common.no')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="tinsp__history-meta">
                    <span className="tinsp__history-count">
                      {t('term.commandsCount', { count: filteredHistory.length })}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon="trash"
                      style={{ height: '22px', padding: '0 6px', fontSize: '11px' }}
                      onClick={() => setShowConfirmClear(true)}
                      title={t('term.clearHistory')}
                    >
                      {t('term.clearHistory')}
                    </Button>
                  </div>
                )
              ) : null}
            </div>

            {filteredHistory.length === 0 ? (
              <div className="tinsp__empty">
                <span className="tinsp__empty-icon">
                  <Icon name={historySearch ? 'search' : 'clock'} size={24} />
                </span>
                <p className="tinsp__empty-title">
                  {historySearch ? t('term.noHistoryMatches') : t('term.emptyHistory')}
                </p>
                <p className="tinsp__empty-desc">
                  {historySearch ? '' : t('term.emptyHistoryDesc')}
                </p>
              </div>
            ) : (
              <div className="tinsp__history-list">
                {filteredHistory.map((item) => {
                  const isExecuted = executedId === item.id;
                  const isCopied = copiedId === item.id;

                  return (
                    <div
                      key={item.id}
                      className={`tinsp__hcard ${isExecuted ? 'tinsp__hcard--executed' : ''}`}
                    >
                      <div className="tinsp__hcard-top">
                        <span
                          className="tinsp__hcard-time"
                          title={new Date(item.timestamp).toLocaleString()}
                        >
                          {formatRelativeTime(item.timestamp, Date.now(), t)}
                        </span>
                        <div className="tinsp__hcard-actions">
                          <IconButton
                            icon="copy"
                            size={12}
                            label={isCopied ? t('term.copied') : t('term.copyCmd')}
                            active={isCopied}
                            onClick={(e) => handleCopy(item.id, item.command, e)}
                          />
                          <IconButton
                            icon="pencil"
                            size={12}
                            label={t('term.insertCmd')}
                            onClick={(e) => handleInsert(item.command, e)}
                          />
                          <IconButton
                            icon="trash"
                            size={12}
                            label={t('term.deleteCmd')}
                            onClick={(e) => {
                              e.stopPropagation();
                              removeHistoryCommand(item.id);
                            }}
                          />
                          <Button
                            variant="ghost"
                            size="sm"
                            icon="terminal"
                            style={{ height: '20px', padding: '0 6px', fontSize: '11px' }}
                            onClick={() => handleRun(item.id, item.command)}
                          >
                            {t('term.run')}
                          </Button>
                        </div>
                      </div>

                      <div
                        className="tinsp__hcard-body"
                        onClick={() => handleInsert(item.command)}
                        title={`${t('term.insertCmd')}: ${item.command}`}
                        role="button"
                        tabIndex={0}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault();
                            handleRun(item.id, item.command);
                          }
                        }}
                      >
                        <code className="tinsp__hcard-code">{item.command}</code>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
