import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { checkForUpdate } from '../updateCheck.js';
import type { RouteContext } from './context.js';
import { parseQuery } from './validate.js';

/**
 * `GET /api/update-check` — is there a newer release than the one running?
 *
 * Served by the backend rather than fetched from the renderer: the request leaves from
 * Node, so there is no CORS negotiation, the answer is cached once for the whole app, and
 * the version being compared against is the one the server actually reports.
 */

/** Where releases live. Kept next to the check so it is one thing to change. */
export const RELEASE_OWNER = 'thewoolfi';
export const RELEASE_REPO = 'WooSSH-Explorer';

const querySchema = z.object({
  /** The explicit "check now" action bypasses the cache. */
  force: z.enum(['1', 'true']).optional(),
});

export function registerUpdateRoutes(router: Router, ctx: RouteContext): void {
  router.get('/update-check', async (req: Request, res: Response) => {
    const query = parseQuery(querySchema, req);
    const result = await checkForUpdate({
      current: ctx.config.version,
      owner: RELEASE_OWNER,
      repo: RELEASE_REPO,
      force: query.force !== undefined,
      logger: ctx.logger,
    });
    res.json(result);
  });
}
