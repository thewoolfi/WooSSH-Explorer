import type { DirectoryListing, FileEntry, FileReadResult, Transfer } from '../../src/api/types';
import type { FilesTab, Tab } from '../../src/state/explorerStore';

/** Test-only factory for `FileEntry` records; every field is overridable. */
export function fileEntry(input: Partial<FileEntry> & { name: string }): FileEntry {
  const name = input.name;
  return {
    // `name` itself arrives through the spread below.
    path: `/${name}`,
    kind: 'file',
    size: 0,
    mtime: 0,
    atime: 0,
    mode: 0o100644,
    modeText: '-rw-r--r--',
    owner: 'root',
    group: 'root',
    uid: 0,
    gid: 0,
    hidden: name.startsWith('.'),
    ...input,
  };
}

/** A directory entry with a realistic mode/size. */
export function dirEntry(name: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return fileEntry({
    name,
    kind: 'directory',
    size: 4096,
    mode: 0o040755,
    modeText: 'drwxr-xr-x',
    ...overrides,
  });
}

export function symlinkEntry(name: string, target: string, overrides: Partial<FileEntry> = {}): FileEntry {
  return fileEntry({
    name,
    kind: 'symlink',
    target,
    mode: 0o120777,
    modeText: 'lrwxrwxrwx',
    ...overrides,
  });
}

export function listing(
  path: string,
  entries: FileEntry[],
  parent: string | null = null,
): DirectoryListing {
  return { path, parent, entries, truncated: false };
}

export function readResult(overrides: Partial<FileReadResult> = {}): FileReadResult {
  return {
    kind: 'text',
    content: 'hello',
    size: 5,
    truncated: false,
    encoding: 'utf-8',
    mimeType: 'text/plain',
    lines: 1,
    ...overrides,
  };
}

export function transfer(overrides: Partial<Transfer> & { id: string }): Transfer {
  return {
    connectionId: 'c1',
    direction: 'upload',
    name: 'a.bin',
    remotePath: '/a.bin',
    localPath: null,
    size: 100,
    transferred: 0,
    state: 'active',
    startedAt: 0,
    finishedAt: null,
    bytesPerSecond: 0,
    resumable: false,
    resumedFrom: 0,
    ...overrides,
  };
}

/** Narrows a `Tab` in assertions without sprinkling casts through the specs. */
export function asFilesTab(tab: Tab | undefined): FilesTab {
  if (!tab) throw new Error('expected a tab, got undefined');
  if (tab.kind !== 'files') throw new Error(`expected a files tab, got "${tab.kind}"`);
  return tab;
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

/** A promise whose settlement the test controls — used to observe in-flight state. */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Lets every already-scheduled microtask run. Used after calling a store action
 * that fires an un-awaited request (`openFilesTab` → `void navigate(...)`).
 */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}
