/**
 * Mock SSH/SFTP server — test support for the SSH Explorer integration suite
 * (see `docs/API.md` §13, which this file implements exactly).
 *
 * Design notes
 * ------------
 * * The SFTP subsystem is backed by a **real temporary directory** (`fs.mkdtemp`),
 *   so every operation genuinely hits the local filesystem: reads return real
 *   bytes, deletes really delete, renames really rename.
 * * The virtual SFTP root `/` is that directory, and it doubles as the shell
 *   working directory (so `fs/list` on `/` lists the fixture entries).
 * * Modes: Windows cannot represent POSIX permission bits, so the mock models a
 *   POSIX host explicitly — directories report `0755`, files `0644` (or `0444`
 *   when the real file carries the read-only attribute), symlinks `0777`, and any
 *   explicit `SETSTAT` mode is remembered in an in-memory overlay and reported
 *   verbatim afterwards. `SETSTAT` still calls the real `fs.chmod`, so the
 *   underlying file really does flip to/from read-only.
 * * `atime`/`mtime` are sent in the units the SFTP v3 protocol mandates (whole
 *   seconds since the epoch), exactly like OpenSSH's `sftp-server`. The API is
 *   expected to convert to epoch milliseconds (contract §2).
 * * `rotateHostKey: true` serves host key K1 until the first client authenticates
 *   successfully, then permanently switches to a freshly generated K2 *on the same
 *   host:port*. That is what lets the suite exercise `409 HOST_KEY_MISMATCH`
 *   without depending on how the product keys its `known_hosts` file (host only
 *   vs. `[host]:port`).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// `ssh2` is CommonJS with a dynamic export shape, so Node's ESM named-export
// detection cannot see `Server`/`utils` — import the default (module.exports) instead.
// eslint-disable-next-line import/no-unresolved
import ssh2 from 'ssh2';

import {
  createFixtureTree,
  FIXTURE_GID,
  FIXTURE_UID,
  FIXTURE_USER,
  type FixtureTree,
} from './fixtures.js';

const { Server: SshServer, utils } = ssh2 as unknown as {
  Server: any;
  utils: { generateKeyPairSync(type: string, opts?: unknown): { private: string; public: string }; parseKey(key: string): any; sftp: any };
};

// `ssh2` re-exports the SFTP constants under `utils.sftp` in 1.17.x.
const { STATUS_CODE, OPEN_MODE } = utils.sftp;

const HOST = '127.0.0.1';
const HOSTNAME = 'mock-host';
const PLATFORM = 'Linux';
const KERNEL_RELEASE = '6.1.0-mock';
const ARCH = 'x86_64';
const SHELL = '/bin/bash';
const GROUP = FIXTURE_USER;

/**
 * Deterministic stand-ins for the Linux tools `GET /system/stats` (contract §16) runs.
 * The values are fixed so the e2e assertions can be exact instead of "some number arrived".
 * `used + free + buff/cache = total`, exactly like a real `free -b` row.
 */
const SYS_STATS = {
  loadOne: '0.42',
  loadFive: '0.55',
  loadFifteen: '0.61',
  /** 10 days, 3:22. */
  uptimeClock: '14:22:01',
  uptimeSpan: '10 days,  3:22',
  cpuCount: 4,
  memTotal: 8_589_934_592,
  memUsed: 4_294_967_296,
  memFree: 1_073_741_824,
  memBuffCache: 3_221_225_472,
  memAvailable: 5_368_709_120,
  swapTotal: 2_147_483_648,
  swapUsed: 268_435_456,
  /** KiB blocks, as `df -Pk` reports them. */
  disks: [
    { filesystem: '/dev/sda1', blocks: 103_080_448, used: 42_949_672, available: 60_130_776, mount: '/' },
    { filesystem: 'tmpfs', blocks: 1_048_576, used: 0, available: 1_048_576, mount: '/dev/shm' },
  ],
} as const;

const DEBUG = !!process.env.MOCK_SSH_DEBUG;
function debug(...parts: unknown[]): void {
  if (DEBUG) console.error('[mock-sshd]', ...parts);
}

export interface MockSshServerOptions {
  /** Defaults to a fresh temp directory. */
  rootDir?: string;
  /** Default "tester". */
  username?: string;
  /** Default "hunter2". */
  password?: string;
  /** OpenSSH public key line accepted for auth (in addition to the generated key). */
  authorizedKey?: string;
  /** PEM/OpenSSH private key; generated when absent. */
  hostKey?: string;
  /** Force AUTH_FAILED. */
  rejectAuth?: boolean;
  /** Serve a *different* host key after the first successful authentication. */
  rotateHostKey?: boolean;
  /**
   * Commands the mock pretends not to have (`command not found`, exit 127) even though the
   * whitelist implements them. Used to exercise the SFTP fallbacks (`cp`/`mv`, `tar`, …).
   */
  missingCommands?: string[];
}

