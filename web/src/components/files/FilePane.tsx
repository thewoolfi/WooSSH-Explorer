import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FileEntry } from '../../api/types';
import { api } from '../../api/client';
import { useConnectionStore } from '../../state/connectionStore';
import { isFilesTab, visibleEntries, type FilesTab } from '../../state/explorerStore';
import { useExplorerStore } from '../../state/explorerStore';
import { useTransferStore } from '../../state/transferStore';
import { useUiStore } from '../../state/uiStore';
import { useEditStore } from '../../state/editStore';
import { useT } from '../../i18n/useT';
import { filterEntries, nextSort, sortEntries, type SortKey } from '../../lib/sort';
import { basenameRemotePath, joinRemotePath, parentRemotePath } from '../../lib/path';
import { formatCount } from '../../lib/format';
import { downloadWithResume, isDesktop } from '../../lib/desktop';
import {
  clipboardAsText,
  planPaste,
  useClipboardStore,
  type ClipboardMode,
  type PasteRefusal,
} from '../../state/clipboardStore';
import { collectDroppedTree, collectPickedTree, directoryOrder, groupByDirectory, type DroppedTree } from '../../lib/drop';
import { EmptyState } from '../ui/Primitives';
import { Menu, Modal, type MenuItem } from '../ui/Overlays';
import { Icon } from '../ui/Icon';
import { Button, Field, TextInput } from '../ui/Primitives';
import { FileTable } from './FileTable';
import { FileGrid } from './FileGrid';
import { FileToolbar } from './FileToolbar';
import { Inspector } from './Inspector';
import { RunCommandDialog } from './RunCommandDialog';

type DialogKind = 'new-folder' | 'rename' | 'delete' | 'permissions' | null;

/** Paste conflicts waiting for an answer. */
interface ConflictState {
  /** Destination paths, shown to the user. */
  paths: string[];
  /** Source paths, re-sent when the user chooses to replace. */
  sources: string[];
  kind: 'copy' | 'move' | 'relay';
  sourceConnectionId?: string;
}

