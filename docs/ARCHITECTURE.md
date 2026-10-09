# WooSSH Explorer — architecture

WooSSH Explorer puts a modern, desktop-class file browser in front of **SFTP**, an
integrated **PTY terminal** in front of the SSH shell channel, and keeps both honest
about host identity. It ships as an **Electron desktop application** and as a plain web
app from the same UI bundle.

```
┌───────────────────────────── browser ──────────────────────────────┐
│  React 19 + Vite                                                   │
│  ┌──────────┬───────────────────────────────┬───────────────────┐ │
│  │ Sidebar  │ Workbench: tabs → file pane   │ Inspector         │ │
│  │ hosts    │ toolbar · breadcrumbs · table │ metadata+preview  │ │
│  │transfers │ bottom dock: transfer queue   │                   │ │
│  └──────────┴───────────────────────────────┴───────────────────┘ │
│  state: zustand stores · transport: fetch + 2 WebSocket channels   │
└───────────────┬──────────────────────────────┬────────────────────┘
                │ /api (REST)                  │ /api/ws, /api/ws/terminal
┌───────────────▼──────────────────────────────▼────────────────────┐
│  Node 24 + Express 5 + ws                                         │
│  routes → SshConnectionManager → ssh2.Client                      │
│           ├── SFTP subsystem   (fsOps, transfers, search, usage)   │
│           ├── exec channel     (serverInfo, du, find)              │
│           └── shell + PTY      (terminal sessions)                 │
│  TransferManager · ProfileStore · known_hosts · event hub          │
└───────────────────────────────────────────────────────────────────┘
```

## Desktop shell

```
┌──────────────────── WooSSH Explorer.exe (Electron main) ────────────────────┐
│  menu bar (File/Edit/View/Connection/Tools/Help)                          │
│  BrowserWindow ── loads http://127.0.0.1:<ephemeral>/                     │
│  preload.cjs ── contextBridge: menu actions, download events, reveal      │
│  session.on('will-download') ── native "Save as" dialog                   │
│                                                                            │
│  main.cjs  ==  express + ws + ssh2 + yazl + zod, bundled by esbuild        │
│                 (the same server/dist/server.js the CLI runs)              │
└────────────────────────────────────────────────────────────────────────────┘
        resources/web/  ← the built web app (extraResources)
```

**The server runs in-process, not as a child process.** `createServer()` is called from
the Electron main process on port 0, so the shell gets a free loopback port, there is no
orphan process to reap, and `app.quit()` closes connections, transfers and sockets through
the same `close()` the tests exercise. The renderer is a normal web page pointed at that
URL — no `nodeIntegration`, `contextIsolation` on, `sandbox` on.

**One UI bundle for two worlds.** `web/src/lib/desktop.ts` probes
`window.sshExplorerDesktop`; when it is absent every desktop call becomes a no-op, so the
identical bundle runs in a browser tab. The bridge is deliberately tiny: menu actions in,
download events out, `reveal`, `openExternal`, `info`. No filesystem, no shell, no Node.

**Packaging.** `desktop/scripts/build.mjs` runs two esbuild passes — `main.cjs` (server +
shell, only `electron` and the optional native add-ons left external) and `preload.cjs` —
copies the icon, and `electron-builder` wraps them with `resources/web` into an NSIS
installer (`createDesktopShortcut` / `createStartMenuShortcut`) and a portable executable.

Two failure modes are handled explicitly because they cost real debugging time:

- `import.meta.url` in the ESM server is rewritten to its CJS equivalent via an esbuild
  `define` + banner, so the preload can stay CommonJS.
- `ssh2` and `ws` probe for optional native add-ons inside `try/catch`; esbuild cannot see
  the `try/catch`, so a resolver plugin marks every `.node` import external and the libraries
  fall back to pure JavaScript.
- `ELECTRON_RUN_AS_NODE` in the environment makes Electron start as plain Node, where
  `require('electron')` returns the npm package's path string. The launcher clears it, and
  the main bundle's banner refuses to run with a readable message.

## Credentials and editing

**Secrets are opt-in and encrypted.** Passwords, passphrases and inline keys live only on
the live `SshConnection` object unless the user ticks *Save these credentials*, which puts
them through `SecretVault` (`server/src/store/secretVault.ts`). The vault takes a pluggable
`SecretBox`: the desktop app injects Electron `safeStorage` (DPAPI on Windows, Keychain on
macOS, libsecret on Linux), and a standalone server falls back to AES-256-GCM with a
32-byte key file at mode 0600. The HTTP surface is deliberately metadata-only — there is
no route that returns a secret — and a credential is written only after a successful
handshake, so a typo never reaches disk. `ProfileStore` still stores no credential at all.

