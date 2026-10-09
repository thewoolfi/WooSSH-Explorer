# WooSSH Explorer — HTTP / WebSocket API contract (v1)

> **Status: FROZEN.** The server implementation (`server/src/**`) and the independent
> integration test harness (`server/test/**`) are both written against this document.
> Any change here must be reflected in both, and in `web/src/api/types.ts`.

All routes are served from the API origin (default `http://127.0.0.1:5178`).
The web dev server proxies `/api` (HTTP + WebSocket) to that origin.

Conventions:

- Request and response bodies are JSON unless stated otherwise.
- Errors always use the envelope below and a matching HTTP status code.
- Paths are **remote** POSIX paths unless the field says otherwise. The client never
  sends a path it has not received from the server, except for user-typed paths, which
  the server normalises via SFTP `realpath`.
- Binary payloads are streamed, never buffered in memory beyond a chunk.

---

## 1. Error envelope

```jsonc
{
  "error": {
    "code": "HOST_KEY_UNKNOWN",       // stable machine-readable code
    "message": "The host key for prod-web-01 is not known yet.",
    "details": { }                     // optional, code-specific
  }
}
```

| code | HTTP | meaning |
| --- | --- | --- |
| `BAD_REQUEST` | 400 | malformed body / query |
| `NOT_FOUND` | 404 | unknown connection, profile or transfer id |
| `CONFLICT` | 409 | state conflict (e.g. duplicate profile name) |
| `AUTH_FAILED` | 401 | the SSH server rejected the credentials |
| `HOST_KEY_UNKNOWN` | 409 | first contact — the client must ask the user to trust the key |
| `HOST_KEY_MISMATCH` | 409 | the presented key differs from the stored one — always fatal |
| `CONNECT_FAILED` | 502 | TCP/DNS/handshake failure (`details.reason`) |
| `SFTP_UNAVAILABLE` | 502 | the server refused the sftp subsystem |
| `SFTP_ERROR` | 400 | an SFTP operation failed (`details.code` = SFTP status code) |
| `REMOTE_ERROR` | 502 | remote command failed |
| `NOT_SUPPORTED` | 501 | feature unavailable for this connection |
| `INTERNAL` | 500 | unexpected server error |

Every response carries `x-request-id`; errors are logged server-side with the same id.
Secrets (passwords, passphrases, key material) are never echoed back and never logged.

---

## 2. Shared types

```ts
type AuthMethod = 'password' | 'privateKey' | 'agent';

interface ConnectionSummary {
  id: string;                 // server-generated, stable for the session lifetime
  label: string;              // user-facing name, defaults to `${username}@${host}`
  color: string;              // one of the palette tags, e.g. "mint" | "amber" | "violet" | "sky" | "rose" | "slate"
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  status: 'connecting' | 'authenticated' | 'disconnected' | 'error';
  statusDetail?: string;      // human readable reason when status is 'disconnected' | 'error'
  hostKeyFingerprint: string; // "SHA256:...." of the negotiated host key
  connectedAt: number | null; // epoch ms
  latencyMs: number | null;   // last measured round trip, null when unknown
  serverInfo?: {
    platform: string;         // uname -s
    release: string;
    arch: string;
    home: string;             // absolute remote home directory
    cwd: string;              // absolute remote working directory
    shell: string;
    username: string;
    hostname: string;
  };
}

type EntryKind = 'file' | 'directory' | 'symlink' | 'other';

interface FileEntry {
  name: string;
  path: string;               // absolute remote path
  kind: EntryKind;
  target?: string;            // symlink target when kind === 'symlink'
  size: number;
  mtime: number;              // epoch ms
  atime: number;              // epoch ms
  mode: number;               // raw POSIX mode bits
  modeText: string;           // "-rw-r--r--"
  owner: string;              // resolved name, falls back to the numeric uid
  group: string;
  uid: number;
  gid: number;
  hidden: boolean;            // the entry's own basename starts with "." — a file
                              // inside a dot-directory is NOT hidden by itself
  linkCount?: number;
}

interface DirectoryListing {
  path: string;               // normalised absolute path
  parent: string | null;      // null at "/"
  entries: FileEntry[];       // unfiltered by the server; the client filters
  truncated: boolean;         // true when the directory exceeded the entry cap
}

type TransferDirection = 'upload' | 'download';
type TransferState = 'queued' | 'active' | 'done' | 'error' | 'cancelled';

interface Transfer {
  id: string;
  connectionId: string;
  direction: TransferDirection;
  name: string;               // basename
  remotePath: string;
  localPath: string | null;   // absolute local path for downloads; null for uploads
  size: number;               // total bytes, -1 when unknown
  transferred: number;
  state: TransferState;
  error?: string;
  startedAt: number;
  finishedAt: number | null;
  bytesPerSecond: number;     // smoothed, 0 when idle
  batchId?: string;           // groups a multi-file operation
}

interface SavedProfile {
  id: string;
  label: string;
  host: string;
  port: number;
  username: string;
  authMethod: AuthMethod;
  privateKeyPath?: string;    // only for authMethod === 'privateKey'
  color: string;
  lastUsedAt: number | null;
  // NEVER contains a password or passphrase.
}
```

