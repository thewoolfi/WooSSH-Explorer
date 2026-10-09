import type { FileEntry } from '../api/types';
import { extensionOf } from './format';
import { classify, type FileKind } from './path';

export type SortKey = 'name' | 'size' | 'mtime' | 'kind' | 'owner' | 'mode';
export type SortDirection = 'asc' | 'desc';

export interface SortSpec {
  key: SortKey;
  direction: SortDirection;
}

export const DEFAULT_SORT: SortSpec = { key: 'name', direction: 'asc' };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function kindRank(entry: FileEntry): number {
  if (entry.kind === 'directory') return 0;
  if (entry.kind === 'symlink') return 1;
  return 2;
}

export function compareEntries(a: FileEntry, b: FileEntry, sort: SortSpec): number {
  const dir = sort.direction === 'asc' ? 1 : -1;
  switch (sort.key) {
    case 'size':
      return (a.size - b.size) * dir || collator.compare(a.name, b.name);
    case 'mtime':
      return (a.mtime - b.mtime) * dir || collator.compare(a.name, b.name);
    case 'owner':
      return (
        collator.compare(a.owner, b.owner) * dir ||
        collator.compare(a.name, b.name)
      );
    case 'mode':
      return (a.mode - b.mode) * dir || collator.compare(a.name, b.name);
    case 'kind':
      return (
        collator.compare(classify(a), classify(b)) * dir || collator.compare(a.name, b.name)
      );
    case 'name':
    default:
      return collator.compare(a.name, b.name) * dir;
  }
}

/** Directories first, then the chosen sort within each group. */
export function sortEntries(entries: FileEntry[], sort: SortSpec): FileEntry[] {
  return [...entries].sort((a, b) => {
    const rank = kindRank(a) - kindRank(b);
    if (rank !== 0) return rank;
    return compareEntries(a, b, sort);
  });
}

export interface FilterOptions {
  query: string;
  showHidden: boolean;
  kinds: Set<FileKind> | null;
}

/** Case-insensitive substring match over the whole path and the extension. */
export function filterEntries(entries: FileEntry[], options: FilterOptions): FileEntry[] {
  const needle = options.query.trim().toLowerCase();
  return entries.filter((entry) => {
    if (!options.showHidden && entry.hidden) return false;
    if (options.kinds && !options.kinds.has(classify(entry))) return false;
    if (!needle) return true;
    if (entry.name.toLowerCase().includes(needle)) return true;
    if (extensionOf(entry.name) === needle.replace(/^\./, '')) return true;
    return false;
  });
}

/** Next sort state when a header is clicked (click cycles asc → desc → asc). */
export function nextSort(current: SortSpec, key: SortKey): SortSpec {
  if (current.key !== key) {
    return { key, direction: key === 'name' ? 'asc' : 'desc' };
  }
  return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
}
