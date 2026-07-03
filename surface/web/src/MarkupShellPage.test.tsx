// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
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
    return <button onClick={() => props.onDirtyChange?.(true)}>editor:{props.initialMarkdown}</button>;
  }),
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
      window.dispatchEvent(new MessageEvent('message', { data: JSON.stringify({ type: 'markup-init', markdown: 'Body' }) }));
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
});
