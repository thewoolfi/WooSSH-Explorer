/**
 * The one piece of the server the desktop shell talks to, declared here so the
 * Electron bundle does not have to depend on the server package's internal type
 * graph. The build aliases this specifier to `server/dist/server.js`.
 *
 * Keep in sync with `docs/API.md` §12.
 */
declare module '@ssh-explorer/server-runtime' {
  export type SecretBoxKind = 'os-keychain' | 'local-key';

  /** Mirrors `server/src/store/secretVault.ts`; a structural match is enough. */
  export interface SecretBox {
    readonly kind: SecretBoxKind;
    readonly label: string;
    encrypt(plaintext: string): Promise<string>;
    decrypt(payload: string): Promise<string>;
  }

  export interface CreateServerOptions {
    port?: number;
    host?: string;
    stateDir?: string;
    downloadDir?: string;
    logLevel?: 'silent' | 'error' | 'warn' | 'info' | 'debug';
    /** Rotating log file; the windowed build has no console to read. */
    logFilePath?: string;
    staticDir?: string | null;
    token?: string | null;
    /** Where saved credentials are encrypted. Defaults to a local AES key file. */
    secretBox?: SecretBox;
  }

  export interface RunningServer {
    url: string;
    port: number;
    httpServer: import('node:http').Server;
    close(): Promise<void>;
  }

  export function createServer(options?: CreateServerOptions): Promise<RunningServer>;
}
