import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';

/**
 * "Edit" — open a remote file in whatever application this PC uses for it, then
 * send the result back.
 *
 * The shell cannot watch a remote file, so the flow is:
 *
 *   1. download to a private temp directory,
 *   2. hand the path to the OS (`shell.openPath`) — the default app opens,
 *   3. watch the directory for the file to change and settle,
 *   4. ask the user in the interface: overwrite on the server, save as a
 *      different remote path, or cancel,
 *   5. upload with the same streaming endpoint the browser uses.
 *
 * Watching the directory rather than the file matters: most editors save by
 * writing a temporary file and renaming it over the original, which silently
 * breaks a watch registered on the file itself.
 */

export type EditState =
  | 'opened'
  | 'changed'
  | 'uploading'
  | 'uploaded'
  | 'cancelled'
  | 'error';

export interface EditEvent {
  sessionId: string;
  state: EditState;
  name: string;
  remotePath: string;
  localPath: string;
  /** Host the file came from, so the renderer can refresh the right folder. */
  connectionId: string;
  /** Bytes uploaded, on `uploaded`. */
  bytes?: number;
  /** Where the bytes went, on `uploaded` (differs for "save as"). */
  target?: string;
  message?: string;
}

export interface OpenEditRequest {
  connectionId: string;
  remotePath: string;
  name: string;
}

export interface EditDecision {
  action: 'overwrite' | 'save-as' | 'cancel';
  /** Required for `save-as`; an absolute remote path. */
  remotePath?: string;
}

interface Session {
  id: string;
  connectionId: string;
  remotePath: string;
  name: string;
  localPath: string;
  directory: string;
  baseline: { mtimeMs: number; size: number };
  watching: boolean;
  /** Set while a change is waiting for the user's decision. */
  pending: boolean;
  settleTimer: NodeJS.Timeout | null;
  pollTimer: NodeJS.Timeout | null;
  dirWatcher: import('node:fs').FSWatcher | null;
}

const SETTLE_MS = 700;
const POLL_MS = 1200;

export interface EditSessionManagerOptions {
  /** Base URL of the embedded API, e.g. `http://127.0.0.1:53124`. */
  apiBaseUrl: string;
  /** Shared secret for the API; sent as `x-ssh-explorer-token`. */
  token?: string;
  /** Directory that holds per-session working copies. */
  rootDir: string;
  /** Opens a local path in the OS default application; resolves to an error string when it fails. */
  openPath: (localPath: string) => Promise<string>;
  emit: (event: EditEvent) => void;
  log: (message: string, meta?: Record<string, unknown>) => void;
}

let sessionSeq = 0;

export class EditSessionManager {
  private readonly sessions = new Map<string, Session>();

  constructor(private readonly options: EditSessionManagerOptions) {}

  /** Number of live sessions — used by the desktop smoke test. */
  get size(): number {
    return this.sessions.size;
  }

  async open(request: OpenEditRequest): Promise<{ sessionId: string; localPath: string }> {
    sessionSeq += 1;
    const id = `edit-${Date.now().toString(36)}-${sessionSeq}`;
    const directory = path.join(this.options.rootDir, id);
    await mkdir(directory, { recursive: true });

    const localPath = path.join(directory, safeFileName(request.name));
    await this.download(request.connectionId, request.remotePath, localPath);

    const stats = await stat(localPath);
    const session: Session = {
      id,
      connectionId: request.connectionId,
      remotePath: request.remotePath,
      name: request.name,
      localPath,
      directory,
      baseline: { mtimeMs: stats.mtimeMs, size: stats.size },
      watching: true,
      pending: false,
      settleTimer: null,
      pollTimer: null,
      dirWatcher: null,
    };
    this.sessions.set(id, session);

    this.options.emit({
      sessionId: id,
      state: 'opened',
      name: session.name,
      remotePath: session.remotePath,
      localPath,
      connectionId: session.connectionId,
    });

    const failure = await this.options.openPath(localPath);
    if (failure !== '') {
      // The file is on disk, so the user can still open it by hand.
      this.options.emit({
        sessionId: id,
        state: 'error',
        name: session.name,
        remotePath: session.remotePath,
        localPath,
        connectionId: session.connectionId,
        message: `No application on this PC could open the file: ${failure}`,
      });
    }

    this.watch(session);
    return { sessionId: id, localPath };
  }

