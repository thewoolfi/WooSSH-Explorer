/**
 * Desktop smoke test: boots the real Electron app, waits for the interface to
 * render, checks that the in-process API answers, writes a screenshot and exits.
 *
 * The child inherits stdio and reports through a file, so nothing depends on
 * capturing piped output.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import electronPath from 'electron';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(here, '..');
const repoDir = path.resolve(desktopDir, '..');
const reportPath = path.join(repoDir, 'design', 'qa', 'desktop-smoke.json');
const shotPath = path.join(repoDir, 'design', 'qa', 'desktop-smoke.png');

await mkdir(path.dirname(reportPath), { recursive: true });
await rm(reportPath, { force: true });

const child = spawn(electronPath, ['.'], {
  cwd: desktopDir,
  stdio: 'inherit',
  env: {
    ...process.env,
    SSH_EXPLORER_SMOKE: '1',
    SSH_EXPLORER_SMOKE_JSON: reportPath,
    SSH_EXPLORER_SMOKE_OUT: shotPath,
  },
});

const code = await new Promise((resolve) => child.on('exit', (value) => resolve(value ?? 1)));

let report = null;
try {
  report = JSON.parse(await readFile(reportPath, 'utf8'));
} catch {
  console.error('[smoke] the app exited without writing a report');
}

if (report) {
  console.log('[smoke]', JSON.stringify(report));
}

const ok = code === 0 && report?.ok === true;
if (!ok) {
  console.error(`[smoke] FAILED (exit ${code})`);
}
process.exit(ok ? 0 : 1);
