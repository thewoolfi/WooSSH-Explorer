import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';

/**
 * Where the desktop shell finds its pieces.
 *
 * Development runs from the repository; a packaged build ships the built web app
 * as an extra resource next to the executable. Per-user state (known_hosts,
 * saved profiles) always lives in the OS application-data directory, never next
 * to the binary, so an installed copy keeps working after an upgrade.
 */
export interface DesktopPaths {
  /** Directory containing the built web app (`index.html` + `assets/`). */
  staticDir: string;
  /** Directory for `known_hosts` and `profiles.json`. */
  stateDir: string;
  /** Where the native save dialog starts. */
  downloadDir: string;
  /** Rotating server log; the only trace a windowed build leaves. */
  logFilePath: string;
  /** Its directory, so "Open Log File" works before the first line is written. */
  logDir: string;
  /** Repository root in development, the resources directory when packaged. */
  rootDir: string;
}

export function resolvePaths(): DesktopPaths {
  const packaged = app.isPackaged;
  // build/main.cjs -> desktop/build -> desktop -> repository root
  const rootDir = packaged ? process.resourcesPath : path.resolve(__dirname, '..', '..');

  return {
    rootDir,
    staticDir: packaged ? path.join(process.resourcesPath, 'web') : path.join(rootDir, 'web', 'dist'),
    stateDir: app.getPath('userData'),
    // The smoke test must not litter the user's real Downloads folder.
    downloadDir: process.env.SSH_EXPLORER_DOWNLOAD_DIR ?? app.getPath('downloads'),
    logDir: path.join(app.getPath('userData'), 'logs'),
    logFilePath: path.join(app.getPath('userData'), 'logs', 'ssh-explorer.log'),
  };
}

/** Thrown when a packaged/development build is missing its web assets. */
export class MissingWebBuildError extends Error {
  constructor(readonly staticDir: string) {
    super(
      `The web application was not found at ${staticDir}.\n\n` +
        'Run "npm run build" in the project root and start the desktop app again.',
    );
    this.name = 'MissingWebBuildError';
  }
}

export function assertWebBuild(paths: DesktopPaths): void {
  if (!fs.existsSync(path.join(paths.staticDir, 'index.html'))) {
    throw new MissingWebBuildError(paths.staticDir);
  }
}

/* -------------------------------------------------------------- window state */

export interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized: boolean;
}

const DEFAULT_STATE: WindowState = { width: 1360, height: 880, maximized: false };

function stateFile(): string {
  return path.join(app.getPath('userData'), 'window-state.json');
}

/** Restores the last window geometry, ignoring anything now off-screen. */
export function loadWindowState(): WindowState {
  let saved: Partial<WindowState>;
  try {
    saved = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as Partial<WindowState>;
  } catch {
    return { ...DEFAULT_STATE };
  }

  const width = clamp(saved.width, 900, 10_000) ?? DEFAULT_STATE.width;
  const height = clamp(saved.height, 600, 10_000) ?? DEFAULT_STATE.height;

  // A monitor may have been unplugged since the last run.
  const visible =
    typeof saved.x === 'number' &&
    typeof saved.y === 'number' &&
    screenHasPoint(saved.x, saved.y);

  return {
    width,
    height,
    ...(visible ? { x: saved.x, y: saved.y } : {}),
    maximized: saved.maximized === true,
  };
}

export function saveWindowState(state: WindowState): void {
  try {
    fs.mkdirSync(path.dirname(stateFile()), { recursive: true });
    fs.writeFileSync(stateFile(), JSON.stringify(state, null, 2), 'utf8');
  } catch {
    /* a lost window position is never worth failing over */
  }
}

function clamp(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** True when a saved top-left corner still lands on a connected display. */
function screenHasPoint(x: number, y: number): boolean {
  try {
    // Imported lazily: `screen` is only usable after the app is ready.
    const { screen } = require('electron') as typeof import('electron');
    return screen.getAllDisplays().some((display) => {
      const { x: dx, y: dy, width, height } = display.workArea;
      return x >= dx - 40 && y >= dy - 40 && x < dx + width - 80 && y < dy + height - 40;
    });
  } catch {
    return false;
  }
}