  /** Applies the user's answer to a detected change. */
  async resolve(sessionId: string, decision: EditDecision): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session === undefined) return;

    if (decision.action === 'cancel') {
      session.pending = false;
      this.options.emit({
        sessionId,
        state: 'cancelled',
        name: session.name,
        remotePath: session.remotePath,
        localPath: session.localPath,
        connectionId: session.connectionId,
      });
      // Keep watching: another save must ask again.
      await this.refreshBaseline(session);
      return;
    }

    const target = decision.action === 'save-as' ? (decision.remotePath ?? '').trim() : session.remotePath;
    if (target === '' || !target.startsWith('/')) {
      this.options.emit({
        sessionId,
        state: 'error',
        name: session.name,
        remotePath: session.remotePath,
        localPath: session.localPath,
        connectionId: session.connectionId,
        message: 'A destination path is required and must be absolute.',
      });
      return;
    }

    session.pending = false;
    this.options.emit({
      sessionId,
      state: 'uploading',
      name: session.name,
      remotePath: session.remotePath,
      localPath: session.localPath,
      connectionId: session.connectionId,
      target,
    });

    try {
      const parent = path.posix.dirname(target);
      const name = path.posix.basename(target);
      await this.upload(session.connectionId, parent === '.' ? '/' : parent, name, session.localPath);
      const stats = await stat(session.localPath);

      if (decision.action === 'save-as') {
        // Later saves of the same editing session default to the new location.
        session.remotePath = target;
      }
      await this.refreshBaseline(session);

      this.options.emit({
        sessionId,
        state: 'uploaded',
        name: session.name,
        remotePath: session.remotePath,
        localPath: session.localPath,
        connectionId: session.connectionId,
        bytes: stats.size,
        target,
      });
    } catch (error) {
      session.pending = false;
      this.options.emit({
        sessionId,
        state: 'error',
        name: session.name,
        remotePath: session.remotePath,
        localPath: session.localPath,
        connectionId: session.connectionId,
        target,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Stops watching and deletes every working copy. Called on quit. */
  async dispose(): Promise<void> {
    for (const session of this.sessions.values()) this.stopWatching(session);
    this.sessions.clear();
    await rm(this.options.rootDir, { recursive: true, force: true }).catch(() => undefined);
  }

  /* ------------------------------------------------------------------ watch */

  private watch(session: Session): void {
    try {
      session.dirWatcher = require('node:fs').watch(session.directory, () => this.onMaybeChanged(session));
    } catch (error) {
      this.options.log('edit: directory watch unavailable, falling back to polling', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
    // Editors that replace the file atomically can slip past a directory watch on
    // some filesystems, so a slow poll runs alongside it as a safety net.
    session.pollTimer = setInterval(() => void this.onMaybeChanged(session), POLL_MS);
    session.pollTimer.unref?.();
  }

  private stopWatching(session: Session): void {
    session.watching = false;
    session.dirWatcher?.close();
    session.dirWatcher = null;
    if (session.pollTimer !== null) clearInterval(session.pollTimer);
    if (session.settleTimer !== null) clearTimeout(session.settleTimer);
    session.pollTimer = null;
    session.settleTimer = null;
  }

  /** Debounces bursts of writes into a single "the file changed" event. */
  private async onMaybeChanged(session: Session): Promise<void> {
    if (!session.watching || session.pending) return;

    let stats;
    try {
      stats = await stat(session.localPath);
    } catch {
      // Mid-rename; the next tick will see the finished file.
      return;
    }
    if (stats.mtimeMs === session.baseline.mtimeMs && stats.size === session.baseline.size) return;

    if (session.settleTimer !== null) clearTimeout(session.settleTimer);
    session.settleTimer = setTimeout(() => {
      void (async () => {
        if (!session.watching || session.pending) return;
        let settled;
        try {
          settled = await stat(session.localPath);
        } catch {
          return;
        }
        if (!settled.isFile() || settled.size === 0) return;
        session.pending = true;
        this.options.emit({
          sessionId: session.id,
          state: 'changed',
          name: session.name,
          remotePath: session.remotePath,
          localPath: session.localPath,
          connectionId: session.connectionId,
          bytes: settled.size,
        });
      })();
    }, SETTLE_MS);
    session.settleTimer.unref?.();
  }

  private async refreshBaseline(session: Session): Promise<void> {
    try {
      const stats = await stat(session.localPath);
      session.baseline = { mtimeMs: stats.mtimeMs, size: stats.size };
    } catch {
      /* the file is gone; the next change will create it again */
    }
  }

  /* ------------------------------------------------------------------- http */

  private url(connectionId: string, suffix: string): string {
    return `${this.options.apiBaseUrl}/api/connections/${encodeURIComponent(connectionId)}${suffix}`;
  }

  /** Auth headers for the shell's own calls to the embedded API. */
  private headers(extra?: Record<string, string>): Record<string, string> {
    const token = this.options.token;
    return token ? { 'x-ssh-explorer-token': token, ...extra } : { ...(extra ?? {}) };
  }

  private download(connectionId: string, remotePath: string, target: string): Promise<void> {
    const url = this.url(connectionId, `/fs/download?path=${encodeURIComponent(remotePath)}`);
    return new Promise((resolve, reject) => {
      const request = http.get(url, { headers: this.headers() }, (response) => {
        if (response.statusCode !== 200) {
          response.resume();
          reject(new Error(`the server answered ${response.statusCode} while downloading`));
          return;
        }
        pipeline(response, createWriteStream(target))
          .then(() => resolve())
          .catch(reject);
      });
      request.on('error', reject);
      request.setTimeout(120_000, () => {
        request.destroy(new Error('the download timed out'));
      });
    });
  }

  private upload(
    connectionId: string,
    remoteDirectory: string,
    name: string,
    source: string,
  ): Promise<void> {
    const suffix = `/fs/upload?path=${encodeURIComponent(remoteDirectory)}&name=${encodeURIComponent(name)}`;
    const url = new URL(this.url(connectionId, suffix));
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          method: 'POST',
          hostname: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          headers: this.headers({ 'content-type': 'application/octet-stream' }),
        },
        (response) => {
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => {
            body += chunk;
          });
          response.on('end', () => {
            if (response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 300) {
              resolve();
              return;
            }
            let message = `the server answered ${response.statusCode}`;
            try {
              const parsed = JSON.parse(body) as { error?: { message?: string } };
              if (parsed.error?.message) message = parsed.error.message;
            } catch {
              /* keep the status-code message */
            }
            reject(new Error(message));
          });
        },
      );
      request.on('error', reject);
      const stream = createReadStream(source);
      stream.on('error', reject);
      stream.pipe(request);
    });
  }
}

/** Keeps the original extension (so the OS picks the right app) but drops anything illegal. */
export function safeFileName(name: string): string {
  const base = path.basename(name).replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+$/, '_');
  const trimmed = base.replace(/[ .]+$/, '');
  const candidate = trimmed === '' ? 'file' : trimmed;
  // Reserved device names on Windows.
  if (/^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(candidate)) return `_${candidate}`;
  return candidate.slice(0, 180);
}
