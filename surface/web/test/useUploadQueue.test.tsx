// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EnqueueOpInput, QueuedOp, UploadPayload } from '@atrium/surface-client';
import { useUploadQueue, waitForQueuedUpload } from '../src/useUploadQueue';

const createdAt = '2026-06-28T16:00:00.000Z';

function uploadOp(
  status: QueuedOp['status'],
  payload: Partial<UploadPayload> = {},
): QueuedOp {
  return {
    opId: 'upload-op',
    opType: 'upload',
    queueKey: 'upload:upload-1',
    payload: {
      uploadKey: 'upload-1',
      localUri: 'blob:http://localhost/local',
      filename: 'file.txt',
      contentType: 'text/plain',
      size: 12,
      ...payload,
    },
    status,
    retryCount: 0,
    createdAt,
  };
}

function payload(overrides: Partial<UploadPayload> = {}): UploadPayload {
  return {
    uploadKey: 'upload-1',
    localUri: 'blob:http://localhost/local',
    filename: 'file.txt',
    contentType: 'text/plain',
    size: 12,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('waitForQueuedUpload', () => {
  it('resolves when the queued upload is marked completed with a file id', async () => {
    vi.useFakeTimers();
    const storage = {
      listOps: vi
        .fn<() => Promise<QueuedOp[]>>()
        .mockResolvedValueOnce([uploadOp('pending')])
        .mockResolvedValueOnce([uploadOp('completed', { uploaded: true, fileId: 'file-1' })]),
    };

    const result = waitForQueuedUpload(storage, 'upload-1');

    await act(async () => {
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(250);
    });

    await expect(result).resolves.toEqual({ fileId: 'file-1' });
  });

  it('rejects when the queued upload disappears', async () => {
    const storage = {
      listOps: vi.fn<() => Promise<QueuedOp[]>>().mockResolvedValue([]),
    };

    await expect(waitForQueuedUpload(storage, 'upload-1')).rejects.toThrow('upload was rejected');
  });
});

describe('useUploadQueue', () => {
  it('queues the upload op before waiting for the completed upload marker', async () => {
    const enqueueOp = vi.fn(async (_input: EnqueueOpInput<'upload'>) => ({ opId: 'op-1' }));
    const storage = {
      listOps: vi
        .fn<() => Promise<QueuedOp[]>>()
        .mockResolvedValue([uploadOp('completed', { uploaded: true, fileId: 'file-1' })]),
    };
    const { result } = renderHook(() => useUploadQueue({ enqueueOp, storage }));

    await expect(result.current.queueUpload(payload())).resolves.toEqual({ fileId: 'file-1' });

    expect(enqueueOp).toHaveBeenCalledWith(
      expect.objectContaining({
        opType: 'upload',
        payload: payload(),
      }),
    );
    expect(storage.listOps).toHaveBeenCalled();
  });
});
