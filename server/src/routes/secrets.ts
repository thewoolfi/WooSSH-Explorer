import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { notFound } from '../errors.js';
import type { SecretStorageInfo } from '../types.js';
import type { RouteContext } from './context.js';
import { parseParams } from './validate.js';

const idSchema = z.object({ id: z.string().min(1).max(200) });

/** `GET /api/system/info` advertises which box protects the vault. */
export function secretStorageInfo(ctx: RouteContext): SecretStorageInfo {
  return {
    available: true,
    kind: ctx.secrets.boxKind,
    label: ctx.secrets.boxLabel,
    vaultPath: ctx.config.secretsPath,
  };
}

/**
 * Contract §14. The vault is metadata-only over HTTP: there is deliberately no
 * endpoint that returns a stored password, passphrase or key to a client.
 */
export function registerSecretRoutes(router: Router, ctx: RouteContext): void {
  const base = '/secrets';

  // GET /api/secrets
  router.get(base, async (_req: Request, res: Response) => {
    res.json({ storage: secretStorageInfo(ctx), secrets: await ctx.secrets.list() });
  });

  // DELETE /api/secrets/:id
  router.delete(`${base}/:id`, async (req: Request, res: Response) => {
    const { id } = parseParams(idSchema, req);
    const removed = await ctx.secrets.forget(id);
    if (!removed) throw notFound(`No stored credential with id ${id}.`, { id });
    ctx.logger.info('stored credential removed', { id });
    res.status(204).end();
  });

  // DELETE /api/secrets — forget everything
  router.delete(base, async (_req: Request, res: Response) => {
    await ctx.secrets.clear();
    ctx.logger.info('credential vault cleared');
    res.status(204).end();
  });
}