---

## 3. System

### `GET /api/health`
`200 { "ok": true, "version": string, "uptimeSeconds": number, "pid": number }`

### `GET /api/system/info`
Information the UI needs before any connection exists.

```jsonc
{
  "version": "1.0.0",
  "platform": "win32",
  "homeDir": "C:\\Users\\Admin",
  "sshDir": "C:\\Users\\Admin\\.ssh",
  "knownHostsPath": "C:\\Users\\Admin\\.ssh-explorer\\known_hosts",
  "profilesPath": "C:\\Users\\Admin\\.ssh-explorer\\profiles.json",
  "defaultDownloadDir": "C:\\Users\\Admin\\Downloads\\WooSSH Explorer",
  "keys": [ { "name": "id_ed25519", "path": "C:\\Users\\Admin\\.ssh\\id_ed25519", "type": "ed25519" } ],
  "secretStorage": {
    "available": true,
    "kind": "os-keychain",          // "os-keychain" | "local-key"
    "label": "Sealed by the operating system keychain (DPAPI on Windows) — bound to your user account",
    "vaultPath": "C:\\Users\\Admin\\AppData\\Roaming\\WooSSH Explorer\\secrets.json"
  }
}
```

`keys` enumerates private keys found in `~/.ssh` (files without a `.pub` suffix that
parse as a private key, plus `id_*` names). Unreadable files are skipped, never fatal.
`secretStorage` describes how saved credentials are protected — see §14.

---

## 4. Saved profiles

Profiles persist host/port/username/auth method/label/colour and a private-key path.
**They never contain a password or passphrase** — that is what §14 is for.

| method | path | body | response |
| --- | --- | --- | --- |
| `GET` | `/api/profiles` | — | `{ "profiles": SavedProfile[] }` |
| `POST` | `/api/profiles` | `{ label, host, port, username, authMethod, privateKeyPath?, color? }` | `201 { "profile": SavedProfile }` |
| `PATCH` | `/api/profiles/:id` | any subset of the create fields | `200 { "profile": SavedProfile }` |
| `DELETE` | `/api/profiles/:id` | — | `204` |

Unknown `id` → `NOT_FOUND`. Profiles are stored at `system/info.profilesPath` with the
file mode `0600` where the OS supports it; a missing or corrupt file is treated as empty.

---

## 5. Connections

### `POST /api/connections`
Opens a connection and blocks until it is authenticated (or fails).

