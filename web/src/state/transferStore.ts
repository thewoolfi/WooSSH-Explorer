import { create } from 'zustand';
import type { AppSettings, Transfer } from '../api/types';
import { api } from '../api/client';
import { downloadWithResume } from '../lib/desktop';
import { formatBytes } from '../lib/format';
import { translate } from '../i18n';
import { useUiStore } from './uiStore';

export interface UploadBatchStats {
  id: string;
  totalFiles: number;
  totalBytes: number;
  completedFiles: number;
  failedFiles: number;
  inProgress: boolean;
  startedAt: number;
}

interface TransferState {
  transfers: Transfer[];
  /** Server-side queue settings; `null` until the first load succeeds. */
  settings: AppSettings | null;
  uploadBatch: UploadBatchStats | null;

  setAll: (transfers: Transfer[]) => void;
  upsert: (transfer: Transfer) => void;
  cancel: (id: string) => Promise<void>;
  retry: (id: string) => Promise<void>;
  clearFinished: () => Promise<void>;
  clearUploadBatch: () => void;
  upload: (connectionId: string, dirPath: string, files: File[]) => Promise<void>;
  uploadBatchEntries: (connectionId: string, items: { dirPath: string; file: File }[]) => Promise<void>;
  loadSettings: () => Promise<void>;
  saveSettings: (next: AppSettings) => Promise<void>;
}

export const useTransferStore = create<TransferState>((set, get) => ({
  transfers: [],
  settings: null,
  uploadBatch: null,

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

  clearUploadBatch: () => set({ uploadBatch: null }),

  uploadBatchEntries: async (connectionId, items) => {
    if (items.length === 0) return;
    const ui = useUiStore.getState();
    ui.setDockView('transfers');

    const totalFiles = items.length;
    const totalBytes = items.reduce((sum, item) => sum + item.file.size, 0);

    set((s) => {
      const prev = s.uploadBatch;
      if (prev && prev.inProgress) {
        return {
          uploadBatch: {
            ...prev,
            totalFiles: prev.totalFiles + totalFiles,
            totalBytes: prev.totalBytes + totalBytes,
          },
        };
      }
      return {
        uploadBatch: {
          id: `batch-${Date.now()}`,
          totalFiles,
          totalBytes,
          completedFiles: 0,
          failedFiles: 0,
          inProgress: true,
          startedAt: Date.now(),
        },
      };
    });

    ui.pushToast({
      level: 'info',
      title: translate('xfer.evaluatingTitle'),
      detail: translate('xfer.evaluatingDetail', { count: totalFiles, size: formatBytes(totalBytes) }),
    });

    const maxConcurrent = Math.max(1, Math.min(6, get().settings?.transfers.maxConcurrent ?? 3));
    let errorCount = 0;

    let index = 0;
    const workers = Array.from({ length: Math.min(maxConcurrent, items.length) }, async () => {
      while (index < items.length) {
        const item = items[index++];
        if (!item) break;
        try {
          const { transfer } = await api.upload(connectionId, item.dirPath, item.file);
          get().upsert(transfer);
          set((s) => {
            if (!s.uploadBatch) return s;
            return {
              uploadBatch: {
                ...s.uploadBatch,
                completedFiles: s.uploadBatch.completedFiles + 1,
              },
            };
          });
        } catch (error) {
          errorCount += 1;
          set((s) => {
            if (!s.uploadBatch) return s;
            return {
              uploadBatch: {
                ...s.uploadBatch,
                failedFiles: s.uploadBatch.failedFiles + 1,
              },
            };
          });
          if (errorCount <= 3) {
            ui.pushToast({
              level: 'error',
              title: translate('xfer.uploadFailedFor', { name: item.file.name }),
              detail: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    });

    await Promise.all(workers);

    const finalBatch = get().uploadBatch;
    set((s) => (s.uploadBatch ? { uploadBatch: { ...s.uploadBatch, inProgress: false } } : s));

    if (finalBatch) {
      if (finalBatch.failedFiles === 0) {
        ui.pushToast({
          level: 'success',
          title: translate('xfer.allUploadedTitle'),
          detail: translate('xfer.allUploadedDetail', {
            count: finalBatch.totalFiles,
            size: formatBytes(finalBatch.totalBytes),
          }),
          persistent: true,
        });
      } else {
        ui.pushToast({
          level: 'warn',
          title: translate('xfer.batchFinishedWithErrors'),
          detail: translate('xfer.batchFinishedWithErrorsDetail', {
            completed: finalBatch.completedFiles,
            total: finalBatch.totalFiles,
            failed: finalBatch.failedFiles,
          }),
          persistent: true,
        });
      }
    }
  },

  upload: async (connectionId, dirPath, files) => {
    const items = files.map((file) => ({ dirPath, file }));
    return get().uploadBatchEntries(connectionId, items);
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
