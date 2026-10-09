import { useCallback, useEffect, useState } from 'react';
import type { KnownHostEntry } from '../../api/types';
import { api } from '../../api/client';
import { useUiStore } from '../../state/uiStore';
import { useT } from '../../i18n/useT';
import { Button, EmptyState, IconButton, Spinner } from '../ui/Primitives';
import { Modal } from '../ui/Overlays';
import { Icon } from '../ui/Icon';

/**
 * The list of pinned host keys, and the way to forget one.
 *
 * Without this, a `HOST_KEY_MISMATCH` left the user editing `known_hosts` in a text
 * editor: the server could already remove an entry safely, it just had no door.
 */
export function KnownHostsDialog() {
  const open = useUiStore((s) => s.knownHostsOpen);
  const setOpen = useUiStore((s) => s.setKnownHostsOpen);
  const pushToast = useUiStore((s) => s.pushToast);
  const { t } = useT();

  const [entries, setEntries] = useState<KnownHostEntry[] | null>(null);
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await api.knownHosts();
      setEntries(result.entries);
      setPath(result.path);
    } catch (caught) {
      setEntries([]);
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setEntries(null);
    void load();
  }, [open, load]);

  const forget = async (entry: KnownHostEntry) => {
    setBusy(entry.host);
    try {
      // The listing hands back the file's own spelling — `[host]:port` for anything that is
      // not port 22. The API wants the two halves separately, and it builds the key itself.
      const { host, port } = splitKnownHost(entry.host);
      await api.forgetKnownHost(host, port);
      pushToast({ level: 'success', title: t('known.removed', { host: entry.host }) });
      await load();
    } catch (caught) {
      pushToast({
        level: 'error',
        title: t('known.removeFailed'),
        detail: caught instanceof Error ? caught.message : String(caught),
      });
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal
      open={open}
      title={t('known.title')}
      subtitle={path || undefined}
      onClose={() => setOpen(false)}
      width={560}
      footer={
        <>
          <span className="pathnote">
            <Icon name="shield" size={12} />
            {t('known.note')}
          </span>
          <span className="spacer" />
          <Button variant="ghost" icon="refresh" onClick={() => void load()}>
            {t('common.refresh')}
          </Button>
          <Button variant="primary" onClick={() => setOpen(false)}>
            {t('common.close')}
          </Button>
        </>
      }
    >
      {error ? <p className="form-error">{error}</p> : null}

      {entries === null ? (
        <div className="known__loading">
          <Spinner /> <span>{t('common.loading')}</span>
        </div>
      ) : entries.length === 0 ? (
        <EmptyState icon="shield" title={t('known.empty')} detail={t('known.emptyHint')} />
      ) : (
        <ul className="known">
          {entries.map((entry) => (
            <li key={`${entry.line}-${entry.host}`} className="known__row">
              <span className="known__text">
                <span className="known__host mono truncate">{entry.host}</span>
                <span className="known__fp mono truncate" title={entry.fingerprint}>
                  {entry.fingerprint}
                </span>
              </span>
              <span className="known__type mono">{entry.keyType.replace(/^ssh-/, '')}</span>
              <span className="known__line mono">#{entry.line}</span>
              <IconButton
                icon="trash"
                label={t('known.remove')}
                size={14}
                disabled={busy === entry.host}
                onClick={() => void forget(entry)}
              />
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

/**
 * Splits a `known_hosts` first field back into the host and port the API takes.
 * OpenSSH writes `[host]:port` for anything that is not port 22 and a bare host otherwise.
 */
export function splitKnownHost(field: string): { host: string; port: number } {
  const match = /^\[(.+)\]:(\d+)$/.exec(field);
  if (match) return { host: match[1] as string, port: Number(match[2]) };
  return { host: field, port: 22 };
}
