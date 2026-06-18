// @vitest-environment jsdom
// ArtifactsSurface: gallery of captured work-product files.

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Artifact } from '@atrium/centaur-client';
import { ArtifactsSurface } from '../src/sessions/ArtifactsSurface';

function art(over: Partial<Artifact>): Artifact {
  return {
    id: 'a1',
    path: '/home/agent/workspace/out/chart.png',
    kind: 'created',
    mime: 'image/png',
    size: 48_210,
    sha256: 'x',
    ref: 'b1',
    executionId: null,
    sourceEventIds: [3],
    ...over,
  };
}

afterEach(cleanup);

describe('ArtifactsSurface', () => {
  it('renders a tile per artifact with filename + count', () => {
    render(
      <ArtifactsSurface
        sessionId="s-1"
        onClose={() => {}}
        artifacts={[
          art({ id: 'a1', path: '/tmp/chart.png' }),
          art({ id: 'a2', path: '/home/agent/workspace/report.csv', mime: 'text/csv' }),
        ]}
      />,
    );
    expect(screen.getByText('· 2')).toBeTruthy();
    expect(screen.getAllByTestId('artifact-tile')).toHaveLength(2);
    expect(screen.getByText('chart.png')).toBeTruthy();
    expect(screen.getByText('report.csv')).toBeTruthy();
  });

  it('serves image bytes via the session artifact route', () => {
    render(<ArtifactsSurface sessionId="s-9" onClose={() => {}} artifacts={[art({ id: 'pic', ref: 'b1' })]} />);
    const img = screen.getByRole('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/sessions/s-9/artifacts/pic');
  });

  it('marks manifest-only artifacts (no bytes staged) and shows a type label', () => {
    render(
      <ArtifactsSurface
        sessionId="s-1"
        onClose={() => {}}
        artifacts={[art({ id: 'big', path: '/home/agent/outputs/render.pdf', mime: 'application/pdf', ref: null })]}
      />,
    );
    // No <img> when there are no servable bytes.
    expect(screen.queryByRole('img')).toBeNull();
    const tile = screen.getByTestId('artifact-tile');
    expect(within(tile).getByText('PDF')).toBeTruthy();
    expect(within(tile).getByText(/not captured/)).toBeTruthy();
  });

  it('closes via the header button (standalone)', () => {
    const onClose = vi.fn();
    render(<ArtifactsSurface sessionId="s-1" onClose={onClose} artifacts={[art({})]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close artifacts' }));
    expect(onClose).toHaveBeenCalled();
  });
});
