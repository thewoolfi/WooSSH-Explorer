import { useEffect, useMemo, useState } from 'react';
import type { FileEntry } from '../../api/types';
import { api } from '../../api/client';
import { useUiStore } from '../../state/uiStore';
import { useT } from '../../i18n/useT';
import { Button, Field, Segmented, TextInput } from '../ui/Primitives';
import { Modal } from '../ui/Overlays';
import { Icon } from '../ui/Icon';
import { joinRemotePath } from '../../lib/path';
import {
  FORMAT_SUFFIX,
  suggestArchiveName,
  uniqueName,
  type ArchiveFormat,
} from '../../lib/archives';

/**
 * Packs the selection into an archive on the remote host.
 *
 * The name is chosen so that the common case needs no typing, and it steps aside when the
 * file already exists — writing over a file because two names collided loses data without
 * ever saying so.
 */
export function ArchiveDialog({
  open,
  connectionId,
  paths,
  currentDir,
  existingNames,
  onClose,
  onDone,
}: {
  open: boolean;
  connectionId: string;
  /** Selection to pack, absolute remote paths. */
  paths: string[];
  /** Folder the archive is created in by default. */
  currentDir: string;
  /** Names already present in `currentDir`, so a collision can be avoided. */
  existingNames: string[];
  onClose: () => void;
  onDone: (entry: FileEntry) => void;
}) {
  const { t } = useT();
  const pushToast = useUiStore((s) => s.pushToast);

  const [format, setFormat] = useState<ArchiveFormat>('zip');
  const [destination, setDestination] = useState(currentDir);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The suggested name follows the format, so switching to tar.gz renames the file only
  // while the user has not typed a name of their own.
  const suggested = useMemo(
    () => uniqueName(suggestArchiveName(paths, format), existingNames),
    [paths, format, existingNames],
  );
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFormat('zip');
    setDestination(currentDir);
    setTouched(false);
    setError(null);
    setBusy(false);
  }, [open, currentDir]);

  useEffect(() => {
    if (!touched) setName(suggested);
  }, [suggested, touched]);

  const target = destination === '' ? '' : joinRemotePath(destination, name.trim());

  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    if (trimmed === '') {
      setError(t('archive.nameRequired'));
      return;
    }
    if (trimmed.includes('/')) {
      setError(t('archive.nameNoSlash'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.archive(connectionId, paths, target, format);
      pushToast({
        level: 'success',
        title: t('archive.created', { name: trimmed }),
        detail: target,
      });
      onDone(result.entry);
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
      title={t('archive.title')}
      subtitle={t('archive.subtitle', { count: String(paths.length) })}
      onClose={onClose}
      footer={
        <>
          <span className="pathnote mono truncate" title={target}>
            {target}
          </span>
          <span className="spacer" />
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" icon="download" loading={busy} onClick={() => void submit()}>
            {t('archive.action')}
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label={t('archive.format')} className="form-grid__wide">
          <Segmented
            value={format}
            onChange={setFormat}
            options={[
              { value: 'zip', label: 'zip' },
              { value: 'tar.gz', label: 'tar.gz' },
              { value: 'tar', label: 'tar' },
            ]}
          />
        </Field>

        <Field label={t('archive.name')} htmlFor="archive-name" className="form-grid__wide">
          <TextInput
            id="archive-name"
            value={name}
            spellCheck={false}
            autoFocus
            onChange={(event) => {
              setTouched(true);
              setName(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void submit();
            }}
          />
        </Field>

        <Field label={t('archive.into')} htmlFor="archive-dir" className="form-grid__wide">
          <TextInput
            id="archive-dir"
            value={destination}
            spellCheck={false}
            onChange={(event) => setDestination(event.target.value)}
          />
        </Field>
      </div>

      <p className="pathnote">
        <Icon name="info" size={12} />
        {t('archive.hint', { suffix: FORMAT_SUFFIX[format] })}
      </p>

      {error ? <p className="form-error">{error}</p> : null}
    </Modal>
  );
}
