// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnnotatedTranscriptRow, type TranscriptDiscussPayload } from './SessionPane';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('AnnotatedTranscriptRow Discuss affordance', () => {
  it('removes the transcript-row comment affordance', () => {
    render(
      <AnnotatedTranscriptRow handle="rec_1">
        <div>Transcript text</div>
      </AnnotatedTranscriptRow>,
    );
    expect(screen.queryByRole('button', { name: 'Comment on entry' })).toBeNull();
  });

  it('copies the entry deep link and exposes a copied state', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText },
    });

    render(
      <AnnotatedTranscriptRow handle="rec_1">
        <div>Transcript text</div>
      </AnnotatedTranscriptRow>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy entry link' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/e/rec_1`));
    expect(screen.getByRole('button', { name: 'Copied entry link' })).toBeTruthy();
  });

  it('copies rendered transcript row text without action labels', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText },
    });

    render(
      <AnnotatedTranscriptRow handle="rec_1">
        <div>
          <span>Transcript text</span>
        </div>
      </AnnotatedTranscriptRow>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Copy block text' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Transcript text'));
    expect(screen.getByRole('button', { name: 'Copied block text' })).toBeTruthy();
  });

  it('does not show block text copy when rendered row text is empty', () => {
    render(
      <AnnotatedTranscriptRow handle="rec_1">
        <div />
      </AnnotatedTranscriptRow>,
    );

    expect(screen.getByRole('button', { name: 'Copy entry link' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy block text' })).toBeNull();
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
    expect(screen.queryByRole('button', { name: 'Discuss' })).toBeNull();
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
    fireEvent.click(screen.getByRole('button', { name: 'Discuss' }));
    expect(onDiscussEntry).toHaveBeenCalledWith({
      handle: 'rec_1',
      channelId: 'ch_1',
      threadRootEventId: 123,
      draft: '/e/rec_1 ',
    });
  });
});