export function FilePane({ tabId }: { tabId: string }) {
  const tab = useExplorerStore((s) => s.tabs.find((t) => t.id === tabId) ?? null);
  const store = useExplorerStore;
  const filesTab = isFilesTab(tab) ? tab : null;

  const connections = useConnectionStore((s) => s.connections);
  const connection = connections.find((c) => c.id === filesTab?.connectionId) ?? null;

  const inspectorOpen = useUiStore((s) => s.inspectorOpen);
  const setInspector = useUiStore((s) => s.setInspector);
  const inspectorWidth = useUiStore((s) => s.inspectorWidth);
  const setInspectorWidth = useUiStore((s) => s.setInspectorWidth);
  const resetInspectorWidth = useUiStore((s) => s.resetInspectorWidth);
  const showHidden = useUiStore((s) => s.showHidden);
  const pushToast = useUiStore((s) => s.pushToast);
  const startEdit = useEditStore((s) => s.start);
  const { t } = useT();
  const openTerminalTab = store((s) => s.openTerminalTab);
  const openFilesTab = store((s) => s.openFilesTab);
  const upload = useTransferStore((s) => s.upload);
  const clipboard = useClipboardStore((s) => s.entry);
  const putClipboard = useClipboardStore((s) => s.put);
  const clearClipboard = useClipboardStore((s) => s.clear);

  const [menu, setMenu] = useState<{ x: number; y: number; entry: FileEntry | null } | null>(null);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [dialogValue, setDialogValue] = useState('');
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [execOpen, setExecOpen] = useState(false);
  const [execEntry, setExecEntry] = useState<FileEntry | null>(null);
  const [dropping, setDropping] = useState(false);
  /** Sources the server refused because the name is taken, awaiting an answer. */
  const [conflicts, setConflicts] = useState<ConflictState | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const dragDepth = useRef(0);

  const entries = filesTab ? visibleEntries(filesTab) : [];

  const visible = useMemo(() => {
    if (!filesTab) return [];
    const filtered = filterEntries(entries, {
      query: filesTab.filter,
      showHidden,
      kinds: null,
    });
    return filesTab.searchResults ? filtered : sortEntries(filtered, filesTab.sort);
  }, [entries, filesTab, showHidden]);

  const selectionSet = useMemo(() => new Set(filesTab?.selection ?? []), [filesTab?.selection]);
  const singleSelected = filesTab && filesTab.selection.length === 1 ? filesTab.selection[0] : null;
  const selectedEntry = singleSelected ? (entries.find((e) => e.path === singleSelected) ?? null) : null;

  // The order the table is actually showing. Passed straight into `select`, so a
  // shift-click ranges over exactly what the user sees and can never race an effect.
  const displayOrder = useMemo(() => visible.map((entry) => entry.path), [visible]);

  /** Rows waiting on a cut, drawn dimmed until the paste happens. */
  const cutPaths = useMemo(
    () =>
      clipboard && clipboard.mode === 'cut' && clipboard.connectionId === filesTab?.connectionId
        ? new Set(clipboard.paths)
        : undefined,
    [clipboard, filesTab?.connectionId],
  );

  /* ------------------------------------------------------------ actions -- */

  const openEntry = useCallback(
    (entry: FileEntry) => {
      if (!filesTab) return;
      const searching = Boolean(filesTab.searchResults);

      if (entry.kind === 'directory') {
        store.getState().clearSearch(filesTab.id);
        void store.getState().navigate(filesTab.id, entry.path);
        return;
      }

      if (searching) {
        // A search hit is shown detached from its folder, so opening it reveals
        // the file in place instead of previewing a path with no context.
        const parent = parentRemotePath(entry.path) ?? filesTab.path;
        store.getState().clearSearch(filesTab.id);
        setInspector(true);
        void store.getState().navigate(filesTab.id, parent).then(() => {
          store.getState().select(filesTab.id, entry.path, 'replace');
          requestAnimationFrame(() => {
            bodyRef.current
              ?.querySelector(`[data-path="${CSS.escape(entry.path)}"]`)
              ?.scrollIntoView({ block: 'center' });
          });
        });
        return;
      }

      if (entry.kind === 'symlink' && entry.target?.startsWith('/')) {
        void store.getState().navigate(filesTab.id, entry.path);
        return;
      }

      setInspector(true);
      void store.getState().loadPreview(filesTab.id, entry.path);
    },
    [filesTab, setInspector, store],
  );

  const downloadEntry = useCallback(
    (entry: FileEntry) => {
      if (!filesTab || !connection) return;
      const url = api.downloadUrl(filesTab.connectionId, entry.path);
      // In the desktop the shell owns the transfer: it can keep the partial and continue
      // it later, which a browser anchor cannot. The anchor stays the browser fallback.
      void downloadWithResume({ url, name: entry.name }).then((result) => {
        if (result !== null) return;
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = entry.name;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      });
    },
    [connection, filesTab],
  );

  const downloadSelection = useCallback(
    async (targets: FileEntry[]) => {
      if (!filesTab || targets.length === 0) return;
      if (targets.length === 1) {
        const only = targets[0];
        if (only) downloadEntry(only);
        return;
      }
      pushToast({ level: 'info', title: t('xfer.batchPreparing', { count: targets.length }) });
      try {
        const response = await fetch(
          `/api/connections/${encodeURIComponent(filesTab.connectionId)}/fs/download-batch`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paths: targets.map((t) => t.path) }),
          },
        );
        if (!response.ok) throw new Error(`Server answered ${response.status}`);
        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `${basenameRemotePath(filesTab.path) || 'files'}.zip`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      } catch (error) {
        pushToast({
          level: 'error',
          title: 'Batch download failed',
          detail: error instanceof Error ? error.message : undefined,
        });
      }
    },
    [downloadEntry, filesTab, pushToast],
  );

  const openDialog = useCallback(
    (kind: DialogKind, initial = '') => {
      setDialogValue(initial);
      setDialogError(null);
      setDialog(kind);
    },
    [],
  );

  const submitDialog = useCallback(async () => {
    if (!filesTab || !dialog) return;
    setDialogBusy(true);
    setDialogError(null);
    try {
      if (dialog === 'new-folder') {
        const name = dialogValue.trim();
        if (!name) throw new Error('Enter a folder name.');
        await store.getState().createFolder(filesTab.id, name);
        pushToast({ level: 'success', title: `Created ${name}` });
      } else if (dialog === 'rename') {
        const target = selectedEntry;
        if (!target) throw new Error('Nothing selected.');
        const name = dialogValue.trim();
        if (!name) throw new Error('Enter a new name.');
        await store.getState().renameEntry(filesTab.id, target.path, name);
        pushToast({ level: 'success', title: `Renamed to ${name}` });
      } else if (dialog === 'delete') {
        const targets = entries.filter((e) => selectionSet.has(e.path));
        await store.getState().deleteEntries(
          filesTab.id,
          targets.map((t) => t.path),
        );
        pushToast({ level: 'success', title: `Deleted ${formatCount(targets.length, 'item')}` });
      } else if (dialog === 'permissions') {
        const target = selectedEntry;
        if (!target) throw new Error('Nothing selected.');
        await store.getState().chmodEntry(filesTab.id, target.path, dialogValue.trim());
        pushToast({ level: 'success', title: `Permissions updated to ${dialogValue.trim()}` });
      }
      setDialog(null);
    } catch (error) {
      setDialogError(error instanceof Error ? error.message : String(error));
    } finally {
      setDialogBusy(false);
    }
  }, [dialog, dialogValue, entries, filesTab, pushToast, selectedEntry, selectionSet, store]);

  const copy = useCallback(
    (text: string, what: string) => {
      void navigator.clipboard
        ?.writeText(text)
        .then(() => pushToast({ level: 'success', title: `${what} copied` }))
        .catch(() => pushToast({ level: 'error', title: 'Clipboard unavailable' }));
    },
    [pushToast],
  );

  /* --------------------------------------------------------- drag & drop -- */

  const handleFiles = useCallback(
    (fileList: FileList | null) => {
      if (!filesTab || !fileList || fileList.length === 0) return;
      void upload(filesTab.connectionId, filesTab.path, Array.from(fileList)).then(() =>
        store.getState().refresh(filesTab.id),
      );
    },
    [filesTab, store, upload],
  );

  /**
   * Uploads a dropped tree: missing directories first, then the files, grouped by
   * destination so each folder is one transfer batch.
   */
  const handleTree = useCallback(
    async (tree: DroppedTree) => {
      if (!filesTab || tree.files.length === 0) return;
      const { connectionId, path: base } = filesTab;
      const push = useUiStore.getState().pushToast;

      const directories = directoryOrder(tree.directories);
      const failures: string[] = [];
      for (const directory of directories) {
        try {
          await api.mkdir(connectionId, joinRemotePath(base, directory));
        } catch (error) {
          // An existing folder answers 409; anything else is worth reporting.
          const message = error instanceof Error ? error.message : String(error);
          if (!/exist/i.test(message)) failures.push(directory);
        }
      }

      const groups = [...groupByDirectory(tree.files).entries()].sort((a, b) =>
        a[0].localeCompare(b[0]),
      );
      for (const [directory, files] of groups) {
        await upload(connectionId, directory === '' ? base : joinRemotePath(base, directory), files);
      }

      await store.getState().refresh(filesTab.id);

      if (tree.unsupported && tree.directories.length > 0) {
        push({ level: 'warn', title: t('files.folderUploadUnsupported') });
      } else if (failures.length > 0) {
        push({
          level: 'warn',
          title: t('op.partialFailure', { count: failures.length, total: directories.length }),
        });
      } else {
        push({
          level: 'success',
          title: t('xfer.stateDone'),
          detail: t('files.uploading', { count: tree.files.length }),
        });
      }
    },
    [filesTab, store, upload, t],
  );

  useEffect(() => {
    const onUploadRequest = () => fileInputRef.current?.click();
    const onNewFolder = () => openDialog('new-folder');
    window.addEventListener('ssh-explorer:upload', onUploadRequest);
    window.addEventListener('ssh-explorer:new-folder', onNewFolder);
    return () => {
      window.removeEventListener('ssh-explorer:upload', onUploadRequest);
      window.removeEventListener('ssh-explorer:new-folder', onNewFolder);
    };
  }, [openDialog]);

  /* ------------------------------------------------- selection → preview -- */

  // Single-clicking a file loads its preview, the way a desktop explorer's
  // preview pane behaves. Debounced so arrowing through a folder is cheap.
  const previewPath = filesTab?.preview?.path ?? null;
  const previewState = filesTab?.preview?.state ?? null;
  useEffect(() => {
    if (!filesTab) return;
    if (!inspectorOpen) return;
    const entry = selectedEntry;
    if (!entry || entry.kind === 'directory') return;
    if (previewPath === entry.path && previewState !== 'error') return;
    const id = window.setTimeout(() => {
      void store.getState().loadPreview(filesTab.id, entry.path);
    }, 140);
    return () => window.clearTimeout(id);
  }, [filesTab, inspectorOpen, previewPath, previewState, selectedEntry, store]);

  /* ------------------------------------------------- focus for hotkeys -- */

  const paneRef = useRef<HTMLDivElement | null>(null);

  // Keyboard shortcuts (F2, Delete, arrows) only reach the pane when it holds
  // focus, so the pane takes focus when a tab is opened and on any click that is
  // not on a form control.
  useEffect(() => {
    const id = window.requestAnimationFrame(() => paneRef.current?.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(id);
  }, [tabId]);

  /* ------------------------------------------------------------ clipboard -- */

  /** Ctrl+C / Ctrl+X: remember the selection, move nothing yet. */
  const copySelection = useCallback(
    (mode: ClipboardMode) => {
      if (!filesTab) return;
      const paths = [...filesTab.selection];
      if (paths.length === 0) {
        pushToast({ level: 'warn', title: t('op.nothingSelected') });
        return;
      }
      const entry = { connectionId: filesTab.connectionId, paths, mode };
      putClipboard(entry);
      // Also fill the system clipboard with the paths, which is what a terminal
      // or an editor is usually waiting for.
      void navigator.clipboard?.writeText(clipboardAsText(entry)).catch(() => undefined);
      pushToast({
        level: 'info',
        title: t(mode === 'cut' ? 'files.cutCount' : 'files.copiedCount', { count: paths.length }),
        detail: paths.length === 1 ? paths[0] : undefined,
      });
    },
    [filesTab, putClipboard, pushToast, t],
  );

  /* ------------------------------------------------------------ clipboard -- */

  /**
   * Runs a paste, and turns "already exists" into a question rather than an error.
   * `only` narrows a retry to the paths that were refused the first time.
   */
  const runPaste = useCallback(
    async (options?: { overwrite?: boolean; only?: string[] }) => {
      if (!filesTab || !connection) return;
      const source = clipboard;
      const decision = planPaste({
        clipboard: source ? { ...source, paths: options?.only ?? source.paths } : null,
        targetConnectionId: filesTab.connectionId,
        targetDir: filesTab.path,
      });

      if (!decision.ok) {
        const message: Record<PasteRefusal, string> = {
          empty: t('files.clipboardEmpty'),
          'nothing-to-paste': t('files.pasteNothing'),
          'already-here': t('files.pasteAlreadyHere'),
        };
        pushToast({ level: 'warn', title: message[decision.reason] });
        return;
      }

      const { plan } = decision;
      setDialogBusy(true);
      try {
        let failed: { path: string; message: string }[] = [];

        if (plan.kind === 'relay') {
          const relayed = await api.relay(
            plan.sourceConnectionId!,
            plan.sources,
            filesTab.connectionId,
            filesTab.path,
            options?.overwrite === true,
          );
          if (relayed.transfers.length > 0) {
            pushToast({
              level: 'success',
              title: t('xfer.relayTitle'),
              detail: t('files.pasted', { count: relayed.transfers.length }),
            });
          }
          // A taken name on the other host is the same question as a local one.
          if (relayed.conflicts.length > 0 && options?.overwrite !== true) {
            setConflicts({
              paths: relayed.conflicts.map((item) => item.targetPath),
              sources: relayed.conflicts.map((item) => item.sourcePath),
              kind: 'relay',
              sourceConnectionId: plan.sourceConnectionId,
            });
            return;
          }
        } else {
          const result =
            plan.kind === 'move'
              ? await api.move(filesTab.connectionId, plan.sources, filesTab.path, options?.overwrite === true)
              : await api.copy(filesTab.connectionId, plan.sources, filesTab.path, options?.overwrite === true);
          failed = result.failed;

          const pasted = result.copied.length;
          if (pasted > 0) {
            pushToast({
              level: 'success',
              title: t('files.pasted', { count: pasted }),
              detail: plan.sources.length > 1 ? filesTab.path : result.copied[0]?.path,
            });
          }
        }

        // A refused name is the user's decision to make, not an error to report.
        const clashing = failed.filter((item) => /exists/i.test(item.message));
        if (clashing.length > 0 && options?.overwrite !== true) {
          setConflicts({
            paths: clashing.map((item) => item.path),
            sources: clashing.map((item) => item.path),
            kind: plan.kind,
            sourceConnectionId: plan.sourceConnectionId,
          });
          return;
        }
        if (failed.length > 0) {
          pushToast({
            level: 'error',
            title: t('files.pasteFailed'),
            detail: failed[0]?.message,
          });
        }

        if (plan.kind === 'move') clearClipboard();
        await store.getState().refresh(filesTab.id);
      } catch (error) {
        pushToast({
          level: 'error',
          title: t('files.pasteFailed'),
          detail: error instanceof Error ? error.message : String(error),
        });
      } finally {
        setDialogBusy(false);
      }
    },
    [clipboard, clearClipboard, connection, entries, filesTab, pushToast, t],
  );

  /** Applies the conflict answer and finishes the paste. */
  const resolveConflicts = useCallback(
    async (action: 'overwrite' | 'skip') => {
      const pending = conflicts;
      setConflicts(null);
      if (!pending) return;
      if (action === 'skip') {
        if (pending.kind === 'move') clearClipboard();
        return;
      }
      await runPaste({ overwrite: true, only: pending.sources });
    },
    [clearClipboard, conflicts, runPaste],
  );

  /* ------------------------------------------------------------ keyboard -- */

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (!filesTab) return;
      const target = event.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
      const list = visible;
      const currentIndex = singleSelected ? list.findIndex((e) => e.path === singleSelected) : -1;

      const move = (delta: number) => {
        if (list.length === 0) return;
        const next = Math.max(0, Math.min(list.length - 1, currentIndex < 0 ? 0 : currentIndex + delta));
        const entry = list[next];
        if (entry) {
          store.getState().select(filesTab.id, entry.path, event.shiftKey ? 'range' : 'replace', displayOrder);
          requestAnimationFrame(() => {
            bodyRef.current
              ?.querySelector(`[data-path="${CSS.escape(entry.path)}"]`)
              ?.scrollIntoView({ block: 'nearest' });
          });
        }
      };

      switch (event.key) {
        case 'ArrowDown':
          event.preventDefault();
          move(1);
          break;
        case 'ArrowUp':
          event.preventDefault();
          move(-1);
          break;
        case 'Home':
          event.preventDefault();
          if (list[0]) store.getState().select(filesTab.id, list[0].path, 'replace', displayOrder);
          break;
        case 'End': {
          event.preventDefault();
          const last = list[list.length - 1];
          if (last) store.getState().select(filesTab.id, last.path, 'replace', displayOrder);
          break;
        }
        case 'Enter':
          event.preventDefault();
          if (selectedEntry) openEntry(selectedEntry);
          break;
        case 'Backspace':
          event.preventDefault();
          void store.getState().up(filesTab.id);
          break;
        case 'F2':
          event.preventDefault();
          if (selectedEntry) openDialog('rename', selectedEntry.name);
          break;
        case 'F5':
          event.preventDefault();
          void store.getState().refresh(filesTab.id);
          break;
        case 'Delete':
          event.preventDefault();
          if (filesTab.selection.length) openDialog('delete');
          break;
        case 'Escape':
          store.getState().clearSelection(filesTab.id);
          break;
        default:
          if (!(event.ctrlKey || event.metaKey)) break;
          switch (event.key.toLowerCase()) {
            case 'a':
              event.preventDefault();
              store.getState().selectAll(filesTab.id, displayOrder);
              break;
            case 'c':
              event.preventDefault();
              copySelection('copy');
              break;
            case 'x':
              event.preventDefault();
              copySelection('cut');
              break;
            case 'v':
              event.preventDefault();
              void runPaste();
              break;
            default:
              break;
          }
      }
    },
    [copySelection, displayOrder, filesTab, openDialog, openEntry, runPaste, selectedEntry, singleSelected, store, visible],
  );

  /* ---------------------------------------------------------------- menu -- */

  const menuItems = useMemo<MenuItem[]>(() => {
    const entry = menu?.entry ?? null;
    const targets = entry
      ? [entry]
      : entries.filter((e) => selectionSet.has(e.path));
    const hasSelection = targets.length > 0;
    return [
      {
        id: 'open',
        label: entry?.kind === 'directory' ? 'Open' : 'Preview',
        icon: entry?.kind === 'directory' ? 'folder-open' : 'eye',
        disabled: !entry,
        onSelect: () => entry && openEntry(entry),
      },
      {
        id: 'open-tab',
        label: 'Open in new tab',
        icon: 'external',
        disabled: !entry || entry.kind !== 'directory',
        onSelect: () => entry && filesTab && openFilesTab(filesTab.connectionId, entry.path),
      },
      {
        id: 'terminal-here',
        label: 'Open terminal here',
        icon: 'terminal',
        disabled: !connection,
        separatorBefore: true,
        onSelect: () =>
          connection && filesTab && openTerminalTab(connection.id, connection.label, filesTab.path),
      },
      {
        id: 'download',
        label: targets.length > 1 ? `Download ${targets.length} items` : 'Download',
        icon: 'download',
        disabled: !hasSelection,
        onSelect: () => void downloadSelection(targets),
      },
      {
        id: 'sep-1',
        label: '-',
      },
      {
        id: 'rename',
        label: t('files.renameEllipsis'),
        icon: 'pencil',
        shortcut: 'F2',
        disabled: !entry,
        onSelect: () => entry && openDialog('rename', entry.name),
      },
      {
        id: 'permissions',
        label: t('files.permissionsEllipsis'),
        icon: 'shield',
        disabled: !entry,
        onSelect: () => {
          if (!entry) return;
          const octal = (entry.mode & 0o7777).toString(8).padStart(3, '0');
          openDialog('permissions', octal);
        },
      },
      {
        id: 'new-folder',
        label: t('files.newFolder'),
        icon: 'folder-plus',
        onSelect: () => openDialog('new-folder'),
      },
      {
        id: 'upload',
        label: t('files.uploadFiles'),
        icon: 'upload',
        onSelect: () => fileInputRef.current?.click(),
      },
      {
        id: 'sep-2',
        label: '-',
      },
      {
        id: 'copy',
        label: t('files.copy'),
        icon: 'copy',
        shortcut: 'Ctrl C',
        disabled: !hasSelection,
        onSelect: () => copySelection('copy'),
      },
      {
        id: 'cut',
        label: t('files.cut'),
        icon: 'scissors',
        shortcut: 'Ctrl X',
        disabled: !hasSelection,
        onSelect: () => copySelection('cut'),
      },
      {
        id: 'paste',
        label: t('files.paste'),
        icon: 'clipboard',
        shortcut: 'Ctrl V',
        disabled: clipboard === null || !filesTab,
        onSelect: () => void runPaste(),
      },
      {
        id: 'sep-3',
        label: '-',
      },
      {
        id: 'copy-path',
        label: t('files.copyPath'),
        icon: 'copy',
        disabled: !entry,
        onSelect: () => entry && copy(entry.path, t('files.path')),
      },
      {
        id: 'copy-name',
        label: t('files.copyName'),
        icon: 'copy',
        disabled: !entry,
        onSelect: () => entry && copy(entry.name, t('files.name')),
      },
      {
        id: 'delete',
        label: targets.length > 1 ? `Delete ${targets.length} items` : 'Delete',
        icon: 'trash',
        tone: 'danger',
        shortcut: 'Del',
        separatorBefore: true,
        disabled: !hasSelection,
        onSelect: () => openDialog('delete'),
      },
    ];
  }, [
    connection,
    copy,
    copySelection,
    clipboard,
    downloadSelection,
    entries,
    filesTab,
    menu?.entry,
    openDialog,
    openEntry,
    openFilesTab,
    openTerminalTab,
    runPaste,
    selectionSet,
    t,
  ]);


  /* --------------------------------------------------------------- render -- */

  if (!filesTab) return null;

  const canBack = filesTab.historyIndex > 0;
  const canForward = filesTab.historyIndex < filesTab.history.length - 1;
  const canUp = Boolean(filesTab.listing?.parent ?? parentRemotePath(filesTab.path));

  return (
    <div
      className={`fpane${dropping ? ' is-dropping' : ''}`}
      ref={paneRef}
      onKeyDown={onKeyDown}
      tabIndex={-1}
      onMouseDown={(event) => {
        const target = event.target as HTMLElement;
        const tag = target.tagName.toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
        paneRef.current?.focus({ preventScroll: true });
      }}
      onDragEnter={(event) => {
        if (!event.dataTransfer?.types.includes('Files')) return;
        dragDepth.current += 1;
        setDropping(true);
      }}
      onDragOver={(event) => {
        if (!event.dataTransfer?.types.includes('Files')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
      }}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDropping(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer?.types.includes('Files')) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDropping(false);
        // Walk folders through webkitGetAsEntry; the flat FileList cannot.
        void collectDroppedTree(event.dataTransfer).then((tree) => handleTree(tree));
      }}
    >
      <FileToolbar
        tab={filesTab}
        home={connection?.serverInfo?.home}
        canBack={canBack}
        canForward={canForward}
        canUp={canUp}
        onNavigate={(path) => void store.getState().navigate(filesTab.id, path)}
        onBack={() => void store.getState().back(filesTab.id)}
        onForward={() => void store.getState().forward(filesTab.id)}
        onUp={() => void store.getState().up(filesTab.id)}
        onRefresh={() => void store.getState().refresh(filesTab.id)}
        onSort={(key: SortKey) =>
          store.getState().setSort(filesTab.id, nextSort(filesTab.sort, key))
        }
        onFilter={(value) => store.getState().setFilter(filesTab.id, value)}
        onSubmitSearch={() => {
          if (filesTab.filter.trim()) {
            void store.getState().runSearch(filesTab.id, filesTab.filter);
          } else {
            store.getState().clearSearch(filesTab.id);
          }
        }}
        onViewMode={(mode) => store.getState().setViewMode(filesTab.id, mode)}
        onNewFolder={() => openDialog('new-folder')}
        onUpload={() => fileInputRef.current?.click()}
        onUploadFolder={() => folderInputRef.current?.click()}
        onOpenTerminal={() =>
          connection && openTerminalTab(connection.id, connection.label, filesTab.path)
        }
      />

      {filesTab.searchResults ? (
        <div className="searchbanner">
          <Icon name="search" size={13} />
          <span>
            {filesTab.searchLoading
              ? t('files.searchingBelow', { path: filesTab.path })
              : t('files.resultsFor', {
                  count: filesTab.searchResults.length,
                  query: filesTab.searchQuery,
                  path: filesTab.path,
                })}
          </span>
          {filesTab.searchTruncated ? (
            <span className="searchbanner__flag">{t('files.limitReached')}</span>
          ) : null}
          <span className="spacer" />
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => store.getState().clearSearch(filesTab.id)}>
            <Icon name="close" size={12} />
            <span className="btn__label">{t('files.backToFolder')}</span>
          </button>
        </div>
      ) : null}

      <div className="fpane__main">
        <div className="fpane__list" ref={bodyRef}>
          {filesTab.error ? (
            <EmptyState
              icon="alert"
              title="Could not read this folder"
              detail={filesTab.error}
              action={
                <Button variant="secondary" size="md" icon="refresh" onClick={() => void store.getState().refresh(filesTab.id)}>
                  Retry
                </Button>
              }
            />
          ) : filesTab.loading && !filesTab.listing ? (
            <div className="fpane__skeleton" aria-hidden="true">
              {Array.from({ length: 9 }).map((_, index) => (
                <span key={index} className="fpane__skeleton-row" style={{ animationDelay: `${index * 40}ms` }} />
              ))}
            </div>
          ) : visible.length === 0 ? (
            <EmptyState
              icon={filesTab.filter ? 'search' : 'folder-open'}
              title={filesTab.filter ? t('files.noMatches') : t('files.emptyFolder')}
              detail={
                filesTab.filter
                  ? t('files.noMatchesHint', { query: filesTab.filter })
                  : t('files.emptyFolderHint')
              }
              action={
                filesTab.filter ? (
                  <Button variant="secondary" size="md" onClick={() => store.getState().setFilter(filesTab.id, '')}>
                    Clear filter
                  </Button>
                ) : (
                  <Button
                    variant="secondary"
                    size="md"
                    icon="folder-plus"
                    onClick={() => openDialog('new-folder')}
                  >
                    New folder
                  </Button>
                )
              }
            />
          ) : filesTab.viewMode === 'list' ? (
            <FileTable
              entries={visible}
              selection={filesTab.selection}
              sort={filesTab.sort}
              loading={filesTab.loading}
              searchMode={Boolean(filesTab.searchResults)}
              cutPaths={cutPaths}
              usage={filesTab.usage}
              onSort={(key) => store.getState().setSort(filesTab.id, nextSort(filesTab.sort, key))}
              onSelect={(entry, mode) =>
                store.getState().select(filesTab.id, entry.path, mode, displayOrder)
              }
              onOpen={openEntry}
              onContextMenu={(entry, x, y) => setMenu({ x, y, entry })}
              onBackgroundContextMenu={(x, y) => setMenu({ x, y, entry: null })}
            />
          ) : (
            <FileGrid
              entries={visible}
              selection={filesTab.selection}
              cutPaths={cutPaths}
              onSelect={(entry, mode) =>
                store.getState().select(filesTab.id, entry.path, mode, displayOrder)
              }
              onOpen={openEntry}
              onContextMenu={(entry, x, y) => setMenu({ x, y, entry })}
              onBackgroundContextMenu={(x, y) => setMenu({ x, y, entry: null })}
            />
          )}
        </div>

        {inspectorOpen ? (
          <Inspector
            listing={filesTab.listing}
            entries={entries}
            selection={filesTab.selection}
            preview={filesTab.preview}
            connectionLabel={connection?.label}
            width={inspectorWidth}
            onWidthChange={setInspectorWidth}
            onWidthReset={resetInspectorWidth}
            search={
              filesTab.searchResults
                ? {
                    query: filesTab.searchQuery,
                    scope: filesTab.path,
                    truncated: filesTab.searchTruncated,
                  }
                : null
            }
            onClose={() => setInspector(false)}
            onOpen={openEntry}
            onPreviewRequest={(path) => void store.getState().loadPreview(filesTab.id, path)}
            onDownload={downloadEntry}
            onMeasureUsage={
              connection
                ? () =>
                    void store
                      .getState()
                      .measureUsage(filesTab.id, [
                        filesTab.path,
                        ...visible.filter((entry) => entry.kind === 'directory').map((entry) => entry.path),
                      ])
                : null
            }
            measuring={filesTab.measuring.length > 0}
            usage={filesTab.usage}
            onExec={(entry) => {
              setExecEntry(entry);
              setExecOpen(true);
            }}
            onEdit={
              isDesktop
                ? (entry) =>
                    void startEdit({
                      connectionId: filesTab.connectionId,
                      remotePath: entry.path,
                      name: entry.name,
                    })
                : null
            }
          />
        ) : null}
      </div>

      {filesTab.listing?.truncated || connection?.status === 'disconnected' || connection?.status === 'error' ? (
        <footer className="fpane__foot hairline-t">
          {filesTab.listing?.truncated ? (
            <span className="fpane__warn">
              <Icon name="alert" size={12} />
              {t('files.truncated', { count: entries.length })}
            </span>
          ) : null}
          {connection?.status === 'disconnected' || connection?.status === 'error' ? (
            <span className="fpane__warn">
              <Icon name="alert" size={12} />
              {connection.statusDetail ?? 'Connection lost'}
            </span>
          ) : null}
        </footer>
      ) : null}

      <RunCommandDialog
        open={execOpen}
        connectionId={filesTab.connectionId}
        connectionLabel={connection?.label}
        cwd={filesTab.path}
        entry={execEntry}
        onClose={() => setExecOpen(false)}
      />

      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          handleFiles(event.target.files);
          event.target.value = '';
        }}
      />

      {/* Separate input: `webkitdirectory` cannot be toggled on the same element. */}
      <input
        ref={folderInputRef}
        type="file"
        multiple
        hidden
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        onChange={(event) => {
          void handleTree(collectPickedTree(event.target.files));
          event.target.value = '';
        }}
      />

      {dropping ? (
        <div className="dropzone">
          <Icon name="upload" size={26} strokeWidth={1.3} />
          <p>{t('files.dropHere')}</p>
          <code className="mono">{filesTab.path}</code>
        </div>
      ) : null}

      {menu ? (
        <Menu x={menu.x} y={menu.y} onClose={() => setMenu(null)} items={menuItems} minWidth={230} />
      ) : null}

      <Modal
        open={dialog === 'new-folder'}
        title={t('op.newFolderTitle')}
        subtitle={filesTab.path}
        onClose={() => setDialog(null)}
        width={420}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" loading={dialogBusy} onClick={() => void submitDialog()}>
              {t('op.createFolder')}
            </Button>
          </>
        }
      >
        <Field label={t('op.folderName')} error={dialogError ?? undefined}>
          <TextInput
            value={dialogValue}
            autoFocus
            mono
            placeholder="releases"
            onChange={(event) => setDialogValue(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && void submitDialog()}
          />
        </Field>
      </Modal>

      <Modal
        open={dialog === 'rename'}
        title={t('op.renameTitle')}
        subtitle={selectedEntry?.path}
        onClose={() => setDialog(null)}
        width={420}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" loading={dialogBusy} onClick={() => void submitDialog()}>
              {t('common.rename')}
            </Button>
          </>
        }
      >
        <Field label={t('op.newName')} error={dialogError ?? undefined}>
          <TextInput
            value={dialogValue}
            autoFocus
            mono
            onChange={(event) => setDialogValue(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && void submitDialog()}
          />
        </Field>
      </Modal>

      <Modal
        open={dialog === 'permissions'}
        title={t('op.permissionsTitle')}
        subtitle={selectedEntry?.path}
        onClose={() => setDialog(null)}
        width={420}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="primary" loading={dialogBusy} onClick={() => void submitDialog()}>
              {t('common.apply')}
            </Button>
          </>
        }
      >
        <Field label={t('op.octalMode')} hint={t('op.octalHint')} error={dialogError ?? undefined}>
          <TextInput
            value={dialogValue}
            autoFocus
            mono
            maxLength={4}
            onChange={(event) => setDialogValue(event.target.value.replace(/[^0-7]/g, ''))}
            onKeyDown={(event) => event.key === 'Enter' && void submitDialog()}
          />
        </Field>
      </Modal>

      <Modal
        open={dialog === 'delete'}
        title={
          filesTab.selection.length > 1
            ? t('op.deleteManyTitle', { count: filesTab.selection.length })
            : t('op.deleteTitle')
        }
        tone="danger"
        onClose={() => setDialog(null)}
        width={460}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="danger" loading={dialogBusy} onClick={() => void submitDialog()}>
              {t('op.deleteForever')}
            </Button>
          </>
        }
      >
        <p className="dialog__text">{t('op.deleteWarning')}</p>
        <ul className="dialog__list mono">
          {entries
            .filter((e) => selectionSet.has(e.path))
            .slice(0, 6)
            .map((entry) => (
              <li key={entry.path} className="truncate">
                {entry.name}
              </li>
            ))}
          {filesTab.selection.length > 6 ? (
            <li>{t('files.andMore', { count: filesTab.selection.length - 6 })}</li>
          ) : null}
        </ul>
        {dialogError ? <p className="field__error">{dialogError}</p> : null}
      </Modal>

      {/* A refused name is a choice, not a failure: ask before replacing anything. */}
      <Modal
        open={conflicts !== null}
        title={t('files.pasteConflictTitle', { count: conflicts?.paths.length ?? 0 })}
        onClose={() => setConflicts(null)}
        width={480}
        footer={
          <>
            <Button variant="ghost" onClick={() => setConflicts(null)}>
              {t('common.cancel')}
            </Button>
            <span className="spacer" />
            <Button variant="secondary" onClick={() => void resolveConflicts('skip')}>
              {t('files.skipExisting')}
            </Button>
            <Button variant="danger" loading={dialogBusy} onClick={() => void resolveConflicts('overwrite')}>
              {t('files.overwriteAll')}
            </Button>
          </>
        }
      >
        <p className="dialog__text">{t('files.pasteConflictBody')}</p>
        <ul className="dialog__list mono">
          {(conflicts?.paths ?? []).slice(0, 6).map((path) => (
            <li key={path} className="truncate">
              {path}
            </li>
          ))}
          {(conflicts?.paths.length ?? 0) > 6 ? (
            <li>{t('files.andMore', { count: (conflicts?.paths.length ?? 0) - 6 })}</li>
          ) : null}
        </ul>
      </Modal>
    </div>
  );
}
