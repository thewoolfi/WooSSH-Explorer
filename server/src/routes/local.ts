import { Router } from 'express';
import { z } from 'zod';

import { LocalFs, LOCAL_CONNECTION_ID } from '../local/localFs.js';
import type { RouteContext } from './context.js';
import { parseBody, parseQuery } from './validate.js';

const listQuery = z.object({
  path: z.string().max(8192).optional(),
  limit: z.coerce.number().int().min(1).max(20_000).optional(),
});

const statQuery = z.object({ path: z.string().min(1).max(8192) });

const readQuery = z.object({
  path: z.string().min(1).max(8192),
  maxBytes: z.coerce.number().int().min(1).max(2_097_152).optional(),
});

const searchQuery = z.object({
  path: z.string().max(8192).optional(),
  query: z.string().min(1).max(1024),
  limit: z.coerce.number().int().min(1).max(2_000).optional(),
});

const usageQuery = z.object({
  paths: z
    .union([z.string().min(1).max(8192), z.array(z.string().min(1).max(8192))])
    .transform((value) => (Array.isArray(value) ? value : [value])),
});

const mkdirSchema = z.object({ path: z.string().min(1).max(8192) });
const renameSchema = z.object({
  from: z.string().min(1).max(8192),
  to: z.string().min(1).max(8192),
});
const deleteSchema = z.object({
  paths: z.array(z.string().min(1).max(8192)).min(1).max(1000),
  recursive: z.boolean().optional(),
});
const chmodSchema = z.object({
  path: z.string().min(1).max(8192),
  mode: z.string().min(1).max(16),
});
const touchSchema = z.object({
  path: z.string().min(1).max(8192),
  mtimeMs: z.number().finite().optional(),
});
const copyMoveSchema = z.object({
  sources: z.array(z.string().min(1).max(8192)).min(1).max(1000),
  destination: z.string().min(1).max(8192),
  overwrite: z.boolean().optional(),
});

/**
 * The filesystem of the machine running the application.
 *
 * Deliberately a separate route tree from `/connections/:id/fs` rather than a special
 * connection id threaded through it: the remote routes reach for a live SSH connection in
 * several places — transfers, archives — and none of that has a local equivalent. Keeping
 * them apart means the remote path is untouched by this feature.
 *
 * The interface treats this computer as a peer of any host, so the responses match the
 * remote ones exactly and the same components render both.
 */
export function registerLocalRoutes(router: Router, ctx: RouteContext): void {
  const fs = new LocalFs(ctx.logger);
  const base = '/local';

  // The interface asks once whether this computer can be browsed at all.
  router.get(`${base}/info`, (_req, res) => {
    res.json({
      available: true,
      connectionId: LOCAL_CONNECTION_ID,
      platform: process.platform,
      home: null,
      username: process.env['USERNAME'] ?? process.env['USER'] ?? '',
    });
  });

  router.get(`${base}/fs/list`, async (req, res) => {
    const query = parseQuery(listQuery, req);
    const listing = await fs.list({
      ...(query.path !== undefined ? { path: query.path } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    });
    res.json({ listing });
  });

  router.get(`${base}/fs/stat`, async (req, res) => {
    const query = parseQuery(statQuery, req);
    const entry = await fs.stat(query.path, true);
    res.json({ entry });
  });

  router.get(`${base}/fs/read`, async (req, res) => {
    const query = parseQuery(readQuery, req);
    res.json(await fs.read(query.path, query.maxBytes));
  });

  router.post(`${base}/fs/mkdir`, async (req, res) => {
    const body = parseBody(mkdirSchema, req);
    res.status(201).json({ entry: await fs.mkdir(body.path) });
  });

  router.post(`${base}/fs/rename`, async (req, res) => {
    const body = parseBody(renameSchema, req);
    res.json({ entry: await fs.rename(body.from, body.to) });
  });

  router.post(`${base}/fs/delete`, async (req, res) => {
    const body = parseBody(deleteSchema, req);
    res.json(await fs.remove(body.paths, body.recursive === true));
  });

  router.post(`${base}/fs/chmod`, async (req, res) => {
    const body = parseBody(chmodSchema, req);
    res.json({ entry: await fs.chmod(body.path, body.mode) });
  });

  router.post(`${base}/fs/touch`, async (req, res) => {
    const body = parseBody(touchSchema, req);
    res.json({ entry: await fs.touch(body.path, body.mtimeMs) });
  });

  router.get(`${base}/fs/search`, async (req, res) => {
    const query = parseQuery(searchQuery, req);
    res.json(
      await fs.search({
        ...(query.path !== undefined ? { path: query.path } : {}),
        query: query.query,
        ...(query.limit !== undefined ? { limit: query.limit } : {}),
      }),
    );
  });

  router.get(`${base}/fs/usage`, async (req, res) => {
    const query = parseQuery(usageQuery, req);
    res.json({ usage: await fs.usage(query.paths) });
  });

  router.post(`${base}/fs/copy`, async (req, res) => {
    const body = parseBody(copyMoveSchema, req);
    res.json(await fs.copy(body.sources, body.destination, { overwrite: body.overwrite === true }));
  });

  router.post(`${base}/fs/move`, async (req, res) => {
    const body = parseBody(copyMoveSchema, req);
    res.json(await fs.move(body.sources, body.destination, { overwrite: body.overwrite === true }));
  });
}
