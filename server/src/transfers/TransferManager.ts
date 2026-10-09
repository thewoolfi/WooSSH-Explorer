import { EventEmitter } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as yazl from 'yazl';

import { ApiError, conflict, internal, mapError, notFound } from '../errors.js';
import type { Logger } from '../logger.js';
import type { Transfer, TransferDirection, TransferSettings, TransferState } from '../types.js';
import { newId } from '../util/ids.js';
import { basename, joinRemotePath, normalizeRemotePath } from '../util/remotePath.js';
import type { SftpFs } from '../ssh/fsOps.js';
import type { SshConnection } from '../ssh/SshConnection.js';
import { ThroughputLimiter } from './ThroughputLimiter.js';
import { TransferQueue } from './TransferQueue.js';

/** Guards against a pathological tree (a bind-mount loop, a server that resolves symlinks). */
const RELAY_MAX_DEPTH = 128;
const RELAY_MAX_NODES = 200_000;
/** Entries read per directory; a listing beyond this is refused rather than silently cut. */
const RELAY_LIST_LIMIT = 50_000;

/** Progress is emitted at most this often per transfer (contract: ~10×/second). */
export const PROGRESS_INTERVAL_MS = 100;
/** Weight of each new sample in the smoothed throughput estimate. */
const SPEED_SMOOTHING = 0.25;

/**
 * Smoothed throughput accounting, kept free of I/O so it can be unit tested directly.
 *
 * The rate only moves on {@link sample}; it decays to zero once {@link IDLE_AFTER_MS} passes
 * without new bytes, which is what "0 when idle" in the contract means.
 */
export class ProgressMeter {
  static readonly IDLE_AFTER_MS = 1_500;

  private lastBytes = 0;
  private lastAt: number;
  private speed = 0;

  constructor(now: number = Date.now()) {
    this.lastAt = now;
  }

  /**
   * Records an absolute byte count and returns the smoothed rate.
   * `now` is injectable so tests can drive time deterministically.
   */
  sample(bytesTransferred: number, now: number = Date.now()): number {
    const elapsed = now - this.lastAt;
    if (elapsed > 0) {
      const delta = bytesTransferred - this.lastBytes;
      if (delta > 0) {
        const instant = (delta * 1000) / elapsed;
        this.speed = this.speed === 0 ? instant : this.speed * (1 - SPEED_SMOOTHING) + instant * SPEED_SMOOTHING;
      } else if (elapsed >= ProgressMeter.IDLE_AFTER_MS) {
        // No forward progress for a while: report idle rather than a stale rate.
        this.speed = 0;
      }
      this.lastBytes = bytesTransferred;
      this.lastAt = now;
    }
    return this.rate;
  }

  get rate(): number {
    if (!Number.isFinite(this.speed) || this.speed < 0) return 0;
    return Math.round(this.speed);
  }
}

export interface TransferManagerOptions {
  downloadDir: string;
  logger: Logger;
  /** §7 `maxConcurrent`; defaults to 3 like the contract's default settings. */
  maxConcurrent?: number;
  /** §7 `speedLimitKbps`; `null` means unlimited. */
  speedLimitKbps?: number | null;
}

export interface DownloadParams {
  connection: SshConnection;
  fs: SftpFs;
  remotePath: string;
  /** Explicit destination; `null`/omitted means "use the default download directory". */
  localPath?: string | null;
  name?: string;
  size?: number;
  batchId?: string;
  /** Byte offset a `Range: bytes=N-` request resumes from (contract §7). */
  resumeFrom?: number;
  /** Last byte of the requested range (inclusive); only meaningful with `resumeFrom`. */
  rangeEnd?: number;
}

export interface BatchParams {
  connection: SshConnection;
  fs: SftpFs;
  /** Absolute, already-resolved remote paths (files and/or directories). */
  paths: string[];
}

/** One top-level item of a relay batch: already resolved on the source connection. */
export interface RelayJob {
  /** Basename of the requested path — what the transfer row shows. */
  name: string;
  sourcePath: string;
  /** Where it lands on the target connection. */
  targetPath: string;
  kind: 'file' | 'directory';
  /**
   * Total bytes under this job, `-1` when unknown (a tree too large to pre-walk).
   * A directory reports the sum of its files, so one row tracks the whole subtree.
   */
  size: number;
  /** Mode to create the target with; omitted means the server default. */
  mode?: number;
}

