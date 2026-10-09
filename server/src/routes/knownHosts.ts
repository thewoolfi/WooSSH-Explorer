import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { notFound } from '../errors.js';
import type { KnownHostEntry } from '../types.js';
import type { RouteContext } from './context.js';
import { parseBody } from './validate.js';

/**
 * §15 known-hosts management.
 *
 * `path` is the writable file in the state directory (`~/.ssh/known_hosts` is only ever read),
 * and the listing covers exactly that file — an entry the UI can see is an entry `DELETE` can
 * remove. Removal rewrites the file atomically and preserves every other byte, including
 * comments, blank lines and CRLF endings.
 */

const deleteSchema = z.object({
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
});

export function registerKnownHostRoutes(router: Router, ctx: RouteContext): void {
  // GET /api/known-hosts
  router.get('/known-hosts', async (_req: Request, res: Response) => {
    const entries: KnownHostEntry[] = await ctx.knownHosts.listEntries();
    res.json({ path: ctx.knownHosts.writePath, entries });
  });

  // DELETE /api/known-hosts
  router.delete('/known-hosts', async (req: Request, res: Response) => {
    const body = parseBody(deleteSchema, req);
    const removed = await ctx.knownHosts.removeHost(body.host, body.port);
    if (removed === 0) {
      // Either the host was never stored, or it only lives in the read-only ~/.ssh/known_hosts,
      // which this API deliberately never writes to (§15).
      throw notFound(`No known_hosts entry for ${body.host}:${body.port}.`, {
        host: body.host,
        port: body.port,
        path: ctx.knownHosts.writePath,
      });
    }
    ctx.logger.info('known_hosts entry removed', { host: body.host, port: body.port, lines: removed });
    res.status(204).end();
  });
}
