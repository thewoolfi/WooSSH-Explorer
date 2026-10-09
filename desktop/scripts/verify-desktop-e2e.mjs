/**
 * End-to-end desktop verification.
 *
 * Starts the mock SSH server, boots the packaged application in smoke mode with
 * that server as a target, and asserts the whole stack inside the shipped
 * artifact: window, menu, embedded API, ssh2 handshake, host-key trust, SFTP
 * listing and the native download pipeline.
 *
 *   node desktop/scripts/verify-desktop-e2e.mjs ["path\\to\\WooSSH Explorer.exe"]
 */
import { spawn } from 'node:child_process';
import { access, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(here, '..', '..');
const tsx = path.join(repoDir, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');

const target = process.argv[2] ?? path.join(repoDir, 'release', 'win-unpacked', 'WooSSH Explorer.exe');
if (!(await access(target).then(() => true).catch(() => false))) {
  console.error(`[e2e] packaged executable not found: ${target}\n[e2e] build it first: npm run dist`);
  process.exit(1);
}

const qaDir = path.join(repoDir, 'design', 'qa');
const mockInfoPath = path.join(qaDir, 'desktop-mock-ssh.json');
const reportPath = path.join(qaDir, 'desktop-e2e.json');
const shotPath = path.join(qaDir, 'desktop-e2e.png');
const downloadDir = path.join(qaDir, 'desktop-downloads');

await mkdir(qaDir, { recursive: true });
await rm(mockInfoPath, { force: true });
await rm(reportPath, { force: true });

/* ------------------------------------------------------------- mock sshd --- */
const mockEnv = { ...process.env };
delete mockEnv.ELECTRON_RUN_AS_NODE;
const mock = spawn(
  tsx,
  ['tools/qa/mock-ssh.ts', '--root', path.join(repoDir, '.mock-ssh-root'), '--info-file', mockInfoPath],
  { cwd: repoDir, stdio: 'ignore', shell: process.platform === 'win32', env: mockEnv },
);

const waitFor = async (file, timeoutMs) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  return null;
};

const mockInfo = await waitFor(mockInfoPath, 30_000);
if (!mockInfo) {
  mock.kill();
  console.error('[e2e] the mock SSH server did not start');
  process.exit(1);
}
console.log(`[e2e] mock sshd on ${mockInfo.host}:${mockInfo.port}`);

/* ------------------------------------------------------------ the app ------ */
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
env.SSH_EXPLORER_SMOKE = '1';
env.SSH_EXPLORER_SMOKE_JSON = reportPath;
env.SSH_EXPLORER_SMOKE_OUT = shotPath;
env.SSH_EXPLORER_SMOKE_DOWNLOAD = '1';
env.SSH_EXPLORER_DOWNLOAD_DIR = downloadDir;
env.SSH_EXPLORER_SMOKE_SSH = mockInfoPath;
// Also exercises the edit round trip: download → local save → prompt → overwrite.
env.SSH_EXPLORER_SMOKE_EDIT = '1';

const app = spawn(target, [], { stdio: 'inherit', env });
const code = await new Promise((resolve) => app.on('exit', (value) => resolve(value ?? 1)));

mock.kill();
await new Promise((resolve) => setTimeout(resolve, 500));
await rm(downloadDir, { recursive: true, force: true });
await rm(mockInfoPath, { force: true });

let report = null;
try {
  report = JSON.parse(await readFile(reportPath, 'utf8'));
} catch {
  console.error('[e2e] the app exited without writing a report');
}

if (report) console.log('[e2e]', JSON.stringify(report, null, 2));

const ok = code === 0 && report?.ok === true;
console.log(ok ? '[e2e] DESKTOP END-TO-END OK' : `[e2e] DESKTOP END-TO-END FAILED (exit ${code})`);
process.exit(ok ? 0 : 1);