export interface RelayParams {
  source: { connection: SshConnection; fs: SftpFs };
  target: { connection: SshConnection; fs: SftpFs };
  /** Already resolved target directory; each job keeps its source basename. */
  targetDir: string;
  jobs: RelayJob[];
  overwrite: boolean;
  /** Called once per written path, so the route can emit `fs:changed` (§8). */
  onFileDone?: (targetPath: string) => void;
}

export interface RelayStart {
  batchId: string;
  transfers: Transfer[];
}

/** Everything a route needs to stream a prepared zip to the client. */
export interface ZipStream {
  archive: Readable;
  /** Resolves once the archive has been fully produced. */
  completed: Promise<void>;
  /** Cancels every file in the batch and stops the byte flow. */
  abort: () => void;
}

interface TransferRecord {  snapshot: Transfer;
  meter: ProgressMeter;
  lastEmit: number;
  abort: (() => void) | null;
}

/**
 * Owns every upload and download, the progress bookkeeping and cancellation.
 *
 * `bytesPerSecond`, states and timestamps all live here; routes only wire HTTP streams to these
 * methods. No whole file is ever buffered in memory.
 */
export class TransferManager extends EventEmitter {
  private readonly records = new Map<string, TransferRecord>();
  /** §7: bounds how many transfers run at once; the rest stay `queued`. */
  private readonly queue: TransferQueue;
  /** §7: pauses read streams once the combined throughput budget is spent. */
  private readonly limiter: ThroughputLimiter;

  constructor(private readonly options: TransferManagerOptions) {
    super();
    this.queue = new TransferQueue(options.maxConcurrent ?? 3);
    this.limiter = new ThroughputLimiter(options.speedLimitKbps ?? null);
  }

  /** Applies the persisted §7 settings; both take effect immediately. */
  applySettings(settings: TransferSettings): void {
    this.queue.setLimit(settings.maxConcurrent);
    this.limiter.setLimit(settings.speedLimitKbps);
  }

  /** Current §7 settings, as the manager enforces them. */
  get settings(): TransferSettings {
    return { maxConcurrent: this.queue.maxConcurrent, speedLimitKbps: this.limiter.limit };
  }

  /** How many transfers are running / waiting for a slot (diagnostics and tests). */
  get queueDepth(): { active: number; queued: number } {
    return { active: this.queue.activeCount, queued: this.queue.queuedCount };
  }

  // ------------------------------------------------------------------- queries

  list(connectionId?: string): Transfer[] {
    const all = [...this.records.values()].map((record) => record.snapshot);
    return connectionId === undefined ? all : all.filter((transfer) => transfer.connectionId === connectionId);
  }

  get(id: string): Transfer {
    return this.getOrThrow(id).snapshot;
  }

  getOrThrow(id: string): TransferRecord {
    const record = this.records.get(id);
    if (record === undefined) throw notFound(`Unknown transfer: ${id}.`);
    return record;
  }

  /** Removes `done`/`error`/`cancelled` transfers; active ones are untouched. */
  clearFinished(): number {
    let removed = 0;
    for (const [id, record] of this.records) {
      if (record.snapshot.state === 'active' || record.snapshot.state === 'queued') continue;
      this.records.delete(id);
      removed += 1;
    }
    return removed;
  }

  /** Resolves the local destination for a download (§10 default download directory). */
  resolveLocalPath(localPath: string | null | undefined, name: string, downloadDir = this.options.downloadDir): string {
    if (localPath === null || localPath === undefined || localPath === '') {
      return path.join(downloadDir, name);
    }
    return path.resolve(localPath);
  }

  /** Creates a local file stream for a download target, creating parent directories first. */
  async openLocalDestination(localPath: string): Promise<Writable> {
    await mkdir(path.dirname(localPath), { recursive: true });
    return createWriteStream(localPath);
  }

  // ------------------------------------------------------------ download (single)

  /**
   * Streams one remote file into `destination` (a local file or an HTTP response) and ends the
   * destination when the transfer settles, so the caller can await a finished response.
   *
   * The bytes flow straight through: nothing is buffered and backpressure reaches the SFTP
   * read stream, which is what keeps a cancelled transfer from being queued in memory.
   */
  async downloadToStream(params: DownloadParams, destination: Writable): Promise<Transfer> {
    try {
      return await this.download(params, destination);
    } finally {
      if (!destination.writableEnded && !destination.destroyed) {
        try {
          destination.end();
        } catch {
          /* the client already went away */
        }
      }
    }
  }

