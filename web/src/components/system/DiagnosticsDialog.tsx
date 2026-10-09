import { useCallback, useEffect, useState } from 'react';
import type { DiagnosticReport } from '../../api/types';
import { api } from '../../api/client';
import { useConnectionStore } from '../../state/connectionStore';
import { useUiStore } from '../../state/uiStore';
import { useT } from '../../i18n/useT';
import { Button, EmptyState, Spinner } from '../ui/Primitives';
import { Modal } from '../ui/Overlays';
import { Icon } from '../ui/Icon';

/**
 * "What can this host actually do?"
 *
 * Written after a real Ubuntu box answered the status probe with nothing at all and the
 * application could only say "not available" — which is true and useless. The report below
 * is meant to be copied and sent: every probe, its exact command and its raw answer.
 */
export function DiagnosticsDialog() {
  const open = useUiStore((s) => s.diagnosticsOpen);
  const setOpen = useUiStore((s) => s.setDiagnosticsOpen);
  const pushToast = useUiStore((s) => s.pushToast);
  const connections = useConnectionStore((s) => s.connections);
  const activeId = useConnectionStore((s) => s.activeId);
  const { t } = useT();

  const connection = connections.find((c) => c.id === activeId) ?? null;
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showProbes, setShowProbes] = useState(false);

  const run = useCallback(async () => {
    if (!connection) return;
    setBusy(true);
    setError(null);
    try {
      setReport(await api.diagnostics(connection.id));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  }, [connection]);

  useEffect(() => {
    if (!open) return;
    setReport(null);
    setShowProbes(false);
    void run();
  }, [open, run]);

  const copy = async (): Promise<void> => {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(report.text);
      pushToast({ level: 'success', title: t('diag.copied') });
    } catch {
      pushToast({ level: 'error', title: t('diag.copyFailed') });
    }
  };

  return (
    <Modal
      open={open}
      title={t('diag.title')}
      subtitle={connection?.label}
      onClose={() => setOpen(false)}
      width={640}
      footer={
        <>
          <span className="pathnote">
            <Icon name="terminal" size={12} />
            {t('diag.hint')}
          </span>
          <span className="spacer" />
          <Button variant="ghost" icon="refresh" loading={busy} onClick={() => void run()}>
            {t('common.refresh')}
          </Button>
          <Button variant="secondary" icon="copy" disabled={report === null} onClick={() => void copy()}>
            {t('diag.copy')}
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
      ) : report === null ? (
        <div className="known__loading">
          <Spinner /> <span>{t('diag.running')}</span>
        </div>
      ) : (
        <div className="diag">
          <section>
            <h3 className="label">{t('diag.findings')}</h3>
            <ul className="diag__findings">
              {report.findings.map((finding) => (
                <li key={finding} className={finding.startsWith('Nothing') ? 'is-ok' : 'is-note'}>
                  <Icon name={finding.startsWith('Nothing') ? 'check' : 'alert'} size={13} />
                  <span>{finding}</span>
                </li>
              ))}
            </ul>
          </section>

          <button
            type="button"
            className={`disclosure${showProbes ? ' is-open' : ''}`}
            onClick={() => setShowProbes((value) => !value)}
            aria-expanded={showProbes}
          >
            <Icon name={showProbes ? 'chevron-down' : 'chevron-right'} size={13} />
            <span>{t('diag.probes', { count: String(report.checks.length) })}</span>
          </button>

          {showProbes ? (
            <div className="diag__probes">
              {report.checks.map((check) => (
                <div key={check.name} className={`diag__probe${check.ok ? '' : ' is-bad'}`}>
                  <div className="diag__head">
                    <span className="diag__name">{check.name}</span>
                    <span className="spacer" />
                    <span className="pathnote mono">{check.durationMs} ms</span>
                  </div>
                  <code className="diag__cmd mono">$ {check.command}</code>
                  {check.output ? <pre className="diag__out mono">{check.output}</pre> : null}
                  {check.error ? <pre className="diag__err mono">{check.error}</pre> : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
