// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { forwardRef, useImperativeHandle } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MarkupPane, type MarkupPaneSource } from './MarkupPane';
import type { MarkupEditorHandle } from '../markup/MarkupEditor';

vi.mock('../markup/MarkupEditor', () => ({
  MarkupEditor: forwardRef<
    MarkupEditorHandle,
    { initialMarkdown: string; onDirtyChange?: (dirty: boolean) => void; className?: string }
  >(function MockMarkupEditor(props, ref) {
    useImperativeHandle(
      ref,
      () => ({
        serialize: () => props.initialMarkdown,
        hasMarkup: () => true,
      }),
      [props.initialMarkdown],
    );
    return (
      <div className={props.className} data-testid="mock-markup-editor">
        {props.initialMarkdown}
      </div>
    );
  }),
}));

vi.mock('./MarkupVersionHistory', () => ({
  MarkupVersionHistory: (props: { artifactId: string; path: string; currentSeq: number }) => (
    <div data-testid="mock-markup-history">
      history:{props.artifactId}:{props.path}:{props.currentSeq}
    </div>
  ),
}));

function source(overrides: Partial<MarkupPaneSource> = {}): MarkupPaneSource {
  return {
    artifactId: 'art_markup',
    path: 'message.md',
    seq: 7,
    sessionId: 'sess_1',
    frontmatter: '',
    body: '## Preferences\n- Choose plan\n',
    ...overrides,
  };
}

function renderPane(overrides: Partial<MarkupPaneSource> = {}) {
  const onClose = vi.fn();
  render(<MarkupPane source={source(overrides)} onClose={onClose} />);
  return { onClose };
}

describe('MarkupPane', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('shows a divergence banner and can reset to the source message', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderPane({
      sourceText: '## Preferences\n- Choose plan\n- Configure notifications\n',
    });

    expect(await screen.findByText('This markup has changed since the original message.')).toBeTruthy();
    expect(await screen.findByTestId('mock-markup-editor')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reset to message' })).toBeTruthy();
    expect(screen.queryByText(/Configure notifications/)).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Reset to message' }));

    expect(window.confirm).toHaveBeenCalledWith('Discard your markup?');
    expect(await screen.findByText(/Configure notifications/)).toBeTruthy();
    expect(screen.getByText('Showing the original message')).toBeTruthy();
  });

  it('does not show the divergence banner when the source message matches the markup body', async () => {
    const body = '## Preferences\n- Choose plan\n';

    renderPane({ body, sourceText: body });

    expect(await screen.findByTestId('mock-markup-editor')).toBeTruthy();
    expect(screen.queryByText('This markup has changed since the original message.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reset to message' })).toBeNull();
  });

  it('opens version history from the header toggle', async () => {
    renderPane();

    expect(await screen.findByTestId('mock-markup-editor')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'History' }));

    expect(screen.getByTestId('mock-markup-history').textContent).toBe('history:art_markup:message.md:7');
  });
});