  /** Streams one remote file into `destination` (a local file or an HTTP response). */
  async download(params: DownloadParams, destination: Writable): Promise<Transfer> {
    const remotePath = normalizeRemotePath(await params.fs.resolve(params.remotePath));
    const name = params.name ?? basename(remotePath);
    const resumeFrom = Number.isFinite(params.resumeFrom) ? Math.max(0, Math.floor(params.resumeFrom as number)) : 0;

    const record = this.register({
      connectionId: params.connection.id,
      direction: 'download',
      name,
      remotePath,
      localPath: params.localPath ?? null,
      size: params.size ?? -1,
    });

    // A resumed download is already partly on the client's disk, so progress starts at the
    // offset and the UI shows one continuous bar (§7 `resumedFrom`).
    record.snapshot.resumedFrom = resumeFrom;
    record.snapshot.transferred = resumeFrom;

    await this.runDownload(record, params.fs, destination, resumeFrom, params.rangeEnd);
    return record.snapshot;
  }

  private async runDownload(
    record: TransferRecord,
    fs: SftpFs,
    destination: Writable,
    resumeFrom = 0,
    rangeEnd?: number,
  ): Promise<void> {
    const transfer = record.snapshot;
    // §7 `maxConcurrent`: no byte is read until a slot is free.
    const slot = await this.queue.acquire();
    let source: Readable | null = null;

    try {
      if (transfer.state === 'cancelled') return;
      this.transition(record, 'active', { startedAt: Date.now() });

      const range =
        resumeFrom > 0
          ? { start: resumeFrom, ...(rangeEnd !== undefined && rangeEnd >= resumeFrom ? { end: rangeEnd } : {}) }
          : undefined;
      source = await fs.openReadStream(transfer.remotePath, range);
      this.limiter.track(source);
      source.on('data', (chunk: Buffer) => {
        if (transfer.state === 'cancelled') return;
        transfer.transferred += chunk.length;
        transfer.bytesPerSecond = record.meter.sample(transfer.transferred);
        this.limiter.report(chunk.length);
        this.maybeEmit(record);
      });
      // Cancelling must break the byte flow in both directions.
      record.abort = (): void => {
        source?.destroy();
        destination.destroy();
      };

      await pipeline(source, destination);
      record.abort = null;
      this.finish(record, 'done');
    } catch (err) {
      record.abort = null;
      if (transfer.state === 'cancelled') return;
      // A destination that is already gone means the client hung up (a browser that closed the
      // download, a local file handle that was dropped): that is a cancellation, not a failure,
      // and the remote read stream simply stops with it.
      if (isCancellationError(err) || destination.destroyed) {
        this.finish(record, 'cancelled');
        return;
      }
      this.finish(record, 'error', describeError(err));
      throw err instanceof ApiError ? err : mapError(err);
    } finally {
      if (source !== null) this.limiter.untrack(source);
      slot.release();
    }
  }

  // -------------------------------------------------------------- download (zip)

