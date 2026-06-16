// @vitest-environment jsdom
// InlineFileChange: glanceable edit row that expands to the coloured diff.

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { FileChange } from '@atrium/centaur-client';
import { InlineFileChange } from '../src/sessions/fileChangeView';

function fc(over: Partial<FileChange>): FileChange {
  return {
    id: 'e1',
    path: 'src/app.ts',
    kind: 'update',
    diff: '- const a = 1;\n+ const a = 2;',
    toolName: 'Edit',
    sourceEventIds: [7],
    ...over,
  };
}

afterEach(cleanup);

describe('InlineFileChange', () => {
  it('shows kind badge, path and add/del counts; diff hidden until expanded', () => {
    render(<InlineFileChange change={fc({})} />);
    expect(screen.getByText('edited')).toBeTruthy();
    expect(screen.getByText('src/app.ts')).toBeTruthy();
    expect(screen.getByText('+1')).toBeTruthy();
    expect(screen.getByText('−1')).toBeTruthy();
    // Collapsed: diff lines not rendered.
    expect(screen.queryByText('+ const a = 2;')).toBeNull();
  });

  it('expands to reveal the coloured diff', () => {
    render(<InlineFileChange change={fc({})} />);
    fireEvent.click(screen.getByRole('button'));
    const card = screen.getByTestId('inline-file-change');
    expect(within(card).getByText('+ const a = 2;')).toBeTruthy();
    expect(within(card).getByText('- const a = 1;')).toBeTruthy();
  });

  it('labels a Write as added', () => {
    render(<InlineFileChange change={fc({ kind: 'add', toolName: 'Write', diff: '+ hello' })} />);
    expect(screen.getByText('added')).toBeTruthy();
    expect(screen.getByText('+1')).toBeTruthy();
  });

  it('flags an errored edit', () => {
    render(<InlineFileChange change={fc({})} status="error" />);
    expect(screen.getByText('error')).toBeTruthy();
  });
});