export interface MockSshServer {
  port: number;
  host: string;
  rootDir: string;
  username: string;
  password: string;
  /** Generated ed25519 private key on disk, for key-based auth. */
  privateKeyPath: string;
  /** Matching OpenSSH public key line. */
  publicKey: string;
  /** "SHA256:<base64, no padding>" — computed like OpenSSH does. */
  hostKeyFingerprint: string;
  connectionCount: number;
  openShells: number;
  close(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* helpers: keys                                                       */
/* ------------------------------------------------------------------ */

function parseKeyOrThrow(pem: string, what: string): any {
  const parsed = utils.parseKey(pem);
  if (parsed instanceof Error) throw new Error(`mock-sshd: cannot parse ${what}: ${parsed.message}`);
  return Array.isArray(parsed) ? parsed[0] : parsed;
}

/** OpenSSH-style fingerprint: SHA-256 of the raw public key blob, base64, unpadded. */
export function keyFingerprint(keyOrPem: string | any): string {
  const key = typeof keyOrPem === 'string' ? parseKeyOrThrow(keyOrPem, 'key') : keyOrPem;
  const blob: Buffer = key.getPublicSSH();
  return `SHA256:${crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '')}`;
}

/**
 * Generates an ed25519 key pair and makes sure ssh2 can parse both halves.
 * `utils.generateKeyPairSync` has been observed (rarely, under parallel test load)
 * to return an OpenSSH private key that `utils.parseKey` rejects, so retry.
 */
function generateUsableKeyPair(attempts = 6): { private: string; public: string; parsed: any } {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const pair = utils.generateKeyPairSync('ed25519');
    const parsedPrivate = utils.parseKey(pair.private);
    if (parsedPrivate instanceof Error) {
      lastError = parsedPrivate;
      continue;
    }
    const parsedPublic = utils.parseKey(pair.public);
    if (parsedPublic instanceof Error) {
      lastError = parsedPublic;
      continue;
    }
    const normalized = Array.isArray(parsedPrivate) ? parsedPrivate[0] : parsedPrivate;
    return { private: pair.private, public: pair.public, parsed: normalized };
  }
  throw new Error(`mock-sshd: could not generate a usable ed25519 key pair: ${lastError?.message ?? 'unknown error'}`);
}

/** Raw key material from a full SSH public key blob (drops the leading algorithm string). */
export function rawKeyFromBlob(blob: Buffer): Buffer {
  const algoLen = blob.readUInt32BE(0);
  return blob.subarray(4 + algoLen);
}

/* ------------------------------------------------------------------ */
/* helpers: virtual <-> real paths                                     */
/* ------------------------------------------------------------------ */

/** Normalises a client-supplied remote path to an absolute virtual path inside `/`. */
export function normalizeVirtual(input: string | undefined): string {
  let s = String(input ?? '').trim().replace(/\\/g, '/');
  if (s === '' || s === '~') s = '/';
  else if (s.startsWith('~/')) s = `/${s.slice(2)}`;
  if (!s.startsWith('/')) s = `/${s}`;
  s = path.posix.normalize(s);
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s === '' ? '/' : s;
}

function virtualToReal(rootDir: string, virtual: string): string {
  const clean = normalizeVirtual(virtual);
  if (clean === '/') return rootDir;
  return path.join(rootDir, ...clean.split('/').filter(Boolean));
}

function realToVirtual(rootDir: string, real: string): string {
  const rel = path.relative(rootDir, real);
  if (rel === '') return '/';
  return `/${rel.split(path.sep).join('/')}`;
}

function isInside(rootDir: string, real: string): boolean {
  const rel = path.relative(rootDir, real);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/* ------------------------------------------------------------------ */
/* helpers: attributes                                                 */
/* ------------------------------------------------------------------ */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function modeText(mode: number): string {
  const perms = mode & 0o7777;
  const type = (mode & 0o170000) === 0o040000 ? 'd' : (mode & 0o170000) === 0o120000 ? 'l' : '-';
  const chars = ['r', 'w', 'x'];
  let out = type;
  for (let bit = 8; bit >= 0; bit -= 1) {
    out += perms & (1 << bit) ? chars[(8 - bit) % 3]! : '-';
  }
  return out;
}

interface Attrs {
  mode: number;
  uid: number;
  gid: number;
  size: number;
  atime: number;
  mtime: number;
}

interface Deps {
  rootDir: string;
  modeOverlay: Map<string, number>;
  /** Virtual link path -> target exactly as the client requested it (POSIX form). */
  symlinkTargets: Map<string, string>;
  /** Commands answered with `command not found` even though the whitelist knows them. */
  missingCommands: Set<string>;
}

function typeBits(st: fs.Stats): number {
  if (st.isDirectory()) return 0o040000;
  if (st.isSymbolicLink()) return 0o120000;
  if (st.isFIFO()) return 0o010000;
  if (st.isSocket()) return 0o140000;
  if (st.isCharacterDevice()) return 0o020000;
  if (st.isBlockDevice()) return 0o060000;
  return 0o100000;
}

/** POSIX-ish effective mode: explicit SETSTAT mode wins, otherwise a sane default. */
function effectiveMode(deps: Deps, virtual: string, st: fs.Stats): number {
  const overlay = deps.modeOverlay.get(virtual);
  // The overlay only ever carries permission bits (SETSTAT cannot change the file type), so the
  // real type bits are kept: without them a chmod'ed directory would be reported as a file.
  if (overlay !== undefined) return typeBits(st) | overlay;
  if (st.isDirectory()) return 0o040000 | 0o755;
  if (st.isSymbolicLink()) return 0o120000 | 0o777;
  if (st.isFile()) {
    // Windows only models the read-only attribute; honour it so chmod 444 is real.
    const writable = (st.mode & 0o200) !== 0;
    return 0o100000 | (writable ? 0o644 : 0o444);
  }
  return typeBits(st) | 0o644;
}

function buildAttrs(deps: Deps, virtual: string, st: fs.Stats): Attrs {
  return {
    mode: effectiveMode(deps, virtual, st),
    uid: FIXTURE_UID,
    gid: FIXTURE_GID,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000),
  };
}

function longName(name: string, attrs: Attrs, linkTarget?: string): string {
  const d = new Date(attrs.mtime * 1000);
  const date = `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${String(
    d.getUTCHours(),
  ).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
  const size = String(attrs.size).padStart(8, ' ');
  const suffix = linkTarget !== undefined ? ` -> ${linkTarget}` : '';
  return `${modeText(attrs.mode)} 1 ${FIXTURE_USER} ${GROUP} ${size} ${date} ${name}${suffix}`;
}

interface NameEntry {
  filename: string;
  longname: string;
  attrs: Attrs;
}

/* ------------------------------------------------------------------ */
/* helpers: SFTP status mapping                                        */
/* ------------------------------------------------------------------ */

function statusFor(err: unknown): number {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case 'ENOENT':
      return STATUS_CODE.NO_SUCH_FILE;
    case 'EACCES':
    case 'EPERM':
      return STATUS_CODE.PERMISSION_DENIED;
    default:
      return STATUS_CODE.FAILURE;
  }
}

/* ------------------------------------------------------------------ */
/* shell / exec command runner (small whitelist)                       */
/* ------------------------------------------------------------------ */

interface CmdResult {
  stdout: string;
  stderr: string;
  code: number;
}

interface CmdCtx {
  deps: Deps;
  username: string;
  /**
   * Shell working directory, mutated by `cd` for the rest of a command line.
   * A real `ssh host 'cd /x && ls'` runs the whole line in one shell, so the mock
   * has to model that or every `cd … && …` invocation looks like a failure.
   */
  cwd?: string;
}

const VARS: Record<string, string> = {
  HOME: '/',
  PWD: '/',
  SHELL,
  HOSTNAME,
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
  TERM: 'xterm-256color',
};

/**
 * What `command -v` reports as installed. Only the tools the product actually asks about:
 * a mock that claims everything exists cannot exercise a host that is missing one.
 */
const KNOWN_TOOLS = new Set([
  'tar',
  'gzip',
  'zip',
  'unzip',
  'find',
  'du',
  'stat',
  'chmod',
  'cp',
  'mv',
  'rm',
  'mkdir',
  'sha256sum',
  'cat',
  'df',
  'free',
  'nproc',
  'uptime',
  'uname',
]);

function expandVars(text: string, ctx: CmdCtx): string {
  const table: Record<string, string> = {
    ...VARS,
    PWD: ctx.cwd ?? '/',
    USER: ctx.username,
    LOGNAME: ctx.username,
  };
  return text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, braced, plain) => {
    const name = String(braced ?? plain);
    return table[name] ?? '';
  });
}

/**
 * Resolves a path argument the way a shell does: absolute stays absolute,
 * `~` is the home directory, anything else is relative to the current `cd`.
 */
function resolveArg(ctx: CmdCtx, value: string | undefined, fallback: string): string {
  const raw = expandVars(value ?? fallback, ctx).trim();
  if (raw === '' ) return normalizeVirtual(ctx.cwd ?? '/');
  if (raw === '~') return '/';
  if (raw.startsWith('~/')) return normalizeVirtual(`/${raw.slice(2)}`);
  if (raw.startsWith('/')) return normalizeVirtual(raw);
  const cwd = ctx.cwd ?? '/';
  return normalizeVirtual(cwd === '/' ? `/${raw}` : `${cwd}/${raw}`);
}

/** Very small tokenizer: honours single/double quotes, keeps `$VAR` for later expansion. */
function tokenize(input: string): string[] {
  const out: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started || current) out.push(current);
      current = '';
      started = false;
      continue;
    }
    current += ch;
  }
  if (started || current) out.push(current);
  return out;
}

/** Splits on a top-level operator, ignoring operators inside quotes. */
function splitTop(input: string, op: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i += 1) {
    const ch = input[i]!;
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    if (input.startsWith(op, i)) {
      parts.push(current);
      current = '';
      i += op.length - 1;
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts;
}

/** Removes shell redirections (`2>/dev/null`, `>/dev/null`, `2>&1`, `&>file`). */
function stripRedirections(command: string): string {
  return command
    .replace(/\s*\d?>>?\s*&\s*\d+/gu, '')
    .replace(/\s*\d?>>?\s*\S+/gu, '')
    .trim();
}

function stripEnvAssignments(command: string): string {
  let s = command.trim();
  for (;;) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|\S*)\s+/u.exec(s);
    if (!m) break;
    s = s.slice(m[0].length);
  }
  return s;
}

/** Unwraps `sh -c '…'`, `/bin/sh -c "…"`, `bash -lc …`. */
function unwrapShell(command: string): string {
  const m = /^(?:\S*\/)?(?:sh|bash|dash|zsh)\s+(?:-[a-zA-Z]+\s+)*(-c|-lc)\s+(.*)$/su.exec(command.trim());
  if (!m) return command;
  const inner = m[2]!.trim();
  if ((inner.startsWith("'") && inner.endsWith("'")) || (inner.startsWith('"') && inner.endsWith('"'))) {
    return inner.slice(1, -1);
  }
  return inner;
}

function baseName(cmd: string): string {
  const parts = cmd.split('/');
  return parts[parts.length - 1] || cmd;
}

/**
 * Moves the explicitly set modes along with a copied/moved subtree.
 *
 * A real `cp -a` preserves modes; on Windows the underlying filesystem cannot represent them,
 * so the overlay is what carries them and it has to follow the paths.
 */
function migrateModeOverlay(deps: Deps, fromVirtual: string, toVirtual: string): void {
  const prefix = fromVirtual === '/' ? '/' : `${fromVirtual}/`;
  const pending: [string, number][] = [];
  for (const [virtual, mode] of deps.modeOverlay) {
    if (virtual === fromVirtual) pending.push([toVirtual, mode]);
    else if (virtual.startsWith(prefix)) pending.push([`${toVirtual}${virtual.slice(fromVirtual.length)}`, mode]);
  }
  for (const [virtual, mode] of pending) deps.modeOverlay.set(virtual, mode);
}

function walkSize(rootDir: string, real: string): number {
  let total = 0;
  const st = fs.lstatSync(real);
  if (st.isSymbolicLink()) return 0;
  if (st.isDirectory()) {
    for (const entry of fs.readdirSync(real, { withFileTypes: true })) {
      const child = path.join(real, entry.name);
      try {
        total += walkSize(rootDir, child);
      } catch {
        /* ignore unreadable children */
      }
    }
    return total;
  }
  void rootDir;
  return st.size;
}

function findMatches(deps: Deps, startVirtual: string, namePattern: string | null, type: string | null, maxDepth: number): string[] {
  const out: string[] = [];
  const globToRe = (glob: string) =>
    new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
  const re = namePattern ? globToRe(namePattern) : null;

  const visit = (virtual: string, depth: number): void => {
    const real = virtualToReal(deps.rootDir, virtual);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(real, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const childVirtual = virtual === '/' ? `/${entry.name}` : `${virtual}/${entry.name}`;
      const childReal = path.join(real, entry.name);
      let isDir = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          isDir = fs.statSync(childReal).isDirectory();
        } catch {
          isDir = false;
        }
      }
      const typeOk = type === null || (type === 'd' ? isDir : !isDir);
      if ((re === null || re.test(entry.name)) && typeOk) out.push(childVirtual);
      if (isDir && depth + 1 <= maxDepth) visit(childVirtual, depth + 1);
    }
  };
  visit(startVirtual === '/' ? '/' : normalizeVirtual(startVirtual), 0);
  return out;
}

/** A word starting with `#` starts a comment, exactly as POSIX shells have it. */function stripComment(command: string): string {
  let quote: string | null = null;
  let atWordStart = true;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] as string;
    if (quote !== null) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      atWordStart = false;
      continue;
    }
    if (char === '#' && atWordStart) return command.slice(0, index);
    atWordStart = char === ' ' || char === '\t';
  }
  return command;
}

