/**
 * Bridge to the Electron shell (`desktop/src/preload.ts`).
 *
 * Everything here degrades to no-ops in a plain browser, so the same bundle runs
 * both as the desktop app and as a normal web page.
 */

export interface DesktopMenuActionMap {
  [action: string]: (() => void) | undefined;
}

/** A change detected in a file that was opened for editing. */
export interface EditEvent {
  sessionId: string;
  state: 'opened' | 'changed' | 'uploading' | 'uploaded' | 'cancelled' | 'error';
  name: string;
  remotePath: string;
  localPath: string;
  /** Host the file came from. */
  connectionId: string;
  bytes?: number;
  target?: string;
  message?: string;
}

export type EditDecision =
  | { action: 'overwrite' }
  | { action: 'save-as'; remotePath: string }
  | { action: 'cancel' };

export interface EditHandle {
  sessionId: string;
  localPath: string;
}

interface DesktopBridge {
  readonly isDesktop: true;
  readonly platform: string;
  onMenuAction(handler: (action: string) => void): () => void;
  onDownloadDone(
    handler: (payload: { path: string; state: string; name: string }) => void,
  ): () => void;
  /** Downloads through the shell, so an interrupted transfer can be continued. */
  downloadResumable(request: { url: string; name: string }): Promise<{
    path: string;
    bytes: number;
    resumedFrom: number;
    resumed: boolean;
  } | null>;
  onDownloadProgress(
    handler: (progress: { name: string; received: number; total: number | null; resumedFrom: number }) => void,
  ): () => void;
  reveal(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  info(): Promise<{
    version: string;
    electron: string;
    chrome: string;
    stateDir: string;
    downloadDir: string;
    logFilePath: string;
    logDir: string;
  }>;
  /** Opens a folder or file with the OS default handler. */
  openPath(path: string): Promise<void>;
  editOpen(request: {
    connectionId: string;
    remotePath: string;
    name: string;
  }): Promise<EditHandle>;
  editResolve(sessionId: string, decision: EditDecision): Promise<void>;
  onEditEvent(handler: (event: EditEvent) => void): () => void;
}

function bridge(): DesktopBridge | null {
  const candidate = (globalThis as { sshExplorerDesktop?: unknown }).sshExplorerDesktop;
  if (
    typeof candidate === 'object' &&
    candidate !== null &&
    (candidate as { isDesktop?: unknown }).isDesktop === true
  ) {
    return candidate as DesktopBridge;
  }
  return null;
}

export const desktopBridge = bridge();

/** True when running inside the Electron shell rather than a browser tab. */
export const isDesktop = desktopBridge !== null;

/** Routes native menu commands onto the renderer's existing actions. */
export function onMenuAction(actions: DesktopMenuActionMap): () => void {
  const desktop = desktopBridge;
  if (!desktop) return () => undefined;
  return desktop.onMenuAction((action) => {
    const handler = actions[action];
    handler?.();
  });
}

/** Notifies when a native "Save as" download settles. */
export function onDownloadDone(
  handler: (payload: { path: string; state: string; name: string }) => void,
): () => void {
  const desktop = desktopBridge;
  if (!desktop) return () => undefined;
  return desktop.onDownloadDone(handler);
}

/**
 * Downloads a file through the shell, which keeps the partial on disk so a retry can
 * continue instead of starting from zero. Resolves `null` in the browser build (where
 * the caller falls back to a plain anchor) and when the user cancels the save dialog.
 */
export async function downloadWithResume(request: {
  url: string;
  name: string;
}): Promise<{ path: string; bytes: number; resumedFrom: number; resumed: boolean } | null> {
  const desktop = desktopBridge;
  if (!desktop || typeof desktop.downloadResumable !== 'function') return null;
  return desktop.downloadResumable(request);
}

export function onDownloadProgress(
  handler: (progress: { name: string; received: number; total: number | null; resumedFrom: number }) => void,
): () => void {
  const desktop = desktopBridge;
  if (!desktop || typeof desktop.onDownloadProgress !== 'function') return () => undefined;
  return desktop.onDownloadProgress(handler);
}

/** Opens a link outside the app: the OS browser in the desktop build, a tab in the browser. */
export function openExternalLink(url: string): void {
  if (desktopBridge) {
    void desktopBridge.openExternal(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** Highlights a downloaded file in Explorer / Finder. */export function revealInFileManager(path: string): void {
  void desktopBridge?.reveal(path);
}

/** Opens a folder or file with the OS default handler; a no-op in the browser. */
export function openWithOs(path: string): void {
  void (desktopBridge as { openPath?: (value: string) => Promise<void> } | null)?.openPath?.(path);
}

export async function desktopInfo(): Promise<{
  version: string;
  stateDir: string;
  downloadDir: string;
  logFilePath: string;
  logDir: string;
} | null> {
  const desktop = desktopBridge;
  if (!desktop) return null;
  try {
    return await desktop.info();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------ edit in default app */

/** Downloads a remote file, opens it in this PC's default app and watches it. */
export async function openForEdit(request: {
  connectionId: string;
  remotePath: string;
  name: string;
}): Promise<EditHandle> {
  const desktop = desktopBridge;
  if (!desktop) throw new Error('Editing in a local application needs the desktop app.');
  return desktop.editOpen(request);
}

/** Answers the "the file changed — what now?" prompt. */
export async function resolveEdit(sessionId: string, decision: EditDecision): Promise<void> {
  await desktopBridge?.editResolve(sessionId, decision);
}

/** Subscribes to edit-session progress. */
export function onEditEvent(handler: (event: EditEvent) => void): () => void {
  const desktop = desktopBridge;
  if (!desktop) return () => undefined;
  return desktop.onEditEvent(handler);
}
