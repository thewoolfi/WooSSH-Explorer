import { randomUUID } from 'node:crypto';

/** Ids handed out to connections, transfers, batches and terminal sessions. */
export function newId(prefix?: string): string {
  const id = randomUUID();
  return prefix === undefined ? id : `${prefix}_${id}`;
}

/** Short, log-friendly random token (never used for anything security sensitive). */
export function shortId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}
