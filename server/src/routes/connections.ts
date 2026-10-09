import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { badRequest, notFound } from '../errors.js';
import type { AuthMethod, ConnectionSummary, SavedProfile } from '../types.js';
import type { SshCredentials } from '../ssh/SshConnection.js';
import { isStorable, redactForStorage } from '../store/secretVault.js';
import type { RouteContext } from './context.js';
import { requireConnection } from './context.js';
import { parseBody, parseParams } from './validate.js';

const authSchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('password'),
    password: z.string().min(1).max(4096),
  }),
  z.object({
    method: z.literal('privateKey'),
    privateKeyPath: z.string().min(1).max(4096).optional(),
    privateKey: z.string().min(1).max(1024 * 1024).optional(),
    passphrase: z.string().max(4096).optional(),
  }),
  z.object({
    method: z.literal('agent'),
    socket: z.string().max(4096).optional(),
  }),
]);

const connectSchema = z.object({
  profileId: z.string().min(1).max(200).optional(),
  label: z.string().trim().min(1).max(200).optional(),
  color: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,31}$/i, 'color must be a short palette tag')
    .optional(),
  host: z.string().trim().min(1).max(255).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  username: z.string().trim().min(1).max(255).optional(),
  auth: authSchema.optional(),
  /** Persist the supplied credential in the encrypted vault (contract §14). */
  saveSecret: z.boolean().optional(),
  /** Reuse a stored credential; defaults to `true` when `auth` is absent. */
  useStoredSecret: z.boolean().optional(),
  trustHostKey: z.boolean().optional(),
  hostKeyFingerprint: z.string().min(7).max(200).optional(),
});

const execSchema = z.object({
  command: z.string().min(1).max(64 * 1024),
  timeoutMs: z.number().int().min(1).max(10 * 60 * 1000).optional(),
});

const idSchema = z.object({ id: z.string().min(1).max(200) });

/** Builds the in-memory credential object from a validated `auth` block. */
export function credentialsFromAuth(
  auth: z.output<typeof authSchema> | undefined,
  fallback: SavedProfile | undefined,
): { credentials: SshCredentials; authMethod: AuthMethod } | null {
  if (auth !== undefined) {
    if (auth.method === 'password') return { credentials: { method: 'password', password: auth.password }, authMethod: 'password' };
    if (auth.method === 'privateKey') {
      return {
        credentials: {
          method: 'privateKey',
          ...(auth.privateKey !== undefined ? { privateKey: auth.privateKey } : {}),
          ...(auth.privateKeyPath !== undefined ? { privateKeyPath: auth.privateKeyPath } : {}),
          ...(auth.passphrase !== undefined ? { passphrase: auth.passphrase } : {}),
        },
        authMethod: 'privateKey',
      };
    }
    return {
      credentials: { method: 'agent', ...(auth.socket !== undefined ? { socket: auth.socket } : {}) },
      authMethod: 'agent',
    };
  }

  // No credentials supplied: reuse the key path recorded in the profile, when there is one.
  if (fallback !== undefined && fallback.authMethod === 'privateKey' && fallback.privateKeyPath !== undefined) {
    return {
      credentials: { method: 'privateKey', privateKeyPath: fallback.privateKeyPath },
      authMethod: 'privateKey',
    };
  }
  if (fallback !== undefined && fallback.authMethod === 'agent') {
    return { credentials: { method: 'agent' }, authMethod: 'agent' };
  }
  return null;
}