function runSimple(ctx: CmdCtx, raw: string): CmdResult {
  // Comments are stripped before anything else: `echo ###X` prints nothing on a real host,
  // and a mock that echoed it would let a marker-delimited command pass here and fail there.
  const command = stripEnvAssignments(stripRedirections(stripComment(raw))).trim();
  if (command === '') return { stdout: '', stderr: '', code: 0 };

  const tokens = tokenize(command);
  const name = baseName(tokens[0] ?? '');
  const args = tokens.slice(1);

  // `missingCommands` lets a test pretend the binary is not installed, which is how the
  // SFTP fallbacks (contract §6) get exercised against a host that *does* have the tool.
  if (ctx.deps.missingCommands.has(name)) {
    return { stdout: '', stderr: `${name}: command not found\n`, code: 127 };
  }

  switch (name) {
    case 'true':
    case ':':
      return { stdout: '', stderr: '', code: 0 };

    case 'echo': {
      const text = args.join(' ');
      return { stdout: `${expandVars(text, ctx)}\n`, stderr: '', code: 0 };
    }

    // `printf '%s\n' x` is how the diagnostics probe reads a value without `echo`'s
    // option parsing; only the `%s\n` shape the probe actually uses is supported.
    case 'printf': {
      const format = args[0] ?? '';
      const values = args.slice(1);
      let text = format.replace(/\\n/g, '\n').replace(/\\t/g, '\t');
      let index = 0;
      text = text.replace(/%s/g, () => expandVars(values[index++] ?? '', ctx));
      return { stdout: text, stderr: '', code: 0 };
    }

    // `command -v <name>`: prints the path when the binary exists, nothing otherwise.
    case 'command': {
      const flagIndex = args.findIndex((arg) => arg === '-v' || arg === '-V');
      if (flagIndex === -1) return { stdout: '', stderr: '', code: 0 };
      let code = 0;
      const found: string[] = [];
      for (const candidate of args.slice(flagIndex + 1)) {
        const tool = baseName(candidate);
        if (ctx.deps.missingCommands.has(tool) || !KNOWN_TOOLS.has(tool)) {
          code = 1;
          continue;
        }
        found.push(`/usr/bin/${tool}`);
      }
      return { stdout: found.length > 0 ? `${found.join('\n')}\n` : '', stderr: '', code };
    }

    case 'head':
    case 'tail': {
      // File-only: the mock does not model pipelines, and no product command uses one.
      const countArg = args.find((arg) => /^-\d+$/.test(arg));
      const count = countArg ? Number.parseInt(countArg.slice(1), 10) : 10;
      const files = args.filter((arg) => !arg.startsWith('-'));
      let source = '';
      for (const file of files) {
        try {
          source += fs.readFileSync(virtualToReal(ctx.deps.rootDir, resolveArg(ctx, file)), 'utf8');
        } catch {
          return { stdout: '', stderr: `${name}: ${file}: No such file or directory\n`, code: 1 };
        }
      }
      const lines = source.split('\n');
      const selected = name === 'head' ? lines.slice(0, count) : lines.slice(Math.max(0, lines.length - count));
      return { stdout: selected.join('\n'), stderr: '', code: 0 };
    }

    case 'pwd':
      return { stdout: `${ctx.cwd ?? '/'}\n`, stderr: '', code: 0 };

    case 'cd': {
      const target = resolveArg(ctx, args.find((a) => !a.startsWith('-')), '~');
      const real = virtualToReal(ctx.deps.rootDir, target);
      let stats: fs.Stats;
      try {
        stats = fs.statSync(real);
      } catch {
        return { stdout: '', stderr: `cd: ${args[0] ?? ''}: No such file or directory\n`, code: 1 };
      }
      if (!stats.isDirectory()) {
        return { stdout: '', stderr: `cd: ${args[0] ?? ''}: Not a directory\n`, code: 1 };
      }
      ctx.cwd = target;
      return { stdout: '', stderr: '', code: 0 };
    }

    case 'whoami':
      return { stdout: `${ctx.username}\n`, stderr: '', code: 0 };

    case 'hostname':
      return { stdout: `${HOSTNAME}\n`, stderr: '', code: 0 };

    case 'id': {
      const flags = args.filter((a) => a.startsWith('-')).join('');
      if (flags.includes('u') && flags.includes('n')) return { stdout: `${ctx.username}\n`, stderr: '', code: 0 };
      if (flags.includes('g') && flags.includes('n')) return { stdout: `${GROUP}\n`, stderr: '', code: 0 };
      if (flags.includes('u')) return { stdout: '1000\n', stderr: '', code: 0 };
      if (flags.includes('g')) return { stdout: '1000\n', stderr: '', code: 0 };
      if (flags.includes('G')) return { stdout: '1000\n', stderr: '', code: 0 };
      return {
        stdout: `uid=1000(${ctx.username}) gid=1000(${GROUP}) groups=1000(${GROUP})\n`,
        stderr: '',
        code: 0,
      };
    }

    case 'uname': {
      const fields: Record<string, () => string> = {
        s: () => PLATFORM,
        n: () => HOSTNAME,
        r: () => KERNEL_RELEASE,
        v: () => '#1 SMP PREEMPT mock',
        m: () => ARCH,
        o: () => 'GNU/Linux',
      };
      const flags = args.join('');
      if (flags.includes('a')) {
        return {
          stdout: `${PLATFORM} ${HOSTNAME} ${KERNEL_RELEASE} #1 SMP PREEMPT mock ${ARCH} GNU/Linux\n`,
          stderr: '',
          code: 0,
        };
      }
      const letters = flags.replace(/^-/, '').split('').filter((c) => c in fields);
      if (letters.length === 0) return { stdout: `${PLATFORM}\n`, stderr: '', code: 0 };
      return { stdout: `${letters.map((c) => fields[c]!()).join(' ')}\n`, stderr: '', code: 0 };
    }

    case 'ls': {
      const targets = args.filter((a) => !a.startsWith('-'));
      const virtual = resolveArg(ctx, targets[0], '.');
      const real = virtualToReal(ctx.deps.rootDir, virtual);
      let dirents: fs.Dirent[];
      try {
        dirents = fs.readdirSync(real, { withFileTypes: true });
      } catch (err) {
        return { stdout: '', stderr: `ls: cannot access '${targets[0] ?? '/'}': No such file or directory\n`, code: 2 };
      }
      const long = args.some((a) => a.startsWith('-') && !a.startsWith('--') && a.includes('l'));
      const all = args.some((a) => a.startsWith('-') && !a.startsWith('--') && a.includes('a'));
      const names = dirents.map((d) => d.name).filter((n) => all || !n.startsWith('.')).sort();
      const lines = names.map((n) => {
        if (!long) return n;
        const childVirtual = virtual === '/' ? `/${n}` : `${virtual}/${n}`;
        const st = fs.lstatSync(path.join(real, n));
        return longName(n, buildAttrs(ctx.deps, childVirtual, st));
      });
      return { stdout: lines.length ? `${lines.join('\n')}\n` : '', stderr: '', code: 0 };
    }

    // --- system stats fixtures (contract §16) -----------------------------
    case 'uptime':
      return {
        stdout: ` ${SYS_STATS.uptimeClock} up ${SYS_STATS.uptimeSpan},  2 users,  load average: ${SYS_STATS.loadOne}, ${SYS_STATS.loadFive}, ${SYS_STATS.loadFifteen}\n`,
        stderr: '',
        code: 0,
      };

    case 'free': {
      // `free -b`: total used free shared buff/cache available
      return {
        stdout: [
          '               total        used        free      shared  buff/cache   available',
          `Mem:     ${SYS_STATS.memTotal}  ${SYS_STATS.memUsed}  ${SYS_STATS.memFree}           0  ${SYS_STATS.memBuffCache}  ${SYS_STATS.memAvailable}`,
          `Swap:    ${SYS_STATS.swapTotal}  ${SYS_STATS.swapUsed}  ${SYS_STATS.swapTotal - SYS_STATS.swapUsed}`,
          '',
        ].join('\n'),
        stderr: '',
        code: 0,
      };
    }

    case 'nproc':
      return { stdout: `${SYS_STATS.cpuCount}\n`, stderr: '', code: 0 };

    case 'df': {
      const rows = SYS_STATS.disks.map((disk) => {
        const capacity = disk.blocks === 0 ? 0 : Math.round((disk.used / disk.blocks) * 100);
        return `${disk.filesystem.padEnd(16)}${String(disk.blocks).padStart(11)}${String(disk.used).padStart(11)}${String(disk.available).padStart(11)}${String(capacity).padStart(8)}% ${disk.mount}`;
      });
      return {
        stdout: `Filesystem       1024-blocks       Used  Available Capacity Mounted on\n${rows.join('\n')}\n`,
        stderr: '',
        code: 0,
      };
    }

    case 'cat': {
      const targets = args.filter((a) => !a.startsWith('-'));
      const requested = targets[0] ?? '';
      // The mock is not a Linux kernel: `/proc/loadavg` is synthesised so the stats route has
      // something real to parse. Every other file is read from the fixture root.
      if (normalizeVirtual(requested) === '/proc/loadavg') {
        return {
          stdout: `${SYS_STATS.loadOne} ${SYS_STATS.loadFive} ${SYS_STATS.loadFifteen} 1/234 5678\n`,
          stderr: '',
          code: 0,
        };
      }
      try {
        const real = virtualToReal(ctx.deps.rootDir, resolveArg(ctx, requested, '.'));
        if (!fs.statSync(real).isFile()) throw new Error('not a file');
        return { stdout: fs.readFileSync(real, 'utf8'), stderr: '', code: 0 };
      } catch {
        return { stdout: '', stderr: `cat: ${requested}: No such file or directory\n`, code: 1 };
      }
    }

    case 'du': {
      const paths = args.filter((a) => !a.startsWith('-'));
      const human = args.some((a) => a.startsWith('-') && !a.startsWith('--') && a.includes('h'));
      const list = paths.length ? paths : ['.'];
      let stdout = '';
      for (const p of list) {
        const virtual = resolveArg(ctx, p, '.');
        const real = virtualToReal(ctx.deps.rootDir, virtual);
        let bytes: number;
        try {
          bytes = walkSize(ctx.deps.rootDir, real);
        } catch {
          return { stdout, stderr: `du: cannot access '${p}': No such file or directory\n`, code: 1 };
        }
        stdout += human ? `${Math.max(1, Math.ceil(bytes / 1024))}K\t${virtual}\n` : `${Math.ceil(bytes / 1024)}\t${virtual}\n`;
      }
      return { stdout, stderr: '', code: 0 };
    }

    // `cp -a` / `mv` — what `fs/copy` and `fs/move` try first (contract §6). The real
    // filesystem does the work, so modes, symlinks and recursion behave like the real tools.
    case 'cp':
    case 'mv': {
      const operands = args.filter((a) => a !== '--' && !a.startsWith('-'));
      if (operands.length < 2) {
        return { stdout: '', stderr: `${name}: missing file operand\n`, code: 1 };
      }
      const sources = operands.slice(0, -1);
      const destination = operands[operands.length - 1] as string;
      const destVirtual = resolveArg(ctx, destination, '.');
      const destReal = virtualToReal(ctx.deps.rootDir, destVirtual);
      let destIsDirectory = false;
      try {
        destIsDirectory = fs.statSync(destReal).isDirectory();
      } catch {
        destIsDirectory = false;
      }

      for (const source of sources) {
        const srcVirtual = resolveArg(ctx, source, '.');
        const srcReal = virtualToReal(ctx.deps.rootDir, srcVirtual);
        // lstat, so a symlink is moved/copied as a symlink even when its target is missing.
        let exists = true;
        try {
          fs.lstatSync(srcReal);
        } catch {
          exists = false;
        }
        if (!exists) {
          return { stdout: '', stderr: `${name}: cannot stat '${source}': No such file or directory\n`, code: 1 };
        }
        const target =
          destIsDirectory || sources.length > 1
            ? path.join(destReal, path.posix.basename(srcVirtual))
            : destReal;
        try {
          if (name === 'mv') {
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.renameSync(srcReal, target);
          } else {
            fs.cpSync(srcReal, target, {
              recursive: true,
              force: true,
              preserveTimestamps: true,
              // Symlinks are recreated as symlinks, never followed — exactly `cp -a`.
              verbatimSymlinks: true,
              dereference: false,
            });
          }
          // Modes set through SETSTAT live in the overlay; they follow the entry (like `-a`).
          const targetVirtual =
            destIsDirectory || sources.length > 1
              ? destVirtual === '/'
                ? `/${path.posix.basename(srcVirtual)}`
                : `${destVirtual}/${path.posix.basename(srcVirtual)}`
              : destVirtual;
          migrateModeOverlay(ctx.deps, srcVirtual, targetVirtual);
          if (name === 'mv') {
            // The old path no longer exists: drop its overlay entries.
            for (const key of [...ctx.deps.modeOverlay.keys()]) {
              if (key === srcVirtual || key.startsWith(`${srcVirtual}/`)) ctx.deps.modeOverlay.delete(key);
            }
          }
        } catch (err) {
          return {
            stdout: '',
            stderr: `${name}: cannot ${name === 'mv' ? 'move' : 'copy'} '${source}': ${(err as Error).message}\n`,
            code: 1,
          };
        }
      }
      return { stdout: '', stderr: '', code: 0 };
    }

    case 'find': {
      let idx = 0;
      let root = '.';
      if (args[0] && !args[0].startsWith('-')) {
        root = args[0];
        idx = 1;
      }
      let namePattern: string | null = null;
      let type: string | null = null;
      let maxDepth = 64;
      for (; idx < args.length; idx += 1) {
        const a = args[idx]!;
        if (a === '-name' || a === '-iname') namePattern = args[(idx += 1)] ?? null;
        else if (a === '-type') type = args[(idx += 1)] ?? null;
        else if (a === '-maxdepth') maxDepth = Number(args[(idx += 1)] ?? '64') || 64;
      }
      const matches = findMatches(ctx.deps, resolveArg(ctx, root, '.'), namePattern, type, maxDepth);
      return { stdout: matches.length ? `${matches.join('\n')}\n` : '', stderr: '', code: 0 };
    }

    default:
      return { stdout: '', stderr: `${name}: command not found\n`, code: 127 };
  }
}

