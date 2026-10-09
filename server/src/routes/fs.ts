import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';

import { badRequest } from '../errors.js';
import { createArchive, extractArchive, type ArchiveFormat } from '../ssh/archive.js';
import type { FileEntry, Transfer } from '../types.js';
import { parentRemotePath } from '../util/remotePath.js';
import type { RouteContext } from './context.js';
import { fsFor, notifyFsChanged, requireAuthenticatedConnection } from './context.js';
import { parseBody, parseParams, parseQuery } from './validate.js';

/** NUL bytes are refused outright: a path is passed to a shell and to SFTP as text. */
const remotePath = z
  .string()
  .min(1)
  .max(8192)
  .refine((value) => !value.includes('\0'), { message: 'a path must not contain NUL' });

const idSchema = z.object({ id: z.string().min(1).max(200) });

const listQuery = z.object({
  path: z.string().max(8192).optional(),
  showHidden: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(20_000).optional(),
});

const statQuery = z.object({ path: z.string().min(1).max(8192) });

const readQuery = z.object({
  path: z.string().min(1).max(8192),
  maxBytes: z.coerce.number().int().min(1).max(2_097_152).optional(),
});

const downloadQuery = z.object({
  path: z.string().min(1).max(8192),
  localPath: z.string().max(4096).optional(),
});

