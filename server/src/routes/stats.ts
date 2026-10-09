import { Router } from 'express';
import type { Request, Response } from 'express';

import { collectSystemStats } from '../systemStats.js';
import { runDiagnostics } from '../diagnostics.js';
import type { SystemStats } from '../types.js';
import type { RouteContext } from './context.js';
import { requireAuthenticatedConnection } from './context.js';

/**
 * §16: one round trip for the status panel. The collector never throws — a host without
 * `/proc`, `/usr/bin/free` or even a working `exec` answers with an all-`null` result rather
 * than an error, and every field is optional from the client's point of view. Since a real
 * host failed exactly this way, the answer also carries `notes` explaining each gap.
 */
export function registerStatsRoutes(router: Router, ctx: RouteContext): void {
  // GET /api/connections/:id/system/stats
  router.get('/connections/:id/system/stats', async (req: Request, res: Response) => {
    const connection = requireAuthenticatedConnection(ctx, req);
    const stats: SystemStats = await collectSystemStats(connection, ctx.logger);
    res.json(stats);
  });

  // GET /api/connections/:id/diagnostics — what this host can and cannot do.
  router.get('/connections/:id/diagnostics', async (req: Request, res: Response) => {
    const connection = requireAuthenticatedConnection(ctx, req);
    const report = await runDiagnostics(connection, ctx.logger);
    res.json(report);
  });
}
