// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { forwardRef, useImperativeHandle } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isMarkupShellRoute, markupShellThemeFromSearch, MarkupShellPage } from './MarkupShellPage';

vi.mock('./markup/MarkupEditor', () => ({
  MarkupEditor: forwardRef(function MockMarkupEditor(
    props: { initialMarkdown: string; onDirtyChange?: (dirty: boolean) => void; className?: string },
    ref,
  ) {
    useImperativeHandle(ref, () => ({
      serialize: () => `${props.initialMarkdown}\nserialized`,
      hasMarkup: () => true,
    }));
    return (
      <button type="button" onClick={() => props.onDirtyChange?.(true)}>
        editor:{props.initialMarkdown}
      </button>
    );
  }),
}));

vi.mock('./components/MarkupVersionHistory', () => ({
  MarkupVersionHistory: (props: { artifactId: string; path: string; currentSeq: number }) => (
    <div data-testid="mock-markup-history">
      history:{props.artifactId}:{props.path}:{props.currentSeq}
    </div>
  ),
}));

describe('MarkupShellPage', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    delete window.ReactNativeWebView;
    document.documentElement.removeAttribute('data-theme');
    history.replaceState(null, '', '/');
  });

  it('matches only the frozen shell route and parses the theme query', () => {
    expect(isMarkupShellRoute('/markup/shell')).toBe(true);
    expect(isMarkupShellRoute('/markup/shell/extra')).toBe(false);
    expect(markupShellThemeFromSearch('?theme=light')).toBe('light');
    expect(markupShellThemeFromSearch('?theme=system')).toBe('dark');
  });

  it('renders a harmless browser hint without the native bridge', () => {
    render(<MarkupShellPage />);

    expect(screen.getByText(/Open this page from the Atrium mobile app/)).toBeTruthy();
  });

  it('posts ready, accepts init, relays dirty, and serializes', () => {
    const postMessage = vi.fn();
    window.ReactNativeWebView = { postMessage };
    history.replaceState(null, '', '/markup/shell?theme=light');
    render(<MarkupShellPage />);

    expect(postMessage).toHaveBeenCalledWith(JSON.stringify({ type: 'markup-shell-ready' }));
    expect(document.documentElement.dataset.theme).toBe('light');

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', { data: JSON.stringify({ type: 'markup-init', markdown: 'Body' }) }),
      );
    });
    expect(screen.getByText('editor:Body')).toBeTruthy();

    screen.getByRole('button', { name: 'editor:Body' }).click();
    expect(postMessage).toHaveBeenCalledWith(JSON.stringify({ type: 'markup-dirty', dirty: true }));

    act(() => {
      window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'markup-request-serialize' }) }));
    });
    expect(postMessage).toHaveBeenCalledWith(
      JSON.stringify({ type: 'markup-serialized', markdown: 'Body\nserialized' }),
    );
  });

  it('shows a divergence banner and can reset to the source message', () => {
    window.ReactNativeWebView = { postMessage: vi.fn() };
    render(<MarkupShellPage />);

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'markup-init',
            markdown: '## Preferences\n- Choose plan\n',
            sourceText: '## Preferences\n- Choose plan\n- Configure notifications\n',
          }),
        }),
      );
    });

    expect(screen.getByText('This markup has changed since the original message.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Reset to message' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Configure notifications/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Reset to message' }));

    expect(screen.getByRole('button', { name: /Configure notifications/ })).toBeTruthy();
    expect(screen.getByText('Showing the original message')).toBeTruthy();
  });

  it.each([
    ['matching source', 'Body'],
    ['null source', null],
  ])('does not show a divergence banner for %s', (_label, sourceText) => {
    window.ReactNativeWebView = { postMessage: vi.fn() };
    render(<MarkupShellPage />);

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({ type: 'markup-init', markdown: 'Body', sourceText }),
        }),
      );
    });

    expect(screen.getByText('editor:Body')).toBeTruthy();
    expect(screen.queryByText('This markup has changed since the original message.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reset to message' })).toBeNull();
  });

  it('opens version history from the shell toggle', () => {
    window.ReactNativeWebView = { postMessage: vi.fn() };
    render(<MarkupShellPage />);

    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: JSON.stringify({
            type: 'markup-init',
            markdown: 'Body',
            artifactId: 'artifact-1',
            path: 'docs/plan.md',
            artifactSeq: 12,
          }),
        }),
      );
    });

    fireEvent.click(screen.getByRole('button', { name: 'History' }));

    expect(screen.getByTestId('mock-markup-history').textContent).toBe('history:artifact-1:docs/plan.md:12');
  });
});
