import { useEffect, useState } from 'react';
import { api } from '../../api/client';
import { useUiStore } from '../../state/uiStore';
import { useT } from '../../i18n/useT';
import { Button, Field, TextInput } from '../ui/Primitives';
import { Modal } from '../ui/Overlays';
import { Icon } from '../ui/Icon';
import { suggestExtractDir } from '../../lib/archives';

/**
 * Unpacks an archive into a folder the user picks.
 *
 * The destination defaults to a folder named after the archive, beside it: unpacking into
 * the current folder scatters the archive's top-level entries among the files already
 * there. Existing files are skipped unless the box is ticked — the server implements both,
 * and skipping is the safe default.
 */
export function ExtractDialog({
  open,
  connectionId,
  archivePath,
  archiveName,
  onClose,
  onDone,
}: {
  open: boolean;
  connectionId: string;
  archivePath: string;
  archiveName: string;
  onClose: () => void;
  onDone: (entries: number, destinationDir: string) => void;
}) {
  const { t } = useT();
  const pushToast = useUiStore((s) => s.pushToast);

  const [destination, setDestination] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDestination(suggestExtractDir(archivePath));
    setOverwrite(false);
    setError(null);
    setBusy(false);
  }, [open, archivePath]);

  const submit = async (): Promise<void> => {
    const dir = destination.trim();
    if (dir === '') {
      setError(t('extract.destRequired'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.extract(connectionId, archivePath, dir, overwrite);
      pushToast({
        level: 'success',
        title: t('extract.done', { count: String(result.entries.length) }),
        detail: dir,
      });
      onDone(result.entries.length, dir);
      onClose();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      title={t('extract.title')}
      subtitle={archiveName}
      onClose={onClose}
      footer={
        <>
          <span className="pathnote mono truncate" title={destination}>
            {destination}
          </span>
          <span className="spacer" />
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" icon="folder-open" loading={busy} onClick={() => void submit()}>
            {t('extract.action')}
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field
          label={t('extract.into')}
          htmlFor="extract-dir"
          hint={t('extract.intoHint')}
          className="form-grid__wide"
        >
          <TextInput
            id="extract-dir"
            value={destination}
            spellCheck={false}
            autoFocus
            onChange={(event) => setDestination(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit();
            }}
          />
        </Field>
      </div>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={overwrite}
          onChange={(event) => setOverwrite(event.target.checked)}
        />
        <span>{t('extract.overwrite')}</span>
      </label>

      <p className="pathnote">
        <Icon name="info" size={12} />
        {overwrite ? t('extract.overwriteHint') : t('extract.skipHint')}
      </p>

      {error ? <p className="form-error">{error}</p> : null}
    </Modal>
  );
}
