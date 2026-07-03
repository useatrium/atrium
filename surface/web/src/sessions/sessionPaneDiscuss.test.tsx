// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnnotatedTranscriptRow, type TranscriptDiscussPayload } from './SessionPane';

afterEach(cleanup);

describe('AnnotatedTranscriptRow Discuss affordance', () => {
  it('removes the transcript-row comment affordance', () => {
    render(
      <AnnotatedTranscriptRow handle="rec_1">
        <div>Transcript text</div>
      </AnnotatedTranscriptRow>,
    );
    expect(screen.queryByRole('button', { name: 'Comment on entry' })).toBeNull();
  });

  it('hides Discuss without thread context, such as popouts', () => {
    render(
      <AnnotatedTranscriptRow
        handle="rec_1"
        discussContext={null}
        onDiscussEntry={vi.fn()}
      >
        <div>Transcript text</div>
      </AnnotatedTranscriptRow>,
    );
    expect(screen.queryByRole('button', { name: 'Discuss in thread' })).toBeNull();
  });

  it('emits a prefilled thread draft payload', () => {
    const onDiscussEntry = vi.fn<(payload: TranscriptDiscussPayload) => void>();
    render(
      <AnnotatedTranscriptRow
        handle="rec_1"
        discussContext={{ channelId: 'ch_1', threadRootEventId: 123 }}
        onDiscussEntry={onDiscussEntry}
      >
        <div>Transcript text</div>
      </AnnotatedTranscriptRow>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Discuss in thread' }));
    expect(onDiscussEntry).toHaveBeenCalledWith({
      handle: 'rec_1',
      channelId: 'ch_1',
      threadRootEventId: 123,
      draft: `${window.location.origin}/e/rec_1 `,
    });
  });
});