/** Runs a (tiny) shell command line against the whitelist above. */
export function runCommand(ctx: CmdCtx, rawCommand: string): CmdResult {
  // One shell per invocation: `cd` persists across `&&`/`;` within the line and
  // is forgotten afterwards, exactly like `ssh host '…'`.
  const shell: CmdCtx = { deps: ctx.deps, username: ctx.username, cwd: ctx.cwd ?? '/' };
  const command = unwrapShell(String(rawCommand ?? ''));
  const segments = splitTop(command, ';');
  let stdout = '';
  let stderr = '';
  let code = 0;
  for (const segment of segments) {
    const orParts = splitTop(segment, '||');
    let result: CmdResult = { stdout: '', stderr: '', code: 0 };
    let done = false;
    for (const orPart of orParts) {
      const andParts = splitTop(orPart, '&&');
      result = { stdout: '', stderr: '', code: 0 };
      for (const andPart of andParts) {
        result = runSimple(shell, andPart);
        if (result.code !== 0) break;
      }
      if (result.code === 0) {
        done = true;
        break;
      }
    }
    void done;
    stdout += result.stdout;
    stderr += result.stderr;
    code = result.code;
  }
  return { stdout, stderr, code };
}

/* ------------------------------------------------------------------ */
/* the server                                                          */
/* ------------------------------------------------------------------ */

