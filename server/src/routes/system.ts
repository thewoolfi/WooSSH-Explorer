import { readdir, readFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { Router } from 'express';
import type { Request, Response } from 'express';

import type { Logger } from '../logger.js';
import type { KeyInfo, SystemInfo } from '../types.js';
import type { RouteContext } from './context.js';
import { secretStorageInfo } from './secrets.js';

const PROCESS_STARTED_AT = Date.now();
const MAX_KEY_PROBE_BYTES = 8 * 1024;

/** Maps a PEM/OpenSSH header to a short key type name. */
export function keyTypeFromPem(content: string): string | null {
  const match = /-----BEGIN ([A-Z0-9 ]*?)PRIVATE KEY-----/.exec(content);
  if (match === null) return null;
  const label = (match[1] ?? '').trim().toUpperCase();
  switch (label) {
    case 'OPENSSH':
      // The algorithm name is the first field of the decoded blob.
      return openSshKeyType(content) ?? 'openssh';
    case 'RSA':
      return 'rsa';
    case 'DSA':
      return 'dsa';
    case 'EC':
      return 'ecdsa';
    case 'ED25519':
      return 'ed25519';
    case '':
      return 'unknown';
    default:
      return label.toLowerCase();
  }
}

function openSshKeyType(content: string): string | null {
  try {
    const body = content.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
    const decoded = Buffer.from(body, 'base64').subarray(0, 64).toString('latin1');
    for (const candidate of [
      'ssh-ed25519',
      'ssh-rsa',
      'ecdsa-sha2-nistp256',
      'ecdsa-sha2-nistp384',
      'ecdsa-sha2-nistp521',
      'ssh-dss',
    ]) {
      if (decoded.includes(candidate)) return candidate;
    }
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Enumerates private keys in `~/.ssh` (contract §3): files without a `.pub` suffix that parse as
 * a private key, plus `id_*` names. Unreadable entries are skipped, never fatal.
 */
export async function findPrivateKeys(sshDir: string, logger: Logger): Promise<KeyInfo[]> {
  let dirents: Dirent[];
  try {
    dirents = await readdir(sshDir, { withFileTypes: true });
  } catch (err) {
    logger.debug('no readable ~/.ssh directory', { path: sshDir, code: (err as { code?: string }).code });
    return [];
  }

  const keys: KeyInfo[] = [];
  for (const dirent of dirents) {
    if (!dirent.isFile()) continue;
    const name = dirent.name;
    if (name.startsWith('.')) continue;
    if (name.endsWith('.pub')) continue;
    if (name === 'known_hosts' || name === 'known_hosts.old') continue;
    if (name === 'authorized_keys' || name === 'config') continue;
    const looksLikeKey = name.startsWith('id_') || /\.(?:pem|key|ppk)$/i.test(name);
    if (!looksLikeKey) continue;

    const fullPath = path.join(sshDir, name);
    try {
      const content = (await readFile(fullPath, { encoding: 'utf8', flag: 'r' })).slice(0, MAX_KEY_PROBE_BYTES);
      const type = keyTypeFromPem(content);
      if (type === null) continue;
      keys.push({ name, path: fullPath, type });
    } catch {
      // Unreadable or not UTF-8 text: skip it rather than guessing.
      continue;
    }
  }

  keys.sort((a, b) => a.name.localeCompare(b.name));
  return keys;
}

export function registerSystemRoutes(router: Router, ctx: RouteContext): void {
  const { config } = ctx;

  // GET /api/health
  router.get('/health', (_req: Request, res: Response) => {
    res.json({
      ok: true,
      version: config.version,
      uptimeSeconds: Math.round((Date.now() - PROCESS_STARTED_AT) / 1000),
      pid: process.pid,
    });
  });

  // GET /api/system/info
  router.get('/system/info', async (_req: Request, res: Response) => {
    const homeDir = homedir();
    const sshDir = path.join(homeDir, '.ssh');
    const keys = await findPrivateKeys(sshDir, ctx.logger);
    const info: SystemInfo = {
      version: config.version,
      platform: process.platform,
      homeDir,
      sshDir,
      knownHostsPath: config.knownHostsPath,
      profilesPath: config.profilesPath,
      defaultDownloadDir: config.downloadDir,
      keys,
      secretStorage: secretStorageInfo(ctx),
    };
    res.json(info);
  });
}
