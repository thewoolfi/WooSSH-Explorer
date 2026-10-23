import { useCallback, useEffect, useRef, useState } from 'react';
import { useT } from '../../i18n/useT';
import type { MessageKey } from '../../i18n';
import { Icon, type IconName } from '../ui/Icon';
import { Button, IconButton } from '../ui/Primitives';
import { useSystemStatsStore } from '../../state/systemStatsStore';

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
}

export function TerminalInspector({
  connectionId,
  width,
  onWidthChange,
  onWidthReset,
  onClose,
  onRunCommand,
}: TerminalInspectorProps) {
  const { t } = useT();
  const [pkgManager, setPkgManager] = useState<PkgManager>('apt');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [executedId, setExecutedId] = useState<string | null>(null);

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
        <IconButton icon="close" label={t('topbar.hideInspector')} size={14} onClick={onClose} />
      </header>

      {stats ? (
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
        {categories.map((cat) => {
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
        })}
      </div>
    </aside>
  );
}
