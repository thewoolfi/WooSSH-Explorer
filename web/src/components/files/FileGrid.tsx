import { memo } from 'react';
import type { FileEntry } from '../../api/types';
import { formatBytes, formatDate } from '../../lib/format';
import { FileIcon } from '../ui/FileIcon';

export interface FileGridProps {
  entries: FileEntry[];
  selection: string[];
  /** Paths waiting on the clipboard to be moved. */
  cutPaths?: ReadonlySet<string>;
  onSelect: (entry: FileEntry, mode: 'replace' | 'toggle' | 'range') => void;
  onOpen: (entry: FileEntry) => void;
  onContextMenu: (entry: FileEntry | null, x: number, y: number) => void;
  onBackgroundContextMenu: (x: number, y: number) => void;
}

export const FileGrid = memo(function FileGrid({
  entries,
  selection,
  cutPaths,
  onSelect,
  onOpen,
  onContextMenu,
  onBackgroundContextMenu,
}: FileGridProps) {
  const selected = new Set(selection);

  return (
    <div
      className="fgrid"
      role="listbox"
      aria-label="Directory contents"
      aria-multiselectable
      onContextMenu={(event) => {
        if (event.target === event.currentTarget) {
          event.preventDefault();
          onBackgroundContextMenu(event.clientX, event.clientY);
        }
      }}
    >
      {entries.map((entry) => {
        const isSelected = selected.has(entry.path);
        return (
          <div
            key={entry.path}
            role="option"
            aria-selected={isSelected}
            data-path={entry.path}
            tabIndex={-1}
            className={`gtile${isSelected ? ' is-selected' : ''}${cutPaths?.has(entry.path) ? ' is-cut' : ''}`}
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
            <span className="gtile__icon">
              <FileIcon entry={entry} size={30} />
            </span>
            <span className="gtile__name truncate" title={entry.name}>
              {entry.name}
            </span>
            <span className="gtile__meta mono">
              {entry.kind === 'directory' ? formatDate(entry.mtime) : formatBytes(entry.size)}
            </span>
          </div>
        );
      })}

      {entries.length === 0 ? (
        <div className="fgrid__blank">
          <p>This folder is empty.</p>
        </div>
      ) : null}
    </div>
  );
});
