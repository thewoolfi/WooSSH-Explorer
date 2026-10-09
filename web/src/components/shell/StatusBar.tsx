import { useConnectionStore } from '../../state/connectionStore';
import { useExplorerStore, visibleEntries, type FilesTab } from '../../state/explorerStore';
import { useTransferStore, activeTransfers, totalSpeed } from '../../state/transferStore';
import { useUiStore } from '../../state/uiStore';
import { summarise, useSystemStatsStore } from '../../state/systemStatsStore';
import { useEffect, useMemo } from 'react';
import { Icon } from '../ui/Icon';
import { StatusDot } from '../ui/Primitives';
import { formatBytes, formatSpeed } from '../../lib/format';
import { useT } from '../../i18n/useT';
import { openExternalLink } from '../../lib/desktop';

/** Where "support the project" leads, kept in one place so it is easy to change. */
const SUPPORT_URL = 'https://boosty.to/andrewwoolfi';

export function StatusBar() {
  const { t } = useT();
  const connections = useConnectionStore((s) => s.connections);
  const activeId = useConnectionStore((s) => s.activeId);
  const active = connections.find((c) => c.id === activeId) ?? null;

  const tabs = useExplorerStore((s) => s.tabs);
  const activeTabId = useExplorerStore((s) => s.activeTabId);
  const tab = tabs.find((t) => t.id === activeTabId) ?? null;
  const filesTab = tab?.kind === 'files' ? (tab as FilesTab) : null;

  const transfers = useTransferStore((s) => s.transfers);
  const live = activeTransfers(transfers);
  const speed = totalSpeed(transfers);
  const setDockView = useUiStore((s) => s.setDockView);
  const setServerStatsOpen = useUiStore((s) => s.setServerStatsOpen);
  const setNetToolsOpen = useUiStore((s) => s.setNetToolsOpen);
  const showHidden = useUiStore((s) => s.showHidden);
  const setShowHidden = useUiStore((s) => s.setShowHidden);
  const stats = useSystemStatsStore((s) => (activeId ? s.byConnection[activeId]?.stats : undefined));
  const refreshStats = useSystemStatsStore((s) => s.refresh);
  const summary = useMemo(() => summarise(stats ?? null), [stats]);

  // Keep the vitals current while a host is connected, without polling hard.
  useEffect(() => {
    if (!activeId || active?.status !== 'authenticated') return;
    void refreshStats(activeId);
    const timer = window.setInterval(() => void refreshStats(activeId), 60_000);
    return () => window.clearInterval(timer);
  }, [activeId, active?.status, refreshStats]);

  const entries = filesTab ? visibleEntries(filesTab) : [];
  const totalBytes = filesTab
    ? (filesTab.listing?.entries ?? [])
        .filter((e) => e.kind === 'file')
        .reduce((sum, e) => sum + e.size, 0)
    : 0;
  const selected = filesTab ? filesTab.selection.length : 0;

  const statusTone =
    active?.status === 'authenticated' ? 'mint' : active?.status === 'connecting' ? 'amber' : 'slate';
  const statusLabel =
    active?.status === 'authenticated'
      ? t('status.connected')
      : active?.status === 'connecting'
        ? t('status.connecting')
        : active
          ? t('status.disconnected')
          : t('status.noConnection');

  return (
    <footer className="statusbar hairline-t">
      <div className="statusbar__left">
        <span className="statusbar__item">
          <StatusDot tone={statusTone} pulse={active?.status === 'connecting'} />
          <span>{statusLabel}</span>
        </span>
        {active?.latencyMs != null && active.status === 'authenticated' ? (
          <button
            type="button"
            className="statusbar__item statusbar__item--action mono"
            title={t('server.title')}
            onClick={() => setServerStatsOpen(true)}
          >
            {active.latencyMs} ms
          </button>
        ) : null}
        {/* Always available, and it probes at once: the moment you need it is the moment
            the host is unreachable. */}
        {active ? (
          <>
            <button
              type="button"
              className="statusbar__item statusbar__item--action mono"
              title={`${t('net.ping')} ${active.host}`}
              onClick={() => setNetToolsOpen(true, active.host, 'ping')}
            >
              <Icon name="activity" size={11} />
              {t('net.ping')}
            </button>
            <button
              type="button"
              className="statusbar__item statusbar__item--action mono"
              title={`${t('net.traceroute')} ${active.host}`}
              onClick={() => setNetToolsOpen(true, active.host, 'traceroute')}
            >
              <Icon name="signal" size={11} />
              {t('net.traceroute')}
            </button>
          </>
        ) : null}
        {active?.serverInfo ? (
          <button
            type="button"
            className="statusbar__item statusbar__item--action mono truncate"
            title={`${active.serverInfo.platform} ${active.serverInfo.release} — ${t('server.title')}`}
            onClick={() => setServerStatsOpen(true)}
          >
            {active.serverInfo.platform} {active.serverInfo.arch}
          </button>
        ) : null}
        {/* Host vitals, from the same cached answer the panel uses. */}
        {summary.load ? (
          <button
            type="button"
            className="statusbar__item statusbar__item--action mono"
            title={`${t('server.load')} — ${t('server.title')}`}
            onClick={() => setServerStatsOpen(true)}
          >
            <Icon name="activity" size={11} />
            {summary.load}
          </button>
        ) : null}
        {summary.memory ? (
          <button
            type="button"
            className="statusbar__item statusbar__item--action mono"
            title={`${t('server.memory')} — ${t('server.title')}`}
            onClick={() => setServerStatsOpen(true)}
          >
            <Icon name="layers" size={11} />
            {summary.memory}
          </button>
        ) : null}
        {summary.disk ? (
          <button
            type="button"
            className="statusbar__item statusbar__item--action mono"
            title={`${t('server.disks')} — ${t('server.title')}`}
            onClick={() => setServerStatsOpen(true)}
          >
            <Icon name="drive" size={11} />
            {summary.disk}
          </button>
        ) : null}
      </div>

      <div className="statusbar__center">
        {filesTab && selected > 0 ? (
          <span className="statusbar__item">
            <Icon name="check" size={11} />
            {t('status.selected', { count: selected })}
          </span>
        ) : null}
      </div>

      <div className="statusbar__right">
        {/* Always in reach, never in the way; opens outside the app. */}
        <button
          type="button"
          className="statusbar__toggle statusbar__toggle--support"
          onClick={() => openExternalLink(SUPPORT_URL)}
          title={t('support.title')}
        >
          <Icon name="heart" size={12} />
          <span>{t('support.label')}</span>
        </button>
        <button
          type="button"
          className={`statusbar__toggle${showHidden ? ' is-on' : ''}`}
          onClick={() => setShowHidden(!showHidden)}
          title={t(showHidden ? 'status.hideDotfiles' : 'status.showDotfiles')}
        >
          <Icon name={showHidden ? 'eye' : 'eye-off'} size={12} />
          <span>{t('status.dotfiles')}</span>
        </button>
        <button
          type="button"
          className={`statusbar__toggle${live.length ? ' is-live' : ''}`}
          onClick={() => setDockView('transfers')}
          title={t('status.openQueue')}
        >
          <Icon name="transfer" size={12} />
          <span className="mono">
            {live.length ? `${live.length} В· ${formatSpeed(speed)}` : t('status.idle')}
          </span>
        </button>
        {filesTab ? (
          <>
            <span className="statusbar__item mono">{t('status.items', { count: entries.length })}</span>
            <span className="statusbar__item mono">{formatBytes(totalBytes)}</span>
          </>
        ) : null}
      </div>
    </footer>
  );
}
