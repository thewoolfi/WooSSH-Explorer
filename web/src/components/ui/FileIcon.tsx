import type { FileEntry } from '../../api/types';
import { classify, type FileKind } from '../../lib/path';
import { Icon, type IconName } from './Icon';

const KIND_ICON: Record<FileKind, IconName> = {
  folder: 'folder',
  text: 'file-text',
  code: 'file-code',
  image: 'file-image',
  archive: 'file-archive',
  pdf: 'file-pdf',
  audio: 'file-audio',
  video: 'file-video',
  sheet: 'file-sheet',
  key: 'file-key',
  database: 'file-database',
  binary: 'file-binary',
};

export function FileIcon({
  entry,
  size = 16,
  className,
}: {
  entry: Pick<FileEntry, 'name' | 'kind'> & { target?: string };
  size?: number;
  className?: string;
}) {
  const kind = classify(entry);
  const isLink = entry.kind === 'symlink';
  return (
    <span className={`file-icon file-icon--${kind}${isLink ? ' is-link' : ''}${className ? ` ${className}` : ''}`}>
      <Icon name={KIND_ICON[kind]} size={size} strokeWidth={kind === 'folder' ? 1.35 : 1.3} />
      {isLink ? (
        <span className="file-icon__link" aria-hidden="true">
          <Icon name="link" size={9} strokeWidth={1.6} />
        </span>
      ) : null}
    </span>
  );
}

export function fileKindLabel(entry: Pick<FileEntry, 'name' | 'kind'>): string {
  const kind = classify(entry);
  const labels: Record<FileKind, string> = {
    folder: 'Folder',
    text: 'Text',
    code: 'Source',
    image: 'Image',
    archive: 'Archive',
    pdf: 'PDF',
    audio: 'Audio',
    video: 'Video',
    sheet: 'Spreadsheet',
    key: 'Key / certificate',
    database: 'Database',
    binary: 'Binary',
  };
  return labels[kind];
}
