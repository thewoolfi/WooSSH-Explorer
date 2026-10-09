import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { badRequest, notFound } from '../errors.js';
import type { SavedProfile } from '../types.js';
import { parseProfileInput } from '../store/profileStore.js';
import type { RouteContext } from './context.js';
import { parseBody, parseParams } from './validate.js';

/**
 * §4: profiles persist host/port/username/auth method/label/colour and never a secret.
 * Unknown keys (including a stray `password`) are stripped before the store sees them.
 */
const COLOR_PATTERN = /^[a-z][a-z0-9-]{0,31}$/i;

const profileFields = {
  label: z.string().trim().min(1).max(200),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  username: z.string().trim().min(1).max(255),
  authMethod: z.enum(['password', 'privateKey', 'agent']),
  privateKeyPath: z.string().min(1).max(4096).optional(),
  color: z.string().regex(COLOR_PATTERN, 'color must be a short palette tag').optional(),
};

const createSchema = z.object({
  label: profileFields.label,
  host: profileFields.host,
  port: profileFields.port.default(22),
  username: profileFields.username,
  authMethod: profileFields.authMethod,
  privateKeyPath: profileFields.privateKeyPath,
  color: profileFields.color,
});

const patchSchema = z
  .object({
    label: profileFields.label.optional(),
    host: profileFields.host.optional(),
    port: profileFields.port.optional(),
    username: profileFields.username.optional(),
    authMethod: profileFields.authMethod.optional(),
    privateKeyPath: profileFields.privateKeyPath,
    color: profileFields.color,
  })
  .refine((value) => Object.keys(value).length > 0, { message: 'at least one field is required' });

const idSchema = z.object({ id: z.string().min(1).max(200) });

/** Removes every `undefined` so a PATCH never blanks a stored field by accident. */
function definedOnly<T extends object>(value: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) out[key] = item;
  }
  return out as Partial<T>;
}

export function registerProfileRoutes(router: Router, ctx: RouteContext): void {
  const base = '/profiles';

  // GET /api/profiles
  router.get(base, async (_req: Request, res: Response) => {
    const profiles = await ctx.profiles.list();
    res.json({ profiles });
  });

  // POST /api/profiles
  router.post(base, async (req: Request, res: Response) => {
    const input = parseBody(createSchema, req);
    // `parseProfileInput` re-checks the shape and refuses anything secret-looking.
    const safe = parseProfileInput(input);
    const profile: SavedProfile = await ctx.profiles.create(safe);
    res.status(201).json({ profile });
  });

  // PATCH /api/profiles/:id
  router.patch(`${base}/:id`, async (req: Request, res: Response) => {
    const { id } = parseParams(idSchema, req);
    const patch = parseBody(patchSchema, req);
    const existing = await ctx.profiles.get(id);
    if (existing === undefined) throw notFound(`Unknown profile: ${id}.`);
    if (patch.authMethod !== undefined && patch.authMethod === 'privateKey' && existing.authMethod !== 'privateKey') {
      if (patch.privateKeyPath === undefined && existing.privateKeyPath === undefined) {
        throw badRequest('privateKeyPath is required when switching to privateKey authentication.', {
          path: ['privateKeyPath'],
        });
      }
    }
    const profile = await ctx.profiles.update(id, definedOnly(patch));
    res.json({ profile });
  });

  // DELETE /api/profiles/:id
  router.delete(`${base}/:id`, async (req: Request, res: Response) => {
    const { id } = parseParams(idSchema, req);
    await ctx.profiles.delete(id);
    res.status(204).end();
  });
}
