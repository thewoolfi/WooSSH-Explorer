import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { runNetProbe } from '../netTools.js';
import type { RouteContext } from './context.js';
import { parseBody } from './validate.js';

/**
 * Ping and traceroute **from this machine** to a host, so a saved host can be checked
 * before connecting to it. No SSH session is involved, which is the point: when a server
 * refuses connections, the network path is the first thing worth ruling out.
 */
const probeSchema = z.object({
  host: z.string().min(1).max(255),
  tool: z.enum(['ping', 'traceroute']),
  count: z.number().int().min(1).max(10).optional(),
});

export function registerNetToolRoutes(router: Router, _ctx: RouteContext): void {
  // POST /api/net/probe
  router.post('/net/probe', async (req: Request, res: Response) => {
    const body = parseBody(probeSchema, req);
    const result = await runNetProbe({ tool: body.tool, host: body.host, count: body.count });
    res.json(result);
  });
}