```jsonc
{
  "profileId": "optional-id",          // when present, server fields default from the profile
  "label": "prod-web-01",
  "color": "mint",
  "host": "10.0.4.11",
  "port": 22,
  "username": "deploy",
  "auth": { "method": "password", "password": "..." },
  // or { "method": "privateKey", "privateKeyPath": "C:\\...\\id_ed25519", "passphrase": "..." }
  // or { "method": "privateKey", "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----..." }
  // or { "method": "agent", "socket": "optional path to the agent socket" }
  // `auth` may be omitted entirely: the vault (§14) then supplies the credential.
  "saveSecret": true,                  // persist the credential after a successful handshake
  "useStoredSecret": true,             // consult the vault; defaults to true when `auth` is absent
  "trustHostKey": false,               // see below
  "hostKeyFingerprint": "SHA256:..."   // echoed back by the client when trusting
}
```

Credential resolution order: an explicit `auth` block, then the vault (unless
`useStoredSecret: false`), then the key path or agent recorded on the profile. When none
of them yields a credential the request fails with `400 BAD_REQUEST`.

Responses:

- `201 { "connection": ConnectionSummary, "savedSecret": boolean, "usedStoredSecret": boolean }`
  — authenticated. `savedSecret` is `true` only when this request wrote to the vault, and
  a credential is written **only after the handshake succeeded**, so a typo can never be
  persisted. `usedStoredSecret` says the vault supplied the credential.
- `409 HOST_KEY_UNKNOWN` with
  `details: { host, port, fingerprint, keyType, knownHostsPath, algorithm }`
  The client shows a trust dialog and retries with `trustHostKey: true` **and** the
  `hostKeyFingerprint` it displayed. If the fingerprint presented at retry time differs
  from the echoed one the server answers `409 HOST_KEY_MISMATCH`.
- `409 HOST_KEY_MISMATCH` with `details: { host, port, fingerprint, expected, knownHostsPath }`
  Never trustable from the UI; the user must edit the known_hosts file.
- `401 AUTH_FAILED` — `details: { attempts, remaining }` when the server reports them.
- `502 CONNECT_FAILED` — `details: { reason: "ECONNREFUSED" | "ETIMEDOUT" | "ENOTFOUND" | ... }`.

Only one active connection per `(host, port, username)` triple is created; asking twice
returns the existing `ConnectionSummary` with `200` instead of `201`.

### Other connection routes

| method | path | result |
| --- | --- | --- |
| `GET` | `/api/connections` | `{ "connections": ConnectionSummary[] }` |
| `GET` | `/api/connections/:id` | `{ "connection": ConnectionSummary }` |
| `DELETE` | `/api/connections/:id` | `204`, tears down SFTP, shell channels and transfers |
| `POST` | `/api/connections/:id/reconnect` | `200 { "connection": ConnectionSummary }`, reuses the stored credentials |
| `POST` | `/api/connections/:id/exec` | body `{ command, timeoutMs? }` → `{ stdout, stderr, code }` |

`:id` may be the literal `:id` value or a saved profile id — unknown → `NOT_FOUND`.

---

## 6. Filesystem

All routes are scoped to one connection and require it to be authenticated.

### `GET /api/connections/:id/fs/list`
Query: `path` (absolute, defaults to `serverInfo.home`), `showHidden` (`true|false`,
as a filter hint only — see below), `limit` (default `5000`, max `20000`).

`200 { "listing": DirectoryListing }`

The server always returns every entry (hidden files included) up to `limit` and sets
`truncated: true` when it stopped early. The client owns the show/hide-hidden decision.

### `GET /api/connections/:id/fs/stat?path=`
`200 { "entry": FileEntry }`

### `GET /api/connections/:id/fs/read`
Query: `path`, `maxBytes` (default `262144`, max `2097152`).

```jsonc
{
  "kind": "text",             // "text" | "image" | "binary" | "tooLarge"
  "content": "…",             // present when kind === "text"
  "dataUrl": "data:image/png;base64,…", // present when kind === "image" and size <= maxBytes
  "size": 10240,
  "truncated": false,
  "encoding": "utf8",
  "mimeType": "text/plain",
  "lines": 240
}
```

Detection order, and why:

