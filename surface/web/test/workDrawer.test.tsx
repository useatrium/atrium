// @vitest-environment jsdom
// WorkDrawer: one tabbed surface over What changed + What it ran with a pin control.

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Artifact, FileChange, SideEffect } from '@atrium/centaur-client';
import { WorkDrawer, type WorkTab } from '../src/sessions/WorkDrawer';

function fc(over: Partial<FileChange>): FileChange {
  return { id: 'c1', path: 'src/a.ts', kind: 'update', diff: '- old\n+ new', toolName: 'Edit', sourceEventIds: [1], ...over };
}
function se(over: Partial<SideEffect>): SideEffect {
  return { id: 's1', command: 'npm install', category: 'package', risk: 'caution', toolName: 'Bash', sourceEventIds: [2], ...over };
}
function art(over: Partial<Artifact>): Artifact {
  return { id: 'a1', path: '/tmp/out.png', kind: 'created', mime: 'image/png', size: 2048, sha256: 'x', ref: 'b1', executionId: null, sourceEventIds: [3], ...over };
}

function renderDrawer(over: Partial<Parameters<typeof WorkDrawer>[0]> = {}) {
  const props = {
    changes: [fc({})],
    changedFileCount: 1,
    effects: [se({})],
    sideEffectCount: 1,
    hasDanger: false,
    artifacts: [] as Artifact[],
    artifactCount: 0,
    sessionId: 's-1',
    tab: 'changes' as WorkTab,
    onTab: vi.fn(),
    pinned: false,
    onTogglePin: vi.fn(),
    onClose: vi.fn(),
    ...over,
  };
  render(<WorkDrawer {...props} />);
  return props;
}

afterEach(cleanup);

