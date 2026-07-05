// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Lightbox } from '../src/components/media';
import type { PreviewFile } from '../src/components/media';

const textFile: PreviewFile = {
  id: 'art-1',
  name: 'result.md',
  mime: 'text/markdown',
  mediaKind: 'text',
  contentUrl: '/api/files/artifact/art-1/content',
};

afterEach(() => {
  cleanup();
});

describe('Lightbox markup action', () => {
  it('shows Mark up for text artifacts only when session id is available', () => {
    const onMarkup = vi.fn();
    const { rerender } = render(
      <Lightbox
        files={[textFile]}
        index={0}
        onIndexChange={() => {}}
        onClose={() => {}}
        onMarkup={onMarkup}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Mark up' })).toBeNull();

    rerender(
      <Lightbox
        files={[textFile]}
        index={0}
        onIndexChange={() => {}}
        onClose={() => {}}
        sessionId="sess-1"
        onMarkup={onMarkup}
      />,
    );

    expect(screen.getByRole('button', { name: 'Mark up' })).toBeTruthy();
  });

  it('shows entry reference chip in the header when the open file has references', () => {
    render(
      <Lightbox
        files={[textFile]}
        index={0}
        onIndexChange={() => {}}
        onClose={() => {}}
        entryReferencesByFileId={{
          'art-1': {
            count: 3,
            latest: [
              {
                eventId: 1,
                handle: 'msg_1',
                channelId: 'ch-1',
                threadRootEventId: null,
                actorLabel: 'Ada',
                excerpt: 'Discussed this artifact',
                ts: new Date().toISOString(),
              },
            ],
          },
        }}
      />,
    );

    expect(screen.getByRole('button', { name: '3 discussions' })).toBeTruthy();
  });

  it('offers Discuss with a prefilled artifact link and no retired Comment button', () => {
    const onDiscuss = vi.fn();
    render(
      <Lightbox
        files={[textFile]}
        index={0}
        onIndexChange={() => {}}
        onClose={() => {}}
        onDiscuss={onDiscuss}
        onComment={vi.fn()}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Comment' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Discuss in channel' }));
    expect(onDiscuss).toHaveBeenCalledWith(textFile, `/e/art_art-1 `);
  });
});
