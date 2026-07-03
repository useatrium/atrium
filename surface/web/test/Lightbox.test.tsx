// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
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
});
