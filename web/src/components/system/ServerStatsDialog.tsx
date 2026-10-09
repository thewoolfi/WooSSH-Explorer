import { useCallback, useEffect, useState } from 'react';
import { useConnectionStore } from '../../state/connectionStore';
import { useSystemStatsStore } from '../../state/systemStatsStore';
import { useUiStore } from '../../state/uiStore';
import { formatBytes, formatRelative } from '../../lib/format';
import { useT } from '../../i18n/useT';
import { Button, EmptyState, Progress, Spinner } from '../ui/Primitives';
import { Modal } from '../ui/Overlays';
import { Icon } from '../ui/Icon';

/**
 * Written as escapes on purpose: this file has been through tools that re-encode text,
 * and a literal dash or middle dot is one bad round-trip away from turning into mojibake.
 */
const DASH = '\u2014';
const MIDDOT = '\u00B7';

/** `df -h` for the host you are on, without opening a terminal. */
export function ServerStatsDialog() {
  const open = useUiStore((s) => s.serverStatsOpen);
  const setOpen = useUiStore((s) => s.setServerStatsOpen);
  const setDiagnosticsOpen = useUiStore((s) => s.setDiagnosticsOpen);
  const connections = useConnectionStore((s) => s.connections);
  const activeId = useConnectionStore((s) => s.activeId);
  const { t } = useT();

  const connection = connections.find((c) => c.id === activeId) ?? null;
  // The status bar keeps this warm, so the panel usually opens with data already there.
  const cached = useSystemStatsStore((s) => (activeId ? s.byConnection[activeId] : undefined));
  const loading = useSystemStatsStore((s) => (activeId ? s.loading[activeId] === true : false));
  const refresh = useSystemStatsStore((s) => s.refresh);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (force: boolean) => {
      if (!connection) return;
      setError(null);
      try {
        await refresh(connection.id, { force });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    },
    [connection, refresh],
  );

  useEffect(() => {
    if (!open) return;
    setError(null);
    void load(false);
  }, [open, load]);

  const stats = cached?.stats ?? null;

  return (
    <Modal
      open={open}
      title={t('server.title')}
      subtitle={connection?.label}
      onClose={() => setOpen(false)}
      width={560}
      footer={
        <>
          <span className="pathnote">
            {stats ? t('server.updated', { when: formatRelative(stats.collectedAt) }) : ''}
          </span>
          <span className="spacer" />
          <Button
            variant="ghost"
            icon="terminal"
            disabled={!connection}
            onClick={() => {
              setOpen(false);
              setDiagnosticsOpen(true);
            }}
          >
            {t('diag.title')}
          </Button>
          <Button variant="ghost" icon="refresh" loading={loading} onClick={() => void load(true)}>
            {t('common.refresh')}
          </Button>
          <Button variant="primary" onClick={() => setOpen(false)}>
            {t('common.close')}
          </Button>
        </>
      }
    >
      {!connection ? (
        <EmptyState icon="server" title={t('server.noConnection')} detail={undefined} />
      ) : error ? (
        <p className="form-error">{error}</p>
      ) : stats === null ? (
        <div className="known__loading">
          <Spinner /> <span>{t('common.loading')}</span>
        </div>
      ) : (
        <div className="stats">
          {/* The server says why a figure is missing; showing that beats a row of dashes. */}
          {stats.notes.length > 0 ? (
            <ul className="stats__notes">
              {stats.notes.map((note) => (
                <li key={`${note.scope}-${note.detail}`}>
                  <Icon name="alert" size={12} />
                  <span>{note.detail}</span>
                </li>
              ))}
            </ul>
          ) : null}

          <dl className="stats__grid">
            <Stat label={t('server.hostname')} value={stats.hostname} />
            <Stat label={t('server.kernel')} value={stats.kernel} />
            <Stat label={t('server.uptime')} value={stats.uptimeSeconds === null ? null : formatUptime(stats.uptimeSeconds)} />
            <Stat
              label={t('server.load')}
              value={stats.load === null ? null : stats.load.map((value) => value.toFixed(2)).join(' / ')}
              sub={stats.cpuCount === null ? undefined : `${t('server.cpus')}: ${stats.cpuCount}`}
            />
          </dl>

          <Meter
            label={t('server.memory')}
            used={stats.memory?.usedBytes ?? null}
            total={stats.memory?.totalBytes ?? null}
          />
          <Meter
            label={t('server.swap')}
            used={stats.swap?.usedBytes ?? null}
            total={stats.swap?.totalBytes ?? null}
          />

          <section className="stats__disks">
            <h3 className="label">{t('server.disks')}</h3>
            {stats.disks.length === 0 ? (
              <p className="pathnote">{t('server.unavailable')}</p>
            ) : (
              stats.disks.map((disk) => (
                <div key={`${disk.filesystem}-${disk.mount}`} className="stats__disk">
                  <div className="stats__diskhead">
                    <span className="mono truncate" title={disk.filesystem}>
                      {disk.mount}
                    </span>
                    <span className="spacer" />
                    <span className="pathnote mono">
                      {formatBytes(disk.usedBytes)} / {formatBytes(disk.sizeBytes)} {MIDDOT}{' '}
                      {percentOf(disk.usedBytes, disk.sizeBytes).toFixed(0)}%
                    </span>
                  </div>
                  <Progress value={disk.usedBytes} max={disk.sizeBytes > 0 ? disk.sizeBytes : 1} />
                </div>
              ))
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}

function Stat({ label, value, sub }: { label: string; value: string | null; sub?: string }) {
  return (
    <div className="stats__cell">
      <dt className="label">{label}</dt>
      <dd className="mono">{value ?? DASH}</dd>
      {sub ? <dd className="pathnote mono">{sub}</dd> : null}
    </div>
  );
}

function Meter({ label, used, total }: { label: string; used: number | null; total: number | null }) {
  const { t } = useT();
  if (used === null || total === null || total <= 0) {
    return (
      <div className="stats__meter">
        <div className="stats__diskhead">
          <span className="label">{label}</span>
          <span className="spacer" />
          <span className="pathnote">
            <Icon name="alert" size={11} /> {t('server.unavailable')}
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="stats__meter">
      <div className="stats__diskhead">
        <span className="label">{label}</span>
        <span className="spacer" />
        <span className="pathnote mono">
          {formatBytes(used)} / {formatBytes(total)} {MIDDOT} {percentOf(used, total).toFixed(0)}%
        </span>
      </div>
      <Progress value={used} max={total} />
    </div>
  );
}

function percentOf(used: number, total: number): number {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, (used / total) * 100));
}

/** `3d 4h`, or `42m` for a freshly booted host. */
function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}
