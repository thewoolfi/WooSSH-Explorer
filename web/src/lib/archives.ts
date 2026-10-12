/**
 * The naming rules behind "archive this" and "extract that".
 *
 * Kept apart from the dialogs so they can be tested directly: the parts that go wrong are
 * stripping an extension from `project.tar.gz` (which must leave `project`, not
 * `project.tar`) and picking a name that does not quietly overwrite something already in
 * the folder.
 */

export type ArchiveFormat = 'zip' | 'tar' | 'tar.gz';

/** The extensions the UI offers to unpack. The server decides for real by reading the file. */
const ARCHIVE_SUFFIXES = ['.tar.gz', '.tar.bz2', '.tar.xz', '.tgz', '.tbz2', '.txz', '.zip', '.tar'];

/** Archive formats and the suffix each one produces. */
export const FORMAT_SUFFIX: Record<ArchiveFormat, string> = {
  zip: '.zip',
  tar: '.tar',
  'tar.gz': '.tar.gz',
};

/**
 * Splits a name into the part worth keeping and the suffix worth preserving.
 *
 * A compound archive suffix is treated as one unit, so numbering `docs.tar.gz` gives
 * `docs-2.tar.gz` rather than the absurd `docs.tar-2.gz`.
 */
function splitSuffix(name: string): { stem: string; suffix: string } {
  const lower = name.toLowerCase();
  const archive = longestArchiveSuffix(lower);
  if (archive !== undefined) {
    const cut = name.length - archive.length;
    return { stem: name.slice(0, cut), suffix: name.slice(cut) };
  }
  const dot = name.lastIndexOf('.');
  // A leading dot is part of the name, not an extension: `.bashrc` has no suffix.
  return dot > 0 ? { stem: name.slice(0, dot), suffix: name.slice(dot) } : { stem: name, suffix: '' };
}

/** The archive suffix a name ends with, longest first so `.tar.gz` beats `.gz`. */
function longestArchiveSuffix(lowerName: string): string | undefined {
  return [...ARCHIVE_SUFFIXES]
    .sort((a, b) => b.length - a.length)
    .find((candidate) => lowerName.endsWith(candidate));
}

/** True when the name looks like something worth offering to unpack. */
export function isArchiveName(name: string): boolean {
  return longestArchiveSuffix(name.toLowerCase()) !== undefined;
}

/** The name without its archive suffix: `project.tar.gz` → `project`. */
export function archiveBaseName(name: string): string {
  const suffix = longestArchiveSuffix(name.toLowerCase());
  return suffix === undefined ? name : name.slice(0, name.length - suffix.length);
}

/**
 * A name for the new archive, based on the selection.
 *
 * One item keeps its own name; several share a parent folder and take its name, because
 * `docs.zip` says more than `archive.zip`. A single file keeps its extension stripped
 * only if it looks like an archive, so `report.pdf` becomes `report.zip` rather than
 * `report.pdf.zip`.
 */
export function suggestArchiveName(paths: readonly string[], format: ArchiveFormat): string {
  const suffix = FORMAT_SUFFIX[format];
  const base = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

  if (paths.length === 0) return `archive${suffix}`;
  if (paths.length > 1) {
    const parent = paths[0]?.slice(0, paths[0].lastIndexOf('/')) ?? '';
    const folder = parent.slice(parent.lastIndexOf('/') + 1);
    return `${folder === '' ? 'archive' : folder}${suffix}`;
  }

  const only = base(paths[0] as string);
  const stem = isArchiveName(only) ? archiveBaseName(only) : only;
  return `${stem === '' ? 'archive' : stem}${suffix}`;
}

/**
 * Appends `-2`, `-3`… until the name is free.
 *
 * Writing an archive over an existing file loses it without a word, so the default name
 * steps aside instead. The comparison is case-insensitive because the target filesystem
 * may well be.
 */
export function uniqueName(desired: string, taken: Iterable<string>): string {
  const used = new Set([...taken].map((name) => name.toLowerCase()));
  if (!used.has(desired.toLowerCase())) return desired;

  const { stem, suffix } = splitSuffix(desired);

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${stem}-${index}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${stem}-${Date.now()}${suffix}`;
}

/**
 * Where an archive should be unpacked by default.
 *
 * A folder named after the archive, beside it: unpacking into the current folder scatters
 * an archive's top-level entries among the files already there, and the user can always
 * point it somewhere else in the dialog.
 */
export function suggestExtractDir(archivePath: string): string {
  const slash = archivePath.lastIndexOf('/');
  const parent = slash <= 0 ? '/' : archivePath.slice(0, slash);
  const base = archiveBaseName(archivePath.slice(slash + 1));
  const name = base === '' ? 'extracted' : base;
  return parent === '/' ? `/${name}` : `${parent}/${name}`;
}
