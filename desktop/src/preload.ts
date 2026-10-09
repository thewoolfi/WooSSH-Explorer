import { contextBridge, ipcRenderer } from 'electron';

/** A change detected in a file that was opened for editing (see `editSession.ts`). */
export interface EditEventPayload {
  sessionId: string;
  state: 'opened' | 'changed' | 'uploading' | 'uploaded' | 'cancelled' | 'error';
  name: string;
  remotePath: string;
  localPath: string;
  connectionId: string;
  bytes?: number;
  target?: string;
  message?: string;
}

/**
 * The only bridge between the sandboxed UI and the desktop shell. Deliberately
 * tiny: no filesystem, no shell, no Node — just the handful of host capabilities
 * the interface actually needs.
 */
export interface DesktopBridge {
  readonly isDesktop: true;
  readonly platform: string;
  /** Menu commands, forwarded as the same action names the shortcuts use. */
  onMenuAction(handler: (action: string) => void): () => void;
  /** Fired after a native "Save as" download finishes. */
  onDownloadDone(handler: (payload: { path: string; state: string; name: string }) => void): () => void;
  /**
   * Downloads a file the shell owns, so an interrupted transfer can be continued.
   * Falls back to Chromium's pipeline only in the browser build, where this is absent.
   */
  downloadResumable(request: {
    url: string;
    name: string;
  }): Promise<{ path: string; bytes: number; resumedFrom: number; resumed: boolean } | null>;
  /** Bytes written so far while a resumable download runs. */
  onDownloadProgress(
    handler: (progress: { name: string; received: number; total: number | null; resumedFrom: number }) => void,
  ): () => void;
  /** Highlights a file in Explorer/Finder. */
  reveal(path: string): Promise<void>;
  /** Opens a folder or file with the OS default handler. */
  openPath(path: string): Promise<void>;
  /** Opens http(s) links in the user's browser. */
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

  /* ---- edit in the OS default application ---- */
  editOpen(request: {
    connectionId: string;
    remotePath: string;
    name: string;
  }): Promise<{ sessionId: string; localPath: string }>;
  editResolve(
    sessionId: string,
    decision: { action: 'overwrite' | 'save-as' | 'cancel'; remotePath?: string },
  ): Promise<void>;
  onEditEvent(handler: (event: EditEventPayload) => void): () => void;
}

const bridge: DesktopBridge = {
  isDesktop: true,
  platform: process.platform,

  onMenuAction(handler) {
    const listener = (_event: unknown, action: string): void => handler(action);
    ipcRenderer.on('desktop:menu', listener);
    return () => ipcRenderer.removeListener('desktop:menu', listener);
  },

  onDownloadDone(handler) {
    const listener = (_event: unknown, payload: { path: string; state: string; name: string }): void =>
      handler(payload);
    ipcRenderer.on('desktop:download-done', listener);
    return () => ipcRenderer.removeListener('desktop:download-done', listener);
  },

  downloadResumable: (request) =>
    ipcRenderer.invoke('desktop:download-resumable', request) as Promise<{
      path: string;
      bytes: number;
      resumedFrom: number;
      resumed: boolean;
    } | null>,

  onDownloadProgress(handler) {
    const listener = (
      _event: unknown,
      progress: { name: string; received: number; total: number | null; resumedFrom: number },
    ): void => handler(progress);
    ipcRenderer.on('desktop:download-progress', listener);
    return () => ipcRenderer.removeListener('desktop:download-progress', listener);
  },

  reveal: (path) => ipcRenderer.invoke('desktop:reveal', path) as Promise<void>,
  openPath: (path) => ipcRenderer.invoke('desktop:open-path', path) as Promise<void>,
  openExternal: (url) => ipcRenderer.invoke('desktop:open-external', url) as Promise<void>,
  info: () =>
    ipcRenderer.invoke('desktop:info') as Promise<
      DesktopBridge['info'] extends () => Promise<infer R> ? R : never
    >,

  editOpen: (request) =>
    ipcRenderer.invoke('desktop:edit-open', request) as Promise<{
      sessionId: string;
      localPath: string;
    }>,
  editResolve: (sessionId, decision) =>
    ipcRenderer.invoke('desktop:edit-resolve', { sessionId, decision }) as Promise<void>,
  onEditEvent(handler) {
    const listener = (_event: unknown, payload: EditEventPayload): void => handler(payload);
    ipcRenderer.on('desktop:edit-event', listener);
    return () => ipcRenderer.removeListener('desktop:edit-event', listener);
  },
};

contextBridge.exposeInMainWorld('sshExplorerDesktop', bridge);
