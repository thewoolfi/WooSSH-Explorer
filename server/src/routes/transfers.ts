import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { badRequest, notFound } from '../errors.js';
import type { Transfer } from '../types.js';
import type { SftpFs } from '../ssh/fsOps.js';
import type { RelayJob } from '../transfers/TransferManager.js';
import { joinRemotePath, normalizeRemotePath, basename } from '../util/remotePath.js';
import type { RouteContext } from './context.js';
import { fsFor, notifyFsChanged, requireConnection } from './context.js';
import { parseParams, parseBody } from './validate.js';

const idSchema = z.object({ id: z.string().min(1).max(200) });

/** Bounds the pre-walk that produces the progress total; beyond it the size is unknown. */
const MEASURE_MAX_NODES = 50_000;

/**
 * Total bytes under a directory, for the progress bar.
 *
 * Deliberately best-effort: a tree larger than the node cap answers `-1` (an unknown size the
 * UI renders as an indeterminate bar) rather than making the request walk a million entries
 * before it can start.
 */
async function measureTree(fs: SftpFs, root: string): Promise<number> {
  let total = 0;
  let nodes = 0;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const current = stack.pop() as string;
    let listing;
    try {
      listing = await fs.list({ path: current, limit: 20_000 });
    } catch {
      return -1;
    }
    for (const child of listing.entries) {
      nodes += 1;
      if (nodes > MEASURE_MAX_NODES) return -1;
      if (child.kind === 'directory') stack.push(child.path);
      else if (child.kind === 'file') total += child.size;
    }
  }
  return total;
}

const relaySchema = z.object({
  sourceConnectionId: z.string().min(1).max(200),
  paths: z.array(z.string().min(1).max(8192)).min(1).max(1000),
  targetConnectionId: z.string().min(1).max(200),
  targetDir: z.string().min(1).max(8192),
  overwrite: z.boolean().optional(),
});

/** §7 — transfer listing, cancellation, clearing, retry and the server-to-server relay. */
export function registerTransferRoutes(router: Router, ctx: RouteContext): void {
  // GET /api/transfers — every connection
  router.get('/transfers', (_req: Request, res: Response) => {
    const transfers: Transfer[] = ctx.transfers.list();
    res.json({ transfers });
  });

  // DELETE /api/transfers — clears finished transfers, keeps active ones
  router.delete('/transfers', (_req: Request, res: Response) => {
    ctx.transfers.clearFinished();
    res.status(204).end();
  });

  // GET /api/connections/:id/transfers
  router.get('/connections/:id/transfers', (req: Request, res: Response) => {
    const connection = requireConnection(ctx, req);
    res.json({ transfers: ctx.transfers.list(connection.id) });
  });

  // POST /api/transfers/relay — copy files or whole trees from one connection straight to another
  router.post('/transfers/relay', async (req: Request, res: Response) => {
    const body = parseBody(relaySchema, req);

    const source = ctx.connections.getOrThrow(body.sourceConnectionId);
    const target = ctx.connections.getOrThrow(body.targetConnectionId);
    for (const connection of [source, target]) {
      if (!connection.isAuthenticated) {
        throw notFound(`Connection ${connection.id} is not authenticated.`, { id: connection.id });
      }
    }

    const sourceFs = fsFor(ctx, source);
    const targetFs = fsFor(ctx, target);
    const targetDir = normalizeRemotePath(await targetFs.resolve(body.targetDir));
    if (targetDir === '/' || !(await targetFs.isDirectory(targetDir))) {
      throw badRequest(`The target directory ${targetDir} does not exist.`, { path: targetDir });
    }

    const jobs: RelayJob[] = [];
    const names = new Set<string>();
    const conflicts: { sourcePath: string; targetPath: string }[] = [];

    for (const input of body.paths) {
      // Follow symlinks: the client asked for the contents, exactly like `fs/download` does.
      const entry = await sourceFs.stat(input, true);
      const name = basename(entry.path);
      if (names.has(name)) {
        throw badRequest(`Two relayed paths would collide on "${name}".`, { path: entry.path });
      }
      names.add(name);

      const targetPath = joinRemotePath(targetDir, name);
      // A name that is already taken is the client's decision to make, not a failure:
      // report it and let the UI ask, exactly like `fs/copy` does. Both paths come back so
      // the prompt can name the destination and the retry can name the source.
      if (body.overwrite !== true && (await targetFs.exists(targetPath))) {
        conflicts.push({ sourcePath: entry.path, targetPath });
        continue;
      }

      if (entry.kind === 'directory') {
        jobs.push({
          name,
          sourcePath: entry.path,
          targetPath,
          kind: 'directory',
          // One row tracks the whole subtree, so its size is the total on disk.
          size: await measureTree(sourceFs, entry.path),
          mode: entry.mode,
        });
      } else {
        jobs.push({
          name,
          sourcePath: entry.path,
          targetPath,
          kind: 'file',
          size: entry.size,
          mode: entry.mode,
        });
      }
    }

    if (jobs.length === 0) {
      // Nothing to start: every requested name is taken and overwriting was not agreed to.
      res.status(202).json({ transfers: [], batchId: null, conflicts });
      return;
    }

    const started = ctx.transfers.startRelay({
      source: { connection: source, fs: sourceFs },
      target: { connection: target, fs: targetFs },
      targetDir,
      jobs,
      overwrite: body.overwrite === true,
      onFileDone: () => notifyFsChanged(ctx, target.id, targetDir),
    });

    // §7: `202 Accepted` — the batch runs in the background and reports over the event bus.
    res.status(202).json({
      transfers: started.transfers.map((transfer) => ({ ...transfer })),
      batchId: started.batchId,
      conflicts,
    });
  });

  // DELETE /api/transfers/:id — cancel
  router.delete('/transfers/:id', (req: Request, res: Response) => {
    const { id } = parseParams(idSchema, req);
    const transfer = ctx.transfers.cancel(id);
    res.json({ transfer });
  });

  // POST /api/transfers/:id/retry
  router.post('/transfers/:id/retry', (req: Request, res: Response) => {
    const { id } = parseParams(idSchema, req);
    // A retried download has no server-side destination of its own, so it is re-queued and the
    // next `fs/download` of the same path drives the bytes (contract §7 only requires the
    // transfer to be restarted, and an upload's body is long gone).
    const { transfer } = ctx.transfers.retry(id);
    res.json({ transfer });
  });
}
