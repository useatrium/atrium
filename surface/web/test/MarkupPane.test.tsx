// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { forwardRef, useImperativeHandle, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, api } from '../src/api';
import { MarkupPane, splitMarkdownFrontmatter, type MarkupPaneSource } from '../src/components/MarkupPane';

vi.mock('../src/api', async () => {
  const actual = await vi.importActual<typeof import('../src/api')>('../src/api');
  return {
    ...actual,
    api: {
      sendArtifactFeedback: vi.fn(),
    },
  };
});

vi.mock(
  '/src/markup/MarkupEditor',
  () => ({
    MarkupEditor: forwardRef(function MockMarkupEditor(
      {
        initialMarkdown,
        onDirtyChange,
        className,
      }: {
        initialMarkdown: string;
        onDirtyChange?: (dirty: boolean) => void;
        className?: string;
      },
      ref,
    ) {
      const [value, setValue] = useState(initialMarkdown);
      useImperativeHandle(ref, () => ({
        serialize: () => value,
        hasMarkup: () => value.includes('{++') || value.includes('{--'),
      }));
      return (
        <textarea
          aria-label="Mock markup editor"
          className={className}
          value={value}
          onChange={(event) => {
            setValue(event.target.value);
            onDirtyChange?.(event.target.value !== initialMarkdown);
          }}
        />
      );
    }),
  }),
);

const source: MarkupPaneSource = {
  artifactId: 'art-1',
  path: 'notes/result.md',
  seq: 7,
  workspaceId: 'ws-1',
  sessionId: 'sess-1',
  frontmatter: '---\ntitle: "Result Notes"\n---\n',
  body: '# Body\n',
};

beforeEach(() => {
  vi.mocked(api.sendArtifactFeedback).mockResolvedValue({ seq: 8, status: 'normal', steered: true });
  vi.stubGlobal('crypto', { randomUUID: () => 'op-1' });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('MarkupPane', () => {
  it('splits frontmatter and seeds the editor with only the markdown body', async () => {
    const split = splitMarkdownFrontmatter('---\ntitle: Result Notes\n---\n\n# Body\n');
    expect(split.frontmatter).toBe('---\ntitle: Result Notes\n---\n');
    expect(split.body).toBe('# Body\n');

    render(<MarkupPane source={{ ...source, ...split }} onClose={() => {}} />);

    expect(await screen.findByRole('dialog', { name: 'Result Notes' })).toBeTruthy();
    expect((await screen.findByLabelText('Mock markup editor') as HTMLTextAreaElement).value).toBe('# Body\n');
  });

  it('sends frontmatter plus serialized body with base seq, session id, note, and op id', async () => {
    const onClose = vi.fn();
    render(<MarkupPane source={source} onClose={onClose} />);

    fireEvent.change(await screen.findByLabelText('Mock markup editor'), {
      target: { value: '# Body\n{++new++}\n' },
    });
    fireEvent.change(screen.getByLabelText('Add a note'), { target: { value: 'tighten this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }));

    await waitFor(() => expect(api.sendArtifactFeedback).toHaveBeenCalledTimes(1));
    expect(api.sendArtifactFeedback).toHaveBeenCalledWith('art-1', {
      content: '---\ntitle: "Result Notes"\n---\n\n# Body\n{++new++}\n',
      baseSeq: 7,
      sessionId: 'sess-1',
      note: 'tighten this',
      opId: 'op-1',
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the pane open on stale base seq', async () => {
    vi.mocked(api.sendArtifactFeedback).mockRejectedValue(new ApiError(409, 'stale_base', 'stale'));

    render(<MarkupPane source={source} onClose={() => {}} />);

    fireEvent.change(await screen.findByLabelText('Mock markup editor'), {
      target: { value: '# Body\n{++new++}\n' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send to agent' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'This document changed since you started — reopen to retry.',
    );
    expect(screen.getByRole('dialog', { name: 'Result Notes' })).toBeTruthy();
  });

  it('writes markup content and sends an entry-link reply in reply mode', async () => {
    const onClose = vi.fn();
    const onSendThreadReply = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MarkupPane
        source={source}
        mode={{ kind: 'reply', channelId: 'ch-1', threadRootEventId: 101 }}
        onClose={onClose}
        onSendThreadReply={onSendThreadReply}
      />,
    );

    fireEvent.change(await screen.findByLabelText('Mock markup editor'), {
      target: { value: '# Body\n{++new++}\n' },
    });
    fireEvent.change(screen.getByLabelText('Say something about your changes'), {
      target: { value: 'please review this' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reply in thread' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock).toHaveBeenCalledWith('/api/files/art-1/content', {
      method: 'PUT',
      credentials: 'same-origin',
      headers: {
        'X-Artifact-Base-Seq': '7',
        'Content-Type': 'text/markdown; charset=utf-8',
      },
      body: '---\ntitle: "Result Notes"\n---\n\n# Body\n{++new++}\n',
    });
    expect(onSendThreadReply).toHaveBeenCalledWith({
      channelId: 'ch-1',
      threadRootEventId: 101,
      text: `please review this\n/e/art_art-1`,
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps reply markup open on stale write-back', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 409,
      statusText: 'Conflict',
      json: vi.fn().mockResolvedValue({ error: 'stale_base' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <MarkupPane
        source={source}
        mode={{ kind: 'reply', channelId: 'ch-1', threadRootEventId: 101 }}
        onClose={() => {}}
        onSendThreadReply={vi.fn()}
      />,
    );

    const editor = await screen.findByLabelText('Mock markup editor') as HTMLTextAreaElement;
    fireEvent.change(editor, {
      target: { value: '# Body\n{++new++}\n' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Reply in thread' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'This document changed since you started — reopen to retry.',
    );
    expect((screen.getByLabelText('Mock markup editor') as HTMLTextAreaElement).value).toBe('# Body\n{++new++}\n');
  });

  it('confirms before closing dirty markup', async () => {
    const onClose = vi.fn();
    const confirm = vi.fn(() => false);
    vi.stubGlobal('confirm', confirm);

    render(<MarkupPane source={source} onClose={onClose} />);

    fireEvent.change(await screen.findByLabelText('Mock markup editor'), {
      target: { value: '# Body\n{++new++}\n' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(confirm).toHaveBeenCalledWith('Discard your markup?');
    expect(onClose).not.toHaveBeenCalled();
  });
});
