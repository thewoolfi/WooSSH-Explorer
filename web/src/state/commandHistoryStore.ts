import { create } from 'zustand';

export interface HistoryCommand {
  id: string;
  command: string;
  timestamp: number;
  connectionId?: string;
}

export const STORAGE_KEY = 'ssh-explorer.terminal-history';
export const MAX_HISTORY_ITEMS = 500;

function loadStoredHistory(): HistoryCommand[] {
  try {
    if (typeof localStorage === 'undefined') return [];
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (item): item is HistoryCommand =>
          Boolean(item && typeof item === 'object' && typeof item.command === 'string' && typeof item.id === 'string'),
      )
      .slice(0, MAX_HISTORY_ITEMS);
  } catch {
    return [];
  }
}

function saveStoredHistory(commands: HistoryCommand[]): void {
  try {
    if (typeof localStorage === 'undefined') return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(commands.slice(0, MAX_HISTORY_ITEMS)));
  } catch {
    /* ignore storage quota errors */
  }
}

export interface CommandHistoryState {
  commands: HistoryCommand[];
  addCommand: (command: string, connectionId?: string) => void;
  removeCommand: (id: string) => void;
  clearHistory: (connectionId?: string) => void;
}

export const useCommandHistoryStore = create<CommandHistoryState>((set) => ({
  commands: loadStoredHistory(),

  addCommand: (rawCommand, connectionId) => {
    const command = rawCommand.trim();
    if (!command) return;

    set((state) => {
      // Remove previous identical command so it moves to top (MRU order) without duplicates
      const filtered = state.commands.filter(
        (c) => !(c.command === command && c.connectionId === connectionId),
      );

      const newItem: HistoryCommand = {
        id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        command,
        timestamp: Date.now(),
        connectionId,
      };

      const updated = [newItem, ...filtered].slice(0, MAX_HISTORY_ITEMS);
      saveStoredHistory(updated);
      return { commands: updated };
    });
  },

  removeCommand: (id) => {
    set((state) => {
      const updated = state.commands.filter((c) => c.id !== id);
      saveStoredHistory(updated);
      return { commands: updated };
    });
  },

  clearHistory: (connectionId) => {
    set((state) => {
      const updated = connectionId
        ? state.commands.filter((c) => c.connectionId !== connectionId)
        : [];
      saveStoredHistory(updated);
      return { commands: updated };
    });
  },
}));
