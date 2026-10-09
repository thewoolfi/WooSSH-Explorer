import { createServer } from './server.js';
import type { LogLevel } from './types.js';

/**
 * Thin CLI wrapper around {@link createServer} (contract §12: the programmatic entry point is
 * `server.ts`; this file only wires it to a terminal).
 */
const LEVELS: ReadonlySet<string> = new Set(['silent', 'error', 'warn', 'info', 'debug']);

function parseArgs(argv: readonly string[]): {
  port?: number;
  host?: string;
  stateDir?: string;
  downloadDir?: string;
  staticDir?: string | null;
  logLevel?: LogLevel;
  token?: string | null;
  help: boolean;
} {
  const out: ReturnType<typeof parseArgs> = { help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    const [flag, inlineValue] = arg.includes('=') ? (arg.split(/=(.*)/s, 2) as [string, string]) : [arg, undefined];
    const next = (): string | undefined => inlineValue ?? argv[++index];
    switch (flag) {
      case '--port':
      case '-p': {
        const value = next();
        if (value !== undefined) out.port = Number.parseInt(value, 10);
        break;
      }
      case '--host': {
        const value = next();
        if (value !== undefined) out.host = value;
        break;
      }
      case '--state-dir': {
        const value = next();
        if (value !== undefined) out.stateDir = value;
        break;
      }
      case '--download-dir': {
        const value = next();
        if (value !== undefined) out.downloadDir = value;
        break;
      }
      case '--static': {
        const value = next();
        if (value !== undefined) out.staticDir = value;
        break;
      }
      case '--no-static':
        out.staticDir = null;
        break;
      case '--log-level': {
        const value = next();
        if (value !== undefined && LEVELS.has(value)) out.logLevel = value as LogLevel;
        break;
      }
      case '--token': {
        const value = next();
        if (value !== undefined) out.token = value;
        break;
      }
      case '--no-token':
        // §10: only for a throwaway local instance — the API then answers any local process.
        out.token = null;
        break;
      case '--help':
      case '-h':
        out.help = true;
        break;
      default:
        break;
    }
  }
  return out;
}

const USAGE = `SSH Explorer server

Usage: node index.js [options]

  -p, --port <n>          HTTP/WS port (default 5178, 0 for ephemeral)
      --host <addr>       bind address (default 127.0.0.1)
      --state-dir <dir>   state directory (known_hosts, profiles.json, settings.json)
      --download-dir <d>  default download destination
      --static <dir>      directory of the built web app
      --no-static         disable static file serving
      --log-level <lvl>   silent | error | warn | info | debug
      --token <token>     require x-ssh-explorer-token on every /api request
      --no-token          disable the token requirement (open API — local use only)
  -h, --help              show this help

Without --token the server generates a random one and prints the ready-to-click URL.`;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(USAGE);
    return;
  }

  const server = await createServer({
    ...(args.port !== undefined && Number.isFinite(args.port) ? { port: args.port } : {}),
    ...(args.host !== undefined ? { host: args.host } : {}),
    ...(args.stateDir !== undefined ? { stateDir: args.stateDir } : {}),
    ...(args.downloadDir !== undefined ? { downloadDir: args.downloadDir } : {}),
    ...(args.staticDir !== undefined ? { staticDir: args.staticDir } : {}),
    ...(args.logLevel !== undefined ? { logLevel: args.logLevel } : {}),
    ...(args.token !== undefined ? { token: args.token } : {}),
  });

  // The generated token is part of the URL, so the printed line stays clickable (§10).
  process.stdout.write(`${server.tokenUrl ?? server.url}\n`);

  let stopping = false;
  const shutdown = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`received ${signal}, shutting down\n`);
    server
      .close()
      .then(() => process.exit(0))
      .catch((err: unknown) => {
        process.stderr.write(`shutdown failed: ${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
      });
    // Never hang forever on a stuck socket.
    const timer = setTimeout(() => process.exit(1), 5_000);
    timer.unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  // A long-lived service must not die because one stream settled after its
  // consumer walked away (a browser that closed mid-download, a connection torn
  // down while a transfer was queued). Log it loudly and keep serving; the
  // alternative — Node's default — is a silent process exit.
  process.on('unhandledRejection', (reason: unknown) => {
    process.stderr.write(
      `unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}\n`,
    );
  });
  process.on('uncaughtException', (error: Error) => {
    process.stderr.write(`uncaught exception: ${error.stack ?? error.message}\n`);
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
