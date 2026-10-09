/**
 * A minimal, random-access ZIP reader (contract §6 `fs/extract`).
 *
 * `yazl` (the writer already in `package.json`) cannot read, and we do not want another
 * dependency just to inspect an archive, so this walks the End Of Central Directory record and
 * the central directory through ranged reads. Nothing is buffered beyond one record, which is
 * what keeps a multi-gigabyte archive extractable over SFTP.
 */

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

const S_IFMT = 0o170000;
const S_IFLNK = 0o120000;
const S_IFDIR = 0o040000;

export const ZIP_METHOD_STORE = 0;
export const ZIP_METHOD_DEFLATE = 8;

/** Inclusive byte range read; `end` is the last byte to return. */
export type ReadRange = (start: number, end: number) => Promise<Buffer>;

export interface ZipEndRecord {
  totalEntries: number;
  centralSize: number;
  centralOffset: number;
}

export interface ZipEntryMeta {
  name: string;
  directory: boolean;
  symlink: boolean;
  /** UNIX mode bits from the external attributes; 0 when the archive has none. */
  mode: number;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  localHeaderOffset: number;
}

export interface ZipDirectory {
  entries: ZipEntryMeta[];
  /** True when the entry cap stopped the listing early. */
  truncated: boolean;
}

export interface ZipDirectoryOptions {
  /** Cap on the number of entries read from the central directory. */
  maxEntries?: number;
}

/** Locates and parses the End Of Central Directory record inside `buffer` (the file tail). */
export function findZipEndRecord(buffer: Buffer): ZipEndRecord {
  if (buffer.length < 22) throw new Error('not a ZIP archive');
  const scanStart = Math.max(0, buffer.length - 22 - 0xffff);
  for (let index = buffer.length - 22; index >= scanStart; index -= 1) {
    if (buffer.readUInt32LE(index) !== EOCD_SIGNATURE) continue;
    const totalEntries = buffer.readUInt16LE(index + 10);
    const centralSize = buffer.readUInt32LE(index + 12);
    const centralOffset = buffer.readUInt32LE(index + 16);
    if (totalEntries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
      throw new Error('ZIP64 archives are not supported');
    }
    return { totalEntries, centralSize, centralOffset };
  }
  throw new Error('ZIP end-of-central-directory record not found');
}

/** Parses a central directory that starts at its first byte. */
export function parseZipCentralDirectory(
  central: Buffer,
  totalEntries: number,
  options: ZipDirectoryOptions = {},
): ZipDirectory {
  const maxEntries = options.maxEntries ?? 50_000;
  const entries: ZipEntryMeta[] = [];
  let cursor = 0;
  let truncated = false;

  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + 46 > central.length) {
      throw new Error('ZIP central directory is truncated');
    }
    if (central.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new Error(`bad central directory signature at entry ${index}`);
    }
    const method = central.readUInt16LE(cursor + 10);
    const crc32 = central.readUInt32LE(cursor + 16);
    const compressedSize = central.readUInt32LE(cursor + 20);
    const uncompressedSize = central.readUInt32LE(cursor + 24);
    const nameLength = central.readUInt16LE(cursor + 28);
    const extraLength = central.readUInt16LE(cursor + 30);
    const commentLength = central.readUInt16LE(cursor + 32);
    const externalAttributes = central.readUInt32LE(cursor + 38);
    const localHeaderOffset = central.readUInt32LE(cursor + 42);
    const name = central.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');

    if (entries.length >= maxEntries) {
      truncated = true;
      break;
    }

    const mode = (externalAttributes >>> 16) & 0xffff;
    const type = mode & S_IFMT;
    entries.push({
      name,
      directory: name.endsWith('/') || type === S_IFDIR,
      symlink: type === S_IFLNK,
      mode,
      method,
      compressedSize,
      uncompressedSize,
      crc32,
      localHeaderOffset,
    });

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return { entries, truncated };
}

/** Reads the central directory of an archive through ranged reads. */
export async function readZipDirectory(
  readRange: ReadRange,
  fileSize: number,
  options: ZipDirectoryOptions = {},
): Promise<ZipDirectory> {
  const tailLength = Math.min(fileSize, 22 + 0xffff);
  if (tailLength < 22) throw new Error('not a ZIP archive');
  const tail = await readRange(fileSize - tailLength, fileSize - 1);
  const end = findZipEndRecord(tail);
  if (end.centralSize === 0) return { entries: [], truncated: false };

  const central = await readRange(end.centralOffset, end.centralOffset + end.centralSize - 1);
  return parseZipCentralDirectory(central, end.totalEntries, options);
}

export interface ZipLocalHeader {
  /** Absolute offset of the first compressed data byte. */
  dataOffset: number;
}

/** Parses the local file header so the compressed payload can be ranged-read directly. */
export function parseZipLocalHeader(buffer: Buffer, offset: number): ZipLocalHeader {
  if (buffer.length < 30) throw new Error('truncated ZIP local header');
  if (buffer.readUInt32LE(0) !== LOCAL_SIGNATURE) throw new Error(`bad ZIP local header at offset ${offset}`);
  const nameLength = buffer.readUInt16LE(26);
  const extraLength = buffer.readUInt16LE(28);
  return { dataOffset: offset + 30 + nameLength + extraLength };
}

/** True when the buffer starts with a ZIP signature (a local header or an empty archive). */
export function looksLikeZip(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  const signature = buffer.readUInt32LE(0);
  return signature === LOCAL_SIGNATURE || signature === EOCD_SIGNATURE;
}