  /**
   * Prepares a ZIP of `paths` (directories are included recursively) and registers one
   * `download` transfer per file, all sharing a `batchId` (contract §6 `fs/download-batch`).
   *
   * The returned {@link ZipStream} is handed to the route, which pipes `archive` to the HTTP
   * response. `completed` settles once the archive has been fully produced; `abort()` stops the
   * byte flow and marks every member `cancelled`.
   *
   * `onHeader` runs after the walk succeeded but before any file data is read, so the caller can
   * still answer with a JSON error when the walk failed.
   */
  async prepareZip(
    params: BatchParams,
    onHeader: () => void | Promise<void>,
  ): Promise<ZipStream> {
    const batchId = newId('batch');
    const zip = new yazl.ZipFile();
    // `@types/yazl` declares only `NodeJS.ReadableStream`; at runtime this is a full duplex
    // stream we pipe to the response and must be able to `end()` on cancellation.
    const output = zip.outputStream as unknown as Readable & Writable;
    const archiveDir = commonParent(params.paths);

    // A zip batch is one unit of work: it takes a single §7 slot for the whole archive, since
    // every member stream has to be open at once for yazl to interleave them.
    const slot = await this.queue.acquire();
    let slotReleased = false;
    const releaseSlot = (): void => {
      if (slotReleased) return;
      slotReleased = true;
      slot.release();
    };

    // A yazl size mismatch is emitted as an `error` event on the ZipFile itself; without a
    // listener it would take the whole process down.
    let zipFailure: Error | null = null;
    zip.on('error', (err: Error) => {
      zipFailure ??= err;
      this.options.logger.warn('zip archive failed', { error: err });
    });

    const collected: { remotePath: string; size: number }[] = [];
    try {
      for (const remotePath of params.paths) {
        await this.collectEntries(params.fs, remotePath, collected);
      }
    } catch (err) {
      releaseSlot();
      throw err;
    }

    // Deduplicate by archive path: selecting a directory and a file inside it must not store
    // the same bytes twice.
    const unique: { remotePath: string; size: number; zipPath: string }[] = [];
    const seen = new Set<string>();
    for (const item of collected) {
      const zipPath = zipEntryPath(archiveDir, item.remotePath);
      if (seen.has(zipPath)) continue;
      seen.add(zipPath);
      unique.push({ ...item, zipPath });
    }

    const totalSize = unique.reduce((sum, item) => sum + item.size, 0);
    const records: TransferRecord[] = [];
    const streams = new Set<Readable>();
    let cancelled = false;

    // The walk succeeded, so headers can go out; anything after this point is streamed.
    await onHeader();

    const abort = (): void => {
      if (cancelled) return;
      cancelled = true;
      for (const record of records) {
        if (record.snapshot.state === 'active' || record.snapshot.state === 'queued') {
          this.finish(record, 'cancelled');
        }
        record.abort = null;
      }
      for (const stream of streams) stream.destroy();
      streams.clear();
      try {
        output.end();
      } catch {
        /* already finished */
      }
      releaseSlot();
    };

    try {
      for (const item of unique) {
        const record = this.register({
          connectionId: params.connection.id,
          direction: 'download',
          name: basename(item.remotePath),
          remotePath: item.remotePath,
          localPath: null,
          // Every member of a batch reports the batch total, so the UI shows one progress bar.
          size: totalSize,
          batchId,
        });
        records.push(record);
        this.transition(record, 'active', { startedAt: Date.now() });

        const source = await params.fs.openReadStream(item.remotePath);
        streams.add(source);
        this.limiter.track(source);
        source.once('close', () => {
          streams.delete(source);
          this.limiter.untrack(source);
        });

        // A single counting wrapper is handed to yazl: no extra pass-through in the chain, so
        // the bytes yazl sees are exactly the bytes SFTP delivered.
        const transfer = record.snapshot;
        const metered = new CountingStream(source, (chunk) => {
          if (transfer.state === 'cancelled') return;
          transfer.transferred += chunk.length;
          transfer.bytesPerSecond = record.meter.sample(transfer.transferred);
          this.limiter.report(chunk.length);
          this.maybeEmit(record);
        });

        zip.addReadStream(metered, item.zipPath, { size: item.size });
      }

      zip.end();
    } catch (err) {
      for (const record of records) {
        record.abort = null;
        if (record.snapshot.state === 'active' || record.snapshot.state === 'queued') {
          this.finish(record, 'error', describeError(err));
        }
      }
      abort();
      throw err instanceof ApiError ? err : mapError(err);
    }

    // All file data has been read by this point; what remains is flushing the compressed
    // stream, so the transfers are reported as done (matching the single-file download).
    for (const record of records) {
      if (record.snapshot.state === 'active') this.finish(record, 'done');
    }

    const completed = new Promise<void>((resolve, reject) => {
      if (zipFailure !== null) {
        reject(zipFailure);
        return;
      }
      output.once('error', reject);
      output.once('end', () => {
        if (zipFailure !== null) reject(zipFailure);
        else resolve();
      });
      output.once('close', () => {
        if (zipFailure !== null) reject(zipFailure);
        else resolve();
      });
    });

    // Whatever the outcome, the batch's §7 slot is handed back once the archive settles.
    void completed.then(releaseSlot, releaseSlot);

    return { archive: output, completed, abort };
  }

  /** Recursively expands a remote path into the files a zip should contain. */
  private async collectEntries(
    fs: SftpFs,
    remotePath: string,
    out: { remotePath: string; size: number }[],
    depth = 0,
  ): Promise<void> {
    if (depth > 128) throw internal('The remote directory tree is too deep.');
    const entry = await fs.stat(remotePath);
    if (entry.kind === 'directory') {
      const listing = await fs.list({ path: entry.path });
      for (const child of listing.entries) {
        await this.collectEntries(fs, child.path, out, depth + 1);
      }
      return;
    }
    out.push({ remotePath: entry.path, size: entry.kind === 'file' ? entry.size : 0 });
  }

