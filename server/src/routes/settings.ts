import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import type { SettingsResponse, TransferSettings } from '../types.js';
import type { RouteContext } from './context.js';
import { parseBody } from './validate.js';

/**
 * §7 transfer settings. `maxConcurrent` bounds how many transfers run at once and
 * `speedLimitKbps` throttles their combined throughput; both are persisted in the state
 * directory and take effect immediately — the `TransferManager` is the single owner of the
 * running values, so a `PATCH` here is applied to the live queue and limiter.
 */

const transferPatch = z
  .object({
    maxConcurrent: z.number().int().min(1).max(8).optional(),
    speedLimitKbps: z.number().int().min(1).max(10_000_000).nullable().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'at least one field is required' });

const settingsPatch = z.object({ transfers: transferPatch });

function response(settings: TransferSettings): SettingsResponse {
  return { transfers: settings };
}

export function registerSettingsRoutes(router: Router, ctx: RouteContext): void {
  // GET /api/settings
  router.get('/settings', async (_req: Request, res: Response) => {
    const settings = await ctx.settings.get();
    res.json(response(settings));
  });

  // PATCH /api/settings — merged into the stored settings
  router.patch('/settings', async (req: Request, res: Response) => {
    const body = parseBody(settingsPatch, req);
    const merged = await ctx.settings.patch(body.transfers);
    // §7: "apply immediately" — the queue and the throughput limiter pick it up right away.
    ctx.transfers.applySettings(merged);
    ctx.logger.info('transfer settings updated', {
      maxConcurrent: merged.maxConcurrent,
      speedLimitKbps: merged.speedLimitKbps ?? 'unlimited',
    });
    res.json(response(merged));
  });
}
