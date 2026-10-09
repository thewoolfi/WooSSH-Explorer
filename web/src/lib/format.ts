/** Value formatting for the file browser chrome. */

const KB = 1024;
const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** Compact binary size: `0 B`, `916 B`, `1.4 KB`, `12.8 MB`. */
export function formatBytes(bytes: number, precision?: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < KB) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  while (value >= KB && unit < UNITS.length - 1) {
    value /= KB;
    unit += 1;
  }
  const digits = precision ?? (value < 10 ? 1 : value < 100 ? 1 : 0);
  return `${value.toFixed(digits)} ${UNITS[unit]}`;
}

/** Fixed-width size column: right aligned, monospace friendly. */
export function formatSizeColumn(bytes: number): string {
  if (bytes < 0) return '—';
  if (bytes < KB) return `${bytes}`;
  let value = bytes;
  let unit = 0;
  while (value >= KB && unit < UNITS.length - 1) {
    value /= KB;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${UNITS[unit]}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad2 = (value: number) => String(value).padStart(2, '0');

/**
 * `08 Oct 15:10` — deliberately locale-independent. A file browser's timestamps
 * are technical data, and a stable width keeps the monospace column aligned.
 */
export function formatDate(ms: number): string {
  if (!ms) return '—';
  const date = new Date(ms);
  return `${pad2(date.getDate())} ${MONTHS[date.getMonth()]} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** `08 Oct 2026, 15:10` */
export function formatFullDate(ms: number): string {
  if (!ms) return '—';
  const date = new Date(ms);
  return `${pad2(date.getDate())} ${MONTHS[date.getMonth()]} ${date.getFullYear()}, ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

/** `just now`, `4 min ago`, `3 d ago`. */
export function formatRelative(ms: number): string {
  if (!ms) return '—';
  const delta = Date.now() - ms;
  if (delta < 45_000) return 'just now';
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} mo ago`;
  return `${Math.round(months / 12)} y ago`;
}

/** `48.2 MB/s` */
export function formatSpeed(bytesPerSecond: number): string {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '—';
  return `${formatBytes(bytesPerSecond, 1)}/s`;
}

/** `~12 s left`, `~3 min left`. */
export function formatEta(remainingBytes: number, bytesPerSecond: number): string {
  if (bytesPerSecond <= 0 || remainingBytes <= 0) return '';
  const seconds = remainingBytes / bytesPerSecond;
  if (seconds < 60) return `~${Math.max(1, Math.round(seconds))} s left`;
  return `~${Math.round(seconds / 60)} min left`;
}

/** Raw POSIX mode bits → `-rw-r--r--`. */
export function modeToText(mode: number): string {
  if (!Number.isFinite(mode)) return '----------';
  const kind =
    (mode & 0o170000) === 0o040000
      ? 'd'
      : (mode & 0o170000) === 0o120000
        ? 'l'
        : (mode & 0o170000) === 0o020000
          ? 'c'
          : (mode & 0o170000) === 0o060000
            ? 'b'
            : (mode & 0o170000) === 0o010000
              ? 'p'
              : (mode & 0o170000) === 0o140000
                ? 's'
                : '-';
  const bits = ['r', 'w', 'x', 'r', 'w', 'x', 'r', 'w', 'x'];
  const masks = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001];
  let out = kind;
  for (let i = 0; i < 9; i += 1) {
    out += mode & (masks[i] as number) ? (bits[i] as string) : '-';
  }
  // setuid / setgid / sticky
  if (mode & 0o4000) out = `${out.slice(0, 3)}${out[3] === 'x' ? 's' : 'S'}${out.slice(4)}`;
  if (mode & 0o2000) out = `${out.slice(0, 6)}${out[6] === 'x' ? 's' : 'S'}${out.slice(7)}`;
  if (mode & 0o1000) out = `${out.slice(0, 9)}${out[9] === 'x' ? 't' : 'T'}`;
  return out;
}

/** Permission shorthand used by the inspector: `drwxr-xr-x · 755`. */
export function modeToOctal(mode: number): string {
  return (mode & 0o7777).toString(8).padStart(3, '0');
}

export function formatCount(value: number, singular: string, plural?: string): string {
  return `${value.toLocaleString()} ${value === 1 ? singular : (plural ?? `${singular}s`)}`;
}

export function formatPercent(done: number, total: number): number {
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(100, (done / total) * 100));
}

/** Human label for the file-type tile in the inspector. */
export function describeKind(name: string, kind: string): string {
  if (kind === 'directory') return 'Folder';
  if (kind === 'symlink') return 'Symbolic link';
  const ext = extensionOf(name);
  if (!ext) return 'File';
  return `${ext.toUpperCase()} file`;
}

export function extensionOf(name: string): string {
  const base = name.startsWith('.') ? name.slice(1) : name;
  const dot = base.lastIndexOf('.');
  if (dot <= 0 || dot === base.length - 1) return '';
  return base.slice(dot + 1).toLowerCase();
}