**Editing a remote file uses the OS, not an embedded editor.**
`EditSessionManager` (`desktop/src/editSession.ts`) downloads to a private temp directory,
hands the path to `shell.openPath`, watches the *directory* — editors save by writing a
temporary file and renaming it over the original, which silently breaks a watch on the
file itself — with a polling fallback for filesystems where the watch is unreliable, and
emits a `changed` event once the writes settle. The renderer turns that into the
Overwrite / Save as… / Cancel prompt, and only then does the main process stream the file
back through the same `/fs/upload` endpoint the browser uses.

## Why the API is shaped this way

**One connection object per host triple.** `SshConnectionManager` dedupes on
`(host, port, username)`. Opening the same host twice in two tabs reuses one TCP
connection and one SFTP session; that keeps an SFTP channel count of one per host
instead of one per browser tab.

**Files stream, they do not buffer.** A download is `sftp.createReadStream` piped into
the HTTP response; an upload is the request stream piped into `sftp.createWriteStream`.
The only place a whole file is read into memory is `GET /fs/read`, which exists purely
for previews and is hard-capped by `maxBytes`.

**The server owns correctness, the client owns presentation.** `fs/list` returns every
entry including dotfiles plus a `truncated` flag; the UI decides whether to show hidden
files, how to sort, and how to filter. That keeps the server stateless per request and
makes the UI's filter instant.

**Host identity is verified or the connection does not happen.** `known_hosts` lives in
`~/.ssh-explorer/known_hosts` (OpenSSH format, `[host]:port` for non-standard ports,
mode 0600). An unknown key produces a typed `HOST_KEY_UNKNOWN` error carrying the
fingerprint; the UI shows it and the client retries with the echoed fingerprint, so a
key that changes between the prompt and the retry is rejected. A *changed* key is
`HOST_KEY_MISMATCH` and is never trustable from the UI.

**Secrets are session-scoped.** Passwords and passphrases are held only on the live
`SshConnection` object so `reconnect` works. `ProfileStore` writes host, port, user,
auth method, key path, colour and label — never a credential. Nothing secret is logged.

## Frontend structure

| area | files | responsibility |
| --- | --- | --- |
| transport | `api/client.ts`, `api/types.ts` | typed REST client, `ApiError` envelope, upload via XHR for progress |
| realtime | `state/eventBus.ts` | one multiplexed `/api/ws` socket, reconnect with backoff, fans events into stores |
| state | `state/*Store.ts` | `connectionStore` (hosts, profiles, system info), `explorerStore` (tabs, listings, selection, history), `transferStore`, `uiStore` (theme, layout prefs, dialogs, toasts) |
| design system | `styles/tokens.css` | every colour, type step, space and radius; `[data-theme="light"]` overrides the same names |
| primitives | `components/ui/*` | hand-built 16px outline icon set, buttons, inputs, segmented control, progress, modal, menu, file icons |
| shell | `components/shell/*` | app grid, top bar, sidebar, tab strip, status bar, command palette, toasts |
| files | `components/files/*` | toolbar, breadcrumbs, virtual-ish dense table, grid, inspector, tokenised text preview, context menu, dialogs |
| terminal | `components/terminal/*` | xterm.js pane bound to `/api/ws/terminal` |
| transfers | `components/transfers/*` | queue rows shared by the sidebar mini-list, the bottom dock and the full view |

`explorerStore` models each tab explicitly (`files` | `terminal` | `transfers`), so
per-tab path history, sort, filter, selection and preview survive tab switching without
a router.

## Data flow for a typical action

1. Double-click a folder → `explorerStore.navigate(tabId, path)` pushes history,
   sets `loading`, calls `GET /fs/list`.
2. The response replaces `listing`; the component derives the visible rows with
   `filterEntries` + `sortEntries` (pure functions in `lib/sort.ts`).
3. Dropping files → `transferStore.upload()` issues one streaming `POST /fs/upload` per
   file and upserts the returned `Transfer`; the server broadcasts `transfer:update`
   frames that the dock renders without polling.
4. Renaming/deleting → the mutating route broadcasts `fs:changed`; every open tab on
   that connection refreshes, so two tabs never disagree.

## Verification

`server/test/support/mockSshServer.ts` is a real SSH server built on `ssh2`'s `Server`
class, backed by a temporary directory on disk. The e2e suite boots it, starts the API
via `createServer({ port: 0, stateDir })`, and drives the public HTTP/WebSocket surface.
That means the tests exercise the actual ssh2 client, the actual SFTP wire protocol and
the actual PTY allocation — not a stubbed transport.
