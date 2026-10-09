import path from 'node:path';
import { cpSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell } from 'electron';
import { createServer, type RunningServer } from '@ssh-explorer/server-runtime';
import { buildMenu, sendToFocused, type MenuAction } from './menu';
import { resolveSecretBox } from './secretBox';
import { EditSessionManager, type EditDecision } from './editSession';
import { downloadResumable } from './resumableDownload';
import {
  assertWebBuild,
  loadWindowState,
  MissingWebBuildError,
  resolvePaths,
  saveWindowState,
  type DesktopPaths,
} from './paths';

const APP_ID = 'dev.sshexplorer.desktop';
const SMOKE = process.env.SSH_EXPLORER_SMOKE === '1';
const SMOKE_DOWNLOAD = process.env.SSH_EXPLORER_SMOKE_DOWNLOAD === '1';

let mainWindow: BrowserWindow | null = null;
let server: RunningServer | null = null;
let paths: DesktopPaths;
let quitting = false;
/** "Edit in the default application" sessions. Created once the server is up. */
let edits: EditSessionManager;
/** Paths of downloads that settled, recorded for the smoke test. */
const settledDownloads: { path: string; state: string; name: string }[] = [];

/* --------------------------------------------------------------------------- */
/*  Server                                                                      */
/* --------------------------------------------------------------------------- */

/**
 * Every API call from the shell carries this token. Without it the API is open to
 * any process on the machine — and since saved credentials are now reused on
 * request, an open port means an open door to the user's servers.
 */
let apiToken = '';

async function startServer(resolved: DesktopPaths): Promise<RunningServer> {
  // Saved credentials are sealed by the OS keychain when the platform offers one.
  const secretBox = resolveSecretBox();
  apiToken = randomBytes(32).toString('base64url');
  return createServer({
    // Port 0 lets the OS pick a free loopback port: two copies of the app, or a
    // development server on 5178, can never collide.
    port: 0,
    host: '127.0.0.1',
    stateDir: resolved.stateDir,
    downloadDir: resolved.downloadDir,
    staticDir: resolved.staticDir,
    // Mirrors the server's own default, so "Open Log File" points at a real file.
    logFilePath: path.join(resolved.stateDir, 'logs', 'ssh-explorer.log'),
    logLevel: (process.env.SSH_EXPLORER_LOG_LEVEL as 'info' | undefined) ?? 'info',
    token: apiToken,
    ...(secretBox !== undefined ? { secretBox } : {}),
  });
}

/** Headers for the shell's own API calls. */
function apiHeaders(extra?: Record<string, string>): Record<string, string> {
  return { 'x-ssh-explorer-token': apiToken, ...extra };
}

/** The URL the window loads, carrying the token so the renderer can seed it. */
function windowUrl(base: string): string {
  return `${base}/?token=${encodeURIComponent(apiToken)}`;
}

/* --------------------------------------------------------------------------- */
/*  Window                                                                      */
/* --------------------------------------------------------------------------- */

function createWindow(url: string): BrowserWindow {
  const state = loadWindowState();

  const window = new BrowserWindow({
    width: state.width,
    height: state.height,
    ...(state.x !== undefined && state.y !== undefined ? { x: state.x, y: state.y } : {}),
    minWidth: 900,
    minHeight: 600,
    show: false,
    // Matches the app background so there is no white flash before first paint.
    backgroundColor: '#0A0C10',
    title: 'WooSSH Explorer',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      backgroundThrottling: false,
    },
  });

  if (state.maximized) window.maximize();

  window.once('ready-to-show', () => {
    window.show();
    if (!SMOKE) window.focus();
  });

  const persist = (): void => {
    if (window.isDestroyed()) return;
    const bounds = window.getNormalBounds();
    saveWindowState({
      width: bounds.width,
      height: bounds.height,
      x: bounds.x,
      y: bounds.y,
      maximized: window.isMaximized(),
    });
  };
  window.on('resize', persist);
  window.on('move', persist);
  window.on('maximize', persist);
  window.on('unmaximize', persist);

  // The interface is a local app: pop-ups go to the real browser, and nothing
  // may navigate the shell away from the bundled origin.
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:/i.test(target)) void shell.openExternal(target);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, target) => {
    if (target !== url && !target.startsWith(url)) {
      event.preventDefault();
      if (/^https?:/i.test(target)) void shell.openExternal(target);
    }
  });

  window.on('closed', () => {
    mainWindow = null;
  });

  void window.loadURL(url);
  return window;
}