  // -------------------------------------------------------------------- upload

  /**
   * Streams `source` straight into `sftp.createWriteStream`. Nothing is buffered: the request
   * body is the producer and SFTP is the consumer (contract §6 `fs/upload`).
   */
  async upload(params: {
    connection: SshConnection;
    fs: SftpFs;
    remotePath: string;
    source: Readable;
    size?: number;
  }): Promise<Transfer> {
    const remotePath = normalizeRemotePath(await params.fs.resolve(params.remotePath));
    const record = this.register({
      connectionId: params.connection.id,
      direction: 'upload',
      name: basename(remotePath),
      remotePath,
      localPath: null,
      size: params.size ?? -1,
    });

    const transfer = record.snapshot;
    // §7 `maxConcurrent`: the request body is not consumed until a slot is free.
    const slot = await this.queue.acquire();

    let target: Writable | null = null;
    try {
      if (transfer.state === 'cancelled') return transfer;
      this.transition(record, 'active', { startedAt: Date.now() });

      target = await params.fs.openWriteStream(remotePath);
      // §7 `speedLimitKbps` covers every active transfer, uploads included: pausing the request
      // body is what pushes back on the client that is sending it.
      this.limiter.track(params.source);
      params.source.on('data', (chunk: Buffer) => {
        if (transfer.state === 'cancelled') return;
        transfer.transferred += chunk.length;
        transfer.bytesPerSecond = record.meter.sample(transfer.transferred);
        this.limiter.report(chunk.length);
        this.maybeEmit(record);
      });
      record.abort = (): void => {
        params.source.unpipe();
        params.source.destroy();
        target?.destroy();
      };

      await pipeline(params.source, target);
      record.abort = null;
      this.finish(record, 'done');
      return transfer;
    } catch (err) {
      record.abort = null;
      if (transfer.state === 'cancelled') return transfer;
      if (isCancellationError(err)) {
        this.finish(record, 'cancelled');
        return transfer;
      }
      this.finish(record, 'error', describeError(err));
      throw err instanceof ApiError ? err : mapError(err);
    } finally {
      this.limiter.untrack(params.source);
      slot.release();
    }
  }

  // -------------------------------------------------------------------- relay

  /**
   * Server-to-server copy (contract §7): reads from the source connection's SFTP session and
   * writes to the target's, registering one `relay` transfer per requested path under one
   * `batchId`.
   *
   * A directory is one transfer for the whole subtree, not one per file: a project with a
   * thousand files would otherwise bury every other transfer in the list. Its `size` is the
   * sum of the files below it and `transferred` accumulates as they land, so the row still
   * shows real progress.
   *
   * The batch is started here and runs in the background — the route answers `202` with the
   * queued transfers, and progress keeps flowing over the event bus. A path that fails is
   * marked `error` and the remaining paths are still attempted.
   */
  startRelay(params: RelayParams): RelayStart {
    const batchId = newId('batch');
    const records = params.jobs.map((job) =>
      this.register({
        connectionId: params.target.connection.id,
        direction: 'relay',
        name: job.name,
        // The transfer belongs to the connection it is written to, so `remotePath` is the
        // destination path — the same convention an upload uses.
        remotePath: job.targetPath,
        localPath: null,
        size: job.size,
        batchId,
      }),
    );

    void this.runRelayBatch(params, records).catch((err: unknown) => {
      this.options.logger.warn('relay batch failed', { error: err });
    });

    return { batchId, transfers: records.map((record) => ({ ...record.snapshot })) };
  }

  private async runRelayBatch(params: RelayParams, records: TransferRecord[]): Promise<void> {
    for (let index = 0; index < records.length; index += 1) {
      const record = records[index] as TransferRecord;
      const job = params.jobs[index] as RelayJob;
      try {
        await this.runRelayJob(record, params, job);
      } catch (err) {
        // §7: one failing path must not abort the batch; the record already carries the error.
        this.options.logger.debug('relay job failed', { id: record.snapshot.id, error: err });
      }
    }
  }

