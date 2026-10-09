import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Transfer } from '../../api/types';
import { useTransferStore } from '../../state/transferStore';
import { useUiStore } from '../../state/uiStore';
import { useConnectionStore } from '../../state/connectionStore';
import { formatBytes, formatEta, formatPercent, formatSpeed } from '../../lib/format';
import { useT } from '../../i18n/useT';
import type { MessageKey } from '../../i18n';
import { Icon } from '../ui/Icon';
import { EmptyState, IconButton, Progress } from '../ui/Primitives';

const STATE_LABEL: Record<Transfer['state'], MessageKey> = {
  queued: 'xfer.stateQueued',
  active: 'xfer.stateActive',
  done: 'xfer.stateDone',
  error: 'xfer.stateError',
  cancelled: 'xfer.stateCancelled',
};

const DIRECTION_ICON: Record<Transfer['direction'], 'upload' | 'download' | 'layers'> = {
  upload: 'upload',
  download: 'download',
  relay: 'layers',
};

/**
 * Announces *transitions*, not byte counts: a live region fed by a progress bar
 * updating several times a second is unusable with a screen reader.
 */
function useTransferAnnouncements(transfers: Transfer[]): string {
  const { t } = useT();
  const previous = useRef(new Map<string, Transfer['state']>());
  const [message, setMessage] = useState('');

  useEffect(() => {
    const seen = previous.current;
    const changes: string[] = [];
    for (const transfer of transfers) {
      const before = seen.get(transfer.id);
      if (before === transfer.state) continue;
      seen.set(transfer.id, transfer.state);
      if (before === undefined && transfer.state === 'queued') continue;
      if (transfer.state === 'done') changes.push(`${transfer.name}: ${t('xfer.stateDone')}`);
      else if (transfer.state === 'error') changes.push(`${transfer.name}: ${t('xfer.stateError')}`);
      else if (transfer.state === 'cancelled') changes.push(`${transfer.name}: ${t('xfer.stateCancelled')}`);
      else if (transfer.state === 'active' && before !== 'active') {
        changes.push(`${transfer.name}: ${t('xfer.stateActive')}`);
      }
    }
    for (const id of [...seen.keys()]) {
      if (!transfers.some((transfer) => transfer.id === id)) seen.delete(id);
    }
    if (changes.length > 0) setMessage(changes.slice(-3).join('. '));
  }, [transfers, t]);

  return message;
}

function TransferRow({ transfer }: { transfer: Transfer }) {
  const cancel = useTransferStore((s) => s.cancel);
  const retry = useTransferStore((s) => s.retry);
  const connections = useConnectionStore((s) => s.connections);
  const connection = connections.find((c) => c.id === transfer.connectionId);
  const target = connections.find((c) => c.id === transfer.targetConnectionId);
  const { t } = useT();
  const percent = formatPercent(transfer.transferred, transfer.size);
  const isRelay = transfer.direction === 'relay';

  return (
    <div className={`xfer is-${transfer.state}`}>
      <span className="xfer__dir" title={transfer.direction}>
        <Icon name={DIRECTION_ICON[transfer.direction]} size={14} />
      </span>

      <div className="xfer__info">
        <div className="xfer__line">
          <span className="xfer__name truncate" title={transfer.remotePath}>
            {transfer.name}
          </span>
          <span className="xfer__state mono">{t(STATE_LABEL[transfer.state])}</span>
        </div>
        <div className="xfer__line xfer__line--meta">
          <span className="xfer__path mono truncate" title={transfer.remotePath}>
            {connection ? `${connection.label}:` : ''}
            {transfer.remotePath}
            {isRelay && transfer.targetPath ? (
              <>
                <Icon name="arrow-right" size={11} />
                {target ? `${target.label}:` : ''}
                {transfer.targetPath}
              </>
            ) : null}
          </span>
        </div>
        {transfer.state === 'active' || transfer.state === 'queued' ? (
          <div className="xfer__progress">
            <Progress value={transfer.transferred} max={transfer.size > 0 ? transfer.size : 100} />
            <span className="xfer__numbers mono">
              {transfer.size > 0
                ? `${formatBytes(transfer.transferred)} / ${formatBytes(transfer.size)} · ${percent.toFixed(0)}%`
                : formatBytes(transfer.transferred)}
              {transfer.resumedFrom ? ` · ${t('xfer.resumed', { size: formatBytes(transfer.resumedFrom) })}` : ''}
            </span>
          </div>
        ) : null}
        {transfer.error ? <p className="xfer__error">{transfer.error}</p> : null}
      </div>

      <div className="xfer__right">
        {transfer.state === 'active' ? (
          <>
            <span className="xfer__speed mono">{formatSpeed(transfer.bytesPerSecond)}</span>
            <span className="xfer__eta mono">
              {transfer.size > 0 ? formatEta(transfer.size - transfer.transferred, transfer.bytesPerSecond) : ''}
            </span>
          </>
        ) : transfer.state === 'done' ? (
          <span className="xfer__done">
            <Icon name="check-circle" size={15} />
            {formatBytes(transfer.size)}
          </span>
        ) : transfer.state === 'error' || transfer.state === 'cancelled' ? (
          <IconButton
            icon="refresh"
            label={t('xfer.retry')}
            size={14}
            onClick={() => void retry(transfer.id)}
          />
        ) : null}
        {transfer.state === 'active' || transfer.state === 'queued' ? (
          <IconButton icon="close" label={t('xfer.cancel')} size={14} onClick={() => void cancel(transfer.id)} />
        ) : null}
      </div>
    </div>
  );
}

