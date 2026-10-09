import { create } from 'zustand';
import type {
  ConnectionSummary,
  HostColor,
  SavedProfile,
  SecretStorageInfo,
  SystemInfo,
  VaultSecretEntry,
} from '../api/types';
import { HOST_COLORS } from '../api/types';
import { api, ApiError } from '../api/client';

const ACTIVE_KEY = 'ssh-explorer.activeConnection';

interface ConnectionState {
  connections: ConnectionSummary[];
  profiles: SavedProfile[];
  systemInfo: SystemInfo | null;
  /** Metadata for every credential in the vault — never a secret. */
  secrets: VaultSecretEntry[];
  secretStorage: SecretStorageInfo | null;
  activeId: string | null;
  bootError: string | null;
  loadingConnections: boolean;
  pendingConnectionId: string | null;

  bootstrap: () => Promise<void>;
  refreshConnections: () => Promise<void>;
  refreshProfiles: () => Promise<void>;
  refreshSecrets: () => Promise<void>;
  forgetSecret: (id: string) => Promise<void>;
  forgetAllSecrets: () => Promise<void>;
  storedSecretFor: (host: string, port: number, username: string) => VaultSecretEntry | undefined;
  setActive: (id: string | null) => void;
  upsertConnection: (connection: ConnectionSummary) => void;
  removeConnection: (id: string) => void;
  connect: (input: Parameters<typeof api.connect>[0]) => Promise<{
    connection: ConnectionSummary;
    savedSecret: boolean;
    usedStoredSecret: boolean;
  }>;
  disconnect: (id: string) => Promise<void>;
  reconnect: (id: string) => Promise<void>;
  saveProfile: (input: Partial<SavedProfile>) => Promise<SavedProfile>;
  updateProfile: (id: string, input: Partial<SavedProfile>) => Promise<void>;
  deleteProfile: (id: string) => Promise<void>;
  measureLatency: (id: string) => Promise<void>;
}

