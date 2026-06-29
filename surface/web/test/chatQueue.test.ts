import { describe, expect, it, vi } from 'vitest';
import type {
  Api,
  MsgSendPayload,
  OpExecuteContext,
  QueuedOp,
  UploadPayload,
} from '@atrium/surface-client';
import { ApiError } from '@atrium/surface-client';
import { createChatOpRegistry, queuedFailureMessage } from '../src/chatQueue';

describe('chatQueue', () => {
  it('keeps user-facing failure copy for queued operations', () => {
    expect(queuedFailureMessage('msg.send')).toBe("Couldn't send the message.");
    expect(queuedFailureMessage('upload')).toBe("Couldn't upload the file.");
    expect(queuedFailureMessage('msg.edit')).toBe("Couldn't save the edit.");
    expect(queuedFailureMessage('msg.delete')).toBe("Couldn't delete the message.");
    expect(queuedFailureMessage('reaction.set')).toBe("Couldn't update the reaction.");
    expect(queuedFailureMessage('read.mark')).toBe("Couldn't mark the channel read.");
    expect(queuedFailureMessage('mute.set')).toBe("Couldn't update the mute setting.");
    expect(queuedFailureMessage('session.spawn')).toBe("Couldn't start the agent session.");
    expect(queuedFailureMessage('session.answer')).toBe("Couldn't submit the answer.");
    expect(queuedFailureMessage('session.steer')).toBe("Couldn't send the session message.");
    expect(queuedFailureMessage('session.cancel')).toBe("Couldn't cancel the session.");
    expect(queuedFailureMessage('prefs.set')).toBe("Couldn't sync settings.");
    expect(queuedFailureMessage('draft.set')).toBe("Couldn't sync the draft.");
    expect(queuedFailureMessage('channel.join')).toBe("Couldn't add the person.");
    expect(queuedFailureMessage('channel.leave')).toBe("Couldn't leave the channel.");
  });

  it('surfaces actionable GitHub repo validation failures for queued spawns', () => {
    expect(
      queuedFailureMessage(
        'session.spawn',
        new ApiError(409, 'github_connection_required', 'server message'),
      ),
    ).toBe('Connect GitHub before starting a session with private repositories.');
    expect(
      queuedFailureMessage(
        'session.spawn',
        new ApiError(409, 'github_repo_access_unverified', 'server message'),
      ),
    ).toBe('Reconnect GitHub before starting a session with private repositories.');
    expect(
      queuedFailureMessage(
        'session.spawn',
        new ApiError(409, 'github_repo_inaccessible', 'Connected GitHub credentials cannot access: acme/private'),
      ),
    ).toBe('Connected GitHub credentials cannot access: acme/private');
    expect(
      queuedFailureMessage(
        'session.spawn',
        new ApiError(502, 'github_repo_validation_failed', 'server message'),
      ),
    ).toBe('Could not validate GitHub repository access. Try again or reconnect GitHub.');
  });

  it('resolves upload refs and voice metadata before posting a queued message', async () => {
    const postMessage = vi.fn().mockResolvedValue({ event: { id: 1 } });
    const registry = createChatOpRegistry();
    const payload: MsgSendPayload & {
      voice: { fileId: string; durationMs: 1200; waveform: number[] };
    } = {
      channelId: 'ch-1',
      text: 'voice note',
      clientMsgId: 'client-1',
      threadRootEventId: 42,
      attachmentRefs: [{ uploadKey: 'upload-1' }],
      voice: { fileId: 'local-file-id', durationMs: 1200, waveform: [0, 1, 0.5] },
    };

    await registry['msg.send'].execute(
      { postMessage } as unknown as Api,
      payload,
      queuedOp('op-1', payload),
      context([
        queuedOp('upload-op', {
          uploadKey: 'upload-1',
          localUri: 'blob:voice',
          filename: 'voice.webm',
          contentType: 'audio/webm',
          size: 128,
          uploaded: true,
          fileId: 'file-1',
        } satisfies UploadPayload),
      ]),
    );

    expect(postMessage).toHaveBeenCalledWith({
      channelId: 'ch-1',
      text: 'voice note',
      clientMsgId: 'client-1',
      threadRootEventId: 42,
      attachments: ['file-1'],
      voice: { durationMs: 1200, waveform: [0, 1, 0.5] },
      opId: 'op-1',
    });
  });

  it('rejects message sends when referenced uploads are not complete', async () => {
    const registry = createChatOpRegistry();
    const payload: MsgSendPayload = {
      channelId: 'ch-1',
      text: 'with attachment',
      clientMsgId: 'client-1',
      attachmentRefs: [{ uploadKey: 'upload-1' }],
    };

    await expect(
      registry['msg.send'].execute(
        { postMessage: vi.fn() } as unknown as Api,
        payload,
        queuedOp('op-1', payload),
        context([]),
      ),
    ).rejects.toThrow('upload upload-1 is not ready');
  });
});

function context(ops: QueuedOp[]): OpExecuteContext {
  return {
    listOps: async () => ops,
    putOp: async () => {},
    uploadFetch: async () => new Response(),
    readUploadBody: async () => new Blob(),
  };
}

function queuedOp(opId: string, payload: unknown): QueuedOp {
  return {
    opId,
    opType: opId === 'upload-op' ? 'upload' : 'msg.send',
    queueKey: opId === 'upload-op' ? 'upload:upload-1' : 'msg:ch-1',
    payload,
    status: opId === 'upload-op' ? 'completed' : 'pending',
    retryCount: 0,
    createdAt: '2026-06-28T13:05:00.000Z',
  };
}
