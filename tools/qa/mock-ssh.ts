/**
 * Runs the test-support mock SSH server as a standalone target so the real UI can
 * be exercised by hand, by the browser QA driver, and by the desktop smoke test.
 *
 *   npx tsx tools/qa/mock-ssh.ts [--port 2222] [--root <dir>] [--info-file <path>]
 *
 * `--info-file` (or `SSH_MOCK_INFO_FILE`) writes the connection details as JSON so
 * a driver never has to capture piped stdout.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startMockSshServer } from '../../server/test/support/mockSshServer.js';

const args = process.argv.slice(2);
const arg = (name: string, fallback: string) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? (args[index + 1] as string) : fallback;
};

const rootDir = arg('root', path.resolve('.mock-ssh-root'));

const server = await startMockSshServer({
  rootDir,
  username: arg('user', 'tester'),
  password: arg('password', 'hunter2'),
});

const info = {
  host: '127.0.0.1',
  port: server.port,
  username: server.username,
  password: server.password,
  privateKeyPath: server.privateKeyPath,
  fingerprint: server.hostKeyFingerprint,
  rootDir: server.rootDir,
};

const infoFile = arg('info-file', process.env.SSH_MOCK_INFO_FILE ?? '');
if (infoFile) {
  mkdirSync(path.dirname(path.resolve(infoFile)), { recursive: true });
  writeFileSync(path.resolve(infoFile), JSON.stringify(info, null, 2), 'utf8');
}

console.log(JSON.stringify(info, null, 2));

const shutdown = async () => {
  await server.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
