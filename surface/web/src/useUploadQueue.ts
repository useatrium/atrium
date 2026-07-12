import { useCallback } from 'react';
import { randomId, type EnqueueOpInput, type QueuedOp, type UploadPayload } from '@atrium/surface-client';

type UploadEnqueue = (input: EnqueueOpInput<'upload'>) => Promise<unknown>;

type UploadQueueStorage = {
  listOps(): Promise<QueuedOp[]>;
};

export function waitForQueuedUpload(
  storage: UploadQueueStorage,
  uploadKey: string,
  pollMs = 250,
): Promise<{ fileId: string }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setInterval>;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      fn();
    };
    const check = () => {
      void storage
        .listOps()
        .then((ops) => {
          const op = ops.find((candidate) => candidate.queueKey === `upload:${uploadKey}`);
          if (!op) {
            finish(() => reject(new Error('upload was rejected')));
            return;
          }
          const payload = op.payload as Partial<UploadPayload>;
          const fileId = payload.fileId;
          if (op.status === 'completed' && payload.uploaded && fileId) {
            finish(() => resolve({ fileId }));
          }
        })
        .catch((err: unknown) => finish(() => reject(err)));
    };
    timer = setInterval(check, pollMs);
    check();
  });
}

export function useUploadQueue({ enqueueOp, storage }: { enqueueOp: UploadEnqueue; storage: UploadQueueStorage }) {
  const queueUpload = useCallback(
    async (payload: UploadPayload): Promise<{ fileId: string }> => {
      await enqueueOp({
        opId: randomId(),
        opType: 'upload',
        payload,
      });
      return waitForQueuedUpload(storage, payload.uploadKey);
    },
    [enqueueOp, storage],
  );

  return { queueUpload };
}