describe('WorkDrawer', () => {
  it('renders a tab per non-empty surface, with counts', () => {
    renderDrawer();
    const tabs = screen.getAllByRole('tab');
    // what-changed + what-it-ran + the always-present Browse files tab.
    expect(tabs).toHaveLength(3);
    expect(screen.getByRole('tab', { name: /What changed/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /What it ran/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Browse files/ })).toBeTruthy();
    // What changed tab is active → shows the file row, not the command.
    expect(screen.getByText('src/a.ts')).toBeTruthy();
    expect(screen.queryByText('npm install')).toBeNull();
  });

  it('omits the tab for an empty surface (but keeps the always-present Files tab)', () => {
    renderDrawer({ effects: [], sideEffectCount: 0 });
    expect(screen.getAllByRole('tab')).toHaveLength(2); // changes + files
    expect(screen.queryByRole('tab', { name: /What it ran/ })).toBeNull();
    expect(screen.getByRole('tab', { name: /Browse files/ })).toBeTruthy();
  });

  it('clicking the What it ran tab calls onTab', () => {
    const props = renderDrawer();
    fireEvent.click(screen.getByRole('tab', { name: /What it ran/ }));
    expect(props.onTab).toHaveBeenCalledWith('sideEffects');
  });

  it('surfaces a Conflicts tab + the resolution UI when conflicts exist', () => {
    const onResolveConflict = vi.fn();
    const conflict = {
      artifactId: 'art-9',
      path: 'proj-x/plan.md',
      kind: 'diff3',
      conflictSeq: 6,
      baseSeq: 4,
      base: { sha: 'b', text: 'a\nb\n' },
      left: { label: 'theirs', author: 'human:alice', sha: 'l', text: 'a\nLEFT\n' },
      right: { label: 'yours', author: 'agent:s1', sha: 'r', text: 'a\nRIGHT\n' },
      markers: '<<<<<<<\nLEFT\n=======\nRIGHT\n>>>>>>>\n',
    };
    renderDrawer({ conflicts: [conflict], conflictCount: 1, onResolveConflict, tab: 'conflicts' as WorkTab });
    // Conflicts leads the tab order (most action-worthy).
    expect(screen.getByRole('tab', { name: /Conflicts/ })).toBeTruthy();
    // Embedded body shows both sides + the resolution actions (no dialog header).
    expect(screen.getByText('theirs')).toBeTruthy();
    expect(screen.getByText('yours')).toBeTruthy();
    fireEvent.click(screen.getByText('Keep theirs'));
    expect(onResolveConflict).toHaveBeenCalledWith('art-9', { kind: 'left' });
  });

  it('shows the active tab body and switches with the tab prop', () => {
    const { rerender } = render(
      <WorkDrawer
        changes={[fc({ path: 'src/x.ts' })]}
        changedFileCount={1}
        effects={[se({ command: 'curl https://example.com', category: 'network' })]}
        sideEffectCount={1}
        hasDanger={false}
        artifacts={[]}
        artifactCount={0}
        sessionId="s-1"
        tab="sideEffects"
        onTab={() => {}}
        pinned={false}
        onTogglePin={() => {}}
        onClose={() => {}}
      />,
    );
    const drawer = screen.getByTestId('work-drawer');
    expect(within(drawer).getByText('curl https://example.com')).toBeTruthy();
    expect(within(drawer).queryByText('src/x.ts')).toBeNull();

    rerender(
      <WorkDrawer
        changes={[fc({ path: 'src/x.ts' })]}
        changedFileCount={1}
        effects={[se({ command: 'curl https://example.com', category: 'network' })]}
        sideEffectCount={1}
        hasDanger={false}
        artifacts={[]}
        artifactCount={0}
        sessionId="s-1"
        tab="changes"
        onTab={() => {}}
        pinned={false}
        onTogglePin={() => {}}
        onClose={() => {}}
      />,
    );
    expect(within(drawer).getByText('src/x.ts')).toBeTruthy();
    expect(within(drawer).queryByText('curl https://example.com')).toBeNull();
  });

  it('falls back to the available tab when the active one is empty', () => {
    renderDrawer({ changes: [], changedFileCount: 0, tab: 'changes' });
    // tab=changes but no changes → renders the what-it-ran body.
    expect(screen.getByText('npm install')).toBeTruthy();
  });

  it('shows artifacts in the combined What changed surface when artifacts exist', () => {
    renderDrawer({
      artifacts: [art({ id: 'a1', path: '/tmp/chart.png' })],
      artifactCount: 1,
      tab: 'artifacts',
    });
    expect(screen.getAllByRole('tab')).toHaveLength(3); // what changed + what it ran + browse files
    expect(screen.queryByRole('tab', { name: /Artifacts/ })).toBeNull();
    expect(screen.getByRole('tab', { name: /What changed/ }).getAttribute('aria-selected')).toBe('true');
    // Back-compat tab=artifacts normalizes to What changed, where the gallery tile shows the filename.
    expect(screen.getByText('Created artifacts')).toBeTruthy();
    expect(screen.getByTestId('artifact-tile')).toBeTruthy();
    expect(screen.getByText('chart.png')).toBeTruthy();
  });

  it('pin toggle is aria-pressed by state and calls onTogglePin', () => {
    const props = renderDrawer({ pinned: false });
    const pin = screen.getByRole('button', { name: 'Pin work drawer' });
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(pin);
    expect(props.onTogglePin).toHaveBeenCalled();
  });

  it('when pinned, the control unpins', () => {
    renderDrawer({ pinned: true });
    const pin = screen.getByRole('button', { name: 'Unpin work drawer' });
    expect(pin.getAttribute('aria-pressed')).toBe('true');
  });

  it('hides the pin control when canPin is false', () => {
    renderDrawer({ canPin: false });
    expect(screen.queryByRole('button', { name: /pin work drawer/i })).toBeNull();
  });

  it('closes via the header button', () => {
    const props = renderDrawer();
    fireEvent.click(screen.getByRole('button', { name: 'Close work drawer' }));
    expect(props.onClose).toHaveBeenCalled();
  });

  it('detaches the active surface to its own tab (/s/:id/work/:slug)', () => {
    renderDrawer({ sessionId: 's-9', tab: 'changes' });
    const detach = screen.getByRole('link', { name: /open what changed in a new tab/i });
    expect(detach.getAttribute('href')).toBe('/s/s-9/work/changes');
    expect(detach.getAttribute('target')).toBe('_blank');
    expect(detach.getAttribute('rel')).toContain('noopener');
  });

  it('the detach link uses the URL-safe slug for the active tab', () => {
    renderDrawer({ tab: 'sideEffects' });
    const detach = screen.getByRole('link', { name: /open what it ran in a new tab/i });
    expect(detach.getAttribute('href')).toBe('/s/s-1/work/side-effects');
  });

  it('hides the detach control when canDetach is false (pending session)', () => {
    renderDrawer({ canDetach: false });
    expect(screen.queryByRole('link', { name: /in a new tab/i })).toBeNull();
  });
});
