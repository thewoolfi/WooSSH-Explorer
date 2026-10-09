import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { FileEntry } from '../../api/types';
import { formatBytes, formatDate, modeToText } from '../../lib/format';
import type { SortKey, SortSpec } from '../../lib/sort';
import { useT } from '../../i18n/useT';
import type { MessageKey } from '../../i18n';
import { FileIcon } from '../ui/FileIcon';
import { Icon } from '../ui/Icon';

const COLUMNS: { key: SortKey | 'kind'; label: MessageKey; align?: 'right'; sortable: boolean }[] = [
  { key: 'name', label: 'files.name', sortable: true },
  { key: 'size', label: 'files.size', align: 'right', sortable: true },
  { key: 'mtime', label: 'files.modified', sortable: true },
  { key: 'mode', label: 'files.permissions', sortable: true },
  { key: 'owner', label: 'files.owner', sortable: true },
];

/** Must match `--h-row` in tokens.css; the virtualiser does arithmetic on it. */
const ROW_HEIGHT = 30;
/** Rows rendered beyond the viewport, so fast scrolling does not show blanks. */
const OVERSCAN = 8;
/** Below this, rendering everything is cheaper than the bookkeeping. */
const VIRTUALIZE_ABOVE = 120;

function parentOf(p: string): string {
  const index = p.lastIndexOf('/');
  return index <= 0 ? '/' : p.slice(0, index);
}

export interface FileTableProps {
  entries: FileEntry[];
  selection: string[];
  sort: SortSpec;
  loading: boolean;
  searchMode: boolean;
  /** Paths waiting on the clipboard to be moved — drawn dimmed like a file manager. */
  cutPaths?: ReadonlySet<string>;
  /** Measured directory sizes, filled in only after the user asks for them. */
  usage?: Record<string, { bytes: number; truncated: boolean }>;
  onSort: (key: SortKey) => void;
  onSelect: (entry: FileEntry, mode: 'replace' | 'toggle' | 'range') => void;
  onOpen: (entry: FileEntry) => void;
  onContextMenu: (entry: FileEntry | null, x: number, y: number) => void;
  onBackgroundContextMenu: (x: number, y: number) => void;
}

