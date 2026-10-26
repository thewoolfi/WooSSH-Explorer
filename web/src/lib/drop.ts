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

/**
 * Detects whether a drag event carries files (from the OS or another window).
 * Robust across browsers, Electron, DOMStringList, and different OS conventions.
 */
export function hasDropFiles(dt: DataTransfer | null | undefined): boolean {
  if (!dt) return false;
  if (dt.files && dt.files.length > 0) return true;
  if (dt.types) {
    try {
      const types = Array.from(dt.types);
      if (
        types.some(
          (t) =>
            t.toLowerCase() === 'files' ||
            t === 'application/x-moz-file' ||
            t === 'text/uri-list',
        )
      ) {
        return true;
      }
    } catch {
      /* fallback */
    }
  }
  return false;
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

async function walk(
  entry: FileSystemEntry,
  prefix: string,
  out: DroppedTree,
  rawFiles: File[],
): Promise<void> {
  if (entry.isFile) {
    try {
      const file = await fileFromEntry(entry as FileSystemFileEntry);
      out.files.push({ file, relativePath: prefix === '' ? file.name : `${prefix}/${file.name}` });
    } catch {
      const match = rawFiles.find((f) => f.name === entry.name);
      if (match) {
        out.files.push({ file: match, relativePath: prefix === '' ? match.name : `${prefix}/${match.name}` });
      }
    }
    return;
  }
  if (!entry.isDirectory) return;

  const directory = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
  out.directories.push(directory);
  const reader = (entry as FileSystemDirectoryEntry).createReader();
  for (const child of await readAllEntries(reader)) {
    await walk(child, directory, out, rawFiles);
  }
}

/**
 * Collects the files behind a drop, walking folders when the browser allows it.
 * Never throws: an unreadable subfolder is skipped rather than failing the drop.
 */
export function collectDroppedTree(transfer: DataTransfer): Promise<DroppedTree> {
  const out: DroppedTree = { files: [], directories: [], unsupported: false };

  // Synchronously extract raw files from transfer.files before any async microtask
  // can detach or clear the browser's DataTransfer object.
  const rawFiles = Array.from(transfer.files ?? []);

  // Synchronously extract entries from transfer.items before any async microtask.
  const entries: (FileSystemEntry | null)[] = [];
  try {
    if (transfer.items && transfer.items.length > 0) {
      for (let i = 0; i < transfer.items.length; i++) {
        const item = transfer.items[i];
        if (item && item.kind === 'file') {
          entries.push(typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null);
        }
      }
    }
  } catch {
    /* ignore synchronous extraction error */
  }

  return (async () => {
    const validEntries = entries.filter((e): e is FileSystemEntry => e !== null);

    if (validEntries.length > 0) {
      for (const entry of validEntries) {
        try {
          await walk(entry, '', out, rawFiles);
        } catch {
          /* skip unreadable branch */
        }
      }
    }

    // Crucial fallback: If entry-based walking produced no files (common on Windows OS file drops
    // where webkitGetAsEntry returns null or fails), ALWAYS fall back to rawFiles!
    if (out.files.length === 0 && rawFiles.length > 0) {
      for (const file of rawFiles) {
        out.files.push({ file, relativePath: file.name });
      }
    }

    return out;
  })();
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
