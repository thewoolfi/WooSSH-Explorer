import { useCallback, useEffect, useState } from 'react';
import type { NetProbeResult } from '../../api/types';
import { api } from '../../api/client';
import { useUiStore } from '../../state/uiStore';
import { useT } from '../../i18n/useT';
import { Button, Spinner, TextInput } from '../ui/Primitives';
import { Modal } from '../ui/Overlays';
import { Icon } from '../ui/Icon';

/**
 * Ping and traceroute from the machine SSH Explorer runs on to a host.
 *
 * Deliberately independent of any session: the moment you most want to know whether a
 * server is reachable is the moment connecting to it fails. It is reachable from the
 * sidebar's context menu, so a saved host can be checked without dialling it.
 */
export function NetworkToolsDialog() {
  const open = useUiStore((s) => s.netToolsOpen);
  const preset = useUiStore((s) => s.netToolsHost);
  const requestedTool = useUiStore((s) => s.netToolsTool);
  const setOpen = useUiStore((s) => s.setNetToolsOpen);
  const { t } = useT();

  const [host, setHost] = useState('');
  const [result, setResult] = useState<NetProbeResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'ping' | 'traceroute' | null>(null);

  const run = useCallback(async (tool: 'ping' | 'traceroute', target: string) => {
    const value = target.trim();
    if (value === '') return;
    setBusy(tool);
    setError(null);
    setResult(null);
    try {
      setResult(await api.netProbe({ host: value, tool }));
    } catch (caught) {
      setResult(null);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(null);
    }
  }, []);

  /**
   * The host was already chosen — the sidebar row that was right-clicked, or the
   * connection the status bar is showing — so the probe starts the moment the panel opens.
   * Asking which host to probe, when the user has just clicked that host, was a question
   * with one possible answer.
   */
  useEffect(() => {
    if (!open) return;
    const target = preset ?? '';
    setHost(target);
    setResult(null);
    setError(null);
    setBusy(null);
    if (target !== '') void run(requestedTool, target);
  }, [open, preset, requestedTool, run]);

  const summary = result?.summary;

  return (
    <Modal
      open={open}
      title={requestedTool === 'traceroute' ? t('net.traceroute') : t('net.ping')}
      subtitle={host === '' ? t('net.subtitle') : host}
      onClose={() => setOpen(false)}
      width={620}
      footer={
        <>
          <span className="pathnote">
            <Icon name="activity" size={12} />
            {t('net.hint')}
          </span>
          <span className="spacer" />
          <Button variant="primary" onClick={() => setOpen(false)}>
            {t('common.close')}
          </Button>
        </>
      }
    >
      <div className="net">
        <div className="net__bar">
          <TextInput
            value={host}
            spellCheck={false}
            placeholder="host or IP"
            aria-label={t('net.host')}
            onChange={(event) => setHost(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void run('ping', host);
            }}
          />
          <Button
            variant={requestedTool === 'ping' ? 'primary' : 'secondary'}
            icon="activity"
            loading={busy === 'ping'}
            disabled={busy !== null || host.trim() === ''}
            onClick={() => void run('ping', host)}
          >
            {t('net.ping')}
          </Button>
          <Button
            variant={requestedTool === 'traceroute' ? 'primary' : 'secondary'}
            icon="signal"
            loading={busy === 'traceroute'}
            disabled={busy !== null || host.trim() === ''}
            onClick={() => void run('traceroute', host)}
          >
            {t('net.traceroute')}
          </Button>
        </div>

        {error ? <p className="form-error">{error}</p> : null}

        {busy !== null ? (
          <div className="known__loading">
            <Spinner /> <span>{t('net.running', { tool: busy })}</span>
          </div>
        ) : null}

        {result?.unavailable ? (
          <div className="net__unavailable">
            <Icon name="alert" size={13} />
            <span>{result.unavailable}</span>
          </div>
        ) : null}

        {result && summary ? (
          <>
            <dl className="net__stats">
              <Stat label={t('net.host')} value={result.host} mono />
              <Stat label={t('net.took')} value={`${result.durationMs} ms`} mono />
              {summary.transmitted !== null ? (
                <Stat
                  label={t('net.packets')}
                  value={`${summary.received ?? '?'}/${summary.transmitted}`}
                  mono
                />
              ) : null}
              {summary.lossPercent !== null ? (
                <Stat
                  label={t('net.loss')}
                  value={`${summary.lossPercent}%`}
                  mono
                  tone={summary.lossPercent > 0 ? 'warn' : 'ok'}
                />
              ) : null}
              {summary.avgMs !== null ? (
                <Stat
                  label={t('net.rtt')}
                  value={`${summary.minMs ?? '?'} / ${summary.avgMs} / ${summary.maxMs ?? '?'} ms`}
                  mono
                />
              ) : null}
              {summary.hops !== null ? <Stat label={t('net.hops')} value={String(summary.hops)} mono /> : null}
            </dl>

            {summary.unreachable ? (
              <div className="net__unreachable">
                <Icon name="alert" size={13} />
                <span>{t('net.unreachable')}</span>
              </div>
            ) : null}

            <pre className="net__out mono">{result.lines.join('\n')}</pre>
          </>
        ) : null}

        {result === null && busy === null && error === null ? (
          <p className="pathnote">{t('net.idle')}</p>
        ) : null}
      </div>
    </Modal>
  );
}

function Stat({
  label,
  value,
  mono = false,
  tone,
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: 'ok' | 'warn';
}) {
  return (
    <div className={`net__stat${tone ? ` is-${tone}` : ''}`}>
      <dt className="label">{label}</dt>
      <dd className={mono ? 'mono' : undefined}>{value}</dd>
    </div>
  );
}