/* --------------------------------------------------------------------------- */
/*  Native downloads                                                            */
/* --------------------------------------------------------------------------- */

/**
 * A download in the renderer becomes a real file with a native "Save as"
 * dialog, which is what makes the app feel like a desktop program rather than a
 * browser tab. The dialog's starting folder is the OS Downloads directory.
 */
function installDownloadHandler(downloadDir: string): void {
  session.defaultSession.on('will-download', (_event, item) => {
    const name = item.getFilename();
    if (SMOKE_DOWNLOAD) {
      // No dialog in the automated check — the rest of the pipeline is identical.
      item.setSavePath(path.join(downloadDir, name));
    } else {
      item.setSaveDialogOptions({
        title: 'Save file',
        defaultPath: path.join(downloadDir, name),
        buttonLabel: 'Save',
      });
    }

    item.once('done', (_doneEvent, state) => {
      const target = item.getSavePath();
      const payload = { path: target, state, name };
      settledDownloads.push(payload);
      mainWindow?.webContents.send('desktop:download-done', payload);
    });
  });
}

/**
 * Asks for a destination with the same native dialog Chromium's download used, so the
 * resumable path feels identical to the one it replaces. `null` means the user cancelled.
 */
async function chooseSavePath(defaultPath: string): Promise<string | null> {
  const result = await dialog.showSaveDialog({
    title: 'Save file',
    defaultPath,
    buttonLabel: 'Save',
  });
  return result.canceled || !result.filePath ? null : result.filePath;
}

/* --------------------------------------------------------------------------- */
/*  IPC                                                                         */
/* --------------------------------------------------------------------------- */

