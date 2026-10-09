/**
 * Turning a drag & drop (or a folder picker) into an uploadable list.
 *
 * `dataTransfer.files` is a flat `FileList`: a dropped directory shows up as one
 * zero-byte entry with no contents, so dropping a folder used to silently upload
 * an empty file. The only way to walk a folder is `webkitGetAsEntry()`, which the
 * Chromium-based browsers and Electron all provide.
 */

export interface DroppedFile {
  file: File;
  /** Path relative to the drop root, using `/` — `docs/notes/todo.txt`. */
  relativePath: string;
}

export interface DroppedTree {
  files: DroppedFile[];
  /** Directories encountered, as relative paths. */
  directories: string[];
  /** True when the browser gave us no way to walk folders. */
  unsupported: boolean;
}

interface FileSystemEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
}

/** Reads every batch from a directory reader; it returns at most 100 at a time. */
function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = [];
    const step = (): void => {
      reader.readEntries((batch) => {
        if (batch.length === 0) {
          resolve(all);
          return;
        }
        all.push(...batch);
        step();
      }, reject);
    };
    step();
  });
}

function fileFromEntry(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function walk(entry: FileSystemEntry, prefix: string, out: DroppedTree): Promise<void> {
  if (entry.isFile) {
    const file = await fileFromEntry(entry as FileSystemFileEntry);
    out.files.push({ file, relativePath: prefix === '' ? file.name : `${prefix}/${file.name}` });
    return;
  }
  if (!entry.isDirectory) return;

  const directory = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
  out.directories.push(directory);
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (const child of await readAllEntries(reader)) {
    await walk(child, directory, out);
  }
}

/**
 * Collects the files behind a drop, walking folders when the browser allows it.
 * Never throws: an unreadable subfolder is skipped rather than failing the drop.
 */
export async function collectDroppedTree(transfer: DataTransfer): Promise<DroppedTree> {
  const out: DroppedTree = { files: [], directories: [], unsupported: false };
  const items = Array.from(transfer.items ?? []).filter((item) => item.kind === 'file');

  const supportsEntries = items.some((item) => typeof item.webkitGetAsEntry === 'function');
  if (!supportsEntries) {
    // Safari and very old browsers: fall back to the flat list, folders and all.
    for (const file of Array.from(transfer.files ?? [])) {
      out.files.push({ file, relativePath: file.name });
    }
    out.unsupported = true;
    return out;
  }

  for (const item of items) {
    const entry = item.webkitGetAsEntry();
    if (!entry) continue;
    try {
      await walk(entry, '', out);
    } catch {
      /* skip an unreadable branch instead of losing the whole drop */
    }
  }
  return out;
}

/**
 * Same result from a `<input type="file" webkitdirectory>`: every file carries
 * `webkitRelativePath` such as `project/src/main.ts`.
 */
export function collectPickedTree(fileList: FileList | null): DroppedTree {
  const out: DroppedTree = { files: [], directories: [], unsupported: false };
  if (!fileList) return out;
  const seen = new Set<string>();
  for (const file of Array.from(fileList)) {
    const relativePath = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    out.files.push({ file, relativePath });
    const segments = relativePath.split('/');
    segments.pop();
    for (let i = 0; i < segments.length; i += 1) {
      const directory = segments.slice(0, i + 1).join('/');
      if (!seen.has(directory)) {
        seen.add(directory);
        out.directories.push(directory);
      }
    }
  }
  return out;
}

/** Groups files by the directory they belong in, keeping a stable order. */
export function groupByDirectory(files: DroppedFile[]): Map<string, File[]> {
  const groups = new Map<string, File[]>();
  for (const { file, relativePath } of files) {
    const slash = relativePath.lastIndexOf('/');
    const directory = slash === -1 ? '' : relativePath.slice(0, slash);
    const bucket = groups.get(directory);
    if (bucket) bucket.push(file);
    else groups.set(directory, [file]);
  }
  return groups;
}

/** All ancestor directories of a set of relative paths, shallowest first. */
export function directoryOrder(directories: string[]): string[] {
  const unique = new Set<string>();
  for (const directory of directories) {
    const segments = directory.split('/').filter(Boolean);
    for (let i = 0; i < segments.length; i += 1) unique.add(segments.slice(0, i + 1).join('/'));
  }
  return [...unique].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
}