export const FileTable = memo(function FileTable({
  entries,
  selection,
  sort,
  loading,
  searchMode,
  cutPaths,
  usage,
  onSort,
  onSelect,
  onOpen,
  onContextMenu,
  onBackgroundContextMenu,
}: FileTableProps) {
  const { t } = useT();
  const selected = new Set(selection);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(0);

  const virtualize = entries.length > VIRTUALIZE_ABOVE;

  useLayoutEffect(() => {
    const node = bodyRef.current;
    if (!node) return;
    setViewport(node.clientHeight);
    const observer = new ResizeObserver(() => setViewport(node.clientHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const node = bodyRef.current;
    if (!node) return;
    const onScroll = () => setScrollTop(node.scrollTop);
    node.addEventListener('scroll', onScroll, { passive: true });
    return () => node.removeEventListener('scroll', onScroll);
  }, []);

  const first = virtualize ? Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN) : 0;
  const last = virtualize
    ? Math.min(entries.length, Math.ceil((scrollTop + Math.max(viewport, ROW_HEIGHT)) / ROW_HEIGHT) + OVERSCAN)
    : entries.length;
  const window = virtualize ? entries.slice(first, last) : entries;

  /**
   * Keeps the keyboard selection on screen. When the row is outside the rendered
   * window there is no DOM node to `scrollIntoView`, so the index is turned into a
   * scroll offset instead — which is why arrow-key navigation still works in a
   * folder with tens of thousands of entries.
   */
  const lastSelected = useRef<string | null>(null);
  useEffect(() => {
    const path = selection.length === 1 ? selection[0] : null;
    const previous = lastSelected.current;
    lastSelected.current = path ?? null;
    if (!path || path === previous || !virtualize) return;

    const node = bodyRef.current;
    if (!node) return;
    const index = entries.findIndex((entry) => entry.path === path);
    if (index < 0) return;

    const top = index * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    if (top >= node.scrollTop && bottom <= node.scrollTop + node.clientHeight) return;
    node.scrollTop = Math.max(0, top - (node.clientHeight - ROW_HEIGHT) / 2);
  }, [selection, entries, virtualize]);

  return (
    <div className="ftable" role="grid" aria-label={t('files.name')} aria-rowcount={entries.length}>
      <div className="ftable__head" role="row">
        {COLUMNS.map((column) => {
          const active = sort.key === column.key;
          return (
            <button
              key={column.key}
              type="button"
              role="columnheader"
              aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
              className={`fhead${column.align === 'right' ? ' is-right' : ''}${active ? ' is-active' : ''}`}
              onClick={() => column.sortable && onSort(column.key as SortKey)}
              disabled={!column.sortable}
            >
              <span>{t(column.label)}</span>
              {active ? (
                <Icon name={sort.direction === 'asc' ? 'chevron-up' : 'chevron-down'} size={11} />
              ) : null}
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="ftable__loading" aria-hidden="true">
          <span className="ftable__loading-bar" />
        </div>
      ) : null}

      <div
        className="ftable__body"
        ref={bodyRef}
        role="rowgroup"
        onContextMenu={(event) => {
          if (event.target === event.currentTarget) {
            event.preventDefault();
            onBackgroundContextMenu(event.clientX, event.clientY);
          }
        }}
      >
        {first > 0 ? (
          <div className="fspacer" style={{ height: first * ROW_HEIGHT }} aria-hidden="true" />
        ) : null}

        {window.map((entry, offset) => {
          const index = first + offset;
          const isSelected = selected.has(entry.path);
          const isCut = cutPaths?.has(entry.path) === true;
          return (
            <div
              key={entry.path}
              role="row"
              aria-rowindex={index + 2}
              aria-selected={isSelected}
              data-path={entry.path}
              className={`frow${isSelected ? ' is-selected' : ''}${entry.hidden ? ' is-hidden-file' : ''}${isCut ? ' is-cut' : ''}`}
              onMouseDown={(event) => {
                if (event.button !== 0) return;
                event.preventDefault();
                const mode = event.shiftKey ? 'range' : event.metaKey || event.ctrlKey ? 'toggle' : 'replace';
                onSelect(entry, mode);
              }}
              onDoubleClick={() => onOpen(entry)}
              onContextMenu={(event) => {
                event.preventDefault();
                if (!isSelected) onSelect(entry, 'replace');
                onContextMenu(entry, event.clientX, event.clientY);
              }}
            >
              <div className="fcell fcell--name" role="gridcell">
                <FileIcon entry={entry} size={16} />
                <span className="fcell__name truncate" title={entry.path}>
                  {entry.name}
                </span>
                {searchMode ? (
                  <span className="fcell__target mono truncate" title={entry.path}>
                    {parentOf(entry.path)}
                  </span>
                ) : entry.kind === 'symlink' && entry.target ? (
                  <span className="fcell__target mono truncate" title={entry.target}>
                    → {entry.target}
                  </span>
                ) : null}
              </div>
              <div className="fcell fcell--size mono" role="gridcell">
                {entry.kind === 'directory' ? (
                  // "—" until the user asks for sizes; then the measured total, which is
                  // a lower bound when the server capped its walk.
                  usage?.[entry.path] ? (
                    <span title={usage[entry.path]!.truncated ? t('inspector.atLeast', { size: formatBytes(usage[entry.path]!.bytes) }) : undefined}>
                      {usage[entry.path]!.truncated ? '≥ ' : ''}
                      {formatBytes(usage[entry.path]!.bytes)}
                    </span>
                  ) : (
                    '—'
                  )
                ) : (
                  formatBytes(entry.size)
                )}
              </div>
              <div className="fcell fcell--mtime mono" role="gridcell">
                {formatDate(entry.mtime)}
              </div>
              <div className="fcell fcell--mode mono" role="gridcell">
                {entry.modeText || modeToText(entry.mode)}
              </div>
              <div className="fcell fcell--owner mono truncate" role="gridcell" title={`${entry.owner}:${entry.group}`}>
                {entry.owner}
              </div>
            </div>
          );
        })}

        {last < entries.length ? (
          <div
            className="fspacer"
            style={{ height: (entries.length - last) * ROW_HEIGHT }}
            aria-hidden="true"
          />
        ) : null}

        {entries.length === 0 && !loading ? (
          <div className="ftable__blank" onContextMenu={(event) => {
            event.preventDefault();
            onBackgroundContextMenu(event.clientX, event.clientY);
          }}>
            <p>{searchMode ? t('files.noSearchResults') : t('files.emptyFolder')}</p>
          </div>
        ) : null}
      </div>
    </div>
  );
});