  private async runRelayJob(record: TransferRecord, params: RelayParams, job: RelayJob): Promise<void> {
    try {
      if (job.kind === 'directory') {
        await this.runRelayTree(record, params, job.sourcePath, job.targetPath, 0, {
          nodes: 0,
          cancelled: false,
        });
      } else {
        await this.relayBytes(record, params, job.sourcePath, job.targetPath, job.mode);
      }

      // Cancelling finishes the record itself; do not overwrite that verdict.
      if (record.snapshot.state === 'cancelled') return;
      if (record.snapshot.state === 'queued') {
        // An empty directory never opened a stream, so it is still queued here.
        this.transition(record, 'active', { startedAt: Date.now() });
      }
      this.finish(record, 'done');
    } catch (err) {
      record.abort = null;
      if (record.snapshot.state === 'cancelled') return;
      if (isCancellationError(err)) {
        this.finish(record, 'cancelled');
        return;
      }
      this.finish(record, 'error', describeError(err));
      throw err instanceof ApiError ? err : mapError(err);
    }
  }

  /** A method call, so TypeScript does not carry a stale narrowing across the walk. */
  private isCancelled(record: TransferRecord): boolean {
    return record.snapshot.state === 'cancelled';
  }

  /**
   * Walks one source tree and mirrors it onto the target.
   *
   * Symlinks are recreated rather than followed, so a link pointing at a parent directory
   * cannot turn the copy into an infinite loop. The depth cap is the second line of defence:
   * a bind mount or a symlink the server resolves for us would otherwise recurse forever.
   */
  private async runRelayTree(
    record: TransferRecord,
    params: RelayParams,
    sourcePath: string,
    targetPath: string,
    depth: number,
    state: { nodes: number; cancelled: boolean },
  ): Promise<void> {
    if (record.snapshot.state === 'cancelled') {
      state.cancelled = true;
      return;
    }
    if (depth > RELAY_MAX_DEPTH) {
      throw new ApiError('BAD_REQUEST', `Refusing to relay ${sourcePath}: deeper than ${RELAY_MAX_DEPTH} levels.`, {
        path: sourcePath,
      });
    }
    state.nodes += 1;
    if (state.nodes > RELAY_MAX_NODES) {
      throw new ApiError('BAD_REQUEST', `Refusing to relay ${sourcePath}: more than ${RELAY_MAX_NODES} entries.`, {
        path: sourcePath,
      });
    }

    // lstat semantics: a symlink stays a symlink and is never traversed.
    const entry = await params.source.fs.stat(sourcePath, false);

    if (entry.kind === 'symlink') {
      const linkTarget = entry.target ?? (await params.source.fs.readlink(sourcePath));
      if (linkTarget === null) {
        throw new ApiError('SFTP_ERROR', `Could not read the symlink target of ${sourcePath}.`, { path: sourcePath });
      }
      if (params.overwrite && (await params.target.fs.exists(targetPath))) {
        await params.target.fs.remove([targetPath], true);
      }
      if (!(await params.target.fs.exists(targetPath))) {
        await params.target.fs.symlink(targetPath, linkTarget);
        params.onFileDone?.(targetPath);
      }
      return;
    }

    if (entry.kind === 'directory') {
      await params.target.fs.mkdirRecursive(targetPath);
      const listing = await params.source.fs.list({ path: sourcePath, limit: RELAY_LIST_LIMIT });
      for (const child of listing.entries) {
        if (state.cancelled || this.isCancelled(record)) {
          state.cancelled = true;
          return;
        }
        await this.runRelayTree(
          record,
          params,
          child.path,
          joinRemotePath(targetPath, child.name),
          depth + 1,
          state,
        );
      }
      // After the children, so a read-only source directory does not block its own contents.
      await params.target.fs.chmod(targetPath, entry.mode & 0o7777).catch(() => undefined);
      return;
    }

    await this.relayBytes(record, params, sourcePath, targetPath, entry.mode);
  }

  /** Streams one file across, counting the bytes into the transfer's progress. */
  private async relayBytes(
    record: TransferRecord,
    params: RelayParams,
    sourcePath: string,
    targetPath: string,
    mode: number | undefined,
  ): Promise<void> {
    const transfer = record.snapshot;
    const slot = await this.queue.acquire();
    let source: Readable | null = null;
    let target: Writable | null = null;

    try {
      if (transfer.state === 'cancelled') return;

      if (await params.target.fs.exists(targetPath)) {
        if (!params.overwrite) {
          // Inside a tree the caller asked for as a whole, an existing file is replaced
          // rather than silently skipped: `relay` mirrors a path, it does not merge.
          throw new ApiError('CONFLICT', `${targetPath} already exists.`, { path: targetPath });
        }
        await params.target.fs.remove([targetPath], true);
      }

      if (transfer.state === 'queued') this.transition(record, 'active', { startedAt: Date.now() });
      source = await params.source.fs.openReadStream(sourcePath);
      target = await params.target.fs.openWriteStream(
        targetPath,
        mode === undefined ? undefined : mode & 0o7777,
      );

      this.limiter.track(source);
      // Progress is reported from the read side: that is where the bytes are counted.
      source.on('data', (chunk: Buffer) => {
        if (transfer.state === 'cancelled') return;
        transfer.transferred += chunk.length;
        transfer.bytesPerSecond = record.meter.sample(transfer.transferred);
        this.limiter.report(chunk.length);
        this.maybeEmit(record);
      });
      record.abort = (): void => {
        source?.destroy();
        target?.destroy();
      };

      await pipeline(source, target);
      record.abort = null;
      params.onFileDone?.(targetPath);
    } finally {
      if (source !== null) this.limiter.untrack(source);
      slot.release();
    }
  }

