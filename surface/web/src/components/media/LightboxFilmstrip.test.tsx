// @vitest-environment jsdom

import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreviewFile } from './types';

vi.mock('./MediaPreview', () => ({
  MediaPreview: ({ file, variant }: { file: PreviewFile; variant: string }) => (
    <div data-testid={`${variant}-preview`} data-file-id={file.id} />
  ),
}));

import { Lightbox } from './Lightbox';

function preview(index: number): PreviewFile {
  return {
    id: `art_${index}`,
    name: `file-${index}.txt`,
    mime: 'text/plain',
    mediaKind: 'text',
    contentUrl: `/api/files/artifact/art_${index}/content`,
  };
}

function Harness({ files, initialIndex }: { files: PreviewFile[]; initialIndex: number }) {
  const [index, setIndex] = useState(initialIndex);
  return <Lightbox files={files} index={index} onIndexChange={setIndex} onClose={() => {}} panel={null} />;
}

afterEach(cleanup);

describe('Lightbox filmstrip hydration', () => {
  it('keeps rendering bounded to the active neighborhood while navigating', () => {
    const files = Array.from({ length: 20 }, (_, index) => preview(index));
    render(<Harness files={files} initialIndex={10} />);

    expect(screen.getAllByTestId('tile-preview').map((node) => node.getAttribute('data-file-id'))).toEqual([
      'art_8',
      'art_9',
      'art_10',
      'art_11',
      'art_12',
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Next file' }));

    expect(screen.getAllByTestId('tile-preview').map((node) => node.getAttribute('data-file-id'))).toEqual([
      'art_9',
      'art_10',
      'art_11',
      'art_12',
      'art_13',
    ]);
  });
});
