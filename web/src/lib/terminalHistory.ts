/**
 * Extracts a typed or executed command from a terminal line or input buffer.
 *
 * Terminal buffers contain the full line (prompt + command + trailing whitespace).
 * If the user typed something in `typedBuffer` and the line ends with it, that
 * is used directly. Otherwise, common shell prompt markers ($ , # , % , > , etc.)
 * are stripped.
 */
export function extractCommandFromLine(screenLine: string, typedBuffer = ''): string {
  const trimmedScreen = screenLine.trim();
  const trimmedTyped = typedBuffer.trim();

  // If typedBuffer is clean and matches the end of screenLine, typedBuffer is exact
  if (trimmedTyped.length > 0 && trimmedScreen.endsWith(trimmedTyped)) {
    return trimmedTyped;
  }

  // Strip shell prompt: match last prompt delimiter ($ # % > » ➜ λ : ✗ ✔ or parenthesized context like (main)) followed by space
  const match = screenLine.match(/^(?:.*(?:[\$#%>»➜λ:✗✔]|\([^)]+\))\s+)(.*)$/);
  if (match && match[1] !== undefined) {
    const candidate = match[1].trim();
    if (candidate.length > 0) return candidate;
  }

  // If typedBuffer was provided, fall back to it
  if (trimmedTyped.length > 0) return trimmedTyped;

  // Fallback: if no prompt pattern matched, return the whole trimmed line unless it looks like a bare prompt
  if (/^[\w.\-@]+[:~#$\s/\\>]+$/.test(trimmedScreen)) {
    return '';
  }
  return trimmedScreen;
}

/** Formats a timestamp into a human-friendly relative time string. */
export function formatRelativeTime(
  timestamp: number,
  now = Date.now(),
  t?: (key: import('../i18n').MessageKey, params?: Record<string, string | number>) => string,
): string {
  const diffSec = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (diffSec < 60) {
    return t ? t('term.justNow') : 'только что';
  }
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) {
    return t ? t('term.minsAgo', { count: diffMin }) : `${diffMin} мин назад`;
  }
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) {
    return t ? t('term.hoursAgo', { count: diffHours }) : `${diffHours} ч назад`;
  }
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) {
    return t ? t('term.daysAgo', { count: diffDays }) : `${diffDays} дн назад`;
  }
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