function installIpc(resolved: DesktopPaths): void {
  ipcMain.handle('desktop:reveal', (_event, target: unknown) => {
    if (typeof target === 'string' && target !== '') shell.showItemInFolder(target);
  });

  /** Opens a folder or a file in whatever the OS uses for it. */
  ipcMain.handle('desktop:open-path', (_event, target: unknown) => {
    if (typeof target === 'string' && target !== '') void shell.openPath(target);
  });

  /**
   * A download the shell owns, so an interrupted one can be continued from its partial.
   * Returns `null` when the user cancelled the save dialog.
   */
  ipcMain.handle('desktop:download-resumable', async (_event, raw: unknown) => {
    const request = raw as { url?: unknown; name?: unknown };
    if (typeof request?.url !== 'string' || typeof request?.name !== 'string') return null;
    if (!/^https?:\/\//i.test(request.url)) return null;

    const name = path.basename(request.name) || 'download';
    const destination = SMOKE_DOWNLOAD
      ? path.join(resolved.downloadDir, name)
      : await chooseSavePath(path.join(resolved.downloadDir, name));
    if (destination === null) return null;

    try {
      const result = await downloadResumable(
        { url: request.url, name, destination, token: apiToken },
        {
          onProgress: (progress) =>
            mainWindow?.webContents.send('desktop:download-progress', { name, ...progress }),
        },
      );
      mainWindow?.webContents.send('desktop:download-done', {
        path: result.path,
        state: 'completed',
        name,
      });
      settledDownloads.push({ path: result.path, state: 'completed', name });
      return result;
    } catch (error) {
      mainWindow?.webContents.send('desktop:download-done', {
        path: destination,
        state: 'interrupted',
        name,
      });
      throw error;
    }
  });

  ipcMain.handle('desktop:open-external', async (_event, url: unknown) => {
    if (typeof url === 'string' && /^https?:/i.test(url)) await shell.openExternal(url);
  });

  ipcMain.handle('desktop:info', () => ({    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    stateDir: resolved.stateDir,
    downloadDir: resolved.downloadDir,
    // The native menu was the only way to these until it was removed on Windows/Linux.
    logFilePath: path.join(resolved.stateDir, 'logs', 'ssh-explorer.log'),
    logDir: path.join(resolved.stateDir, 'logs'),
  }));

  /* ------------------------------------------------ edit in default app --- */

  ipcMain.handle('desktop:edit-open', async (_event, raw: unknown) => {
    const request = raw as { connectionId?: unknown; remotePath?: unknown; name?: unknown };
    if (
      typeof request?.connectionId !== 'string' ||
      typeof request?.remotePath !== 'string' ||
      typeof request?.name !== 'string'
    ) {
      throw new Error('edit-open needs connectionId, remotePath and name.');
    }
    return edits.open({
      connectionId: request.connectionId,
      remotePath: request.remotePath,
      name: request.name,
    });
  });

  ipcMain.handle('desktop:edit-resolve', async (_event, raw: unknown) => {
    const payload = raw as { sessionId?: unknown; decision?: EditDecision };
    if (typeof payload?.sessionId !== 'string' || payload.decision === undefined) {
      throw new Error('edit-resolve needs a sessionId and a decision.');
    }
    await edits.resolve(payload.sessionId, payload.decision);
  });
}

/* --------------------------------------------------------------------------- */
/*  Smoke mode                                                                  */
/* --------------------------------------------------------------------------- */

/**
 * Headless-ish self check used by `npm run app:smoke`: boots the whole desktop
 * stack, waits for the UI to render, asserts the shell and the API are both
 * alive, writes a screenshot and exits with a status code.
 */
async function runSmoke(window: BrowserWindow, serverUrl: string): Promise<void> {
  const out = process.env.SSH_EXPLORER_SMOKE_OUT ?? path.resolve(__dirname, '..', '..', 'design', 'qa', 'desktop-smoke.png');
  const result: Record<string, unknown> = {
    windowVisible: false,
    title: '',
    menuItems: 0,
    shellRendered: false,
    apiFromRenderer: null,
    screenshot: null,
    errors: [] as string[],
  };

  try {
    await new Promise<void>((resolve) => window.webContents.once('did-finish-load', () => resolve()));
    // Let React mount and the stores finish their first fetch.
    await new Promise((resolve) => setTimeout(resolve, 2500));

    result.windowVisible = window.isVisible();
    result.title = window.getTitle();
    // macOS keeps the native menu; Windows and Linux deliberately have none, because the
    // system draws it and it cannot be themed. The renderer's own affordances are checked
    // below instead, so this stays a real assertion on both platforms.
    result.menuItems = Menu.getApplicationMenu()?.items.length ?? 0;
    result.menuExpected = process.platform === 'darwin';

    const probe = (await window.webContents.executeJavaScript(
      `(async () => {
         const health = await fetch('/api/health', { headers: { 'x-ssh-explorer-token': ${JSON.stringify(apiToken)} } })
           .then((r) => r.json()).catch((e) => ({ error: String(e) }));
         return {
           shell: Boolean(document.querySelector('.app')),
           theme: document.documentElement.dataset.theme ?? null,
           brand: document.querySelector('.brand__name')?.textContent ?? null,
           health,
           bridge: typeof window.sshExplorerDesktop === 'object' && window.sshExplorerDesktop !== null,
           // Reachable without the native menu: Ctrl+K opens the palette that now holds
           // the folder and log entries the Tools menu used to own.
           commandPalette: Boolean(document.querySelector('.palette-trigger, .topbar__search')),
           // The renderer must have picked the token out of the URL and stripped it.
           urlHasToken: location.search.includes('token'),
         };
       })()`,
      true,
    )) as {
      shell: boolean;
      theme: string | null;
      brand: string | null;
      health: { ok?: boolean; version?: string; error?: string };
      bridge: boolean;
      urlHasToken: boolean;
      commandPalette: boolean;
    };

    result.shellRendered = probe.shell;
    result.apiFromRenderer = probe.health;
    result.brand = probe.brand;
    result.theme = probe.theme;
    result.bridge = probe.bridge;
    result.tokenSeeded = !probe.urlHasToken;
    result.commandPalette = probe.commandPalette;

    const image = await window.webContents.capturePage();
    const fs = await import('node:fs/promises');
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, image.toPNG());
    result.screenshot = out;

    // Exercises the Electron-only part of downloading: anchor click → Chromium
    // download → will-download → file on disk → done event → renderer notice.
    if (SMOKE_DOWNLOAD) {
      result.download = await runDownloadProbe(window, paths.downloadDir);
    }

    // Exercises the bundled ssh2 inside the asar: real TCP → host key → auth →
    // SFTP listing, all through the same HTTP API the UI uses.
    const sshTarget = process.env.SSH_EXPLORER_SMOKE_SSH;
    if (sshTarget) {
      const target = JSON.parse(await fs.readFile(sshTarget, 'utf8')) as {
        host: string;
        port: number;
        username: string;
        password: string;
      };
      result.ssh = await runSshProbe(serverUrl, target);
    }

    const downloadOk =
      result.download === undefined || (result.download as { ok: boolean }).ok === true;
    const sshOk = result.ssh === undefined || (result.ssh as { ok: boolean }).ok === true;

    const menuOk =
      result.menuExpected === true
        ? (result.menuItems as number) > 0
        : // Without the native menu every action must be reachable inside the app: the
          // command palette is where the folder and log entries moved to.
          (result.commandPalette as boolean | undefined) === true;

    const ok =
      result.shellRendered === true &&
      result.windowVisible === true &&
      probe.health?.ok === true &&
      result.bridge === true &&
      menuOk &&
      downloadOk &&
      sshOk;

    const report = JSON.stringify({ ok, ...result }, null, 2);
    process.stdout.write(`${report}\n`);
    // Also written to a file so the driver never has to capture piped stdio.
    const reportPath = process.env.SSH_EXPLORER_SMOKE_JSON;
    if (reportPath) {
      const fs = await import('node:fs/promises');
      await fs.mkdir(path.dirname(reportPath), { recursive: true });
      await fs.writeFile(reportPath, report, 'utf8');
    }

    if (process.env.SSH_EXPLORER_SMOKE_CLOSE === '1') {
      // Exercise the real "user closes the window" path: no app.exit() here, the
      // driver asserts the process ends on its own.
      window.close();
      return;
    }

    app.exit(ok ? 0 : 1);
  } catch (error) {
    process.stderr.write(`smoke failed: ${error instanceof Error ? error.stack : String(error)}\n`);
    app.exit(1);
  }
}

