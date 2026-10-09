import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../src/api/client', () => {
  class ApiError extends Error {
    readonly code: string;
    readonly status: number;
    readonly details: Record<string, unknown>;
    readonly requestId: string | null;

    constructor(
      status: number,
      code: string,
      message: string,
      details: Record<string, unknown> = {},
      requestId: string | null = null,
    ) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
      this.details = details;
      this.requestId = requestId;
    }
  }

  const stub = () => vi.fn();
  return {
    ApiError,
    api: {
      health: stub(),
      systemInfo: stub(),
      listProfiles: stub(),
      createProfile: stub(),
      updateProfile: stub(),
      deleteProfile: stub(),
      listSecrets: stub(),
      forgetSecret: stub(),
      forgetAllSecrets: stub(),
      listConnections: stub(),
      getConnection: stub(),
      connect: stub(),
      disconnect: stub(),
      reconnect: stub(),
      exec: stub(),
      list: stub(),
      stat: stub(),
      read: stub(),
      mkdir: stub(),
      rename: stub(),
      remove: stub(),
      chmod: stub(),
      touch: stub(),
      search: stub(),
      usage: stub(),
      upload: stub(),
      listTransfers: stub(),
      cancelTransfer: stub(),
      clearTransfers: stub(),
      retryTransfer: stub(),
    },
  };
});

import { api } from '../../src/api/client';
import {
  activeTransfers,
  totalSpeed,
  useTransferStore,
} from '../../src/state/transferStore';
import { useUiStore } from '../../src/state/uiStore';
import { transfer } from '../helpers/fixtures';

const apiMock = vi.mocked(api);
const store = () => useTransferStore.getState();

beforeEach(() => {
  vi.clearAllMocks();
  useTransferStore.setState({ transfers: [] });
  useUiStore.setState({ toasts: [] });
  apiMock.clearTransfers.mockResolvedValue(undefined);
});

describe('transferStore bookkeeping', () => {
  test('upsert appends new transfers and replaces in place, keeping the order', () => {
    store().upsert(transfer({ id: 'a', name: 'a.bin' }));
    store().upsert(transfer({ id: 'b', name: 'b.bin' }));
    store().upsert(transfer({ id: 'a', name: 'a.bin', transferred: 50, state: 'active' }));

    expect(store().transfers.map((entry) => entry.id)).toEqual(['a', 'b']);
    expect(store().transfers[0]?.transferred).toBe(50);
  });

  test('setAll replaces the whole list', () => {
    store().upsert(transfer({ id: 'a' }));

    store().setAll([transfer({ id: 'x' }), transfer({ id: 'y' })]);

    expect(store().transfers.map((entry) => entry.id)).toEqual(['x', 'y']);
  });

  test('cancel() adopts the record the API returns', async () => {
    store().upsert(transfer({ id: 'tx_1', state: 'active', transferred: 10 }));
    apiMock.cancelTransfer.mockResolvedValue({
      transfer: transfer({ id: 'tx_1', state: 'cancelled', transferred: 10 }),
    });

    await store().cancel('tx_1');

    expect(apiMock.cancelTransfer).toHaveBeenCalledWith('tx_1');
    expect(store().transfers).toHaveLength(1);
    expect(store().transfers[0]).toMatchObject({ id: 'tx_1', state: 'cancelled' });
  });

  test('clearFinished() drops everything that is no longer running', async () => {
    store().setAll([
      transfer({ id: 'active', state: 'active' }),
      transfer({ id: 'queued', state: 'queued' }),
      transfer({ id: 'done', state: 'done' }),
      transfer({ id: 'error', state: 'error' }),
      transfer({ id: 'cancelled', state: 'cancelled' }),
    ]);

    await store().clearFinished();

    expect(apiMock.clearTransfers).toHaveBeenCalledTimes(1);
    expect(store().transfers.map((entry) => entry.id)).toEqual(['active', 'queued']);
  });

  test('upload() upserts every accepted file', async () => {
    apiMock.upload.mockResolvedValue({ transfer: transfer({ id: 'u1', direction: 'upload' }) });
    const files = [new File(['a'], 'a.bin'), new File(['b'], 'b.bin')];

    await store().upload('c1', '/home', files);

    expect(apiMock.upload).toHaveBeenCalledTimes(2);
    expect(apiMock.upload).toHaveBeenCalledWith('c1', '/home', files[0]);
    // Both calls resolve to the same record, so upsert must not duplicate it.
    expect(store().transfers.map((entry) => entry.id)).toEqual(['u1']);
  });

  test('a failed upload is reported per file and does not reject the batch', async () => {
    const files = [new File(['a'], 'good.bin'), new File(['b'], 'bad.bin')];
    apiMock.upload.mockImplementation(async (_connectionId: string, _dir: string, file: File) => {
      if (file.name === 'bad.bin') throw new Error('quota exceeded');
      return { transfer: transfer({ id: 'u1', name: file.name }) };
    });

    await expect(store().upload('c1', '/home', files)).resolves.toBeUndefined();

    expect(store().transfers.map((entry) => entry.id)).toEqual(['u1']);
    const toasts = useUiStore.getState().toasts;
    expect(toasts.map((toast) => toast.level)).toEqual(['error']);
    expect(toasts[0]?.title).toBe('Upload failed: bad.bin');
    expect(toasts[0]?.detail).toBe('quota exceeded');
  });
});

describe('transfer selectors', () => {
  test('activeTransfers keeps only running work', () => {
    const transfers = [
      transfer({ id: 'a', state: 'active' }),
      transfer({ id: 'q', state: 'queued' }),
      transfer({ id: 'd', state: 'done' }),
      transfer({ id: 'e', state: 'error' }),
      transfer({ id: 'c', state: 'cancelled' }),
    ];

    expect(activeTransfers(transfers).map((entry) => entry.id)).toEqual(['a', 'q']);
  });

  test('totalSpeed sums active transfers only and survives a missing rate', () => {
    const transfers = [
      transfer({ id: 'a', state: 'active', bytesPerSecond: 1024 }),
      transfer({ id: 'b', state: 'active', bytesPerSecond: 512 }),
      transfer({ id: 'c', state: 'queued', bytesPerSecond: 4096 }),
      transfer({ id: 'd', state: 'done', bytesPerSecond: 4096 }),
      transfer({ id: 'e', state: 'active', bytesPerSecond: 0 }),
    ];

    expect(totalSpeed(transfers)).toBe(1536);
    expect(totalSpeed([])).toBe(0);
    expect(totalSpeed([transfer({ id: 'nan', state: 'active', bytesPerSecond: Number.NaN })])).toBe(0);
  });
});
