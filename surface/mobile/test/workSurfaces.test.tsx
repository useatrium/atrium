// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import type { Artifact } from '@atrium/centaur-client';
import { renderWithTheme as renderUI } from './rnTestUtils';
import { ArtifactsSurface } from '../src/components/work/ArtifactsSurface';
import { WorkStrips } from '../src/components/work/WorkStrips';
import { MobileWorkSheet, type WorkSurfaceTab } from '../src/components/work/MobileWorkSheet';
import { Text } from 'react-native';

afterEach(cleanup);

function artifact(over: Partial<Artifact>): Artifact {
  return {
    id: 'a1',
    path: '/home/agent/workspace/out/chart.png',
    kind: 'created',
    mime: 'image/png',
    size: 48_210,
    sha256: 'x',
    ref: 'blob-1',
    executionId: null,
    sourceEventIds: [3],
    ...over,
  };
}

describe('ArtifactsSurface (mobile)', () => {
  it('renders a tile per artifact: image thumbnail, type label, and manifest-only note', () => {
    const artifactUri = vi.fn((aid: string) => `uri://${aid}`);
    renderUI(
      <ArtifactsSurface
        artifacts={[
          artifact({ id: 'img', path: 'out/chart.png', mime: 'image/png', ref: 'b1' }),
          artifact({ id: 'csv', path: 'out/data.csv', mime: 'text/csv', ref: 'b2', size: 2048 }),
          artifact({ id: 'big', path: 'out/huge.bin', mime: 'application/octet-stream', ref: null }),
        ]}
        artifactUri={artifactUri}
        imageHeaders={{ authorization: 'Bearer t' }}
      />,
    );
    // basenames render
    expect(screen.getByText('chart.png')).toBeInTheDocument();
    expect(screen.getByText('data.csv')).toBeInTheDocument();
    expect(screen.getByText('huge.bin')).toBeInTheDocument();
    // image tile builds its byte URL from the bound artifactUri
    expect(artifactUri).toHaveBeenCalledWith('img');
    // non-image → type label; manifest-only → "not captured"
    expect(screen.getByText('CSV')).toBeInTheDocument();
    expect(screen.getByText('NOT CAPTURED')).toBeInTheDocument();
    expect(screen.getByText('not captured · too large')).toBeInTheDocument();
  });

  it('shows an empty state when there are no artifacts', () => {
    renderUI(<ArtifactsSurface artifacts={[]} artifactUri={(a) => a} imageHeaders={{}} />);
    expect(screen.getByText('No artifacts captured.')).toBeInTheDocument();
  });
});

describe('WorkStrips (mobile)', () => {
  it('shows a chip only for non-empty surfaces and opens on press', () => {
    const onOpen = vi.fn();
    renderUI(
      <WorkStrips
        items={[
          { key: 'changes', label: 'Changes', count: 0 },
          { key: 'artifacts', label: 'Artifacts', count: 2 },
        ]}
        onOpen={onOpen}
      />,
    );
    expect(screen.queryByLabelText(/Changes: 0/)).toBeNull(); // empty surface hidden
    fireEvent.click(screen.getByLabelText('Artifacts: 2'));
    expect(onOpen).toHaveBeenCalledWith('artifacts');
  });

  it('renders nothing when every surface is empty', () => {
    const { container } = renderUI(<WorkStrips items={[{ key: 'changes', label: 'Changes', count: 0 }]} onOpen={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('MobileWorkSheet (mobile)', () => {
  const tabs: WorkSurfaceTab[] = [
    { key: 'artifacts', label: 'Artifacts', count: 2, render: () => <Text>artifacts body</Text> },
    { key: 'changes', label: 'Changes', count: 1, render: () => <Text>changes body</Text> },
  ];

  it('renders the active tab body full-screen and switches tabs', () => {
    const onTab = vi.fn();
    renderUI(<MobileWorkSheet visible tabs={tabs} activeKey="artifacts" onTab={onTab} onClose={() => {}} />);
    const sheet = screen.getByTestId('mobile-work-sheet');
    expect(within(sheet).getByText('artifacts body')).toBeInTheDocument();
    fireEvent.click(within(sheet).getByRole('tab', { name: /Changes/ }));
    expect(onTab).toHaveBeenCalledWith('changes');
  });

  it('closes via the header control', () => {
    const onClose = vi.fn();
    renderUI(<MobileWorkSheet visible tabs={tabs} activeKey="artifacts" onTab={() => {}} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText('Close work surfaces'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