1. A known **image extension** → `image` (or `tooLarge` past `maxBytes`). Images are
   checked *first* because real PNG/JPEG data contains NUL bytes; sniffing before the
   extension would classify every photograph as opaque binary.
2. Otherwise, a **NUL byte in the first 8 KiB** → `binary`.
3. Otherwise → `text`, truncated to `maxBytes` with `truncated: true`.

`fs/read` never throws for binary content, and a file whose extension lies (a `.png`
that is not an image) still answers `image` — the client is responsible for degrading
gracefully when the payload does not decode.

### `GET /api/connections/:id/fs/download?path=`
Streams the file with `Content-Disposition: attachment; filename*=UTF-8''<encoded>`,
`Content-Type: application/octet-stream`, `Content-Length` when known.
Registers a `download` transfer that emits progress events.

### `POST /api/connections/:id/fs/download-batch`
Body `{ "paths": string[], "name"?: string }` → streams a ZIP archive
(`Content-Type: application/zip`). Directory entries are zipped recursively.
Registers one `download` transfer per file sharing a `batchId`.

### `POST /api/connections/:id/fs/upload?path=<remote dir>&name=<file name>`
Body: raw `application/octet-stream` (the client streams the file). Optional header
`content-length`. `200 { "transfer": Transfer }` once the stream is fully written.
Registers an `upload` transfer that emits progress events.
When `path` already contains an entry with that name the server overwrites it.

### `POST /api/connections/:id/fs/mkdir` — `{ "path": string }` → `201 { "entry": FileEntry }`
### `POST /api/connections/:id/fs/rename` — `{ "from": string, "to": string }` → `200 { "entry": FileEntry }`
### `POST /api/connections/:id/fs/delete` — `{ "paths": string[], "recursive"?: boolean }`
`200 { "deleted": string[], "failed": [{ "path": string, "message": string }] }`
Directories require `recursive: true`; without it a non-empty directory is reported in
`failed` and nothing is deleted for that path.

### `POST /api/connections/:id/fs/chmod` — `{ "path": string, "mode": string }` (`"644"`, `"0755"`)
`200 { "entry": FileEntry }`

### `POST /api/connections/:id/fs/touch` — `{ "path": string, "mtimeMs"?: number }` → `200 { "entry": FileEntry }`

### `GET /api/connections/:id/fs/search`
Query: `path` (root), `query` (substring, case-insensitive), `limit` (default 200, max 2000).
Implemented with SFTP walking, falling back to `find` when available.
`200 { "results": FileEntry[], "truncated": boolean, "scanned": number }`

### `GET /api/connections/:id/fs/usage?paths=a&paths=b`
Runs `du -sk` when available; falls back to a recursive SFTP size walk.
`200 { "usage": [{ "path": string, "bytes": number, "truncated": boolean }] }`
`truncated` marks a walk that hit the node cap, so the number is a lower bound.

### `POST /api/connections/:id/fs/copy`
```jsonc
{ "sources": ["/a/b.txt"], "destination": "/c", "overwrite": false }
```
→ `200 { "copied": FileEntry[], "failed": [{ "path": string, "message": string }] }`

`destination` is a directory (each source keeps its basename) or, for a single source, the
full target path. Directories are copied recursively, symlinks are recreated rather than
followed, and file modes are preserved. Both endpoints accept `sources` and `destination`:

### `POST /api/connections/:id/fs/move`
Same body and response as `copy`, but the source is removed afterwards. Inside one
filesystem this is a `rename`; across filesystems the server falls back to copy + delete.
Moving a directory into itself is `400 BAD_REQUEST`.

Both are implemented **on the server**: `cp -a` / `mv` over `exec` when the shell supports
them, otherwise an SFTP copy. Nothing travels through the client.

### `POST /api/connections/:id/fs/archive`
```jsonc
{ "paths": ["/var/www/app"], "destination": "/backups/app.tar.gz", "format": "tar.gz" }
```
`format`: `tar.gz` | `tar` | `zip`. → `201 { "entry": FileEntry, "bytes": number }`
Directories are archived recursively with their basename as the root entry.

