// @vitest-environment jsdom
// WorkDrawer: one tabbed surface over What changed + What it ran with a pin control.

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Artifact, ArtifactPresentation, FileChange, SideEffect } from '@atrium/centaur-client';
import { WorkDrawer, type WorkTab } from '../src/sessions/WorkDrawer';

vi.mock('../src/sessions/AppsSurface', () => ({
  AppsSurface: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="apps-surface">Apps for {sessionId}</div>
  ),
}));

function fc(over: Partial<FileChange>): FileChange {
  return { id: 'c1', path: 'src/a.ts', kind: 'update', diff: '- old\n+ new', toolName: 'Edit', sourceEventIds: [1], ...over };
}
function se(over: Partial<SideEffect>): SideEffect {
  return { id: 's1', command: 'npm install', category: 'package', risk: 'caution', toolName: 'Bash', sourceEventIds: [2], ...over };
}
function art(over: Partial<Artifact>): Artifact {
  return { id: 'a1', path: '/tmp/out.png', kind: 'created', mime: 'image/png', size: 2048, sha256: 'x', ref: 'b1', executionId: null, sourceEventIds: [3], ...over };
}
function presentation(over: Partial<ArtifactPresentation>): ArtifactPresentation {
  return {
    id: 'artifact-presented:shared/apps/demo/index.html',
    path: 'shared/apps/demo/index.html',
    title: 'Pipeline Dashboard',
    renderer: 'html-app',
    description: 'Business view',
    executionId: 'exe_1',
    sourceEventIds: [4],
    ...over,
  };
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
    // what-changed + what-it-ran + the always-present Files (hub) / Published apps tabs.
    expect(tabs).toHaveLength(4);
    expect(screen.getByRole('tab', { name: /What changed/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /What it ran/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /^Files$/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Published apps/ })).toBeTruthy();
    // What changed tab is active → shows the file row, not the command.
    expect(screen.getByText('src/a.ts')).toBeTruthy();
    expect(screen.queryByText('npm install')).toBeNull();
  });

  it('omits the tab for an empty surface (but keeps the always-present Files tab)', () => {
    renderDrawer({ effects: [], sideEffectCount: 0 });
    expect(screen.getAllByRole('tab')).toHaveLength(3); // changes + files (hub) + apps
    expect(screen.queryByRole('tab', { name: /What it ran/ })).toBeNull();
    expect(screen.getByRole('tab', { name: /^Files$/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Published apps/ })).toBeTruthy();
  });

  it('shows the Files hub tab (backed by the workspace when known)', () => {
    renderDrawer({ workspaceId: 'ws-1' });
    // What changed + What it ran + the always-present Files (hub) + Published apps.
    expect(screen.getAllByRole('tab')).toHaveLength(4);
    expect(screen.getByRole('tab', { name: /^Files$/ })).toBeTruthy();
  });

  it('clicking the What it ran tab calls onTab', () => {
    const props = renderDrawer();
    fireEvent.mouseDown(screen.getByRole('tab', { name: /What it ran/ }), { button: 0, ctrlKey: false });
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
    expect(screen.getAllByRole('tab')).toHaveLength(4); // what changed + what it ran + browse files + apps
    expect(screen.queryByRole('tab', { name: /Artifacts/ })).toBeNull();
    expect(screen.getByRole('tab', { name: /What changed/ }).getAttribute('aria-selected')).toBe('true');
    // Back-compat tab=artifacts normalizes to What changed, where the gallery tile shows the filename.
    expect(screen.getByText('Created artifacts')).toBeTruthy();
    expect(screen.getByTestId('artifact-tile')).toBeTruthy();
    expect(screen.getByText('chart.png')).toBeTruthy();
  });

  it('renders AppsSurface from the Published apps tab', () => {
    renderDrawer({ tab: 'apps' });
    expect(screen.getByRole('tab', { name: /Published apps/ }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('apps-surface').textContent).toBe('Apps for s-1');
  });

  it('promotes artifact presentations inside the What changed surface', () => {
    renderDrawer({
      artifacts: [art({ id: 'app', path: 'shared/apps/demo/index.html', mime: 'text/html' })],
      artifactPresentations: [presentation({})],
      artifactCount: 1,
      tab: 'changes',
    });
    expect(screen.getByText('Presented apps')).toBeTruthy();
    expect(screen.getByText('Pipeline Dashboard')).toBeTruthy();
    expect(screen.getByText('Presented app · Business view')).toBeTruthy();
    expect(screen.getByRole('button', { name: /preview app/i })).toBeTruthy();
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

  it('the detach link supports the Published apps slug', () => {
    renderDrawer({ tab: 'apps' });
    const detach = screen.getByRole('link', { name: /open published apps in a new tab/i });
    expect(detach.getAttribute('href')).toBe('/s/s-1/work/apps');
  });

  it('hides the detach control when canDetach is false (pending session)', () => {
    renderDrawer({ canDetach: false });
    expect(screen.queryByRole('link', { name: /in a new tab/i })).toBeNull();
  });
});