  // ------------------------------------------------------------------ lifecycle

  /** Cancels one transfer. `queued` transfers move to `cancelled` without any I/O. */
  cancel(id: string): Transfer {
    const record = this.getOrThrow(id);
    if (record.snapshot.state === 'done' || record.snapshot.state === 'error' || record.snapshot.state === 'cancelled') {
      return record.snapshot;
    }
    this.finish(record, 'cancelled');
    const abort = record.abort;
    record.abort = null;
    abort?.();
    return record.snapshot;
  }

  /** Cancels everything belonging to one connection (contract §11.10). */
  cancelForConnection(connectionId: string): void {
    for (const [id, record] of this.records) {
      if (record.snapshot.connectionId !== connectionId) continue;
      if (record.snapshot.state !== 'active' && record.snapshot.state !== 'queued') continue;
      try {
        this.cancel(id);
      } catch {
        /* keep going: one failure must not block teardown */
      }
    }
  }

  /** Cancels every in-flight transfer. Called by `RunningServer.close()`. */
  cancelAll(): void {
    for (const [id, record] of this.records) {
      if (record.snapshot.state !== 'active' && record.snapshot.state !== 'queued') continue;
      try {
        this.cancel(id);
      } catch {
        /* ignore */
      }
    }
  }

  /**
   * Cancels everything and tears down the queue/throttle timers. Called by
   * `RunningServer.close()` so no waiting request and no timer outlives the server.
   */
  shutdown(): void {
    this.cancelAll();
    this.queue.close();
    this.limiter.dispose();
  }

  /**
   * Restarts a failed or cancelled transfer (contract §7).
   *
   * A download is re-queued: its bytes have no destination of their own server-side, so the next
   * `fs/download` of the same path is what drives them. An upload cannot be replayed at all
   * because the request body has been consumed, so it is refused with `409 CONFLICT`.
   * A transfer that is still running or already finished is returned unchanged.
   */
  retry(id: string): { transfer: Transfer } {
    const record = this.getOrThrow(id);
    const transfer = record.snapshot;

    if (transfer.state === 'active' || transfer.state === 'queued' || transfer.state === 'done') {
      return { transfer };
    }
    if (transfer.direction === 'upload') {
      throw conflict('An upload cannot be retried; send the file again.', { id, state: transfer.state });
    }

    transfer.error = undefined;
    transfer.transferred = 0;
    transfer.bytesPerSecond = 0;
    transfer.resumedFrom = 0;
    transfer.finishedAt = null;
    this.transition(record, 'queued');
    return { transfer };
  }

  // ----------------------------------------------------------------- internals

  private register(params: {
    connectionId: string;
    direction: TransferDirection;
    name: string;
    remotePath: string;
    localPath: string | null;
    size: number;
    batchId?: string;
  }): TransferRecord {
    const id = newId('tx');
    const snapshot: Transfer = {
      id,
      connectionId: params.connectionId,
      direction: params.direction,
      name: params.name,
      remotePath: params.remotePath,
      localPath: params.localPath,
      size: params.size,
      transferred: 0,
      state: 'queued',
      startedAt: Date.now(),
      finishedAt: null,
      bytesPerSecond: 0,
      // §7: only a download can be re-requested with a `Range` header.
      resumable: params.direction === 'download',
      resumedFrom: 0,
    };
    if (params.batchId !== undefined) snapshot.batchId = params.batchId;

    const record: TransferRecord = {
      snapshot,
      meter: new ProgressMeter(),
      lastEmit: 0,
      abort: null,
    };
    this.records.set(id, record);
    this.emitUpdate(record, true);
    return record;
  }

