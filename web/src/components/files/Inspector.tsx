import { useCallback, useEffect, useRef, useState } from 'react';
import type { DirectoryListing, FileEntry, FileReadResult } from '../../api/types';
import { basenameRemotePath, classify } from '../../lib/path';
import { formatBytes, formatCount, formatFullDate, formatRelative, modeToOctal } from '../../lib/format';
import { FileIcon, fileKindLabel } from '../ui/FileIcon';
import { Icon } from '../ui/Icon';
import { IconButton } from '../ui/Primitives';
import { PreviewPlaceholder, TextPreview } from './TextPreview';
import { useT } from '../../i18n/useT';
import type { PreviewState } from '../../state/explorerStore';

export interface InspectorProps {
  listing: DirectoryListing | null;
  entries: FileEntry[];
  selection: string[];
  preview: PreviewState | null;
  connectionLabel?: string;
  search?: { query: string; scope: string; truncated: boolean } | null;
  /** Current inspector width in pixels, driven by the drag handle. */
  width: number;
  onWidthChange: (width: number) => void;
  onWidthReset: () => void;
  onClose: () => void;
  onOpen: (entry: FileEntry) => void;
  onPreviewRequest: (path: string) => void;
  onDownload: (entry: FileEntry) => void;
  /** Opens "run a command on the server"; the entry is only a hint. */
  onExec: (entry: FileEntry | null) => void;
  /** Desktop only: open the file in the OS default application. */
  onEdit: ((entry: FileEntry) => void) | null;
  /** Measures this folder and its subfolders; `null` when there is no host. */
  onMeasureUsage: (() => void) | null;
  measuring: boolean;
  usage: Record<string, { bytes: number; truncated: boolean }>;
}

export function Inspector({
  listing,
  entries,
  selection,
  preview,
  connectionLabel,
  search,
  width,
  onWidthChange,
  onWidthReset,
  onClose,
  onOpen,
  onPreviewRequest,
  onDownload,
  onExec,
  onEdit,
  onMeasureUsage,
  measuring,
  usage,
}: InspectorProps) {
  const selectedEntry =
    selection.length === 1 ? (entries.find((e) => e.path === selection[0]) ?? null) : null;

  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const { t, tc } = useT();

  const onPointerMove = useCallback(
    (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      // The inspector sits on the right, so dragging left widens it.
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
          // The double-click's own pointerdown started a drag; drop it first so a
          // trailing pointermove cannot immediately re-apply the dragged width.
          endDrag();
          onWidthReset();
        }}
      />

      <header className="inspector__head hairline-b">
        <h2 className="label">{t('inspector.title')}</h2>
        <span className="spacer" />
        <IconButton
          icon="code"
          label={t('inspector.runCommand')}
          size={14}
          onClick={() => onExec(selectedEntry)}
        />
        <IconButton icon="close" label={t('topbar.hideInspector')} size={14} onClick={onClose} />
      </header>

      <div className="inspector__scroll scroll-y">
        {selection.length > 1 ? (
          <MultiSummary entries={entries} selection={selection} />
        ) : selectedEntry ? (
          <Subject
            entry={selectedEntry}
            onOpen={onOpen}
            onPreviewRequest={onPreviewRequest}
            onDownload={onDownload}
            onExec={onExec}
            onEdit={onEdit}
            usage={usage}
            onMeasureUsage={onMeasureUsage}
            measuring={measuring}
          />
        ) : search ? (
          <SearchSummary search={search} entries={entries} />
        ) : (
          <FolderSummary
            listing={listing}
            entries={entries}
            connectionLabel={connectionLabel}
            onExec={onExec}
            usage={usage}
            onMeasureUsage={onMeasureUsage}
            measuring={measuring}
          />
        )}

        {selectedEntry && selectedEntry.kind !== 'directory' ? (
          <section className="inspector__preview">
            {!preview || preview.path !== selectedEntry.path ? (
              <PreviewPlaceholder loading={false} message={t('files.noPreviewLoaded')} />
            ) : preview.state === 'loading' ? (
              <PreviewPlaceholder loading />
            ) : preview.state === 'error' ? (
              <PreviewPlaceholder loading={false} message={preview.error ?? t('files.previewUnavailable')} />
            ) : preview.data ? (
              <PreviewBody
                data={preview.data}
                name={selectedEntry.name}
                onDownload={() => onDownload(selectedEntry)}
              />
            ) : null}
          </section>
        ) : null}
      </div>
    </aside>
  );
}

