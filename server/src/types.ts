/**
 * Shared server-side types. These mirror the frozen contract in `docs/API.md` §2
 * exactly — do not add, rename or reorder fields that are serialised to clients.
 */

export type AuthMethod = 'password' | 'privateKey' | 'agent';

export type ConnectionStatus = 'connecting' | 'authenticated' | 'disconnected' | 'error';

export type EntryKind = 'file' | 'directory' | 'symlink' | 'other';

export type TransferDirection = 'upload' | 'download' | 'relay';

export type TransferState = 'queued' | 'active' | 'done' | 'error' | 'cancelled';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

export interface ServerInfo {
  platform: string;
  release: string;
  arch: string;
  home: string;
  cwd: string;
  shell: string;
  username: string;
  hostname: string;
}

export interface ConnectionSummary {
  id: string;
  label: string;
  color: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  status: ConnectionStatus;
  statusDetail?: string;
  hostKeyFingerprint: string;
  connectedAt: number | null;
  latencyMs: number | null;
  serverInfo?: ServerInfo;
}

export interface FileEntry {
  name: string;
  path: string;
  kind: EntryKind;
  target?: string;
  size: number;
  mtime: number;
  atime: number;
  mode: number;
  modeText: string;
  owner: string;
  group: string;
  uid: number;
  gid: number;
  hidden: boolean;
  linkCount?: number;
}

export interface DirectoryListing {
  path: string;
  parent: string | null;
  entries: FileEntry[];
  truncated: boolean;
}

export interface Transfer {
  id: string;
  connectionId: string;
  direction: TransferDirection;
  name: string;
  remotePath: string;
  localPath: string | null;
  size: number;
  transferred: number;
  state: TransferState;
  error?: string;
  startedAt: number;
  finishedAt: number | null;
  bytesPerSecond: number;
  batchId?: string;
  /** Downloads only: the file can be re-requested with a `Range` header (contract §7). */
  resumable: boolean;
  /** Bytes already on disk before this attempt (0 unless a `Range` was honoured). */
  resumedFrom: number;
}

/** `GET`/`PATCH /api/settings` — contract §7. */
export interface TransferSettings {
  /** 1…8: how many transfers may run at once; the rest stay `queued`. */
  maxConcurrent: number;
  /** Combined throughput ceiling in kibibytes per second (KiB/s), or `null` for unlimited. */
  speedLimitKbps: number | null;
}

export interface SettingsResponse {
  transfers: TransferSettings;
}

export interface SavedProfile {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  privateKeyPath?: string;
  color: string;
  lastUsedAt: number | null;
}

/** `GET /api/system/info` */
export interface KeyInfo {
  name: string;
  path: string;
  type: string;
}

/** How saved credentials are encrypted at rest (contract §14). */
export interface SecretStorageInfo {
  available: boolean;
  kind: 'os-keychain' | 'local-key';
  label: string;
  vaultPath: string;
}

export interface SystemInfo {
  version: string;
  platform: string;
  homeDir: string;
  sshDir: string;
  knownHostsPath: string;
  profilesPath: string;
  defaultDownloadDir: string;
  keys: KeyInfo[];
  secretStorage: SecretStorageInfo;
}

/** `GET /api/connections/:id/fs/read` */
export type ReadKind = 'text' | 'image' | 'binary' | 'tooLarge';

export interface ReadResult {
  kind: ReadKind;
  content?: string;
  dataUrl?: string;
  size: number;
  truncated: boolean;
  encoding: string;
  mimeType: string;
  lines?: number;
}

/** `POST /api/connections/:id/exec` */
export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** `GET /api/known-hosts` — contract §15. */
export interface KnownHostEntry {
  /** The host field exactly as written in the file, e.g. `[10.0.0.1]:2222`. */
  host: string;
  keyType: string;
  fingerprint: string;
  marker?: 'cert-authority' | 'revoked';
  /** 1-based line number in the file at `path`. */
  line: number;
}

/** One `df -Pk` row of `GET /api/connections/:id/system/stats` (contract §16). */
export interface DiskUsage {
  filesystem: string;
  sizeBytes: number;
  usedBytes: number;
  availableBytes: number;
  mount: string;
}

export interface MemoryUsage {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
}

export interface SwapUsage {
  totalBytes: number;
  usedBytes: number;
}

/** `GET /api/connections/:id/system/stats` — every unreadable section is `null` (contract §16). */
export interface SystemStats {
  collectedAt: number;
  uptimeSeconds: number | null;
  load: [number, number, number] | null;
  cpuCount: number | null;
  memory: MemoryUsage | null;
  swap: SwapUsage | null;
  disks: DiskUsage[];
  hostname: string | null;
  kernel: string | null;
  /**
   * Why a figure is missing, in the server's own words.
   *
   * An empty panel used to be indistinguishable from a host without the tools — and the
   * one time it mattered, the cause (a marker-delimited command that a real shell read as
   * a comment) had to be reconstructed from a screenshot. Empty means everything parsed.
   */
  notes: SystemNote[];
}

export interface SystemNote {
  /** `command` when the remote shell refused, `markers` when nothing came back, else the section. */
  scope: 'command' | 'markers' | 'uptime' | 'load' | 'cpu' | 'memory' | 'swap' | 'disks' | 'kernel';
  /** Human-readable, already safe to show. */
  detail: string;
}
