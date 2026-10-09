import type {
  AppSettings,
  ArchiveFormat,
  ConnectRequest,
  ConnectResponse,
  ConnectionSummary,
  CopyResult,
  DirectoryListing,
  FileEntry,
  DiagnosticReport,
  FileReadResult,
  HealthInfo,
  KnownHostEntry,
  NetProbeResult,
  RelayStart,
  RemoteSystemStats,
  SavedProfile,
  SecretStorageInfo,
  SystemInfo,
  Transfer,
  VaultSecretEntry,
} from './types';
import type { ApiErrorBody } from './types';
import { authHeaders, withToken } from './auth';

/** Thrown for every non-2xx API response; carries the §1 envelope. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown>;
  readonly requestId: string | null;

  constructor(
    status: number,
    code: string,
    message: string,
    details: Record<string, unknown> = {},
    requestId: string | null = null,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

const BASE = '/api';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...authHeaders(),
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch (cause) {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the SSH Explorer service.', {
      cause: String(cause),
    });
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  const requestId = res.headers.get('x-request-id');

  if (!res.ok) {
    let code = 'INTERNAL';
    let message = `Request failed with status ${res.status}.`;
    let details: Record<string, unknown> = {};
    if (text) {
      try {
        const body = JSON.parse(text) as ApiErrorBody;
        if (body?.error) {
          code = body.error.code ?? code;
          message = body.error.message ?? message;
          details = body.error.details ?? {};
        }
      } catch {
        message = text.slice(0, 400);
      }
    }
    throw new ApiError(res.status, code, message, details, requestId);
  }

  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ApiError(res.status, 'INTERNAL', 'The service returned malformed JSON.', {
      sample: text.slice(0, 200),
    });
  }
}

function qs(params: Record<string, string | number | boolean | undefined | string[]>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      for (const item of value) search.append(key, item);
    } else {
      search.set(key, String(value));
    }
  }
  const out = search.toString();
  return out ? `?${out}` : '';
}

export const api = {
  health: () => request<HealthInfo>('/health'),
  systemInfo: () => request<SystemInfo>('/system/info'),

  /* ---- profiles -------------------------------------------------------- */
  listProfiles: () => request<{ profiles: SavedProfile[] }>('/profiles'),
  createProfile: (body: Partial<SavedProfile>) =>
    request<{ profile: SavedProfile }>('/profiles', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateProfile: (id: string, body: Partial<SavedProfile>) =>
    request<{ profile: SavedProfile }>(`/profiles/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteProfile: (id: string) =>
    request<void>(`/profiles/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /* ---- stored credentials (contract §14) ------------------------------- */
  listSecrets: () =>
    request<{ storage: SecretStorageInfo; secrets: VaultSecretEntry[] }>('/secrets'),
  forgetSecret: (id: string) =>
    request<void>(`/secrets/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  forgetAllSecrets: () => request<void>('/secrets', { method: 'DELETE' }),

  /* ---- connections ----------------------------------------------------- */
  listConnections: () => request<{ connections: ConnectionSummary[] }>('/connections'),
  getConnection: (id: string) =>
    request<{ connection: ConnectionSummary }>(`/connections/${encodeURIComponent(id)}`),
  connect: (body: ConnectRequest) =>
    request<ConnectResponse>('/connections', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  disconnect: (id: string) =>
    request<void>(`/connections/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  reconnect: (id: string) =>
    request<{ connection: ConnectionSummary }>(`/connections/${encodeURIComponent(id)}/reconnect`, {
      method: 'POST',
    }),
  exec: (id: string, command: string, timeoutMs?: number) =>
    request<{ stdout: string; stderr: string; code: number }>(
      `/connections/${encodeURIComponent(id)}/exec`,
      { method: 'POST', body: JSON.stringify({ command, timeoutMs }) },
    ),

  /* ---- filesystem ------------------------------------------------------ */
  list: (id: string, path: string, limit?: number) =>
    request<{ listing: DirectoryListing }>(
      `/connections/${encodeURIComponent(id)}/fs/list${qs({ path, limit })}`,
    ),
  stat: (id: string, path: string) =>
    request<{ entry: FileEntry }>(`/connections/${encodeURIComponent(id)}/fs/stat${qs({ path })}`),
  read: (id: string, path: string, maxBytes?: number) =>
    request<FileReadResult>(
      `/connections/${encodeURIComponent(id)}/fs/read${qs({ path, maxBytes })}`,
    ),
  mkdir: (id: string, path: string) =>
    request<{ entry: FileEntry }>(`/connections/${encodeURIComponent(id)}/fs/mkdir`, {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),
  rename: (id: string, from: string, to: string) =>
    request<{ entry: FileEntry }>(`/connections/${encodeURIComponent(id)}/fs/rename`, {
      method: 'POST',
      body: JSON.stringify({ from, to }),
    }),
  remove: (id: string, paths: string[], recursive = false) =>
    request<{ deleted: string[]; failed: { path: string; message: string }[] }>(
      `/connections/${encodeURIComponent(id)}/fs/delete`,
      { method: 'POST', body: JSON.stringify({ paths, recursive }) },
    ),
  chmod: (id: string, path: string, mode: string) =>
    request<{ entry: FileEntry }>(`/connections/${encodeURIComponent(id)}/fs/chmod`, {
      method: 'POST',
      body: JSON.stringify({ path, mode }),
    }),
  touch: (id: string, path: string, mtimeMs?: number) =>
    request<{ entry: FileEntry }>(`/connections/${encodeURIComponent(id)}/fs/touch`, {
      method: 'POST',
      body: JSON.stringify({ path, mtimeMs }),
    }),
  search: (id: string, path: string, query: string, limit?: number) =>
    request<{ results: FileEntry[]; truncated: boolean; scanned: number }>(
      `/connections/${encodeURIComponent(id)}/fs/search${qs({ path, query, limit })}`,
    ),
  usage: (id: string, paths: string[]) =>
    request<{ usage: { path: string; bytes: number; truncated: boolean }[] }>(
      `/connections/${encodeURIComponent(id)}/fs/usage${qs({ paths })}`,
    ),

  copy: (id: string, sources: string[], destination: string, overwrite = false) =>
    request<CopyResult>(`/connections/${encodeURIComponent(id)}/fs/copy`, {
      method: 'POST',
      body: JSON.stringify({ sources, destination, overwrite }),
    }),

  move: (id: string, sources: string[], destination: string, overwrite = false) =>
    request<CopyResult>(`/connections/${encodeURIComponent(id)}/fs/move`, {
      method: 'POST',
      body: JSON.stringify({ sources, destination, overwrite }),
    }),

  archive: (id: string, paths: string[], destination: string, format: ArchiveFormat) =>
    request<{ entry: FileEntry; bytes: number }>(
      `/connections/${encodeURIComponent(id)}/fs/archive`,
      { method: 'POST', body: JSON.stringify({ paths, destination, format }) },
    ),

  extract: (id: string, path: string, destinationDir: string, overwrite = false) =>
    request<{ entries: FileEntry[]; truncated: boolean }>(
      `/connections/${encodeURIComponent(id)}/fs/extract`,
      { method: 'POST', body: JSON.stringify({ path, destinationDir, overwrite }) },
    ),

  relay: (
    sourceConnectionId: string,
    paths: string[],
    targetConnectionId: string,
    targetDir: string,
    overwrite = false,
  ) =>
    request<RelayStart>('/transfers/relay', {
      method: 'POST',
      body: JSON.stringify({ sourceConnectionId, paths, targetConnectionId, targetDir, overwrite }),
    }),

  systemStats: (id: string) =>
    request<RemoteSystemStats>(`/connections/${encodeURIComponent(id)}/system/stats`),

  /** Ping or traceroute from this machine to a host — no session required. */
  netProbe: (body: { host: string; tool: 'ping' | 'traceroute'; count?: number }) =>
    request<NetProbeResult>('/net/probe', { method: 'POST', body: JSON.stringify(body) }),

  /** What this host can actually do; the answer to "why is the panel empty". */
  diagnostics: (id: string) =>
    request<DiagnosticReport>(`/connections/${encodeURIComponent(id)}/diagnostics`),

  knownHosts: () => request<{ path: string; entries: KnownHostEntry[] }>('/known-hosts'),

  forgetKnownHost: (host: string, port: number) =>
    request<void>('/known-hosts', { method: 'DELETE', body: JSON.stringify({ host, port }) }),

  settings: () => request<AppSettings>('/settings'),

  updateSettings: (patch: Partial<AppSettings>) =>
    request<AppSettings>('/settings', { method: 'PATCH', body: JSON.stringify(patch) }),

  downloadUrl: (id: string, path: string) =>
    `${BASE}/connections/${encodeURIComponent(id)}/fs/download${qs({ path })}`,

  upload: async (
    id: string,
    dirPath: string,
    file: File,
    onProgress?: (sent: number, total: number) => void,
    signal?: AbortSignal,
  ): Promise<{ transfer: Transfer }> => {
    // XHR keeps upload progress observable in every browser we support.
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `${BASE}/connections/${encodeURIComponent(id)}/fs/upload${qs({ path: dirPath, name: file.name })}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => onProgress?.(e.loaded, e.total || file.size);
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText) as { transfer: Transfer });
          } catch {
            reject(new ApiError(xhr.status, 'INTERNAL', 'Malformed upload response.'));
          }
          return;
        }
        let code = 'INTERNAL';
        let message = `Upload failed with status ${xhr.status}.`;
        try {
          const body = JSON.parse(xhr.responseText) as ApiErrorBody;
          if (body?.error) {
            code = body.error.code;
            message = body.error.message;
          }
        } catch {
          /* keep defaults */
        }
        reject(new ApiError(xhr.status, code, message));
      };
      xhr.onerror = () => reject(new ApiError(0, 'NETWORK', 'Upload failed: network error.'));
      xhr.onabort = () => reject(new ApiError(0, 'ABORTED', 'Upload cancelled.'));
      signal?.addEventListener('abort', () => xhr.abort(), { once: true });
      xhr.send(file);
    });
  },

  /* ---- transfers ------------------------------------------------------- */
  listTransfers: () => request<{ transfers: Transfer[] }>('/transfers'),
  cancelTransfer: (id: string) =>
    request<{ transfer: Transfer }>(`/transfers/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  clearTransfers: () => request<void>('/transfers', { method: 'DELETE' }),
  retryTransfer: (id: string) =>
    request<{ transfer: Transfer }>(`/transfers/${encodeURIComponent(id)}/retry`, {
      method: 'POST',
    }),
};

export function eventSocketUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return withToken(`${proto}//${location.host}${BASE}/ws`);
}

export function terminalSocketUrl(connectionId: string, cols: number, rows: number): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return withToken(`${proto}//${location.host}${BASE}/ws/terminal${qs({ connectionId, cols, rows })}`);
}