### `POST /api/connections/:id/fs/extract`
```jsonc
{ "path": "/backups/app.tar.gz", "destinationDir": "/tmp/restore", "overwrite": false }
```
→ `201 { "entries": FileEntry[], "truncated": boolean }`

Format is detected from the archive itself, not the name. Refuses to write outside
`destinationDir` (a `..` entry or an absolute symlink in the archive is `400 BAD_REQUEST`)
and refuses zip-slip style entries by name.

---

## 7. Transfers

| method | path | result |
| --- | --- | --- |
| `GET` | `/api/transfers` | `{ "transfers": Transfer[] }` (all connections) |
| `GET` | `/api/connections/:id/transfers` | `{ "transfers": Transfer[] }` |
| `DELETE` | `/api/transfers/:id` | cancel → `200 { "transfer": Transfer }` (`cancelled`) |
| `DELETE` | `/api/transfers` | `204`, clears finished transfers from the list |
| `POST` | `/api/transfers/:id/retry` | `200 { "transfer": Transfer }`, restarts a failed/cancelled transfer |
| `POST` | `/api/transfers/relay` | `202 { "transfers": Transfer[], "batchId": string }` — server-to-server |

### `POST /api/transfers/relay`
Copy files **or whole directory trees** from one connection straight to another, without the
bytes passing through the browser:

```jsonc
{
  "sourceConnectionId": "conn_a",
  "paths": ["/var/log/app.log", "/srv/project"],
  "targetConnectionId": "conn_b",
  "targetDir": "/incoming",
  "overwrite": false
}
```

The server walks each source path on the source SFTP session and mirrors it onto the target's:
directories are created as they are visited, symlinks are recreated rather than followed (so a
link to a parent cannot make the copy recurse forever), and file modes are preserved.

**One `relay` transfer per requested path**, not per file — a project with thousands of files
reports as a single row whose `size` is the sum of the files under it. The batch shares a
`batchId`; progress is counted from the read side.

Response `202`:

```jsonc
{
  "transfers": [ /* one per path that was started */ ],
  "batchId": "batch_…",          // null when nothing could be started
  "conflicts": [ { "sourcePath": "/srv/project", "targetPath": "/incoming/project" } ]
}
```

A name that is already taken on the target is **not started** and is reported in `conflicts`
instead — `overwrite: false` never replaces anything, and the client asks the user exactly as
it does for `fs/copy`. Re-issuing the request with `overwrite: true` and only those
`sourcePath` values replaces them.

A single path that fails mid-batch is marked `error` and the remaining paths still run.
Trees deeper than 128 levels or larger than 200 000 entries are refused rather than walked.

### Resumable downloads
`GET /fs/download` accepts a `Range: bytes=<offset>-` header. When the offset is inside the
file the server answers `206 Partial Content` with the remaining bytes and the transfer
continues from `offset` instead of restarting. `Transfer` gains:

```ts
resumable: boolean;        // downloads only; false for uploads and relays
resumedFrom: number;       // bytes already on disk before this attempt
```

A client that can resume (the desktop shell, which knows the partial file) re-issues the
request with the header; a browser simply starts over.

### Transfer settings
| method | path | result |
| --- | --- | --- |
| `GET` | `/api/settings` | `{ "transfers": { "maxConcurrent": number, "speedLimitKbps": number \| null } }` |
| `PATCH` | `/api/settings` | same body shape, merged into the stored settings |

`maxConcurrent` (1…8, default 3) bounds how many transfers run at once; the rest stay
`queued`. `speedLimitKbps` throttles the *combined* throughput of all active transfers and
is enforced by pausing the read streams, so the remote side sees backpressure rather than a
dropped connection. Settings persist in the state directory and apply immediately.

---

## 8. WebSocket — event bus

`GET /api/ws` (upgrade). One socket per browser tab; the server sends JSON frames.

