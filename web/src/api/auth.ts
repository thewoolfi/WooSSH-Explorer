/**
 * Optional shared-secret support (`SSH_EXPLORER_TOKEN`, contract §10).
 *
 * The token is only needed when the API is deliberately exposed beyond loopback.
 * It is read from `localStorage`, or seeded once from `?token=…` in the URL, which
 * is then stripped so it does not linger in history or get pasted onward.
 *
 * Browsers cannot set headers on a WebSocket handshake, so the same value is also
 * appended as a `token` query parameter on the two socket URLs — the server
 * accepts either form for upgrades.
 */

const STORAGE_KEY = 'ssh-explorer.token';

let cached: string | null | undefined;

function readFromStorage(): string | null {
  try {
    return window.localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeToStorage(value: string): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* private mode — the token stays in memory for this page load only */
  }
}

function seedFromUrl(): string | null {
  try {
    const url = new URL(window.location.href);
    const provided = url.searchParams.get('token');
    if (!provided) return null;
    url.searchParams.delete('token');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    writeToStorage(provided);
    return provided;
  } catch {
    return null;
  }
}

/** The active token, or null when the API is not token-protected. */
export function apiToken(): string | null {
  if (cached === undefined) {
    cached = readFromStorage() ?? seedFromUrl();
  }
  return cached;
}

export function setApiToken(value: string | null): void {
  cached = value && value !== '' ? value : null;
  try {
    if (cached) window.localStorage.setItem(STORAGE_KEY, cached);
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* private mode */
  }
}

/** Headers every REST call must carry. */
export function authHeaders(): Record<string, string> {
  const token = apiToken();
  return token ? { 'x-ssh-explorer-token': token } : {};
}

/** Appends the token to an absolute WebSocket URL when one is configured. */
export function withToken(url: string): string {
  const token = apiToken();
  if (!token) return url;
  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}
