// @vitest-environment jsdom
// WorkDrawer: one tabbed surface over Changes + Side-effects with a pin control.

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileChange, SideEffect } from '@atrium/centaur-client';
import { WorkDrawer, type WorkTab } from '../src/sessions/WorkDrawer';

function fc(over: Partial<FileChange>): FileChange {
  return { id: 'c1', path: 'src/a.ts', kind: 'update', diff: '- old\n+ new', toolName: 'Edit', sourceEventIds: [1], ...over };
}
function se(over: Partial<SideEffect>): SideEffect {
  return { id: 's1', command: 'npm install', category: 'package', risk: 'caution', toolName: 'Bash', sourceEventIds: [2], ...over };
}

function renderDrawer(over: Partial<Parameters<typeof WorkDrawer>[0]> = {}) {
  const props = {
    changes: [fc({})],
    changedFileCount: 1,
    effects: [se({})],
    sideEffectCount: 1,
    hasDanger: false,
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
    expect(tabs).toHaveLength(2);
    expect(screen.getByRole('tab', { name: /Changes/ })).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Side-effects/ })).toBeTruthy();
    // Changes tab is active → shows the file row, not the command.
    expect(screen.getByText('src/a.ts')).toBeTruthy();
    expect(screen.queryByText('npm install')).toBeNull();
  });

  it('omits the tab for an empty surface', () => {
    renderDrawer({ effects: [], sideEffectCount: 0 });
    expect(screen.getAllByRole('tab')).toHaveLength(1);
    expect(screen.queryByRole('tab', { name: /Side-effects/ })).toBeNull();
  });

  it('clicking the Side-effects tab calls onTab', () => {
    const props = renderDrawer();
    fireEvent.click(screen.getByRole('tab', { name: /Side-effects/ }));
    expect(props.onTab).toHaveBeenCalledWith('sideEffects');
  });

  it('shows the active tab body and switches with the tab prop', () => {
    const { rerender } = render(
      <WorkDrawer
        changes={[fc({ path: 'src/x.ts' })]}
        changedFileCount={1}
        effects={[se({ command: 'curl https://example.com', category: 'network' })]}
        sideEffectCount={1}
        hasDanger={false}
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
    // tab=changes but no changes → renders the side-effects body.
    expect(screen.getByText('npm install')).toBeTruthy();
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
});