```jsonc
{ "type": "hello", "serverTime": 1730000000000, "version": "1.0.0" }
{ "type": "connection:status", "connection": ConnectionSummary }
{ "type": "connection:closed", "connectionId": "…", "reason": "…" }
{ "type": "transfer:update", "transfer": Transfer }
{ "type": "fs:changed", "connectionId": "…", "path": "…" }   // emitted after mutating routes
{ "type": "toast", "level": "info" | "warn" | "error", "message": "…" }
```

Clients may send `{ "type": "ping" }` and receive `{ "type": "pong", "t": <epoch ms> }`.
Unparseable frames are ignored. The socket never carries credentials.

## 9. WebSocket — terminal

`GET /api/ws/terminal?connectionId=<id>&cols=<n>&rows=<n>` (upgrade).

Client → server frames:

```jsonc
{ "t": "input",  "data": "ls -la\n" }
{ "t": "resize", "cols": 120, "rows": 32 }
{ "t": "signal", "signal": "INT" }        // optional
```

Server → client frames:

```jsonc
{ "t": "ready",  "sessionId": "…", "term": "xterm-256color" }
{ "t": "output", "data": "total 48\n" }
{ "t": "exit",   "code": 0, "signal": null, "reason": "exited" | "closed" | "error" }
{ "t": "error",  "code": "SFTP_UNAVAILABLE", "message": "…" }
```

The server requests a PTY (`pty: { term: 'xterm-256color', cols, rows }`) and bridges
stdin/stdout. Closing the socket closes the channel. Output is UTF-8 text; the server
replaces invalid sequences rather than failing.

---

## 10. Configuration

Environment variables read once at startup:

| name | default | meaning |
| --- | --- | --- |
| `SSH_EXPLORER_PORT` | `5178` | HTTP/WS port |
| `SSH_EXPLORER_HOST` | `127.0.0.1` | bind address (never default to `0.0.0.0`) |
| `SSH_EXPLORER_HOME` | `~/.ssh-explorer` | state directory (contains `known_hosts`, `profiles.json`, `secrets.json`, `secret.key`) |
| `SSH_EXPLORER_DOWNLOAD_DIR` | `~/Downloads/WooSSH Explorer` | default download destination |
| `SSH_EXPLORER_STATIC` | `web/dist` when it exists | directory of the built web app to serve |
| `SSH_EXPLORER_LOG_LEVEL` | `info` | `silent` \| `error` \| `warn` \| `info` \| `debug` |
| `SSH_EXPLORER_TOKEN` | **generated** | when set, used as the shared secret. When unset the server generates one and prints `http://host:port/?token=…` on startup, so the app can still be opened with one click |
| `SSH_EXPLORER_NO_TOKEN` | unset | `1` disables the requirement entirely. Only for a throwaway local instance — the API then answers any process on the machine, and a saved credential can be used by anyone who can reach the port |

`createServer({ token })` keeps the same three states: a string requires that token, `null`
disables it (what the integration tests use), and omitting it generates one.

---

## 11. Behavioural guarantees the tests rely on

1. `POST /api/connections` with wrong credentials ⇒ `401 AUTH_FAILED`, and the failed
   client is destroyed (no leaked sockets — asserted in tests).
2. A first connection to a host with no stored key ⇒ `409 HOST_KEY_UNKNOWN`; the same
   call with `trustHostKey: true` and the echoed fingerprint ⇒ `201`; a subsequent
   connection to the same host needs no trust flag.
3. A host presenting a different key than the stored one ⇒ `409 HOST_KEY_MISMATCH`,
   and the stored key is **not** overwritten.
4. `fs/list` returns dotfiles, resolving `~` and relative paths through `realpath`.
5. `fs/mkdir` → `fs/rename` → `fs/list` → `fs/delete` round-trips on the mock server.
6. `fs/upload` then `fs/download` of the same bytes round-trips byte-exactly, and both
   emit at least one `transfer:update` with `state: "active"` followed by `"done"`.