function Subject({
  entry,
  onOpen,
  onPreviewRequest,
  onDownload,
  onExec,
  onEdit,
  usage,
  onMeasureUsage,
  measuring,
}: {
  entry: FileEntry;
  onOpen: (entry: FileEntry) => void;
  onPreviewRequest: (path: string) => void;
  onDownload: (entry: FileEntry) => void;
  onExec: (entry: FileEntry | null) => void;
  onEdit: ((entry: FileEntry) => void) | null;
  usage: Record<string, { bytes: number; truncated: boolean }>;
  onMeasureUsage: (() => void) | null;
  measuring: boolean;
}) {
  const { t } = useT();
  const editable = entry.kind === 'file';
  const measured = usage[entry.path];
  const sizeLabel =
    entry.kind !== 'directory'
      ? formatBytes(entry.size)
      : measured
        ? `${measured.truncated ? '≥ ' : ''}${formatBytes(measured.bytes)}`
        : measuring
          ? t('inspector.calculating')
          : '—';
  return (
    <div className="inspector__subject">
      <span className={`inspector__tile inspector__tile--${classify(entry)}`}>
        <FileIcon entry={entry} size={34} />
      </span>
      <h3 className="inspector__name" title={entry.name}>
        {entry.name}
      </h3>
      <p className="inspector__kind">{fileKindLabel(entry)}</p>

      <dl className="meta">
        <Meta
          label={t('inspector.size')}
          value={sizeLabel}
          sub={measured?.truncated ? t('inspector.atLeastShort') : undefined}
        />
        <Meta label={t('inspector.modified')} value={formatFullDate(entry.mtime)} sub={formatRelative(entry.mtime)} />
        <Meta label={t('inspector.permissions')} value={`${entry.modeText} В· ${modeToOctal(entry.mode)}`} />
        <Meta
          label={t('inspector.owner')}
          value={`${entry.owner}:${entry.group}`}
          sub={`uid ${entry.uid} В· gid ${entry.gid}`}
        />
        {entry.linkCount != null ? <Meta label={t('inspector.links')} value={String(entry.linkCount)} /> : null}
        {entry.target ? <Meta label={t('inspector.target')} value={entry.target} /> : null}
        <Meta label={t('inspector.path')} value={entry.path} />
      </dl>

      <div className="inspector__actions">
        {entry.kind === 'directory' ? (
          <>
            <button type="button" className="btn btn--secondary btn--md btn--block" onClick={() => onOpen(entry)}>
              <Icon name="folder-open" size={14} />
              <span className="btn__label">{t('files.openFolder')}</span>
            </button>
            {onMeasureUsage ? (
              <button
                type="button"
                className="btn btn--secondary btn--md btn--block"
                title={t('inspector.measureHint')}
                disabled={measuring}
                onClick={onMeasureUsage}
              >
                <Icon name="layers" size={14} />
                <span className="btn__label">
                  {measuring ? t('inspector.calculating') : t('inspector.measure')}
                </span>
              </button>
            ) : null}
            <button type="button" className="btn btn--secondary btn--md btn--block" onClick={() => onExec(entry)}>
              <Icon name="code" size={14} />
              <span className="btn__label">{t('files.runHere')}</span>
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              className="btn btn--secondary btn--md btn--block"
              onClick={() => onPreviewRequest(entry.path)}
            >
              <Icon name="eye" size={14} />
              <span className="btn__label">Preview</span>
            </button>
            <button
              type="button"
              className="btn btn--primary btn--md btn--block"
              onClick={() => onDownload(entry)}
            >
              <Icon name="download" size={14} />
              <span className="btn__label">Download</span>
            </button>
            {onEdit ? (
              <button
                type="button"
                className="btn btn--secondary btn--md btn--block"
                onClick={() => onEdit(entry)}
                title="Open in the default application on this PC and send the changes back"
              >
                <Icon name="pencil" size={14} />
                <span className="btn__label">Edit</span>
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn--secondary btn--md btn--block"
              onClick={() => onExec(entry)}
              title="Run a command on the server"
            >
              <Icon name="code" size={14} />
              <span className="btn__label">{t('files.runOnServer')}</span>
            </button>
          </>
        )}
      </div>

      {editable && !onEdit ? (
        <p className="inspector__note">
          {t('files.editNeedsDesktop')}
        </p>
      ) : null}
    </div>
  );
}

function MultiSummary({ entries, selection }: { entries: FileEntry[]; selection: string[] }) {
  const { t, tc } = useT();
  const set = new Set(selection);
  const chosen = entries.filter((e) => set.has(e.path));
  const files = chosen.filter((e) => e.kind === 'file');
  const folders = chosen.filter((e) => e.kind === 'directory');
  const bytes = files.reduce((sum, e) => sum + e.size, 0);

  return (
    <div className="inspector__multi">
      <span className="inspector__tile inspector__tile--multi">
        <Icon name="layers" size={26} strokeWidth={1.2} />
        <span className="inspector__tile-count mono">{selection.length}</span>
      </span>
      <h3 className="inspector__name">{tc('inspector.selectedCount', selection.length)}</h3>
      <p className="inspector__kind">
        {formatCount(folders.length, 'folder')} В· {formatCount(files.length, 'file')}
      </p>
      <dl className="meta">
        {files.length > 0 ? <Meta label={t('inspector.totalSize')} value={formatBytes(bytes)} sub={t('inspector.filesOnly')} /> : null}
        <Meta label={t('inspector.items')} value={String(selection.length)} />
      </dl>
    </div>
  );
}

function FolderSummary({
  listing,
  entries,
  connectionLabel,
  onExec,
  usage,
  onMeasureUsage,
  measuring,
}: {
  listing: DirectoryListing | null;
  entries: FileEntry[];
  connectionLabel?: string;
  onExec: (entry: FileEntry | null) => void;
  usage: Record<string, { bytes: number; truncated: boolean }>;
  onMeasureUsage: (() => void) | null;
  measuring: boolean;
}) {
  const { t } = useT();
  if (!listing) {
    return <PreviewPlaceholder loading={false} message={t('files.selectToInspect')} />;
  }

  const folders = entries.filter((e) => e.kind === 'directory');
  const files = entries.filter((e) => e.kind === 'file');
  const bytes = files.reduce((sum, e) => sum + e.size, 0);
  const name = listing.path === '/' ? '/' : basenameRemotePath(listing.path);
  const measuredHere = usage[listing.path];

  return (
    <div className="inspector__subject">
      <span className="inspector__tile inspector__tile--folder">
        <Icon name="folder-open" size={34} strokeWidth={1.2} />
      </span>
      <h3 className="inspector__name" title={listing.path}>
        {name}
      </h3>
      <p className="inspector__kind">
        {connectionLabel ? `Folder on ${connectionLabel}` : 'Folder'}
      </p>

      <dl className="meta">
        <Meta label={t('inspector.folders')} value={String(folders.length)} />
        <Meta label={t('inspector.files')} value={String(files.length)} />
        <Meta label={t('inspector.size')} value={formatBytes(bytes)} sub={t('inspector.topLevel')} />
        {measuredHere ? (
          <Meta
            label={t('inspector.totalSize')}
            value={`${measuredHere.truncated ? '≥ ' : ''}${formatBytes(measuredHere.bytes)}`}
            sub={measuredHere.truncated ? t('inspector.atLeastShort') : undefined}
          />
        ) : null}
        <Meta label={t('inspector.path')} value={listing.path} />
      </dl>

      <div className="inspector__actions">
        {onMeasureUsage ? (
          <button
            type="button"
            className="btn btn--secondary btn--md btn--block"
            title={t('inspector.measureHint')}
            disabled={measuring}
            onClick={onMeasureUsage}
          >
            <Icon name="layers" size={14} />
            <span className="btn__label">
              {measuring ? t('inspector.calculating') : t('inspector.measure')}
            </span>
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn--secondary btn--md btn--block"
          onClick={() => onExec(null)}
        >
          <Icon name="code" size={14} />
          <span className="btn__label">{t('files.runCommandHere')}</span>
        </button>
      </div>
    </div>
  );
}

function SearchSummary({
  search,
  entries,
}: {
  search: { query: string; scope: string; truncated: boolean };
  entries: FileEntry[];
}) {
  const { t } = useT();
  const folders = entries.filter((e) => e.kind === 'directory').length;
  const files = entries.filter((e) => e.kind === 'file').length;
  const bytes = entries
    .filter((e) => e.kind === 'file')
    .reduce((sum, e) => sum + e.size, 0);

  return (
    <div className="inspector__subject">
      <span className="inspector__tile inspector__tile--search">
        <Icon name="search" size={32} strokeWidth={1.2} />
      </span>
      <h3 className="inspector__name">{t('inspector.searchResults')}</h3>
      <p className="inspector__kind">“{search.query}” below {search.scope}</p>

      <dl className="meta">
        <Meta
          label="Matches"
          value={String(entries.length)}
          sub={search.truncated ? t('inspector.limitReached') : undefined}
        />
        <Meta label={t('inspector.folders')} value={String(folders)} />
        <Meta label={t('inspector.files')} value={String(files)} />
        <Meta label={t('inspector.size')} value={formatBytes(bytes)} />
        <Meta label={t('inspector.scope')} value={search.scope} />
      </dl>
    </div>
  );
}

function PreviewBody({
  data,
  name,
  onDownload,
}: {
  data: FileReadResult;
  name: string;
  onDownload: () => void;
}) {
  const [imageBroken, setImageBroken] = useState(false);

  if (data.kind === 'image' && data.dataUrl && !imageBroken) {
    return (
      <div className="preview preview--image">
        <div className="preview__bar">
          <span className="label">Preview</span>
          <span className="spacer" />
          <span className="preview__meta mono">{data.mimeType}</span>
        </div>
        <div className="preview__image-frame">
          {/* The server classifies by extension, so a mislabelled file can fail
              to decode — fall back to the binary state instead of a broken icon. */}
          <img src={data.dataUrl} alt={name} onError={() => setImageBroken(true)} />
        </div>
      </div>
    );
  }
  if (data.kind === 'text') {
    return <TextPreview result={data} name={name} onDownload={onDownload} />;
  }
  return (
    <div className="preview preview--empty">
      <Icon name={data.kind === 'tooLarge' ? 'alert' : 'file-binary'} size={18} />
      <p>
        {imageBroken
          ? 'This file is named like an image but does not decode.'
          : data.kind === 'tooLarge'
            ? 'File is too large to preview.'
            : 'No inline preview for this file type.'}
      </p>
      <button type="button" className="btn btn--secondary btn--sm" onClick={onDownload}>
        <Icon name="download" size={13} />
        <span className="btn__label">Download</span>
      </button>
    </div>
  );
}

function Meta({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="meta__row">
      <dt className="meta__key label">{label}</dt>
      <dd className="meta__val" title={value}>
        {value}
        {sub ? <span className="meta__sub">{sub}</span> : null}
      </dd>
    </div>
  );
}
