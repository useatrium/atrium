// @vitest-environment jsdom
// ChangesSurface: groups edits by path, shows kind badges, toggles diffs.

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FileChange } from '@atrium/centaur-client';
import { ChangesSurface } from '../src/sessions/ChangesSurface';

function fc(over: Partial<FileChange>): FileChange {
  return {
    id: 't1',
    path: 'src/a.ts',
    kind: 'update',
    diff: '- old\n+ new',
    toolName: 'Edit',
    sourceEventIds: [1],
    ...over,
  };
}

afterEach(cleanup);

describe('ChangesSurface', () => {
  it('groups by path and counts distinct files', () => {
    render(
      <ChangesSurface
        changes={[
          fc({ id: 't1', path: 'src/a.ts' }),
          fc({ id: 't2', path: 'src/a.ts', diff: '+ more' }),
          fc({ id: 't3', path: 'src/b.ts', kind: 'add', diff: '+ x' }),
        ]}
        onClose={() => {}}
      />,
    );
    // Two distinct files in the header count.
    expect(screen.getByText('· 2')).toBeTruthy();
    expect(screen.getByText('src/a.ts')).toBeTruthy();
    expect(screen.getByText('src/b.ts')).toBeTruthy();
    expect(screen.getByText('added')).toBeTruthy();
  });

  it('expands a file to reveal its diff lines', () => {
    render(<ChangesSurface changes={[fc({ path: 'src/a.ts', diff: '- old\n+ new' })]} onClose={() => {}} />);
    // Diff hidden until the row is clicked.
    expect(screen.queryByText('+ new')).toBeNull();
    fireEvent.click(screen.getByText('src/a.ts'));
    const surface = screen.getByTestId('changes-surface');
    expect(within(surface).getByText('+ new')).toBeTruthy();
    expect(within(surface).getByText('- old')).toBeTruthy();
  });

  it('closes via the header button', () => {
    const onClose = vi.fn();
    render(<ChangesSurface changes={[fc({})]} onClose={onClose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Close changes' }));
    expect(onClose).toHaveBeenCalled();
  });
});
