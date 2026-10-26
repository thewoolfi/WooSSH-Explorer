import { describe, expect, test } from 'vitest';
import {
  collectDroppedTree,
  collectPickedTree,
  directoryOrder,
  groupByDirectory,
  hasDropFiles,
} from '../../src/lib/drop';

describe('hasDropFiles', () => {
  test('recognises Files in dataTransfer.types', () => {
    const dt = { types: ['Files'] } as unknown as DataTransfer;
    expect(hasDropFiles(dt)).toBe(true);
  });

  test('recognises lowercase files in dataTransfer.types', () => {
    const dt = { types: ['files'] } as unknown as DataTransfer;
    expect(hasDropFiles(dt)).toBe(true);
  });

  test('recognises application/x-moz-file in dataTransfer.types', () => {
    const dt = { types: ['application/x-moz-file'] } as unknown as DataTransfer;
    expect(hasDropFiles(dt)).toBe(true);
  });

  test('recognises populated files list even if types is empty', () => {
    const file = new File(['hello'], 'hello.txt', { type: 'text/plain' });
    const dt = { files: [file], types: [] } as unknown as DataTransfer;
    expect(hasDropFiles(dt)).toBe(true);
  });

  test('returns false for text/plain without files', () => {
    const dt = { files: [], types: ['text/plain'] } as unknown as DataTransfer;
    expect(hasDropFiles(dt)).toBe(false);
  });

  test('returns false for null/undefined', () => {
    expect(hasDropFiles(null)).toBe(false);
    expect(hasDropFiles(undefined)).toBe(false);
  });
});

describe('collectDroppedTree', () => {
  test('falls back to transfer.files when items is empty or has no entries', async () => {
    const file1 = new File(['a'], 'file1.txt', { type: 'text/plain' });
    const file2 = new File(['b'], 'file2.txt', { type: 'text/plain' });
    const dt = {
      files: [file1, file2],
      items: [],
    } as unknown as DataTransfer;

    const result = await collectDroppedTree(dt);
    expect(result.files).toHaveLength(2);
    expect(result.files[0]!.file.name).toBe('file1.txt');
    expect(result.files[0]!.relativePath).toBe('file1.txt');
    expect(result.files[1]!.file.name).toBe('file2.txt');
    expect(result.files[1]!.relativePath).toBe('file2.txt');
  });

  test('falls back to transfer.files when webkitGetAsEntry returns null', async () => {
    const file = new File(['test'], 'test.txt', { type: 'text/plain' });
    const dt = {
      files: [file],
      items: [
        {
          kind: 'file',
          webkitGetAsEntry: () => null,
        },
      ],
    } as unknown as DataTransfer;

    const result = await collectDroppedTree(dt);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.file.name).toBe('test.txt');
  });
});

describe('groupByDirectory', () => {
  test('groups root and subfolder files properly', () => {
    const f1 = new File(['1'], 'root.txt');
    const f2 = new File(['2'], 'sub.txt');
    const f3 = new File(['3'], 'deep.txt');

    const groups = groupByDirectory([
      { file: f1, relativePath: 'root.txt' },
      { file: f2, relativePath: 'sub/sub.txt' },
      { file: f3, relativePath: 'sub/deep.txt' },
    ]);

    expect(groups.get('')).toHaveLength(1);
    expect(groups.get('sub')).toHaveLength(2);
  });
});

describe('directoryOrder', () => {
  test('orders shallowest directories first', () => {
    const ordered = directoryOrder(['a/b/c', 'a', 'a/b']);
    expect(ordered).toEqual(['a', 'a/b', 'a/b/c']);
  });
});