/**
 * Triggers a download from the renderer and waits for it to land on disk.
 * Returns a report the smoke test can assert on and print.
 */
async function runDownloadProbe(
  window: BrowserWindow,
  downloadDir: string,
): Promise<Record<string, unknown>> {
  const fs = await import('node:fs/promises');
  const probeName = 'desktop-download-probe.bin';
  const expectedBytes = 4096;

  await window.webContents.executeJavaScript(
    `(() => {
       const bytes = new Uint8Array(${expectedBytes}).fill(65);
       const blob = new Blob([bytes], { type: 'application/octet-stream' });
       const url = URL.createObjectURL(blob);
       const anchor = document.createElement('a');
       anchor.href = url;
       anchor.download = ${JSON.stringify(probeName)};
       document.body.appendChild(anchor);
       anchor.click();
       anchor.remove();
       setTimeout(() => URL.revokeObjectURL(url), 5000);
       return true;
     })()`,
    true,
  );

  const deadline = Date.now() + 20_000;
  while (settledDownloads.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  const settled = settledDownloads[0];
  const target = settled?.path ?? path.join(downloadDir, probeName);
  const stat = await fs.stat(target).catch(() => null);
  const matchesRendererNotification = settled !== undefined;

  // Do not leave probe files behind.
  if (stat) await fs.rm(target, { force: true });

  return {
    requested: probeName,
    expectedBytes,
    settled: matchesRendererNotification,
    state: settled?.state ?? null,
    path: target,
    size: stat?.size ?? null,
    ok: settled?.state === 'completed' && stat?.size === expectedBytes,
  };
}

/**
 * Connects to a real SSH server through the embedded API and lists its root.
 * This is what proves the bundled `ssh2` works from inside the packaged app.
 */
async function runSshProbe(
  baseUrl: string,
  target: { host: string; port: number; username: string; password: string },
): Promise<Record<string, unknown>> {
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: apiHeaders(body === undefined ? undefined : { 'content-type': 'application/json' }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };

  const credentials = {
    host: target.host,
    port: target.port,
    username: target.username,
    auth: { method: 'password' as const, password: target.password },
  };

  const first = await request('/api/connections', credentials);
  let connection = first.body?.connection;
  let trusted = false;

  if (first.status === 409 && first.body?.error?.code === 'HOST_KEY_UNKNOWN') {
    const fingerprint = first.body.error.details.fingerprint as string;
    const retry = await request('/api/connections', {
      ...credentials,
      trustHostKey: true,
      hostKeyFingerprint: fingerprint,
    });
    connection = retry.body?.connection;
    trusted = retry.status === 201;
  }

  if (!connection?.id) {
    return { ok: false, step: 'connect', firstStatus: first.status, firstBody: first.body };
  }

  const listing = await request(`/api/connections/${connection.id}/fs/list?path=/`);
  const entries = (listing.body?.listing?.entries ?? []) as { name: string }[];

  // The edit round trip needs the connection to still be open.
  const edit =
    process.env.SSH_EXPLORER_SMOKE_EDIT === '1'
      ? await runEditProbe(baseUrl, connection.id, entries.map((entry) => entry.name))
      : undefined;

  await fetch(`${baseUrl}/api/connections/${connection.id}`, {
    method: 'DELETE',
    headers: apiHeaders(),
  }).catch(() => undefined);

  return {
    ok: trusted && listing.status === 200 && entries.length > 0 && (edit === undefined || edit.ok === true),
    hostKeyChallenge: first.status === 409,
    trusted,
    serverInfo: connection.serverInfo
      ? `${connection.serverInfo.platform} ${connection.serverInfo.arch}`
      : null,
    listingStatus: listing.status,
    entryCount: entries.length,
    sample: entries.slice(0, 5).map((entry) => entry.name),
    ...(edit !== undefined ? { edit } : {}),
  };
}

/**
 * Exercises "edit in the default application" end to end without launching a real
 * editor: download → simulate a local save → the `changed` prompt → overwrite →
 * read the file back from the server and confirm the new bytes are there.
 */
async function runEditProbe(
  baseUrl: string,
  connectionId: string,
  names: string[],
): Promise<Record<string, unknown>> {
  const fsp = await import('node:fs/promises');
  const target = names.find((name) => /\.(?:txt|md|json|conf)$/i.test(name)) ?? names[0];
  if (target === undefined) return { ok: false, message: 'the server offered no files to edit' };

  const events: string[] = [];
  const scratch = path.join(app.getPath('temp'), `ssh-explorer-edit-probe-${Date.now()}`);
  const editsProbe = new EditSessionManager({
    apiBaseUrl: baseUrl,
    token: apiToken,
    rootDir: scratch,
    // Never launch an application from an automated run.
    openPath: async () => '',
    emit: (event) => events.push(event.state),
    log: () => undefined,
  });

  try {
    const handle = await editsProbe.open({
      connectionId,
      remotePath: `/${target}`,
      name: target,
    });

    const marker = `ssh-explorer-edited-${Date.now()}`;
    await fsp.appendFile(handle.localPath, `\n${marker}\n`, 'utf8');

    const changed = await waitForEvent(events, 'changed', 15_000);
    if (!changed) return { ok: false, target, events, message: 'no change was detected' };

    await editsProbe.resolve(handle.sessionId, { action: 'overwrite' });
    const uploaded = await waitForEvent(events, 'uploaded', 20_000);
    if (!uploaded) return { ok: false, target, events, message: 'the overwrite did not complete' };

    // Read it back through the API: the server must now hold the edited bytes.
    const response = await fetch(
      `${baseUrl}/api/connections/${connectionId}/fs/download?path=${encodeURIComponent(`/${target}`)}`,
      { headers: apiHeaders() },
    );
    const body = await response.text();

    return {
      ok: response.status === 200 && body.includes(marker),
      target,
      events,
      remoteBytes: body.length,
      markerFound: body.includes(marker),
    };
  } catch (error) {
    return { ok: false, target, events, message: error instanceof Error ? error.message : String(error) };
  } finally {
    await editsProbe.dispose().catch(() => undefined);
  }
}

/** Polls the collected event names until `state` appears. */
async function waitForEvent(events: string[], state: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (events.includes(state)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/* --------------------------------------------------------------------------- */
/*  Lifecycle                                                                   */
/* --------------------------------------------------------------------------- */

/**
 * The product used to be called "SSH Explorer", and Electron derives the user-data
 * directory from that name. Renaming it therefore moves the directory, which would leave
 * every saved host, credential and pinned key behind in the old one — an upgrade would
 * look like a factory reset.
 *
 * Copied once, before anything reads it. A failure here is not fatal: starting fresh
 * beats refusing to launch.
 */
function migrateRenamedUserData(): void {
  try {
    const current = app.getPath('userData');
    const legacy = path.join(path.dirname(current), 'SSH Explorer');
    if (current === legacy || existsSync(current) || !existsSync(legacy)) return;
    cpSync(legacy, current, { recursive: true });
  } catch {
    /* the old directory may be locked or unreadable; carry on with a clean one */
  }
}

async function main(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  app.setAppUserModelId(APP_ID);

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  await app.whenReady();

  // Before anything reads the state directory: the product was renamed, and Electron
  // derives that directory from the name.
  migrateRenamedUserData();
  paths = resolvePaths();

  try {
    assertWebBuild(paths);
  } catch (error) {
    const message =
      error instanceof MissingWebBuildError
        ? error.message
        : `Could not start WooSSH Explorer: ${error instanceof Error ? error.message : String(error)}`;
    dialog.showErrorBox('WooSSH Explorer', message);
    app.exit(1);
    return;
  }

  server = await startServer(paths);

  edits = new EditSessionManager({
    apiBaseUrl: server.url,
    token: apiToken,
    rootDir: path.join(app.getPath('temp'), 'ssh-explorer-edit'),
    openPath: (localPath) => shell.openPath(localPath),
    emit: (event) => mainWindow?.webContents.send('desktop:edit-event', event),
    log: (message, meta) => process.stderr.write(`${message} ${JSON.stringify(meta ?? {})}\n`),
  });

  // Windows and Linux draw the menu bar themselves, in the system's own colours: a grey
  // strip across the top of a dark application that Electron cannot restyle. Every action
  // it holds also exists in the app — the command palette, the hotkeys and the context
  // menus — so on those platforms the bar is removed rather than left looking foreign.
  // macOS keeps it: there the menu lives in the system menu bar, where it belongs.
  if (process.platform === 'darwin') {
    Menu.setApplicationMenu(
      buildMenu({
        send: (action: MenuAction) => sendToFocused(mainWindow, action),
        downloadDir: paths.downloadDir,
        stateDir: paths.stateDir,
        logFilePath: paths.logFilePath,
        logDir: paths.logDir,
        version: app.getVersion(),
      }),
    );
  } else {
    Menu.setApplicationMenu(null);
    mainWindow?.setMenuBarVisibility(false);
  }

  installDownloadHandler(paths.downloadDir);
  installIpc(paths);

  mainWindow = createWindow(windowUrl(server.url));

  if (SMOKE) {
    await runSmoke(mainWindow, server.url);
    return;
  }
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0 && server) {
      mainWindow = createWindow(windowUrl(server.url));
    }
  });
}

app.on('window-all-closed', () => {
  // A desktop app on Windows/Linux exits with its last window.
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  quitting = true;
});

app.on('will-quit', (event) => {
  if (!server) return;
  event.preventDefault();
  const pending = server;
  server = null;
  // Closing the window must always end the process. If a socket refuses to settle,
  // fall through to a hard exit rather than leaving the app running with no window.
  const bail = setTimeout(() => app.exit(0), 2500);
  bail.unref?.();
  void edits
    ?.dispose()
    .catch(() => undefined)
    .then(() => pending.close())
    .catch(() => undefined)
    .finally(() => {
      clearTimeout(bail);
      app.exit(0);
    });
});

process.on('uncaughtException', (error) => {
  dialog.showErrorBox('WooSSH Explorer — unexpected error', error.stack ?? error.message);
});

void main().catch((error: unknown) => {
  dialog.showErrorBox(
    'WooSSH Explorer',
    `Could not start: ${error instanceof Error ? error.message : String(error)}`,
  );
  app.exit(1);
});