/** Concurrency and bandwidth limits, read from and written to `/api/settings`. */
function TransferSettings() {
  const settings = useTransferStore((s) => s.settings);
  const saveSettings = useTransferStore((s) => s.saveSettings);
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const [limit, setLimit] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setLimit(settings?.transfers.speedLimitKbps ? String(settings.transfers.speedLimitKbps) : '');
  }, [settings]);

  const apply = useCallback(
    async (patch: { maxConcurrent?: number; speedLimitKbps?: number | null }) => {
      setBusy(true);
      try {
        await saveSettings({ transfers: { ...(settings?.transfers ?? { maxConcurrent: 3, speedLimitKbps: null }), ...patch } });
      } finally {
        setBusy(false);
      }
    },
    [saveSettings, settings],
  );

  return (
    <div className="xfercfg">
      <IconButton
        icon="sliders"
        label={t('xfer.settings')}
        size={14}
        active={open}
        onClick={() => setOpen((value) => !value)}
      />
      {open ? (
        <div className="xfercfg__pop">
          <label className="xfercfg__row">
            <span className="label">{t('xfer.maxConcurrent')}</span>
            <select
              value={settings?.transfers.maxConcurrent ?? 3}
              disabled={busy}
              onChange={(event) => void apply({ maxConcurrent: Number(event.target.value) })}
            >
              {[1, 2, 3, 4, 5, 6, 8].map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
          <label className="xfercfg__row">
            <span className="label">{t('xfer.speedLimit')}</span>
            <span className="xfercfg__input">
              <input
                type="number"
                min={0}
                step={64}
                placeholder={t('xfer.speedLimitOff')}
                value={limit}
                disabled={busy}
                onChange={(event) => setLimit(event.target.value)}
                onBlur={() => {
                  const value = limit.trim() === '' ? null : Number(limit);
                  if (value !== null && (!Number.isFinite(value) || value <= 0)) {
                    setLimit('');
                    void apply({ speedLimitKbps: null });
                    return;
                  }
                  void apply({ speedLimitKbps: value });
                }}
              />
              <span className="xfercfg__unit mono">KB/s</span>
            </span>
          </label>
        </div>
      ) : null}
    </div>
  );
}

function useSplitTransfers() {
  const transfers = useTransferStore((s) => s.transfers);
  return useMemo(
    () => ({
      active: transfers.filter((t) => t.state === 'active' || t.state === 'queued'),
      done: transfers.filter((t) => t.state !== 'active' && t.state !== 'queued'),
    }),
    [transfers],
  );
}

