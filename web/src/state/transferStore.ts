import { create } from 'zustand';
import type { AppSettings, Transfer } from '../api/types';
import { api } from '../api/client';
import { downloadWithResume } from '../lib/desktop';
import { useUiStore } from './uiStore';

interface TransferState {
  transfers: Transfer[];
  /** Server-side queue settings; `null` until the first load succeeds. */
  settings: AppSettings | null;

  setAll: (transfers: Transfer[]) => void;
  upsert: (transfer: Transfer) => void;
  cancel: (id: string) => Promise<void>;
  retry: (id: string) => Promise<void>;
  clearFinished: () => Promise<void>;
  upload: (connectionId: string, dirPath: string, files: File[]) => Promise<void>;
  loadSettings: () => Promise<void>;
  saveSettings: (next: AppSettings) => Promise<void>;
}

export const useTransferStore = create<TransferState>((set, get) => ({
  transfers: [],
  settings: null,

  setAll: (transfers) => set({ transfers }),

  loadSettings: async () => {
    try {
      set({ settings: await api.settings() });
    } catch {
      /* an older server without /api/settings simply keeps the defaults */
    }
  },

  saveSettings: async (next) => {
    try {
      set({ settings: await api.updateSettings(next) });
    } catch (error) {
      useUiStore.getState().pushToast({
        level: 'warn',
        title: 'Could not save the transfer settings',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  },

  upsert: (transfer) =>
    set((state) => {
      const index = state.transfers.findIndex((t) => t.id === transfer.id);
      if (index < 0) return { transfers: [...state.transfers, transfer] };
      const next = [...state.transfers];
      next[index] = transfer;
      return { transfers: next };
    }),

  cancel: async (id) => {
    const { transfer } = await api.cancelTransfer(id);
    get().upsert(transfer);
  },

  retry: async (id) => {
    const existing = get().transfers.find((t) => t.id === id);
    if (!existing) return;
    const push = useUiStore.getState().pushToast;

    if (existing.direction === 'download') {
      // A download's bytes have no server-side destination, so the API can only
      // reset the record — replaying it is the client's job. Re-issue the
      // download instead of leaving a row stuck in `queued` forever.
      const url = api.downloadUrl(existing.connectionId, existing.remotePath);
      // In the desktop the shell continues from the partial it kept, so a failed 5 GB
      // transfer resumes rather than starting over.
      void downloadWithResume({ url, name: existing.name }).then((result) => {
        if (result !== null) {
          if (result.resumed) {
            push({
              level: 'info',
              title: `Resumed ${existing.name}`,
              detail: `from ${result.resumedFrom} bytes`,
            });
          }
          return;
        }
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = existing.name;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
      });
      return;
    }

    try {
      const { transfer } = await api.retryTransfer(id);
      get().upsert(transfer);
    } catch (error) {
      push({
        level: 'warn',
        title: 'This transfer cannot be retried',
        detail:
          error instanceof Error
            ? error.message
            : 'Send the file again to start a new upload.',
      });
    }
  },

  clearFinished: async () => {
    await api.clearTransfers();
    set((state) => ({
      transfers: state.transfers.filter((t) => t.state === 'active' || t.state === 'queued'),
    }));
  },

  upload: async (connectionId, dirPath, files) => {
    const push = useUiStore.getState().pushToast;
    await Promise.all(
      files.map(async (file) => {
        try {
          const { transfer } = await api.upload(connectionId, dirPath, file);
          get().upsert(transfer);
        } catch (error) {
          push({
            level: 'error',
            title: `Upload failed: ${file.name}`,
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
  },
}));

export function activeTransfers(transfers: Transfer[]): Transfer[] {
  return transfers.filter((t) => t.state === 'active' || t.state === 'queued');
}

export function totalSpeed(transfers: Transfer[]): number {
  return transfers
    .filter((t) => t.state === 'active')
    .reduce((sum, t) => sum + (t.bytesPerSecond || 0), 0);
}
