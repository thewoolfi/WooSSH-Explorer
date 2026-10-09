/**
 * A minimal USTAR writer/parser, used by `fs/archive` and `fs/extract` when the remote host has
 * no `tar` binary (contract §6).
 *
 * Deliberately small but correct for the cases the API needs: regular files, directories,
 * symlinks, the GNU long-name extension (`././@LongLink`) and the POSIX `prefix` field. The
 * parser validates the header checksum, so a random blob is never mistaken for an archive.
 */

export const TAR_BLOCK_SIZE = 512;

/** The tar type flags this server understands. */
export type TarTypeFlag = '0' | '2' | '5' | 'L' | 'x' | 'g' | '1' | '3' | '4' | '6';

export interface TarWriteEntry {
  name: string;
  /** POSIX mode bits (permission bits only; the type lives in `typeflag`). */
  mode: number;
  size: number;
  mtimeMs: number;
  typeflag: TarTypeFlag;
  linkname?: string;
  uid?: number;
  gid?: number;
}

export interface TarReadEntry {
  name: string;
  typeflag: TarTypeFlag | string;
  size: number;
  mode: number;
  mtimeMs: number;
  linkname: string;
  /** True for a regular file (`0` or the historic NUL flag). */
  isFile: boolean;
  isDirectory: boolean;
  isSymlink: boolean;
  isHardLink: boolean;
  /** True for metadata entries the caller should consume and not extract. */
  isMetadata: boolean;
}

function writeOctal(target: Buffer, offset: number, length: number, value: number): void {
  const clamped = Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  const text = clamped.toString(8).slice(-(length - 1)).padStart(length - 1, '0');
  target.write(text, offset, length - 1, 'ascii');
  target.writeUInt8(0, offset + length - 1);
}