export function registerConnectionRoutes(router: Router, ctx: RouteContext): void {
  const base = '/connections';

  // GET /api/connections
  router.get(base, (_req: Request, res: Response) => {
    res.json({ connections: ctx.connections.list() });
  });

  // POST /api/connections
  router.post(base, async (req: Request, res: Response) => {
    const body = parseBody(connectSchema, req);

    const profile = body.profileId !== undefined ? await ctx.profiles.get(body.profileId) : undefined;
    if (body.profileId !== undefined && profile === undefined) {
      throw notFound(`Unknown profile: ${body.profileId}.`, { path: ['profileId'] });
    }

    const host = body.host ?? profile?.host;
    const port = body.port ?? profile?.port ?? 22;
    const username = body.username ?? profile?.username;
    if (host === undefined || username === undefined) {
      throw badRequest('host and username are required (directly or through profileId).', {
        issues: [
          ...(host === undefined ? [{ path: ['host'], message: 'host is required', code: 'custom' }] : []),
          ...(username === undefined ? [{ path: ['username'], message: 'username is required', code: 'custom' }] : []),
        ],
      });
    }

    // Credential resolution order (contract §14):
    //   1. an explicit `auth` block in the request,
    //   2. the encrypted vault, unless the caller opts out,
    //   3. the key path / agent recorded on the profile.
    let resolved = body.auth !== undefined ? credentialsFromAuth(body.auth, profile) : null;
    let usedStoredSecret = false;

    if (resolved === null && body.useStoredSecret !== false) {
      const stored = await ctx.secrets.get(host, port, username);
      if (stored !== null) {
        resolved = { credentials: stored, authMethod: stored.method };
        usedStoredSecret = true;
      }
    }
    if (resolved === null) resolved = credentialsFromAuth(undefined, profile);

    if (resolved === null) {
      throw badRequest(
        'An auth block is required, or save credentials for this host first.',
        { path: ['auth'] },
      );
    }

    const outcome = await ctx.connections.connect(
      {
        host,
        port,
        username,
        credentials: resolved.credentials,
        ...(body.label !== undefined ? { label: body.label } : profile !== undefined ? { label: profile.label } : {}),
        ...(body.color !== undefined ? { color: body.color } : profile !== undefined ? { color: profile.color } : {}),
        ...(body.trustHostKey !== undefined ? { trustHostKey: body.trustHostKey } : {}),
        ...(body.hostKeyFingerprint !== undefined ? { hostKeyFingerprint: body.hostKeyFingerprint } : {}),
      },
      profile?.id,
    );

    // Only persist after the handshake succeeded, so a typo never reaches the vault.
    let savedSecret = false;
    if (body.saveSecret === true && isStorable(resolved.credentials)) {
      try {
        await ctx.secrets.put(
          { host, port, username },
          redactForStorage(resolved.credentials),
        );
        savedSecret = true;
        ctx.logger.info('credential stored', { host, port, username, method: resolved.authMethod });
      } catch (err) {
        // A failure to save must never fail the connection the user just made.
        ctx.logger.warn('could not store the credential', {
          host,
          port,
          username,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }

    if (outcome.reused) {
      ctx.logger.debug('connection reused', { id: outcome.connection.id });
      res.status(200).json({ connection: outcome.summary, savedSecret, usedStoredSecret });
      return;
    }

    if (profile !== undefined) {
      // Fire-and-forget bookkeeping; never blocks the response.
      void ctx.profiles.touchLastUsed(profile.id);
    }
    ctx.logger.info('connection established', {
      id: outcome.connection.id,
      host,
      port,
      username,
      method: resolved.authMethod,
      usedStoredSecret,
    });
    res.status(201).json({ connection: outcome.summary, savedSecret, usedStoredSecret });
  });

  // GET /api/connections/:id
  router.get(`${base}/:id`, (req: Request, res: Response) => {
    const { id } = parseParams(idSchema, req);
    const connection = ctx.connections.getOrThrow(id);
    const summary: ConnectionSummary = connection.summary();
    res.json({ connection: summary });
  });

  // DELETE /api/connections/:id
  router.delete(`${base}/:id`, (req: Request, res: Response) => {
    const { id } = parseParams(idSchema, req);
    const connection = ctx.connections.getOrThrow(id);
    // Transfers and shells first, then the transport (contract §11.10).
    ctx.transfers.cancelForConnection(connection.id);
    ctx.connections.close(connection.id, 'Closed by the client.');
    ctx.logger.info('connection closed', { id: connection.id });
    res.status(204).end();
  });

  // POST /api/connections/:id/reconnect
  router.post(`${base}/:id/reconnect`, async (req: Request, res: Response) => {
    const { id } = parseParams(idSchema, req);
    const connection = ctx.connections.getOrThrow(id);
    // Anything still reading from the old transport has to stop before it is replaced.
    ctx.transfers.cancelForConnection(connection.id);
    const summary = await ctx.connections.reconnect(connection.id);
    res.json({ connection: summary });
  });

  // POST /api/connections/:id/exec
  router.post(`${base}/:id/exec`, async (req: Request, res: Response) => {
    const body = parseBody(execSchema, req);
    const connection = requireConnection(ctx, req);
    const result = await connection.exec(body.command, {
      ...(body.timeoutMs !== undefined ? { timeoutMs: body.timeoutMs } : {}),
    });
    res.json({ stdout: result.stdout, stderr: result.stderr, code: result.code });
  });
}
