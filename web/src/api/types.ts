/**
 * Wire types — the single source of truth on the client side.
 * Mirrors `docs/API.md` §2, §3, §4, §6, §7, §8, §9.
 */

export type AuthMethod = 'password' | 'privateKey' | 'agent';
export type HostColor = 'mint' | 'amber' | 'violet' | 'sky' | 'rose' | 'slate';

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

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

export type ConnectionStatus = 'connecting' | 'authenticated' | 'disconnected' | 'error';

export interface ConnectionSummary {
  id: string;
  label: string;
  color: HostColor | string;
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

export type EntryKind = 'file' | 'directory' | 'symlink' | 'other';

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

export type ReadKind = 'text' | 'image' | 'binary' | 'tooLarge';

export interface FileReadResult {
  kind: ReadKind;
  content?: string;
  dataUrl?: string;
  size: number;
  truncated: boolean;
  encoding: string;
  mimeType: string;
  lines: number;
}

export type TransferDirection = 'upload' | 'download' | 'relay';
export type TransferState = 'queued' | 'active' | 'done' | 'error' | 'cancelled';

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
  /** Downloads only: the server will continue from an offset (contract §7). */
  resumable: boolean;
  /** Bytes that were already on disk before this attempt. */
  resumedFrom: number;
  /** Relay only: the other side of the copy. */
  targetConnectionId?: string;
  targetPath?: string;
}

export type ArchiveFormat = 'tar.gz' | 'tar' | 'zip';

/** A relayed name that is already taken on the target, reported before anything starts. */
export interface RelayConflict {
  sourcePath: string;
  targetPath: string;
}

export interface RelayStart {
  transfers: Transfer[];
  batchId: string | null;
  conflicts: RelayConflict[];
}

export interface CopyResult {
  copied: FileEntry[];
  failed: { path: string; message: string }[];
}

export interface KnownHostEntry {
  host: string;
  keyType: string;
  fingerprint: string;
  marker?: 'cert-authority' | 'revoked';
  line: number;
}

export interface RemoteSystemStats {  collectedAt: number;
  uptimeSeconds: number | null;
  load: number[] | null;
  cpuCount: number | null;
  memory: { totalBytes: number; usedBytes: number; availableBytes: number } | null;
  swap: { totalBytes: number; usedBytes: number } | null;
  disks: {
    filesystem: string;
    sizeBytes: number;
    usedBytes: number;
    availableBytes: number;
    mount: string;
  }[];
  hostname: string | null;
  kernel: string | null;
  /**
   * Why a figure is missing, in the server's own words. Empty when everything parsed —
   * so an empty panel can say *why* instead of showing a row of dashes.
   */
  notes: { scope: string; detail: string }[];
}

export interface DiagnosticCheck {
  name: string;
  command: string;
  ok: boolean;
  output: string;
  error: string | null;
  durationMs: number;
}

export interface DiagnosticReport {
  collectedAt: number;
  latencyMs: number | null;
  checks: DiagnosticCheck[];
  findings: string[];
  /** A block the user can paste into a bug report. */
  text: string;
}

export interface NetProbeResult {
  tool: 'ping' | 'traceroute';
  host: string;
  lines: string[];
  summary: {
    transmitted: number | null;
    received: number | null;
    lossPercent: number | null;
    minMs: number | null;
    avgMs: number | null;
    maxMs: number | null;
    hops: number | null;
    unreachable: boolean;
  };
  durationMs: number;
  /** Set when the local machine has no such tool. */
  unavailable: string | null;
}

export interface AppSettings {
  transfers: {
    maxConcurrent: number;
    /** Kilobytes per second across all active transfers; `null` is unlimited. */
    speedLimitKbps: number | null;
  };
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

export interface LocalKey {
  name: string;
  path: string;
  type: string;
}

/** How saved credentials are protected at rest (contract §14). */
export interface SecretStorageInfo {
  available: boolean;
  kind: 'os-keychain' | 'local-key';
  label: string;
  vaultPath: string;
}

/** Metadata about a stored credential — never the secret itself. */
export interface VaultSecretEntry {
  id: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  updatedAt: number;
}

export interface SystemInfo {
  version: string;
  platform: string;
  homeDir: string;
  sshDir: string;
  knownHostsPath: string;
  profilesPath: string;
  defaultDownloadDir: string;
  keys: LocalKey[];
  secretStorage: SecretStorageInfo;
}

export interface HealthInfo {
  ok: boolean;
  version: string;
  uptimeSeconds: number;
  pid: number;
}

export type AuthPayload =
  | { method: 'password'; password: string }
  | { method: 'privateKey'; privateKeyPath?: string; privateKey?: string; passphrase?: string }
  | { method: 'agent'; socket?: string };

export interface ConnectRequest {
  profileId?: string;
  label?: string;
  color?: string;
  host: string;
  port: number;
  username: string;
  auth?: AuthPayload;
  /** Persist the supplied credential in the encrypted vault (§14). */
  saveSecret?: boolean;
  /** Reuse a stored credential; defaults to true when `auth` is omitted. */
  useStoredSecret?: boolean;
  trustHostKey?: boolean;
  hostKeyFingerprint?: string;
  saveProfile?: boolean;
}

export interface ConnectResponse {
  connection: ConnectionSummary;
  /** `true` when this request wrote a credential to the vault. */
  savedSecret?: boolean;
  /** `true` when the vault supplied the credential for this request. */
  usedStoredSecret?: boolean;
}

export interface HostKeyChallenge {
  host: string;
  port: number;
  fingerprint: string;
  keyType: string;
  algorithm: string;
  knownHostsPath: string;
  expected?: string;
}

/* ---- WebSocket event bus ------------------------------------------------ */

export type ServerEvent =
  | { type: 'hello'; serverTime: number; version: string }
  | { type: 'connection:status'; connection: ConnectionSummary }
  | { type: 'connection:closed'; connectionId: string; reason: string }
  | { type: 'transfer:update'; transfer: Transfer }
  | { type: 'fs:changed'; connectionId: string; path: string }
  | { type: 'toast'; level: 'info' | 'warn' | 'error'; message: string }
  | { type: 'pong'; t: number };

export type TerminalClientFrame =
  | { t: 'input'; data: string }
  | { t: 'resize'; cols: number; rows: number }
  | { t: 'signal'; signal: string };

export type TerminalServerFrame =
  | { t: 'ready'; sessionId: string; term: string }
  | { t: 'output'; data: string }
  | { t: 'exit'; code: number | null; signal: string | null; reason: string }
  | { t: 'error'; code: string; message: string };

export const HOST_COLORS: HostColor[] = ['mint', 'amber', 'violet', 'sky', 'rose', 'slate'];