function readOctal(source: Buffer, offset: number, length: number): number {
  const raw = source.subarray(offset, offset + length);
  // Some writers emit a NUL or space terminated value; GNU also emits a base-256 value for
  // huge sizes, which we deliberately do not support (the size then stays 0 and the entry is
  // treated as empty rather than truncating a real file silently).
  if ((raw[0] as number) > 0x7f) return 0;
  const text = raw.toString('ascii').replace(/\0.*$/s, '').trim();
  if (text === '') return 0;
  const parsed = Number.parseInt(text, 8);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** Splits a name into the USTAR `prefix`/`name` pair, or `null` when it does not fit. */
export function splitUstarName(name: string): { name: string; prefix: string } | null {
  const bytes = Buffer.byteLength(name, 'utf8');
  if (bytes <= 100) return { name, prefix: '' };
  // Prefer a split on a `/` so `prefix` holds the directory part.
  for (let index = name.length - 1; index > 0; index -= 1) {
    if (name[index] !== '/') continue;
    const prefix = name.slice(0, index);
    const rest = name.slice(index + 1);
    if (rest === '') continue;
    if (Buffer.byteLength(prefix, 'utf8') <= 155 && Buffer.byteLength(rest, 'utf8') <= 100) {
      return { name: rest, prefix };
    }
  }
  return null;
}

/** Type flags whose payload is empty by definition (their `size` field must be zero). */
const SIZE_LESS_TYPES: ReadonlySet<string> = new Set(['1', '2', '3', '4', '5', '6']);

/** Builds one 512-byte header block. Long names are handled by the caller (GNU `L` entry). */
export function tarHeaderBlock(entry: TarWriteEntry): Buffer {
  const block = Buffer.alloc(TAR_BLOCK_SIZE);
  const split = splitUstarName(entry.name) ?? { name: entry.name.slice(0, 100), prefix: '' };

  block.write(split.name.slice(0, 100), 0, 100, 'utf8');
  writeOctal(block, 100, 8, entry.mode & 0o7777);
  writeOctal(block, 108, 8, entry.uid ?? 0);
  writeOctal(block, 116, 8, entry.gid ?? 0);
  writeOctal(block, 124, 12, SIZE_LESS_TYPES.has(entry.typeflag) ? 0 : entry.size);
  writeOctal(block, 136, 12, Math.floor((entry.mtimeMs ?? 0) / 1000));
  // The checksum is computed with its own field filled with spaces.
  block.fill(0x20, 148, 156);
  block.write(entry.typeflag, 156, 1, 'ascii');
  block.write((entry.linkname ?? '').slice(0, 100), 157, 100, 'utf8');
  block.write('ustar\0', 257, 6, 'ascii');
  block.write('00', 263, 2, 'ascii');
  block.write('root', 265, 32, 'ascii');
  block.write('root', 297, 32, 'ascii');
  block.write(split.prefix.slice(0, 155), 345, 155, 'utf8');

  let checksum = 0;
  for (const byte of block) checksum += byte;
  const text = checksum.toString(8).padStart(6, '0');
  block.write(text, 148, 6, 'ascii');
  block.writeUInt8(0, 154);
  block.writeUInt8(0x20, 155);
  return block;
}

/** The GNU long-name entry that precedes a header whose name does not fit in 100 bytes. */
export const GNU_LONG_NAME_PATH = '././@LongLink';

export function gnuLongNameBlocks(name: string): { header: Buffer; data: Buffer } {
  const payload = Buffer.from(`${name}\0`, 'utf8');
  const padded = Buffer.alloc(Math.ceil(payload.length / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE);
  payload.copy(padded);
  return {
    header: tarHeaderBlock({
      name: GNU_LONG_NAME_PATH,
      mode: 0o644,
      size: payload.length,
      mtimeMs: 0,
      typeflag: 'L',
    }),
    data: padded,
  };
}

/** True when a 512-byte block is the end-of-archive marker (all zeroes). */
export function isZeroBlock(block: Buffer): boolean {
  for (const byte of block) {
    if (byte !== 0) return false;
  }
  return true;
}

/** True when the block carries a plausible USTAR header (magic + checksum). */
export function looksLikeTarHeader(block: Buffer): boolean {
  if (block.length < TAR_BLOCK_SIZE) return false;
  const magic = block.subarray(257, 262).toString('ascii');
  if (magic !== 'ustar') return false;
  return tarHeaderChecksumOk(block);
}

function tarHeaderChecksumOk(block: Buffer): boolean {
  const stored = readOctal(block, 148, 8);
  let sum = 0;
  for (let index = 0; index < TAR_BLOCK_SIZE; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : (block[index] as number);
  }
  return stored === sum;
}

/** Parses one 512-byte header block; `null` for the end-of-archive block or a bad checksum. */
export function parseTarHeader(block: Buffer): TarReadEntry | null {
  if (block.length < TAR_BLOCK_SIZE) return null;
  if (isZeroBlock(block)) return null;
  if (!tarHeaderChecksumOk(block)) return null;

  const typeflagRaw = block.subarray(156, 157).toString('ascii');
  const typeflag = typeflagRaw === '\0' || typeflagRaw === '' ? '0' : typeflagRaw;
  const prefix = block.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
  const bare = block.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
  const name = prefix === '' ? bare : `${prefix}/${bare}`;
  const size = readOctal(block, 124, 12);

  return {
    name,
    typeflag,
    size,
    mode: readOctal(block, 100, 8),
    mtimeMs: readOctal(block, 136, 12) * 1000,
    linkname: block.subarray(157, 257).toString('utf8').replace(/\0.*$/s, ''),
    isFile: typeflag === '0' || typeflag === '7',
    isDirectory: typeflag === '5' || (typeflag === '0' && name.endsWith('/')),
    isSymlink: typeflag === '2',
    isHardLink: typeflag === '1',
    isMetadata: typeflag === 'x' || typeflag === 'g' || typeflag === 'L' || typeflag === 'K',
  };
}

/** Rounds a byte count up to the next 512-byte block boundary. */
export function tarPadding(size: number): number {
  const remainder = size % TAR_BLOCK_SIZE;
  return remainder === 0 ? 0 : TAR_BLOCK_SIZE - remainder;
}