7. Cancelling an `active` transfer moves it to `cancelled` and stops the byte flow.
8. Terminal: connecting, writing `echo hello\n`, and receiving `hello` in `output`.
9. Every error response validates against the §1 envelope and carries `x-request-id`.
10. Deleting a connection cancels its in-flight transfers and closes its shells.

---

## 12. Programmatic entry point (used by the integration tests)

`server/src/server.ts` must export exactly this shape. The e2e suite imports it and
listens on an ephemeral port; it must never require the CLI entry point.

```ts
export interface CreateServerOptions {
  port?: number;              // 0 => ephemeral, default from config
  host?: string;              // default 127.0.0.1
  stateDir?: string;          // overrides SSH_EXPLORER_HOME (isolates known_hosts + profiles)
  downloadDir?: string;
  logLevel?: 'silent' | 'error' | 'warn' | 'info' | 'debug';
  staticDir?: string | null;  // null disables static serving
  token?: string | null;
  secretBox?: SecretBox;      // §14; the desktop app injects an OS-keychain box
}

export interface SecretBox {
  readonly kind: 'os-keychain' | 'local-key';
  readonly label: string;
  encrypt(plaintext: string): Promise<string>;
  decrypt(payload: string): Promise<string>;
}

export interface RunningServer {
  url: string;                // e.g. "http://127.0.0.1:53124"
  port: number;
  httpServer: import('node:http').Server;
  close(): Promise<void>;     // closes sockets, SSH clients and pending transfers
}

export function createServer(options?: CreateServerOptions): Promise<RunningServer>;
```

`listen()` must resolve only after the socket is bound, and `close()` must be safe to
call twice. `server/src/index.ts` is a thin CLI wrapper around `createServer()` that
also installs SIGINT/SIGTERM handlers.

## 13. Mock SSH server contract (test support, not shipped)

`server/test/support/mockSshServer.ts` exports:

```ts
export interface MockSshServerOptions {
  rootDir?: string;                       // defaults to a fresh temp directory
  username?: string;                      // default "tester"
  password?: string;                      // default "hunter2"
  authorizedKey?: string;                 // OpenSSH public key line accepted for auth
  hostKey?: string;                       // PEM/OpenSSH private key; generated when absent
  rejectAuth?: boolean;                   // force AUTH_FAILED
  rotateHostKey?: boolean;                // generate a *different* key to trigger MISMATCH
}

export interface MockSshServer {
  port: number;
  host: string;
  rootDir: string;
  username: string;
  password: string;
  privateKeyPath: string;                 // generated ed25519 key on disk for key auth
  publicKey: string;
  hostKeyFingerprint: string;             // "SHA256:<base64, no padding>"
  connectionCount: number;
  openShells: number;
  close(): Promise<void>;
}

export function startMockSshServer(options?: MockSshServerOptions): Promise<MockSshServer>;
```

The mock serves `rootDir` as the SFTP root **and** as the shell working directory, so
`fs/list` on `/` lists the real files inside `rootDir`. It must implement enough SFTP
(`OPEN`, `READ`, `WRITE`, `CLOSE`, `OPENDIR`, `READDIR`, `STAT`, `LSTAT`, `FSTAT`,
`SETSTAT`, `MKDIR`, `RMDIR`, `REMOVE`, `RENAME`, `REALPATH`, `READLINK`, `SYMLINK`)
for the whole §6 surface, plus `session` → `pty` + `shell` and `exec` for §5.

Its `exec` channel models a shell, not a command list: `;`, `&&`, `||`, quoting,
`$VAR` expansion and `cd` (whose working directory persists across the rest of the same
command line) all behave, so `cd /docs && ls -la` works exactly as it would over a real
SSH connection. Commands outside the whitelist answer `127 command not found`, like a
real shell would for a missing binary.

---

## 14. Stored credentials (the vault)

Saving a password, passphrase or inline key is opt-in per connection (`saveSecret: true`
on `POST /api/connections`). Everything the vault holds is encrypted before it touches
the disk, and **the API never returns a secret**: a client can only learn *which* host
triples have one.

