import { useEffect, useRef, useState } from 'react';
import type { FilesTab } from '../../state/explorerStore';
import type { SortKey } from '../../lib/sort';
import { useT } from '../../i18n/useT';
import { Icon } from '../ui/Icon';
import { IconButton } from '../ui/Primitives';
import { Menu, type MenuItem } from '../ui/Overlays';
import { Breadcrumbs } from './Breadcrumbs';

const SORT_LABEL: Record<SortKey, string> = {
  name: 'Name',
  size: 'Size',
  mtime: 'Modified',
  kind: 'Type',
  owner: 'Owner',
  mode: 'Permissions',
};

export interface FileToolbarProps {
  tab: FilesTab;
  home?: string;
  canBack: boolean;
  canForward: boolean;
  canUp: boolean;
  onNavigate: (path: string) => void;
  onBack: () => void;
  onForward: () => void;
  onUp: () => void;
  onRefresh: () => void;
  onSort: (key: SortKey) => void;
  onFilter: (value: string) => void;
  onSubmitSearch: () => void;
  onViewMode: (mode: 'list' | 'grid') => void;
  onNewFolder: () => void;
  onUpload: () => void;
  onUploadFolder: () => void;
  onOpenTerminal: () => void;
}

export function FileToolbar({
  tab,
  home,
  canBack,
  canForward,
  canUp,
  onNavigate,
  onBack,
  onForward,
  onUp,
  onRefresh,
  onSort,
  onFilter,
  onSubmitSearch,
  onViewMode,
  onNewFolder,
  onUpload,
  onUploadFolder,
  onOpenTerminal,
}: FileToolbarProps) {
  const [editingPath, setEditingPath] = useState(false);
  const { t } = useT();
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [sortMenu, setSortMenu] = useState<{ x: number; y: number } | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const focus = () => searchRef.current?.focus();
    const edit = () => setEditingPath(true);
    window.addEventListener('ssh-explorer:focus-search', focus);
    window.addEventListener('ssh-explorer:edit-path', edit);
    return () => {
      window.removeEventListener('ssh-explorer:focus-search', focus);
      window.removeEventListener('ssh-explorer:edit-path', edit);
    };
  }, []);

  const moreItems: MenuItem[] = [
    { id: 'new-folder', label: t('files.newFolder'), icon: 'folder-plus', shortcut: 'Ctrl в‡§ N', onSelect: onNewFolder },
    { id: 'upload', label: t('files.uploadFiles'), icon: 'upload', onSelect: onUpload },
    { id: 'upload-folder', label: t('files.uploadFolder'), icon: 'folder-up', onSelect: onUploadFolder },
    { id: 'terminal', label: t('files.openTerminalHere'), icon: 'terminal', onSelect: onOpenTerminal },
    { id: 'sep', label: '-' },
    { id: 'refresh', label: t('common.refresh'), icon: 'refresh', shortcut: 'F5', onSelect: onRefresh },
    {
      id: 'copy-path',
      label: t('files.copyPath'),
      icon: 'copy',
      onSelect: () => void navigator.clipboard?.writeText(tab.path),
    },
  ];

  return (
    <div className="toolbar hairline-b">
      <div className="toolbar__nav">
        <IconButton icon="arrow-left" label="Back" onClick={onBack} disabled={!canBack} />
        <IconButton icon="arrow-right" label="Forward" onClick={onForward} disabled={!canForward} />
        <IconButton icon="arrow-corner-up" label="Parent folder" onClick={onUp} disabled={!canUp} />
        <IconButton icon="refresh" label="Refresh" onClick={onRefresh} />
      </div>

      <Breadcrumbs
        path={tab.path}
        home={home}
        onNavigate={onNavigate}
        editing={editingPath}
        onEditingChange={setEditingPath}
      />

      <div className="toolbar__right">
        <label className="toolbar__search" title={t('files.filterLabel')}>
          <Icon name={tab.searchResults ? 'layers' : 'search'} size={14} />
          <input
            ref={searchRef}
            value={tab.filter}
            placeholder={t('files.filterPlaceholder')}
            spellCheck={false}
            onChange={(event) => onFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                onSubmitSearch();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                onFilter('');
                event.currentTarget.blur();
              }
            }}
            aria-label="Filter files in this folder, or press Enter to search recursively"
          />
          {tab.filter ? (
            <button type="button" aria-label="Clear filter" onClick={() => onFilter('')}>
              <Icon name="close" size={12} />
            </button>
          ) : null}
        </label>

        <button
          type="button"
          className="sortbtn"
          onClick={(event) => setSortMenu({ x: event.clientX - 150, y: event.clientY + 8 })}
          title="Sort"
        >
          <Icon name={tab.sort.direction === 'asc' ? 'sort-asc' : 'sort-desc'} size={14} />
          <span className="sortbtn__label">{SORT_LABEL[tab.sort.key]}</span>
          <Icon name="chevron-down" size={12} />
        </button>

        <div className="segmented segmented--icons" role="tablist" aria-label="View mode">
          <button
            type="button"
            role="tab"
            aria-selected={tab.viewMode === 'list'}
            className={`segmented__item${tab.viewMode === 'list' ? ' is-active' : ''}`}
            onClick={() => onViewMode('list')}
            title="List view"
          >
            <Icon name="list" size={14} />
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab.viewMode === 'grid'}
            className={`segmented__item${tab.viewMode === 'grid' ? ' is-active' : ''}`}
            onClick={() => onViewMode('grid')}
            title="Grid view"
          >
            <Icon name="grid" size={14} />
          </button>
        </div>

        <IconButton
          icon="dots"
          label="More actions"
          onClick={(event) => setMenu({ x: event.clientX, y: event.clientY + 12 })}
        />
      </div>

      {sortMenu ? (
        <Menu
          x={sortMenu.x}
          y={sortMenu.y}
          minWidth={200}
          onClose={() => setSortMenu(null)}
          items={[
            {
              id: 'asc',
              label: 'Ascending',
              icon: 'sort-asc',
              onSelect: () => onSort(tab.sort.key),
            },
            {
              id: 'desc',
              label: 'Descending',
              icon: 'sort-desc',
              onSelect: () => onSort(tab.sort.key),
            },
            { id: 'sep', label: '-' },
            { id: 'name', label: 'Sort by name', icon: 'list', onSelect: () => onSort('name') },
            { id: 'size', label: 'Sort by size', icon: 'sliders', onSelect: () => onSort('size') },
            { id: 'mtime', label: 'Sort by modified', icon: 'clock', onSelect: () => onSort('mtime') },
            { id: 'kind', label: 'Sort by type', icon: 'layers', onSelect: () => onSort('kind') },
            { id: 'owner', label: 'Sort by owner', icon: 'user', onSelect: () => onSort('owner') },
            { id: 'mode', label: 'Sort by permissions', icon: 'shield', onSelect: () => onSort('mode') },
          ]}
        />
      ) : null}

      {menu ? <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={moreItems} /> : null}
    </div>
  );
}
