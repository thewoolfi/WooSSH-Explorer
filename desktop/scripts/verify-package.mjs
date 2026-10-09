/**
 * Boots a packaged build (`release/win-unpacked` or the portable exe) in smoke
 * mode and reports whether the real, shipped artifact starts and renders.
 *
 *   node desktop/scripts/verify-package.mjs ["path\\to\\WooSSH Explorer.exe"]
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { access, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(here, '..', '..');

/**
 * A portable build self-extracts and the launcher can outlive a hard `app.exit()`,
 * leaving processes that hold the single-instance lock and silently swallow the
 * next launch. Clean up before and after so runs stay independent.
 */
function killLeftovers() {
  if (process.platform !== 'win32') return;
  const script =
    "Get-Process | Where-Object { $_.ProcessName -eq 'WooSSH Explorer' } | Stop-Process -Force -ErrorAction SilentlyContinue";
  try {
    const { execFileSync } = require('node:child_process');
    execFileSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'ignore' });
  } catch {
    /* best effort */
  }
}

const target =
  process.argv[2] ?? path.join(repoDir, 'release', 'win-unpacked', 'WooSSH Explorer.exe');

if (!(await access(target).then(() => true).catch(() => false))) {
  console.error(`[verify] packaged executable not found: ${target}`);
  console.error('[verify] build it first:  npm run dist');
  process.exit(1);
}

const reportPath = path.join(repoDir, 'design', 'qa', 'desktop-packaged-smoke.json');
const shotPath = path.join(repoDir, 'design', 'qa', 'desktop-packaged-smoke.png');
const downloadDir = path.join(repoDir, 'design', 'qa', 'desktop-downloads');
await mkdir(path.dirname(reportPath), { recursive: true });
await rm(reportPath, { force: true });
await mkdir(downloadDir, { recursive: true });

const env = { ...process.env };
// Must not be inherited: with it set, Electron runs as plain Node.
delete env.ELECTRON_RUN_AS_NODE;
env.SSH_EXPLORER_SMOKE = '1';
env.SSH_EXPLORER_SMOKE_JSON = reportPath;
env.SSH_EXPLORER_SMOKE_OUT = shotPath;
// Also drive a real download through Electron's save pipeline.
env.SSH_EXPLORER_SMOKE_DOWNLOAD = '1';
env.SSH_EXPLORER_DOWNLOAD_DIR = downloadDir;

console.log(`[verify] launching ${path.relative(repoDir, target)}`);
killLeftovers();
const child = spawn(target, [], { stdio: 'inherit', env });
const code = await new Promise((resolve) => child.on('exit', (value) => resolve(value ?? 1)));
killLeftovers();

let report = null;
try {
  report = JSON.parse(await readFile(reportPath, 'utf8'));
} catch {
  console.error('[verify] the packaged app exited without writing a report');
}

if (report) console.log('[verify]', JSON.stringify(report, null, 2));

const ok = code === 0 && report?.ok === true;
if (!ok) {
  console.log(`[verify] PACKAGED APP FAILED (exit ${code})`);
  process.exit(1);
}

/* ------------------------------------------------- closing the window ------ */
// The real user path: close the window and expect the process (and the embedded
// server it owns) to end by itself, without an explicit exit call.
console.log('[verify] checking that closing the window ends the process ...');
await rm(reportPath, { force: true });
killLeftovers();

const closeEnv = { ...env, SSH_EXPLORER_SMOKE_CLOSE: '1' };
const closer = spawn(target, [], { stdio: 'ignore', env: closeEnv });
const closedInTime = await Promise.race([
  new Promise((resolve) => closer.on('exit', () => resolve(true))),
  new Promise((resolve) => setTimeout(() => resolve(false), 25_000)),
]);

if (!closedInTime) {
  killLeftovers();
  console.error('[verify] FAILED: the app was still running 25s after its window closed');
  process.exit(1);
}

const closeReport = await readFile(reportPath, 'utf8')
  .then((text) => JSON.parse(text))
  .catch(() => null);
killLeftovers();

console.log(`[verify] window close ended the process (report written: ${closeReport !== null})`);
console.log('[verify] PACKAGED APP OK');
process.exit(0);