const batchSchema = z.object({
  paths: z.array(z.string().min(1).max(8192)).min(1).max(1000),
  name: z.string().min(1).max(255).optional(),
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

const searchQuery = z.object({
  path: z.string().max(8192).optional(),
  query: z.string().min(1).max(1024),
  limit: z.coerce.number().int().min(1).max(2_000).optional(),
});

const usageQuery = z.object({
  paths: z.union([z.string().min(1).max(8192), z.array(z.string().min(1).max(8192))]).transform((value) =>
    Array.isArray(value) ? value : [value],
  ),
});

const uploadQuery = z.object({
  path: z.string().min(1).max(8192),
  name: z.string().min(1).max(255),
});

/** §6 `fs/copy` and `fs/move`. */
const copyMoveSchema = z.object({
  sources: z.array(remotePath).min(1).max(1000),
  destination: remotePath,
  overwrite: z.boolean().optional(),
});

/** §6 `fs/archive`. */
const archiveSchema = z.object({
  paths: z.array(remotePath).min(1).max(1000),
  destination: remotePath,
  format: z.enum(['tar.gz', 'tar', 'zip']),
});

/** §6 `fs/extract`. */
const extractSchema = z.object({
  path: remotePath,
  destinationDir: remotePath,
  overwrite: z.boolean().optional(),
});

/**
 * `Range: bytes=N-` (contract §7 resumable downloads).
 *
 * Only the open-ended form is honoured; anything else (`bytes=a-b`, multiple ranges, a
 * malformed header) is ignored and the whole file is served with `200`, which is what a client
 * that cannot resume expects anyway.
 */
export function parseResumeOffset(header: string | undefined, size: number): number | 'unsatisfiable' | null {
  if (header === undefined) return null;
  // Without a known size a partial response cannot carry a valid `Content-Range`.
  if (size < 0) return null;
  const match = /^bytes=(\d+)-$/i.exec(header.trim());
  if (match === null) return null;

  const offset = Number.parseInt(match[1] as string, 10);
  if (!Number.isFinite(offset) || offset < 0) return null;
  if (offset === 0) return null;
  if (offset >= size) return 'unsatisfiable';
  return offset;
}

/** `Content-Disposition` with an RFC 5987 encoded filename (contract §6). */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function failed(prefix: string, err: unknown): Error {
  return new Error(`${prefix}: ${err instanceof Error ? err.message : String(err)}`);
}

export function registerFileRoutes(router: Router, ctx: RouteContext): void {
  const base = '/connections/:id/fs';

  // GET /api/connections/:id/fs/list
  router.get(`${base}/list`, async (req: Request, res: Response) => {
    const connection = requireAuthenticatedConnection(ctx, req);
    const query = parseQuery(listQuery, req);
    const listing = await fsFor(ctx, connection).list({
      ...(query.path !== undefined ? { path: query.path } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    });
    // `showHidden` is a client-side hint only: the server always returns everything (§6).
    res.json({ listing });
  });

  // GET /api/connections/:id/fs/stat
  router.get(`${base}/stat`, async (req: Request, res: Response) => {
    const connection = requireAuthenticatedConnection(ctx, req);
    const query = parseQuery(statQuery, req);
    const entry: FileEntry = await fsFor(ctx, connection).stat(query.path);
    res.json({ entry });
  });

  // GET /api/connections/:id/fs/read
  router.get(`${base}/read`, async (req: Request, res: Response) => {
    const connection = requireAuthenticatedConnection(ctx, req);
    const query = parseQuery(readQuery, req);
    const result = await fsFor(ctx, connection).read(
      query.path,
      query.maxBytes,
    );
    res.json(result);
  });

  // GET /api/connections/:id/fs/download
  router.get(`${base}/download`, async (req: Request, res: Response) => {
    const connection = requireAuthenticatedConnection(ctx, req);
    const query = parseQuery(downloadQuery, req);
    const fs = fsFor(ctx, connection);
    // Follow symlinks here: the client asked for the contents of the target.
    const entry = await fs.stat(query.path, true);
    if (entry.kind === 'directory') {
      throw badRequest('A directory cannot be streamed; use fs/download-batch.', { path: entry.path });
    }

    // `localPath` is only recorded when the client explicitly chose a destination; the default
    // download directory is a *client-side* default, so nothing is written on the server.
    const localPath = query.localPath === undefined ? null : ctx.transfers.resolveLocalPath(query.localPath, entry.name);

    // §7 resumable downloads: `Range: bytes=N-` continues a partly written file.
    const resume = parseResumeOffset(req.get('range') ?? undefined, entry.size);
    if (resume === 'unsatisfiable') {
      // 416 is not one of the §1 statuses, so it is rendered here; the envelope and
      // `x-request-id` still match every other error response.
      res.status(416);
      res.setHeader('content-range', `bytes */${entry.size}`);
      res.json({
        error: {
          code: 'BAD_REQUEST',
          message: `The requested range starts at or past the end of ${entry.name} (${entry.size} bytes).`,
        },
      });
      return;
    }
    const resumeFrom = resume ?? 0;
    const remaining = entry.size >= 0 ? entry.size - resumeFrom : -1;

    res.status(resumeFrom > 0 ? 206 : 200);
    res.setHeader('content-type', 'application/octet-stream');
    res.setHeader('content-disposition', contentDisposition(entry.name));
    res.setHeader('cache-control', 'no-store');
    res.setHeader('accept-ranges', 'bytes');
    if (resumeFrom > 0 && entry.size >= 0) {
      res.setHeader('content-range', `bytes ${resumeFrom}-${entry.size - 1}/${entry.size}`);
    }
    if (remaining >= 0) res.setHeader('content-length', String(remaining));

    let cancelled = false;
    const onResClose = (): void => {
      if (!res.writableFinished) cancelled = true;
    };
    res.once('close', onResClose);

    const transfer = await ctx.transfers
      .downloadToStream(
        {
          connection,
          fs,
          remotePath: entry.path,
          localPath,
          name: entry.name,
          size: entry.size,
          resumeFrom,
          ...(entry.size >= 0 ? { rangeEnd: entry.size - 1 } : {}),
        },
        res,
      )
      .catch((err: unknown) => {
        if (!cancelled && !res.writableEnded && !res.destroyed) res.destroy(failed('download failed', err));
        throw err;
      })
      .finally(() => {
        res.removeListener('close', onResClose);
      });
    ctx.logger.debug('download finished', {
      id: transfer.id,
      bytes: transfer.transferred,
      resumedFrom: transfer.resumedFrom,
      cancelled,
    });
  });

  // POST /api/connections/:id/fs/download-batch
  router.post(`${base}/download-batch`, async (req: Request, res: Response) => {
    const connection = requireAuthenticatedConnection(ctx, req);
    const body = parseBody(batchSchema, req);
    const fs = fsFor(ctx, connection);

    const resolved: string[] = [];
    for (const item of body.paths) {
      resolved.push((await fs.stat(item)).path);
    }

    let started = false;
    const zip = await ctx.transfers.prepareZip({ connection, fs, paths: resolved }, () => {
      // Runs after the walk succeeded: a failure above still gets a JSON error envelope.
      // (`res.setHeader` does not commit the response, so this is still pre-stream.)
      started = true;
      res.status(200);
      res.setHeader('content-type', 'application/zip');
      res.setHeader('content-disposition', contentDisposition(body.name ?? 'download.zip'));
      res.setHeader('cache-control', 'no-store');
    });
    if (!started) {
      throw badRequest('Nothing to download.', { paths: resolved });
    }
    const onClose = (): void => {
      if (!res.writableFinished) zip.abort();
    };
    res.once('close', onClose);

    zip.completed.catch((err: unknown) => {
      ctx.logger.warn('zip download failed', { error: err });
      zip.abort();
    });

    zip.archive.pipe(res);
    try {
      await zip.completed;
    } finally {
      res.removeListener('close', onClose);
      if (!res.writableEnded && !res.destroyed) res.end();
    }
  });

  // POST /api/connections/:id/fs/upload?path=&name=
  router.post(`${base}/upload`, async (req: Request, res: Response) => {
    const connection = requireAuthenticatedConnection(ctx, req);
    const query = parseQuery(uploadQuery, req);
    const fs = fsFor(ctx, connection);

    const headerLength = req.get('content-length');
    const size = headerLength !== undefined && /^\d+$/.test(headerLength) ? Number.parseInt(headerLength, 10) : -1;
    const remotePath = `${query.path.replace(/\/+$/, '')}/${query.name}`;

    const transfer: Transfer = await ctx.transfers.upload({
      connection,
      fs,
      remotePath,
      source: req,
      size,
    });
    const parent = parentRemotePath(transfer.remotePath);
    if (parent !== null) notifyFsChanged(ctx, connection.id, parent);
    res.status(200).json({ transfer });
  });

  // POST /api/connections/:id/fs/mkdir
  router.post(`${base}/mkdir`, async (req: Request, res: Response) => {
    const connection = requireAuthenticatedConnection(ctx, req);
    const body = parseBody(mkdirSchema, req);
    const entry = await fsFor(ctx, connection).mkdir(body.path);
    notifyFsChanged(ctx, connection.id, parentRemotePath(entry.path) ?? entry.path);
    res.status(201).json({ entry });
  });

  // POST /api/connections/:id/fs/rename
  router.post(`${base}/rename`, async (req: Request, res: Response) => {
    const connection = requireAuthenticatedConnection(ctx, req);
    const body = parseBody(renameSchema, req);
    const entry = await fsFor(ctx, connection).rename(body.from, body.to);
    notifyFsChanged(ctx, connection.id, parentRemotePath(entry.path) ?? entry.path);
    res.json({ entry });
  });

  // POST /api/connections/:id/fs/delete
  router.post(`${base}/delete`, async (req: Request, res: Response) => {
    const connection = requireAuthenticatedConnection(ctx, req);
    const body = parseBody(deleteSchema, req);
    const result = await fsFor(ctx, connection).remove(body.paths, body.recursive === true);
    for (const deleted of result.deleted) {
      notifyFsChanged(ctx, connection.id, parentRemotePath(deleted) ?? '/');
    }
    res.json(result);
  });

  // POST /api/connections/:id/fs/chmod
  router.post(`${base}/chmod`, async (req: Request, res: Response) => {
    const connection = requireAuthenticatedConnection(ctx, req);
    const body = parseBody(chmodSchema, req);
    const entry = await fsFor(ctx, connection).chmod(body.path, body.mode);
    notifyFsChanged(ctx, connection.id, parentRemotePath(entry.path) ?? entry.path);
    res.json({ entry });
  });

  // POST /api/connections/:id/fs/touch
  router.post(`${base}/touch`, async (req: Request, res: Response) => {
    const connection = requireAuthenticatedConnection(ctx, req);
    const body = parseBody(touchSchema, req);
    const entry = await fsFor(ctx, connection).touch(body.path, body.mtimeMs);
    notifyFsChanged(ctx, connection.id, parentRemotePath(entry.path) ?? entry.path);
    res.json({ entry });
  });

  // GET /api/connections/:id/fs/search
  router.get(`${base}/search`, async (req: Request, res: Response) => {
    const connection = requireAuthenticatedConnection(ctx, req);
    const query = parseQuery(searchQuery, req);
    const result = await fsFor(ctx, connection).search({
      query: query.query,
      ...(query.path !== undefined ? { path: query.path } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
    });
    res.json(result);
  });

  // GET /api/connections/:id/fs/usage?paths=a&paths=b
  router.get(`${base}/usage`, async (req: Request, res: Response) => {
    const connection = requireAuthenticatedConnection(ctx, req);
    const query = parseQuery(usageQuery, req);
    const usage = await fsFor(ctx, connection).usage(query.paths);
    res.json({ usage });
  });

  // POST /api/connections/:id/fs/copy
  router.post(`${base}/copy`, async (req: Request, res: Response) => {
    const connection = requireAuthenticatedConnection(ctx, req);
    const body = parseBody(copyMoveSchema, req);
    const result = await fsFor(ctx, connection).copy(body.sources, body.destination, {
      overwrite: body.overwrite === true,
    });
    notifyCopyResult(ctx, connection.id, body.destination, result.copied);
    res.json(result);
  });

  // POST /api/connections/:id/fs/move
  router.post(`${base}/move`, async (req: Request, res: Response) => {
    const connection = requireAuthenticatedConnection(ctx, req);
    const body = parseBody(copyMoveSchema, req);
    const result = await fsFor(ctx, connection).move(body.sources, body.destination, {
      overwrite: body.overwrite === true,
    });
    notifyCopyResult(ctx, connection.id, body.destination, result.copied);
    // The sources are gone: the client has to refresh their directories too.
    for (const source of body.sources) {
      const parent = parentRemotePath(source);
      if (parent !== null) notifyFsChanged(ctx, connection.id, parent);
    }
    res.json(result);
  });

  // POST /api/connections/:id/fs/archive
  router.post(`${base}/archive`, async (req: Request, res: Response) => {
    const connection = requireAuthenticatedConnection(ctx, req);
    const body = parseBody(archiveSchema, req);
    const result = await createArchive(connection, fsFor(ctx, connection), ctx.logger, {
      paths: body.paths,
      destination: body.destination,
      format: body.format as ArchiveFormat,
    });
    notifyFsChanged(ctx, connection.id, parentRemotePath(result.entry.path) ?? result.entry.path);
    res.status(201).json(result);
  });

  // POST /api/connections/:id/fs/extract
  router.post(`${base}/extract`, async (req: Request, res: Response) => {
    const connection = requireAuthenticatedConnection(ctx, req);
    const body = parseBody(extractSchema, req);
    const result = await extractArchive(connection, fsFor(ctx, connection), ctx.logger, {
      path: body.path,
      destinationDir: body.destinationDir,
      overwrite: body.overwrite === true,
    });
    notifyFsChanged(ctx, connection.id, body.destinationDir);
    res.status(201).json(result);
  });
}

/** Every directory a copy/move touched: the destination plus each new entry's parent. */
function notifyCopyResult(
  ctx: RouteContext,
  connectionId: string,
  destination: string,
  copied: readonly FileEntry[],
): void {
  const seen = new Set<string>();
  const parents = [parentRemotePath(destination) ?? destination, ...copied.map((entry) => parentRemotePath(entry.path) ?? entry.path)];
  for (const parent of parents) {
    if (seen.has(parent)) continue;
    seen.add(parent);
    notifyFsChanged(ctx, connectionId, parent);
  }
}