export async function startMockSshServer(options: MockSshServerOptions = {}): Promise<MockSshServer> {
  const username = options.username ?? FIXTURE_USER;
  const password = options.password ?? 'hunter2';
  const rejectAuth = options.rejectAuth ?? false;
  const rotateHostKey = options.rotateHostKey ?? false;

  // --- root directory + fixture tree -------------------------------------
  const ownsRootDir = options.rootDir === undefined;
  const rootDir = options.rootDir ?? (await fsp.mkdtemp(path.join(os.tmpdir(), 'ssh-explorer-mock-')));
  await fsp.mkdir(rootDir, { recursive: true });
  const fixture: FixtureTree = createFixtureTree(rootDir);

  // --- keys ---------------------------------------------------------------
  const hostKeyPair = generateUsableKeyPair();
  const hostKey1 = options.hostKey ?? hostKeyPair.private;
  const hostKeyFingerprint = options.hostKey ? keyFingerprint(hostKey1) : keyFingerprint(hostKeyPair.parsed);

  const clientKeyPair = generateUsableKeyPair();
  const keysDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ssh-explorer-mock-keys-'));
  const privateKeyPath = path.join(keysDir, 'id_ed25519');
  await fsp.writeFile(privateKeyPath, clientKeyPair.private, { mode: 0o600 });
  await fsp.writeFile(`${privateKeyPath}.pub`, clientKeyPair.public, { mode: 0o644 });
  const publicKey = clientKeyPair.public.trim();

  const acceptedKeys: any[] = [clientKeyPair.parsed];
  if (options.authorizedKey) acceptedKeys.push(parseKeyOrThrow(options.authorizedKey, 'authorizedKey'));

  // --- state --------------------------------------------------------------
  const deps: Deps = {
    rootDir,
    modeOverlay: new Map(),
    symlinkTargets: new Map(),
    missingCommands: new Set(options.missingCommands ?? []),
  };
  const liveClients = new Set<any>();
  const liveSockets = new Set<net.Socket>();
  let connections = 0;
  let openShells = 0;
  let closed = false;
  let rotated = false;

  const keyForRotation = rotateHostKey ? generateUsableKeyPair().private : null;

  function verifySignature(key: any, algo: string, hashAlgo: string | undefined, blob: Buffer, signature: Buffer): boolean {
    try {
      const pem: string | null = key.getPublicPEM();
      if (!pem) return false;
      if (algo === 'ssh-ed25519' || algo.startsWith('sk-ssh-ed25519')) {
        return crypto.verify(null, blob, pem, signature);
      }
      const hash = hashAlgo ?? (algo === 'ssh-rsa' ? 'sha1' : 'sha256');
      const verifier = crypto.createVerify(hash);
      verifier.update(blob);
      return verifier.verify(pem, signature);
    } catch (err) {
      debug('signature verification failed', err);
      return false;
    }
  }

  function handleAuthentication(ctx: any): void {
    const methods = ['password', 'publickey'];
    if (rejectAuth) return ctx.reject(methods);
    if (ctx.username !== username) return ctx.reject(methods);

    if (ctx.method === 'password') {
      if (typeof ctx.password === 'string' && crypto.timingSafeEqual(
        crypto.createHash('sha256').update(ctx.password).digest(),
        crypto.createHash('sha256').update(password).digest(),
      )) {
        return ctx.accept();
      }
      return ctx.reject(methods);
    }

    if (ctx.method === 'publickey') {
      // `ctx.key.data` is the *full* SSH public key blob (algorithm + key material),
      // which is exactly what `Key#getPublicSSH()` returns.
      const presented: Buffer = ctx.key.data;
      const match = acceptedKeys.find((candidate) => {
        const blob: Buffer = candidate.getPublicSSH();
        return candidate.type === ctx.key.algo && blob.length === presented.length && crypto.timingSafeEqual(blob, presented);
      });
      if (!match) return ctx.reject(methods);
      if (ctx.signature) {
        // ssh2's server-side PK context exposes `key.algo` + `hashAlgo` (not `sigAlgo`).
        return verifySignature(match, ctx.key.algo, ctx.hashAlgo, ctx.blob, ctx.signature)
          ? ctx.accept()
          : ctx.reject(methods);
      }
      // No signature yet: tell the client the key is acceptable (publickey OK).
      return ctx.accept();
    }

    return ctx.reject(methods);
  }

  /* ---------------- SFTP subsystem ---------------- */

  function attachSftp(sftp: any): void {
    const openFiles = new Map<string, { fd: number; virtual: string }>();
    const openDirs = new Map<string, { entries: NameEntry[]; sent: boolean }>();
    let nextHandle = 1;

    const newHandle = (): Buffer => {
      const buf = Buffer.alloc(4);
      buf.writeUInt32BE(nextHandle++);
      return buf;
    };
    const key = (handle: Buffer): string => handle.toString('hex');

    const statEntry = (virtual: string): NameEntry => {
      const real = virtualToReal(rootDir, virtual);
      const st = fs.lstatSync(real);
      const attrs = buildAttrs(deps, virtual, st);
      let target: string | undefined;
      if (st.isSymbolicLink()) {
        try {
          // Prefer the target as requested by the client; Windows rewrites link
          // targets (drive letters, backslashes) and SFTP speaks POSIX.
          target = deps.symlinkTargets.get(virtual) ?? fs.readlinkSync(real).replace(/\\/g, '/');
        } catch {
          target = deps.symlinkTargets.get(virtual);
        }
      }
      return {
        filename: path.posix.basename(virtual) || virtual,
        longname: longName(path.posix.basename(virtual) || virtual, attrs, target),
        attrs,
      };
    };

    function readDirEntries(virtual: string): NameEntry[] {
      const real = virtualToReal(rootDir, virtual);
      const dirents = fs.readdirSync(real, { withFileTypes: true });
      const self = fs.statSync(real);
      const entries: NameEntry[] = [];
      const selfAttrs = buildAttrs(deps, virtual, self);
      entries.push({ filename: '.', longname: longName('.', selfAttrs), attrs: selfAttrs });
      const parentVirtual = virtual === '/' ? '/' : path.posix.dirname(virtual);
      const parentReal = virtualToReal(rootDir, parentVirtual);
      let parentStats: fs.Stats;
      try {
        parentStats = fs.statSync(parentReal);
      } catch {
        parentStats = self;
      }
      const parentAttrs = buildAttrs(deps, parentVirtual, parentStats);
      entries.push({ filename: '..', longname: longName('..', parentAttrs), attrs: parentAttrs });

      for (const dirent of dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        const childVirtual = virtual === '/' ? `/${dirent.name}` : `${virtual}/${dirent.name}`;
        try {
          entries.push(statEntry(childVirtual));
        } catch {
          /* skip entries that vanish mid-listing */
        }
      }
      return entries;
    }

    sftp.on('REALPATH', (reqid: number, requested: string) => {
      const virtual = normalizeVirtual(requested);
      const real = virtualToReal(rootDir, virtual);
      let resolved = virtual;
      try {
        const canonical = fs.realpathSync(real);
        if (isInside(rootDir, canonical)) resolved = realToVirtual(rootDir, canonical);
      } catch {
        /* non-existent paths are canonicalised lexically, like a forgiving server */
      }
      debug('REALPATH', requested, '->', resolved);
      const attrs = (() => {
        try {
          return buildAttrs(deps, resolved, fs.statSync(virtualToReal(rootDir, resolved)));
        } catch {
          return { mode: 0o040755, uid: FIXTURE_UID, gid: FIXTURE_GID, size: 0, atime: 0, mtime: 0 };
        }
      })();
      sftp.name(reqid, [{ filename: resolved, longname: resolved, attrs }]);
    });

    sftp.on('STAT', (reqid: number, requested: string) => {
      const virtual = normalizeVirtual(requested);
      try {
        const st = fs.statSync(virtualToReal(rootDir, virtual));
        sftp.attrs(reqid, buildAttrs(deps, virtual, st));
      } catch (err) {
        sftp.status(reqid, statusFor(err));
      }
    });

    sftp.on('LSTAT', (reqid: number, requested: string) => {
      const virtual = normalizeVirtual(requested);
      try {
        const st = fs.lstatSync(virtualToReal(rootDir, virtual));
        sftp.attrs(reqid, buildAttrs(deps, virtual, st));
      } catch (err) {
        sftp.status(reqid, statusFor(err));
      }
    });

    sftp.on('FSTAT', (reqid: number, handle: Buffer) => {
      const file = openFiles.get(key(handle));
      if (!file) return sftp.status(reqid, STATUS_CODE.FAILURE);
      try {
        const st = fs.fstatSync(file.fd);
        sftp.attrs(reqid, buildAttrs(deps, file.virtual, st));
      } catch (err) {
        sftp.status(reqid, statusFor(err));
      }
    });

    sftp.on('OPEN', (reqid: number, requested: string, flags: number) => {
      const virtual = normalizeVirtual(requested);
      const real = virtualToReal(rootDir, virtual);
      const canRead = (flags & OPEN_MODE.READ) !== 0;
      const canWrite = (flags & OPEN_MODE.WRITE) !== 0;
      const creat = (flags & OPEN_MODE.CREAT) !== 0;
      const trunc = (flags & OPEN_MODE.TRUNC) !== 0;
      const excl = (flags & OPEN_MODE.EXCL) !== 0;
      const append = (flags & OPEN_MODE.APPEND) !== 0;

      let nodeFlags: string;
      if (append) nodeFlags = canRead ? 'a+' : 'a';
      else if (canWrite && trunc) nodeFlags = canRead ? 'w+' : 'w';
      else if (canWrite && creat) nodeFlags = canRead ? 'a+' : 'a';
      else if (canWrite) nodeFlags = 'r+';
      else nodeFlags = 'r';
      if (excl) nodeFlags += 'x';

      try {
        const fd = fs.openSync(real, nodeFlags);
        const handle = newHandle();
        openFiles.set(key(handle), { fd, virtual });
        debug('OPEN', virtual, nodeFlags);
        sftp.handle(reqid, handle);
      } catch (err) {
        debug('OPEN failed', virtual, nodeFlags, (err as Error).message);
        sftp.status(reqid, statusFor(err));
      }
    });

    sftp.on('READ', (reqid: number, handle: Buffer, offset: number, len: number) => {
      const file = openFiles.get(key(handle));
      if (!file) return sftp.status(reqid, STATUS_CODE.FAILURE);
      const size = Math.max(0, Math.min(len, 1024 * 1024));
      const buf = Buffer.allocUnsafe(size);
      fs.read(file.fd, buf, 0, size, offset, (err, bytesRead) => {
        if (err) return sftp.status(reqid, statusFor(err));
        if (!bytesRead) return sftp.status(reqid, STATUS_CODE.EOF);
        return sftp.data(reqid, buf.subarray(0, bytesRead));
      });
    });

    sftp.on('WRITE', (reqid: number, handle: Buffer, offset: number, data: Buffer) => {
      const file = openFiles.get(key(handle));
      if (!file) return sftp.status(reqid, STATUS_CODE.FAILURE);
      fs.write(file.fd, data, 0, data.length, offset, (err) => {
        if (err) return sftp.status(reqid, statusFor(err));
        return sftp.status(reqid, STATUS_CODE.OK);
      });
    });

    sftp.on('CLOSE', (reqid: number, handle: Buffer) => {
      const handleKey = key(handle);
      const file = openFiles.get(handleKey);
      if (file) {
        openFiles.delete(handleKey);
        return fs.close(file.fd, (err) => sftp.status(reqid, err ? statusFor(err) : STATUS_CODE.OK));
      }
      // Directory handles are closed through the same CLOSE request.
      if (openDirs.has(handleKey)) {
        openDirs.delete(handleKey);
        return sftp.status(reqid, STATUS_CODE.OK);
      }
      return sftp.status(reqid, STATUS_CODE.FAILURE);
    });

    sftp.on('OPENDIR', (reqid: number, requested: string) => {
      const virtual = normalizeVirtual(requested);
      try {
        const entries = readDirEntries(virtual);
        const handle = newHandle();
        openDirs.set(key(handle), { entries, sent: false });
        debug('OPENDIR', virtual, `${entries.length} entries`);
        sftp.handle(reqid, handle);
      } catch (err) {
        debug('OPENDIR failed', virtual, (err as Error).message);
        sftp.status(reqid, statusFor(err));
      }
    });

    sftp.on('READDIR', (reqid: number, handle: Buffer) => {
      const dir = openDirs.get(key(handle));
      if (!dir) return sftp.status(reqid, STATUS_CODE.FAILURE);
      if (dir.sent) return sftp.status(reqid, STATUS_CODE.EOF);
      dir.sent = true;
      return sftp.name(reqid, dir.entries);
    });

    sftp.on('MKDIR', (reqid: number, requested: string) => {
      const virtual = normalizeVirtual(requested);
      try {
        fs.mkdirSync(virtualToReal(rootDir, virtual));
        sftp.status(reqid, STATUS_CODE.OK);
      } catch (err) {
        sftp.status(reqid, statusFor(err));
      }
    });

    sftp.on('RMDIR', (reqid: number, requested: string) => {
      const virtual = normalizeVirtual(requested);
      try {
        fs.rmdirSync(virtualToReal(rootDir, virtual));
        deps.modeOverlay.delete(virtual);
        sftp.status(reqid, STATUS_CODE.OK);
      } catch (err) {
        sftp.status(reqid, statusFor(err));
      }
    });

    sftp.on('REMOVE', (reqid: number, requested: string) => {
      const virtual = normalizeVirtual(requested);
      try {
        fs.unlinkSync(virtualToReal(rootDir, virtual));
        deps.modeOverlay.delete(virtual);
        sftp.status(reqid, STATUS_CODE.OK);
      } catch (err) {
        sftp.status(reqid, statusFor(err));
      }
    });

    sftp.on('RENAME', (reqid: number, oldRequested: string, newRequested: string) => {
      const from = normalizeVirtual(oldRequested);
      const to = normalizeVirtual(newRequested);
      try {
        const fromReal = virtualToReal(rootDir, from);
        const toReal = virtualToReal(rootDir, to);
        if (fs.existsSync(toReal)) {
          const st = fs.lstatSync(toReal);
          if (st.isDirectory()) fs.rmdirSync(toReal);
          else fs.unlinkSync(toReal);
        }
        fs.renameSync(fromReal, toReal);
        const overlay = deps.modeOverlay.get(from);
        if (overlay !== undefined) {
          deps.modeOverlay.delete(from);
          deps.modeOverlay.set(to, overlay);
        }
        sftp.status(reqid, STATUS_CODE.OK);
      } catch (err) {
        sftp.status(reqid, statusFor(err));
      }
    });

    sftp.on('SETSTAT', (reqid: number, requested: string, attrs: any) => {
      const virtual = normalizeVirtual(requested);
      const real = virtualToReal(rootDir, virtual);
      try {
        if (typeof attrs?.mode === 'number') {
          deps.modeOverlay.set(virtual, attrs.mode & 0o7777);
          try {
            fs.chmodSync(real, attrs.mode & 0o7777);
          } catch {
            /* Windows models only the read-only bit — the overlay keeps the semantics */
          }
        }
        if (typeof attrs?.size === 'number') fs.truncateSync(real, attrs.size);
        const toDate = (value: number): Date => new Date(value < 1e12 ? value * 1000 : value);
        if (typeof attrs?.atime === 'number' && typeof attrs?.mtime === 'number') {
          fs.utimesSync(real, toDate(attrs.atime), toDate(attrs.mtime));
        } else if (typeof attrs?.mtime === 'number') {
          fs.utimesSync(real, new Date(), toDate(attrs.mtime));
        }
        sftp.status(reqid, STATUS_CODE.OK);
      } catch (err) {
        sftp.status(reqid, statusFor(err));
      }
    });

    sftp.on('READLINK', (reqid: number, requested: string) => {
      const virtual = normalizeVirtual(requested);
      try {
        const target = deps.symlinkTargets.get(virtual) ?? fs.readlinkSync(virtualToReal(rootDir, virtual)).replace(/\\/g, '/');
        sftp.name(reqid, [{ filename: target, longname: target, attrs: {} as Attrs }]);
      } catch (err) {
        sftp.status(reqid, statusFor(err));
      }
    });

    sftp.on('SYMLINK', (reqid: number, arg1: string, arg2: string) => {
      // OpenSSH's own sftp client swaps the two path arguments (see ssh2's SFTP.js).
      const opensshOrder = !!(sftp as any)._isOpenSSH;
      const linkPath = normalizeVirtual(opensshOrder ? arg2 : arg1);
      const requestedTarget = opensshOrder ? arg1 : arg2;
      const realLink = virtualToReal(rootDir, linkPath);
      // Absolute POSIX targets must be translated for the host filesystem, but the
      // client must always see the POSIX target it asked for.
      const realTarget = requestedTarget.startsWith('/')
        ? virtualToReal(rootDir, normalizeVirtual(requestedTarget))
        : requestedTarget;
      try {
        fs.symlinkSync(realTarget, realLink);
        deps.symlinkTargets.set(linkPath, requestedTarget);
        sftp.status(reqid, STATUS_CODE.OK);
      } catch (err) {
        sftp.status(reqid, statusFor(err));
      }
    });

    sftp.on('EXTENDED', (reqid: number, extName: string, extData: Buffer) => {
      if (extName === 'fsync@openssh.com') {
        const len = extData.readUInt32BE(0);
        const handleKey = extData.subarray(4, 4 + len).toString('hex');
        const file = openFiles.get(handleKey);
        if (!file) return sftp.status(reqid, STATUS_CODE.FAILURE);
        return fs.fsync(file.fd, (err) => sftp.status(reqid, err ? statusFor(err) : STATUS_CODE.OK));
      }
      if (extName === 'posix-rename@openssh.com') {
        const len1 = extData.readUInt32BE(0);
        const oldPath = extData.subarray(4, 4 + len1).toString('utf8');
        const off = 4 + len1;
        const len2 = extData.readUInt32BE(off);
        const newPath = extData.subarray(off + 4, off + 4 + len2).toString('utf8');
        try {
          fs.renameSync(virtualToReal(rootDir, normalizeVirtual(oldPath)), virtualToReal(rootDir, normalizeVirtual(newPath)));
          return sftp.status(reqid, STATUS_CODE.OK);
        } catch (err) {
          return sftp.status(reqid, statusFor(err));
        }
      }
      debug('EXTENDED unsupported:', extName);
      return sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED);
    });
  }

  /* ---------------- session handling ---------------- */

  const cmdCtx: CmdCtx = { deps, username };

  function handleSession(session: any): void {
    let ptyInfo: { term?: string; rows?: number; cols?: number } = {};

    session.on('pty', (accept: any) => {
      if (typeof accept === 'function') accept();
    });
    session.on('window-change', (accept: any, _reject: any, info: any) => {
      ptyInfo = { ...ptyInfo, rows: info?.rows, cols: info?.cols };
      if (typeof accept === 'function') accept();
    });
    session.on('signal', (accept: any) => {
      if (typeof accept === 'function') accept();
    });
    session.on('env', (accept: any) => {
      if (typeof accept === 'function') accept();
    });

    session.on('sftp', (accept: any) => {
      const sftpStream = accept();
      sftpStream.on('error', (err: Error) => debug('sftp stream error', err.message));
      attachSftp(sftpStream);
    });

    session.on('exec', (accept: any, _reject: any, info: any) => {
      const stream = accept();
      const result = runCommand(cmdCtx, info?.command ?? '');
      debug('exec', JSON.stringify(info?.command), '->', result.code);
      stream.on('error', () => {});
      if (result.stdout) stream.write(result.stdout);
      if (result.stderr) stream.stderr.write(result.stderr);
      stream.exit(result.code);
      stream.end();
    });

    session.on('shell', (accept: any) => {
      const stream = accept();
      openShells += 1;
      let pending = '';
      let finished = false;
      let cols = ptyInfo.cols ?? 80;
      let rows = ptyInfo.rows ?? 24;
      const prompt = `${username}@${HOSTNAME}:${cols}x${rows}$ `;

      const finish = (): void => {
        if (finished) return;
        finished = true;
        openShells -= 1;
      };

      stream.on('error', () => finish());
      stream.on('close', () => finish());
      // The client closed stdin: a real shell exits and the channel is torn down.
      stream.on('end', () => {
        if (finished) return;
        try {
          stream.exit(0);
        } catch {
          /* channel may already be gone */
        }
        stream.end();
        finish();
      });

      stream.write(`${prompt}`);
      debug('shell opened');

      const handleLine = (line: string): void => {
        const trimmed = line.trim();
        if (trimmed === '') {
          stream.write(prompt);
          return;
        }
        if (trimmed === 'exit' || trimmed.startsWith('exit ')) {
          const code = Number(trimmed.split(/\s+/)[1] ?? '0') || 0;
          stream.write('logout\r\n');
          stream.exit(code);
          stream.end();
          finish();
          return;
        }
        const result = runCommand(cmdCtx, trimmed);
        const text = (result.stdout + result.stderr).replace(/\r?\n/g, '\r\n');
        stream.write(text);
        stream.write(prompt);
      };

      stream.on('data', (chunk: Buffer) => {
        pending += chunk.toString('utf8');
        for (;;) {
          let index = pending.search(/[\r\n]/);
          if (index === -1) break;
          const line = pending.slice(0, index);
          // swallow a paired \r\n as one terminator
          if (pending[index] === '\r' && pending[index + 1] === '\n') pending = pending.slice(index + 2);
          else pending = pending.slice(index + 1);
          handleLine(line);
          if (finished) return;
        }
        // Ctrl-C resets the pending line, like a real shell
        if (pending.includes('\u0003')) {
          pending = '';
          stream.write('^C\r\n');
          stream.write(prompt);
        }
      });
    });

    session.on('subsystem', (accept: any, reject: any, info: any) => {
      if (info?.name === 'sftp') {
        const sftpStream = accept();
        sftpStream.on('error', (err: Error) => debug('sftp stream error', err.message));
        attachSftp(sftpStream);
      } else {
        reject?.();
      }
    });
  }

  /* ---------------- host-key rotation ---------------- */

  function buildSshServer(privateKey: string): any {
    const server = new SshServer({ hostKeys: [privateKey] }, (client: any) => {
      liveClients.add(client);
      client.on('error', (err: Error) => debug('client error', err.message));
      client.on('close', () => liveClients.delete(client));
      client.on('authentication', handleAuthentication);
      client.on('ready', () => {
        debug('client authenticated');
        if (rotateHostKey && keyForRotation && !rotated) {
          rotated = true;
          secondServer = buildSshServer(keyForRotation);
          debug('host key rotated for subsequent connections');
        }
      });
      client.on('session', (accept: any) => handleSession(accept()));
    });
    return server;
  }

  let secondServer: any = null;
  const primary = buildSshServer(hostKey1);

  const acceptor = net.createServer((socket) => {
    connections += 1;
    liveSockets.add(socket);
    socket.on('close', () => {
      liveSockets.delete(socket);
      connections -= 1;
    });
    socket.on('error', () => {});
    const target = rotated && secondServer ? secondServer : primary;
    try {
      target.injectSocket(socket);
    } catch (err) {
      debug('injectSocket failed', err);
      socket.destroy();
    }
  });
  acceptor.on('error', (err) => debug('accept error', err.message));

  await new Promise<void>((resolve, reject) => {
    acceptor.once('error', reject);
    acceptor.listen(0, HOST, () => resolve());
  });
  const address = acceptor.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  debug('listening on', HOST, port, 'root', rootDir, 'fingerprint', hostKeyFingerprint);

  return {
    port,
    host: HOST,
    rootDir,
    username,
    password,
    privateKeyPath,
    publicKey,
    hostKeyFingerprint,
    get connectionCount(): number {
      return Math.max(0, connections);
    },
    get openShells(): number {
      return Math.max(0, openShells);
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;

      // Graceful first: a real sshd sends SSH_MSG_DISCONNECT and closes the socket,
      // so clients observe a clean close instead of a TCP reset.
      for (const client of liveClients) {
        try {
          client.end();
        } catch {
          /* ignore */
        }
      }
      for (let i = 0; i < 40 && liveClients.size > 0; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      for (const socket of liveSockets) {
        try {
          socket.destroy();
        } catch {
          /* ignore */
        }
      }
      liveSockets.clear();
      liveClients.clear();

      await new Promise<void>((resolve) => {
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          resolve();
        };
        const timer = setTimeout(finish, 2000);
        timer.unref?.();
        try {
          acceptor.close(() => {
            clearTimeout(timer);
            finish();
          });
        } catch {
          clearTimeout(timer);
          finish();
        }
      });

      connections = 0;
      openShells = 0;

      if (ownsRootDir) {
        await fsp.rm(rootDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      }
      await fsp.rm(keysDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
      void fixture;
    },
  };
}

export default startMockSshServer;
