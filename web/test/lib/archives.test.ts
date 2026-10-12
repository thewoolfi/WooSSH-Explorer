import { describe, expect, test } from 'vitest';

import {
  archiveBaseName,
  isArchiveName,
  suggestArchiveName,
  suggestExtractDir,
  uniqueName,
} from '../../src/lib/archives';

describe('isArchiveName', () => {
  test('recognises the formats the server can unpack', () => {
    for (const name of ['a.zip', 'a.tar', 'a.tar.gz', 'a.TGZ', 'a.tar.bz2', 'a.tar.xz']) {
      expect(isArchiveName(name)).toBe(true);
    }
  });

  test('leaves ordinary files alone', () => {
    for (const name of ['a.txt', 'archive', 'a.zip.txt', 'a.pdf']) {
      expect(isArchiveName(name)).toBe(false);
    }
  });
});

describe('archiveBaseName', () => {
  test('strips the longest matching suffix', () => {
    // The whole point: `project.tar.gz` must not leave a stray `.tar`.
    expect(archiveBaseName('project.tar.gz')).toBe('project');
    expect(archiveBaseName('project.zip')).toBe('project');
    expect(archiveBaseName('project.tar')).toBe('project');
  });

  test('ignores case', () => {
    expect(archiveBaseName('Project.TAR.GZ')).toBe('Project');
  });

  test('leaves a name with no archive suffix untouched', () => {
    expect(archiveBaseName('notes.txt')).toBe('notes.txt');
    expect(archiveBaseName('archive')).toBe('archive');
  });

  test('does not treat a leading dot as an extension', () => {
    expect(archiveBaseName('.zip')).toBe('');
  });
});

describe('suggestArchiveName', () => {
  test('one folder keeps its own name', () => {
    expect(suggestArchiveName(['/home/me/docs'], 'zip')).toBe('docs.zip');
  });

  test('one file takes the format extension, not a doubled one', () => {
    expect(suggestArchiveName(['/home/me/report.pdf'], 'zip')).toBe('report.pdf.zip');
    expect(suggestArchiveName(['/home/me/old.tar.gz'], 'tar.gz')).toBe('old.tar.gz');
  });

  test('several items are named after the folder they share', () => {
    expect(suggestArchiveName(['/home/me/docs/a', '/home/me/docs/b'], 'tar.gz')).toBe('docs.tar.gz');
  });

  test('falls back to a usable name when there is nothing to go on', () => {
    expect(suggestArchiveName([], 'tar')).toBe('archive.tar');
    expect(suggestArchiveName(['/'], 'zip')).toBe('archive.zip');
  });
});

describe('uniqueName', () => {
  test('keeps the wanted name when it is free', () => {
    expect(uniqueName('docs.zip', ['other.zip'])).toBe('docs.zip');
  });

  test('steps aside instead of overwriting', () => {
    expect(uniqueName('docs.zip', ['docs.zip'])).toBe('docs-2.zip');
    expect(uniqueName('docs.zip', ['docs.zip', 'docs-2.zip'])).toBe('docs-3.zip');
  });

  test('inserts the number before the whole suffix', () => {
    // `docs.tar-2.gz` would be absurd; the suffix is `.tar.gz`.
    expect(uniqueName('docs.tar.gz', ['docs.tar.gz'])).toBe('docs-2.tar.gz');
  });

  test('compares without regard to case, because the target filesystem might not', () => {
    expect(uniqueName('Docs.zip', ['docs.zip'])).toBe('Docs-2.zip');
  });

  test('a dotfile has no suffix to preserve', () => {
    expect(uniqueName('.env', ['.env'])).toBe('.env-2');
  });
});

describe('suggestExtractDir', () => {
  test('unpacks beside the archive, into a folder named after it', () => {
    expect(suggestExtractDir('/home/me/project.tar.gz')).toBe('/home/me/project');
    expect(suggestExtractDir('/home/me/bundle.zip')).toBe('/home/me/bundle');
  });

  test('handles an archive sitting in the root', () => {
    expect(suggestExtractDir('/project.tar.gz')).toBe('/project');
  });

  test('falls back when the name is nothing but an extension', () => {
    expect(suggestExtractDir('/home/me/.zip')).toBe('/home/me/extracted');
  });
});
