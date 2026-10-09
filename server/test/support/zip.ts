/**
 * Minimal ZIP reader for the batch-download tests (`POST …/fs/download-batch`).
 *
 * Deliberately dependency-free: it walks the End Of Central Directory record, then
 * the central directory, then each local header, and inflates deflate entries with
 * `node:zlib`. CRC-32 and both size fields are verified, so a corrupted or
 * truncated archive fails the test instead of silently passing.
 */
import zlib from 'node:zlib';

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

export interface ZipEntry {
  name: string;
  /** True when the entry name ends with "/" (directory entry). */
  directory: boolean;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  method: number;
  content: Buffer;
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

export function crc32(buffer: Buffer): number {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]!) & 0xff]!;
  }
  return (crc ^ -1) >>> 0;
}

/** Parses a ZIP archive held in memory. Throws on malformed input. */
export function parseZip(buffer: Buffer): ZipEntry[] {
  if (buffer.length < 22) throw new Error(`not a ZIP archive: only ${buffer.length} bytes`);

  let eocd = -1;
  const scanStart = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= scanStart; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('ZIP end-of-central-directory record not found');

  const totalEntries = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  if (centralOffset + centralSize > buffer.length) {
    throw new Error('ZIP central directory is out of bounds (truncated archive?)');
  }

  const entries: ZipEntry[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error(`bad central directory signature at entry ${index} (offset ${cursor})`);
    }
    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');

    if (buffer.readUInt32LE(localOffset) !== LOCAL_SIGNATURE) {
      throw new Error(`bad local header signature for ${name}`);
    }
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    let content: Buffer;
    if (method === 0) content = Buffer.from(raw);
    else if (method === 8) content = zlib.inflateRawSync(raw);
    else throw new Error(`unsupported ZIP compression method ${method} for ${name}`);

    if ((flags & 0x8) === 0 && content.length !== uncompressedSize) {
      throw new Error(`size mismatch for ${name}: ${content.length} != ${uncompressedSize}`);
    }
    if (crc32(content) !== crc) {
      throw new Error(`CRC-32 mismatch for ${name}`);
    }

    entries.push({
      name,
      directory: name.endsWith('/'),
      compressedSize,
      uncompressedSize: content.length,
      crc32: crc,
      method,
      content,
    });

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

/** Convenience lookup: entry content by exact name, or by basename match. */
export function entryContent(entries: ZipEntry[], name: string): Buffer | undefined {
  const exact = entries.find((entry) => entry.name === name);
  if (exact) return exact.content;
  const base = name.split('/').pop();
  const byBase = entries.find((entry) => entry.name.split('/').pop() === base && !entry.directory);
  return byBase?.content;
}