  private transition(record: TransferRecord, state: TransferState, patch: Partial<Transfer> = {}): void {
    Object.assign(record.snapshot, patch, { state });
    if (state === 'done' || state === 'error' || state === 'cancelled') {
      record.snapshot.finishedAt = Date.now();
      if (state !== 'done') record.snapshot.bytesPerSecond = 0;
    }
    this.emitUpdate(record, true);
  }

  private finish(record: TransferRecord, state: 'done' | 'error' | 'cancelled', error?: string): void {
    const current = record.snapshot.state;
    if (current === 'done' || current === 'error' || current === 'cancelled') return;
    if (state === 'error' && error !== undefined) record.snapshot.error = error;
    this.transition(record, state);
  }

  /** Emits at most ~10 updates per second per transfer; state changes always emit. */
  private maybeEmit(record: TransferRecord): void {
    const now = Date.now();
    if (now - record.lastEmit < PROGRESS_INTERVAL_MS) return;
    this.emitUpdate(record, false, now);
  }

  private emitUpdate(record: TransferRecord, force: boolean, now = Date.now()): void {
    if (!force && now - record.lastEmit < PROGRESS_INTERVAL_MS) return;
    record.lastEmit = now;
    this.emit('transfer:update', record.snapshot);
  }
}

// -------------------------------------------------------------------- utilities

/**
 * Passes `source` through unchanged while reporting every chunk to `onChunk`.
 *
 * Used instead of an extra `PassThrough` stage so the stream handed to `yazl` is the only
 * consumer of the SFTP read stream: one pipe, exact backpressure, and no buffered copy that can
 * be dropped when a pass-through auto-destroys at EOF.
 */
export class CountingStream extends Readable {
  private readonly source: Readable;
  private readonly onChunk: (chunk: Buffer) => void;
  private sourceEnded = false;
  private sourceErrored = false;
  /** Bytes pushed downstream so far. */
  counted = 0;

  constructor(source: Readable, onChunk: (chunk: Buffer) => void) {
    super();
    this.source = source;
    this.onChunk = onChunk;

    source.on('data', (chunk: Buffer) => {
      this.counted += chunk.length;
      this.onChunk(chunk);
      if (!this.push(chunk)) source.pause();
    });
    source.on('end', () => {
      this.sourceEnded = true;
      this.push(null);
    });
    // The error is forwarded, not re-emitted by `destroy()`: `destroy(err)` can fire before a
    // consumer attaches a listener, which would surface as an unhandled 'error' event.
    source.on('error', (err: Error) => {
      this.sourceErrored = true;
      this.emit('error', err);
    });
    source.on('close', () => {
      // A stream that closes without ending (SFTP session loss) must not hang the archive:
      // end the readable side so yazl notices the short read.
      if (!this.sourceEnded && !this.sourceErrored && !this.readableEnded) this.push(null);
    });
  }

  override _read(): void {
    this.source.resume();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    // A clean destroy (error === null) must not look like a failure to the source.
    this.source.destroy(error ?? undefined);
    callback(error);
  }
}

/** Longest directory prefix shared by every path (used to trim zip entry names). */
export function commonParent(paths: readonly string[]): string {
  if (paths.length === 0) return '/';
  const split = paths.map((item) => normalizeRemotePath(item).split('/'));
  const first = split[0] as string[];
  const shared: string[] = [];
  // The last segment of a path is its name, never part of the shared directory.
  for (let index = 0; index < first.length - 1; index += 1) {
    const segment = first[index];
    if (segment === undefined) break;
    if (split.every((parts) => parts[index] === segment)) shared.push(segment);
    else break;
  }
  const joined = shared.join('/');
  return joined === '' ? '/' : joined;
}

/** Zip entry name: paths are stored relative to their common parent directory. */
export function zipEntryPath(parent: string, remotePath: string): string {
  const normalized = normalizeRemotePath(remotePath);
  if (parent === '/' || parent === '') return normalized.replace(/^\/+/, '');
  if (normalized === parent) return basename(normalized);
  if (normalized.startsWith(`${parent}/`)) return normalized.slice(parent.length + 1);
  return normalized.replace(/^\/+/, '');
}

function isCancellationError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ABORT_ERR') return true;
  const message = (err as { message?: unknown }).message;
  return typeof message === 'string' && /premature close|aborted/i.test(message);
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  const api = mapError(err);
  if (api.code !== 'INTERNAL') return api.message;
  return err instanceof Error ? err.message : 'Unknown transfer error.';
}
