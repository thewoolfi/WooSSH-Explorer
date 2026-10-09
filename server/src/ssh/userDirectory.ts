/**
 * uid/gid → name resolution for a remote host.
 *
 * `id(1)` output is not guaranteed for arbitrary servers, so the canonical `/etc/passwd` and
 * `/etc/group` files are parsed instead. Failures degrade to the numeric id, never to an error.
 */

export interface ParsedAccountFile {
  /** numeric id → name */
  byId: Map<number, string>;
}

/** Parses `name:x:id:...` (passwd) or `name:x:id:members` (group) style databases. */
export function parseAccountFile(content: string): ParsedAccountFile {
  const byId = new Map<number, string>();
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const fields = trimmed.split(':');
    const name = fields[0];
    const idField = fields[2];
    if (name === undefined || name === '' || idField === undefined) continue;
    const id = Number.parseInt(idField, 10);
    if (!Number.isInteger(id) || id < 0) continue;
    // The first definition wins, matching libc behaviour for duplicated ids.
    if (!byId.has(id)) byId.set(id, name);
  }
  return { byId };
}

/** Immutable lookup table built from `/etc/passwd` and `/etc/group`. */
export class UserDirectory {
  constructor(
    private readonly users: Map<number, string> = new Map(),
    private readonly groups: Map<number, string> = new Map(),
  ) {}

  static empty(): UserDirectory {
    return new UserDirectory();
  }

  static fromContents(passwd: string | null, group: string | null): UserDirectory {
    return new UserDirectory(
      passwd === null ? new Map() : parseAccountFile(passwd).byId,
      group === null ? new Map() : parseAccountFile(group).byId,
    );
  }

  /** Resolved user name, or the numeric uid as a string (contract §2 `owner`). */
  owner(uid: number): string {
    return this.users.get(uid) ?? String(uid);
  }

  /** Resolved group name, or the numeric gid as a string (contract §2 `group`). */
  group(gid: number): string {
    return this.groups.get(gid) ?? String(gid);
  }

  get size(): number {
    return this.users.size + this.groups.size;
  }
}
