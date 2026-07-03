// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { HubFileVersion } from '@atrium/surface-client';
import { VersionDiffView } from './VersionDiffView';
import type { PreviewFile } from './types';

const file: PreviewFile = {
  id: 'file-1',
  name: 'plan.md',
  mime: 'text/markdown',
  mediaKind: 'text',
  contentUrl: '/files/plan.md',
};

function version(seq: number): HubFileVersion {
  return {
    seq,
    author: 'u-1',
    kind: 'modified',
    status: 'normal',
    createdAt: '2026-07-03T00:00:00.000Z',
    sizeBytes: null,
    mime: 'text/markdown',
    isLatest: seq === 2,
  };
}

function textBlob(text: string): Blob {
  return { size: text.length, text: async () => text } as unknown as Blob;
}

describe('VersionDiffView', () => {
  it('offers a markup mode for CriticMarkup text and folds frontmatter', async () => {
    render(
      <VersionDiffView
        file={file}
        selectedVersion={version(1)}
        latestVersion={version(2)}
        selectedBlob={textBlob('Body')}
        latestBlob={textBlob('---\ntitle: Plan\n---\nBody {--old--}{++new++}')}
      />,
    );

    expect(await screen.findByRole('button', { name: 'Markup' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Markup' }));

    expect(screen.getByText('Markup view of latest version v2')).toBeTruthy();
    expect(screen.getByText('frontmatter')).toBeTruthy();
    expect(screen.getByText('old').className).toContain('atrium-critic-view-del');
    expect(screen.getByText('new').className).toContain('atrium-critic-view-ins');
    expect(screen.getByText('frontmatter').closest('details')?.hasAttribute('open')).toBe(false);

    fireEvent.click(screen.getByText('frontmatter'));
    await waitFor(() => expect(screen.getByText('frontmatter').closest('details')?.hasAttribute('open')).toBe(true));
    expect(screen.getByText(/title: Plan/)).toBeTruthy();
  });
});
