/**
 * Gaps in `@types/ssh2@1.15.6` versus the `ssh2@1.17.0` runtime this project ships.
 *
 * Everything else comes from the official definitions — this file exists only so we
 * do not have to hand-maintain a whole ambient module. Both entries were verified
 * against the installed source rather than assumed:
 *
 *   - `Stats.extended`      → `node_modules/ssh2/lib/protocol/SFTP.js:2426`
 *     (`this.extended = (initial && initial.extended)`), populated from the
 *     `extended@openssh.com` attribute reply. It carries `linkCount`.
 *   - `Client` `"handshake"` → `node_modules/ssh2/lib/client.js:323`
 *     (`this.emit('handshake', negotiated)`), carrying `srvHostKey`.
 *
 * Delete an entry here as soon as the upstream types catch up.
 */
import 'ssh2';

declare module 'ssh2' {
  interface Stats {
    /** Present when the server answered with `extended@openssh.com` attributes. */
    extended?: {
      linkCount?: number;
      [key: string]: unknown;
    };
  }

  interface Client {
    on(
      event: 'handshake',
      listener: (negotiated: { srvHostKey?: string; kex?: string; cipher?: string }) => void,
    ): this;
    once(
      event: 'handshake',
      listener: (negotiated: { srvHostKey?: string; kex?: string; cipher?: string }) => void,
    ): this;
  }
}