Two encryption boxes ship, selected by the host application:

| box | where | protection |
| --- | --- | --- |
| `os-keychain` | the desktop app, via Electron `safeStorage` | DPAPI on Windows, Keychain on macOS, libsecret on Linux. The key stays in the OS keychain and the ciphertext is bound to the logged-in account. |
| `local-key` | a standalone server (fallback) | AES-256-GCM with a random 32-byte key file next to the vault, mode 0600. Protects against other users, accidental commits and backups — **not** against someone who already has access to your account, because the key sits beside the data. |

`GET /api/system/info` → `secretStorage` reports which one is active, and the UI shows
that sentence next to the checkbox rather than implying more protection than exists.

Entries are keyed by `(host, port, username)`, so changing the user name leaves the old
entry untouched and it can be forgotten separately.

| method | path | result |
| --- | --- | --- |
| `GET` | `/api/secrets` | `{ "storage": SecretStorageInfo, "secrets": VaultSecretEntry[] }` |
| `DELETE` | `/api/secrets/:id` | `204`, or `404 NOT_FOUND` when the id is unknown |
| `DELETE` | `/api/secrets` | `204`, forgets everything |

```ts
interface VaultSecretEntry {
  id: string;          // sha256(user NUL host NUL port), first 24 hex chars
  host: string;
  port: number;
  username: string;
  authMethod: 'password' | 'privateKey';
  updatedAt: number;
}
```

Guarantees the tests pin down:

1. Nothing is written while the host key is still unverified or the login failed.
2. A stored credential can drive a later `POST /api/connections` that sends no `auth` at
   all, and the response says `usedStoredSecret: true`.
3. The vault file on disk never contains the plaintext, and `GET /api/secrets` never
   contains it either.
4. A vault written by a different box (or a rotated key) degrades to "ask again": the
   metadata stays readable, decryption returns `null`, and the connection reports
   `400 BAD_REQUEST` when no other credential is available.
5. `useStoredSecret: false` disables the lookup for one request.

---

## 15. Known hosts management

The UI must be able to answer `HOST_KEY_MISMATCH` without sending the user to a text
editor.

| method | path | result |
| --- | --- | --- |
| `GET` | `/api/known-hosts` | `{ "path": string, "entries": KnownHostEntry[] }` |
| `DELETE` | `/api/known-hosts` | body `{ "host": string, "port": number }` → `204`, or `404` when absent |

```ts
interface KnownHostEntry {
  host: string;          // as written in the file, e.g. "[10.0.0.1]:2222"
  keyType: string;       // "ssh-ed25519"
  fingerprint: string;   // "SHA256:…"
  marker?: 'cert-authority' | 'revoked';
  line: number;          // 1-based line in the file
}
```

Removing an entry writes the file atomically and preserves every other line byte for byte,
including comments. It never writes to the user's `~/.ssh/known_hosts` (read-only source).

---

## 16. Remote system stats

`GET /api/connections/:id/system/stats` — one round trip for the status panel.

```jsonc
{
  "collectedAt": 1730000000000,
  "uptimeSeconds": 812345,
  "load": [0.42, 0.55, 0.61],          // null on systems without /proc/loadavg
  "cpuCount": 4,
  "memory": { "totalBytes": 0, "usedBytes": 0, "availableBytes": 0 },  // null when unknown
  "swap":   { "totalBytes": 0, "usedBytes": 0 },                        // null when unknown
  "disks": [
    { "filesystem": "/dev/sda1", "sizeBytes": 0, "usedBytes": 0, "availableBytes": 0, "mount": "/" }
  ],
  "hostname": "prod-web-01",
  "kernel": "Linux 6.1.0"
}
```

Collected with a single `exec` (`uptime; cat /proc/loadavg; free -b; df -Pk; uname -sr`),
parsed defensively: any section that cannot be read is `null`, never an error, and the
whole route degrades to `df -Pk` alone on systems without `/proc`. Every field is optional
from the client's point of view — it renders whatever arrived.