export const useConnectionStore = create<ConnectionState>((set, get) => ({
  connections: [],
  profiles: [],
  systemInfo: null,
  secrets: [],
  secretStorage: null,
  activeId: null,
  bootError: null,
  loadingConnections: false,
  pendingConnectionId: null,

  bootstrap: async () => {
    try {
      const [info, profiles, connections, secrets] = await Promise.all([
        api.systemInfo(),
        api.listProfiles().catch(() => ({ profiles: [] as SavedProfile[] })),
        api.listConnections().catch(() => ({ connections: [] as ConnectionSummary[] })),
        api.listSecrets().catch(() => null),
      ]);
      const remembered = safeRead(ACTIVE_KEY);
      const known = connections.connections.some((c) => c.id === remembered);
      const authenticated = connections.connections.filter((c) => c.status === 'authenticated');
      set({
        systemInfo: info,
        profiles: profiles.profiles,
        connections: connections.connections,
        secrets: secrets?.secrets ?? [],
        secretStorage: secrets?.storage ?? info.secretStorage ?? null,
        activeId:
          (known && remembered) ||
          authenticated[0]?.id ||
          connections.connections[0]?.id ||
          null,
        bootError: null,
      });
    } catch (error) {
      set({
        bootError:
          error instanceof ApiError
            ? error.message
            : 'The SSH Explorer service is not reachable.',
      });
    }
  },

  refreshConnections: async () => {
    set({ loadingConnections: true });
    try {
      const { connections } = await api.listConnections();
      const { activeId } = get();
      const stillThere = connections.some((c) => c.id === activeId);
      set({
        connections,
        loadingConnections: false,
        activeId: stillThere ? activeId : (connections[0]?.id ?? null),
      });
    } catch {
      set({ loadingConnections: false });
    }
  },

  refreshProfiles: async () => {
    try {
      const { profiles } = await api.listProfiles();
      set({ profiles });
    } catch {
      /* profiles are a convenience, never fatal */
    }
  },

  refreshSecrets: async () => {
    try {
      const { secrets, storage } = await api.listSecrets();
      set({ secrets, secretStorage: storage });
    } catch {
      /* the vault is optional; never block the UI on it */
    }
  },

  forgetSecret: async (id) => {
    await api.forgetSecret(id);
    set((state) => ({ secrets: state.secrets.filter((entry) => entry.id !== id) }));
  },

  forgetAllSecrets: async () => {
    await api.forgetAllSecrets();
    set({ secrets: [] });
  },

  /** Matches the vault's own key: host + port + username. */
  storedSecretFor: (host, port, username) =>
    get().secrets.find(
      (entry) => entry.host === host && entry.port === port && entry.username === username,
    ),

  setActive: (id) => {
    set({ activeId: id });
    if (id) safeWrite(ACTIVE_KEY, id);
    else safeRemove(ACTIVE_KEY);
  },

  upsertConnection: (connection) => {
    set((state) => {
      const index = state.connections.findIndex((c) => c.id === connection.id);
      const connections =
        index >= 0
          ? state.connections.map((c) => (c.id === connection.id ? connection : c))
          : [...state.connections, connection];
      return { connections };
    });
  },

  removeConnection: (id) => {
    set((state) => {
      const connections = state.connections.filter((c) => c.id !== id);
      const activeId = state.activeId === id ? (connections[0]?.id ?? null) : state.activeId;
      if (activeId) safeWrite(ACTIVE_KEY, activeId);
      else safeRemove(ACTIVE_KEY);
      return { connections, activeId };
    });
  },

  connect: async (input) => {
    const { connection, savedSecret, usedStoredSecret } = await api.connect(input);
    get().upsertConnection(connection);
    get().setActive(connection.id);
    if (savedSecret) void get().refreshSecrets();
    if (input.saveProfile) {
      await get()
        .saveProfile({
          label: connection.label,
          host: connection.host,
          port: connection.port,
          username: connection.username,
          authMethod: connection.authMethod,
          color: connection.color,
          privateKeyPath:
            input.auth?.method === 'privateKey' ? input.auth.privateKeyPath : undefined,
        })
        .catch(() => undefined);
    }
    void get().measureLatency(connection.id);
    return {
      connection,
      savedSecret: savedSecret === true,
      usedStoredSecret: usedStoredSecret === true,
    };
  },

  disconnect: async (id) => {
    await api.disconnect(id);
    get().removeConnection(id);
  },

  reconnect: async (id) => {
    const { connection } = await api.reconnect(id);
    get().upsertConnection(connection);
  },

  saveProfile: async (input) => {
    const { profile } = await api.createProfile(input);
    set((state) => ({ profiles: [...state.profiles, profile] }));
    return profile;
  },

  updateProfile: async (id, input) => {
    const { profile } = await api.updateProfile(id, input);
    set((state) => ({ profiles: state.profiles.map((p) => (p.id === id ? profile : p)) }));
  },

  deleteProfile: async (id) => {
    await api.deleteProfile(id);
    set((state) => ({ profiles: state.profiles.filter((p) => p.id !== id) }));
  },

  measureLatency: async (id) => {
    const started = performance.now();
    try {
      const { connection } = await api.getConnection(id);
      const elapsed = Math.round(performance.now() - started);
      get().upsertConnection({ ...connection, latencyMs: elapsed });
    } catch {
      /* the socket handler will mark it disconnected */
    }
  },
}));

export function activeConnection(state: ConnectionState): ConnectionSummary | null {
  return state.connections.find((c) => c.id === state.activeId) ?? null;
}

export function nextHostColor(existing: { color: string }[]): HostColor {
  const used = new Set(existing.map((p) => p.color));
  return HOST_COLORS.find((c) => !used.has(c)) ?? (HOST_COLORS[existing.length % HOST_COLORS.length] as HostColor);
}

function safeRead(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeWrite(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

function safeRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* private mode */
  }
}
