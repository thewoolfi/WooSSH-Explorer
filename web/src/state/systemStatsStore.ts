import { create } from 'zustand';
import type { RemoteSystemStats } from '../api/types';
import { api } from '../api/client';

/**
 * Cached `df`/`free`/`uptime` answers, shared by the status bar and the status panel.
 *
 * One fetch feeds both, so opening the panel never issues a second command, and the
 * status bar can show a load figure without asking the host on every render.
 */
const STALE_AFTER_MS = 30_000;

interface SystemStatsState {
  byConnection: Record<string, { stats: RemoteSystemStats; fetchedAt: number }>;
  loading: Record<string, boolean>;
  /** Fetches when the cached answer is missing or older than {@link STALE_AFTER_MS}. */
  refresh: (connectionId: string, options?: { force?: boolean }) => Promise<void>;
  forget: (connectionId: string) => void;
}

export const useSystemStatsStore = create<SystemStatsState>((set, get) => ({
  byConnection: {},
  loading: {},

  refresh: async (connectionId, options) => {
    const cached = get().byConnection[connectionId];
    if (!options?.force && cached && Date.now() - cached.fetchedAt < STALE_AFTER_MS) return;
    if (get().loading[connectionId]) return;

    set((s) => ({ loading: { ...s.loading, [connectionId]: true } }));
    try {
      const stats = await api.systemStats(connectionId);
      set((s) => ({
        byConnection: { ...s.byConnection, [connectionId]: { stats, fetchedAt: Date.now() } },
      }));
    } catch {
      // A host without `/proc` or without a shell is not an error worth surfacing here:
      // the panel reports it, the status bar simply shows nothing.
    } finally {
      set((s) => ({ loading: { ...s.loading, [connectionId]: false } }));
    }
  },

  forget: (connectionId) =>
    set((s) => {
      const next = { ...s.byConnection };
      delete next[connectionId];
      return { byConnection: next };
    }),
}));

/** The bits worth a few characters in the status bar. */
export function summarise(stats: RemoteSystemStats | null): {
  load: string | null;
  memory: string | null;
  disk: string | null;
} {
  if (!stats) return { load: null, memory: null, disk: null };

  const memoryPercent =
    stats.memory && stats.memory.totalBytes > 0
      ? Math.round((stats.memory.usedBytes / stats.memory.totalBytes) * 100)
      : null;

  // The fullest filesystem is the one worth knowing about.
  let disk: string | null = null;
  let worst = -1;
  for (const entry of stats.disks) {
    if (entry.sizeBytes <= 0) continue;
    const percent = (entry.usedBytes / entry.sizeBytes) * 100;
    if (percent > worst) {
      worst = percent;
      disk = `${Math.round(percent)}%`;
    }
  }

  return {
    load: stats.load && stats.load.length > 0 ? (stats.load[0] as number).toFixed(2) : null,
    memory: memoryPercent === null ? null : `${memoryPercent}%`,
    disk,
  };
}