export function TransferDock() {
  const open = useUiStore((s) => s.dockOpen);
  const view = useUiStore((s) => s.dockView);
  const height = useUiStore((s) => s.dockHeight);
  const setHeight = useUiStore((s) => s.setDockHeight);
  const toggleDock = useUiStore((s) => s.toggleDock);
  const setDockView = useUiStore((s) => s.setDockView);

  const transfers = useTransferStore((s) => s.transfers);
  const clearFinished = useTransferStore((s) => s.clearFinished);
  const { t } = useT();
  const announcement = useTransferAnnouncements(transfers);
  const { active, done } = useSplitTransfers();

  const dragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      setHeight(drag.startHeight - (event.clientY - drag.startY));
    },
    [setHeight],
  );

  const onPointerUp = useCallback(() => {
    dragRef.current = null;
    document.body.classList.remove('is-resizing');
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
  }, [onPointerMove]);

  useEffect(() => () => onPointerUp(), [onPointerUp]);

  if (!open) return null;

  return (
    <section className="dock" style={{ height }}>
      <div
        className="dock__resizer"
        role="separator"
        aria-orientation="horizontal"
        onPointerDown={(event) => {
          dragRef.current = { startY: event.clientY, startHeight: height };
          document.body.classList.add('is-resizing');
          window.addEventListener('pointermove', onPointerMove);
          window.addEventListener('pointerup', onPointerUp);
        }}
      />
      <header className="dock__head hairline-b">
        <div className="dock__tabs">
          <button
            type="button"
            className={`dock__tab${view === 'transfers' ? ' is-active' : ''}`}
            onClick={() => setDockView('transfers')}
          >
            {t('xfer.queue')}
            {active.length ? <span className="dock__badge mono">{active.length}</span> : null}
          </button>
        </div>
        <span className="spacer" />
        <TransferSettings />
        {done.length ? (
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => void clearFinished()}>
            <Icon name="trash" size={12} />
            <span className="btn__label">{t('xfer.clearFinished')}</span>
          </button>
        ) : null}
        <IconButton icon="close" label={t('xfer.hidePanel')} size={14} onClick={() => toggleDock()} />
      </header>

      {/* Transitions only — see useTransferAnnouncements. */}
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>

      <div className="dock__body scroll-y">
        {transfers.length === 0 ? (
          <EmptyState icon="transfer" title={t('xfer.noneYet')} detail={t('xfer.noneYetHint')} />
        ) : (
          <>
            {active.map((transfer) => (
              <TransferRow key={transfer.id} transfer={transfer} />
            ))}
            {done.map((transfer) => (
              <TransferRow key={transfer.id} transfer={transfer} />
            ))}
          </>
        )}
      </div>
    </section>
  );
}

export function TransferView() {
  const transfers = useTransferStore((s) => s.transfers);
  const clearFinished = useTransferStore((s) => s.clearFinished);
  const { t } = useT();
  const announcement = useTransferAnnouncements(transfers);
  const { active, done } = useSplitTransfers();

  return (
    <div className="xferview">
      <header className="xferview__head hairline-b">
        <h2 className="xferview__title">{t('xfer.title')}</h2>
        <span className="xferview__count mono">
          {t('xfer.activeCount', { active: active.length, finished: done.length })}
        </span>
        <span className="spacer" />
        <TransferSettings />
        {done.length ? (
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => void clearFinished()}>
            <Icon name="trash" size={12} />
            <span className="btn__label">{t('xfer.clearFinished')}</span>
          </button>
        ) : null}
      </header>

      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>

      <div className="xferview__body scroll-y">
        {transfers.length === 0 ? (
          <EmptyState icon="transfer" title={t('xfer.nothingYet')} detail={t('xfer.nothingYetHint')} />
        ) : (
          <>
            {active.length ? (
              <section className="xferview__group">
                <h3 className="label">{t('xfer.inProgress')}</h3>
                {active.map((transfer) => (
                  <TransferRow key={transfer.id} transfer={transfer} />
                ))}
              </section>
            ) : null}
            {done.length ? (
              <section className="xferview__group">
                <h3 className="label">{t('xfer.history')}</h3>
                {done.map((transfer) => (
                  <TransferRow key={transfer.id} transfer={transfer} />
                ))}
              </section>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
