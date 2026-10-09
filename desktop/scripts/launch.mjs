/**
 * Launches the Electron shell.
 *
 * Two things this wrapper does that `electron .` cannot:
 *   1. Drops `ELECTRON_RUN_AS_NODE`. When that variable is set — some editors and
 *      agent harnesses export it globally — Electron starts as plain Node, the
 *      built-in `electron` module is replaced by the npm package, and the app dies
 *      with a confusing "cannot read properties of undefined" error.
 *   2. Reports a clean message when the shell or the web build is missing.
 *
 *   node scripts/launch.mjs [--smoke]
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { access, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, '..');
const repoDir = path.resolve(desktopDir, '..');
const smoke = process.argv.includes('--smoke');

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(path.join(desktopDir, 'build', 'main.cjs')))) {
  console.error('The desktop shell is not built. Run: npm run build:desktop');
  process.exit(1);
}
if (!(await exists(path.join(repoDir, 'web', 'dist', 'index.html')))) {
  console.error('The web application is not built. Run: npm run build');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

/**
 * A crashed or force-killed instance keeps the single-instance lock, and the next
 * launch then exits silently having done nothing. Clear the way before starting.
 */
function killStrayInstances() {
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

const reportPath = path.join(repoDir, 'design', 'qa', 'desktop-smoke.json');
const shotPath = path.join(repoDir, 'design', 'qa', 'desktop-smoke.png');

if (smoke) {
  killStrayInstances();
  await mkdir(path.dirname(reportPath), { recursive: true });
  await rm(reportPath, { force: true });
  env.SSH_EXPLORER_SMOKE = '1';
  env.SSH_EXPLORER_SMOKE_JSON = reportPath;
  env.SSH_EXPLORER_SMOKE_OUT = shotPath;
}

const child = spawn(electronPath, ['.'], { cwd: desktopDir, stdio: 'inherit', env });
const code = await new Promise((resolve) => child.on('exit', (value) => resolve(value ?? 1)));

if (!smoke) process.exit(code);
let report = null;
try {
  report = JSON.parse(await readFile(reportPath, 'utf8'));
} catch {
  console.error('[smoke] the app exited without writing a report');
}

if (report) console.log('[smoke]', JSON.stringify(report, null, 2));

const ok = code === 0 && report?.ok === true;
console.log(ok ? '[smoke] PASSED' : `[smoke] FAILED (exit ${code})`);
process.exit(ok ? 0 : 1);
