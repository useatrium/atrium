// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer';

const channelContext = { scope: 'channel' as const, channelLabel: '#engineering' };

function renderComposer(props: Partial<React.ComponentProps<typeof Composer>> = {}) {
  const onSend = vi.fn();
  const onAgentSend = vi.fn();
  render(
    <Composer
      placeholder="Message"
      onSend={onSend}
      routing={{ kind: 'managed', context: channelContext, onAgentSend }}
      {...props}
    />,
  );
  return { onSend, onAgentSend };
}

const toggle = () => screen.getByTestId('composer-audience-pill');
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Composer audience control', () => {
  it('uses an icon-only switch plus persistent destination feedback', () => {
    renderComposer();

    expect(toggle().textContent).toBe('');
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect(toggle().getAttribute('aria-label')).toContain('Messaging people');
    expect(screen.getByPlaceholderText('Message people…')).toBeTruthy();

    fireEvent.click(toggle());

    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(toggle().getAttribute('aria-label')).toContain('Prompting the agent');
    expect(screen.getByPlaceholderText('Prompt agent…')).toBeTruthy();
  });

  it('turns a leading !! into agent mode and swallows the sigil', () => {
    renderComposer();
    const input = screen.getByLabelText('Message input') as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: '!!Research this' } });

    expect(input.value).toBe('Research this');
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
  });

  it('preserves Mod+J and Escape audience switching', () => {
    renderComposer();
    const input = screen.getByLabelText('Message input');

    fireEvent.keyDown(input, { key: 'j', metaKey: true });
    expect(toggle().getAttribute('aria-pressed')).toBe('true');

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
  });

  it('defaults an attached non-driver thread to Suggest and keeps it sticky after send', () => {
    const onAgentSend = vi.fn();
    renderComposer({
      routing: {
        kind: 'managed',
        context: {
          scope: 'thread',
          channelLabel: 'this thread',
          threadRootEventId: 17,
          meId: 'me',
          attachedSession: { id: 's-1', title: 'Fix tests', driverId: 'someone-else' },
        },
        onAgentSend,
      },
    });

    expect(screen.getByPlaceholderText('Prompt agent…')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Message input'), { target: { value: 'Try the flaky test first' } });
    fireEvent.click(screen.getByRole('button', { name: 'Suggest' }));

    expect(onAgentSend).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'suggest', sessionId: 's-1' }),
      'Try the flaky test first',
      undefined,
      undefined,
    );
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
  });

  it('restores a saved People draft instead of applying the attached-thread Agent default', () => {
    renderComposer({
      initialDraft: 'Keep this in the discussion',
      initialDraftAgentIntent: false,
      routing: {
        kind: 'managed',
        context: {
          scope: 'thread',
          channelLabel: 'this thread',
          threadRootEventId: 17,
          attachedSession: { id: 's-1', title: 'Fix tests', driverId: 'me' },
          meId: 'me',
        },
        onAgentSend: vi.fn(),
      },
    });

    expect(toggle().getAttribute('aria-pressed')).toBe('false');
    expect((screen.getByLabelText('Message input') as HTMLTextAreaElement).value).toBe('Keep this in the discussion');
  });

  it('dispatches a channel spawn request and returns to People after send', () => {
    const { onAgentSend } = renderComposer();
    fireEvent.click(toggle());
    fireEvent.change(screen.getByLabelText('Message input'), { target: { value: 'Research the incident' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    expect(onAgentSend).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'spawn-channel' }),
      'Research the incident',
      undefined,
      undefined,
    );
    expect(toggle().getAttribute('aria-pressed')).toBe('false');
  });

  it('hides voice recording while Agent is selected', () => {
    renderComposer({ allowAttachments: true, allowVoice: true });
    expect(screen.getByRole('button', { name: 'Record a voice message' })).toBeTruthy();

    fireEvent.click(toggle());

    expect(screen.queryByRole('button', { name: 'Record a voice message' })).toBeNull();
  });

  it('routes uploaded files through the agent handler', async () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:test');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const queueUpload = vi.fn().mockResolvedValue({ fileId: 'file-1' });
    const { onAgentSend } = renderComposer({ allowAttachments: true, queueUpload });
    const file = new File(['hello'], 'notes.txt', { type: 'text/plain' });

    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [file] },
    });
    await waitFor(() => expect(screen.getByText('notes.txt')).toBeTruthy());
    fireEvent.click(toggle());
    fireEvent.change(screen.getByLabelText('Message input'), { target: { value: 'Read this' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));

    expect(onAgentSend).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'spawn-channel' }),
      'Read this',
      [expect.objectContaining({ id: 'file-1', filename: 'notes.txt' })],
      [expect.objectContaining({ uploadKey: expect.any(String) })],
    );
  });
});

describe('Composer draft audience', () => {
  it('immediately reroutes existing text and persists its selected audience', () => {
    const onDraftChange = vi.fn();
    renderComposer({ draftKey: 'channel:c1', onDraftChange });
    const input = screen.getByLabelText('Message input');
    fireEvent.change(input, { target: { value: 'fix the build' } });

    fireEvent.click(toggle());
    expect(onDraftChange).toHaveBeenLastCalledWith('channel:c1', 'fix the build', true);

    fireEvent.click(toggle());
    expect(onDraftChange).toHaveBeenLastCalledWith('channel:c1', 'fix the build', false);
  });

  it('restores an agent-intent draft directly to Agent', () => {
    renderComposer({ draftKey: 'channel:c1', initialDraft: 'fix the build', initialDraftAgentIntent: true });

    expect((screen.getByLabelText('Message input') as HTMLTextAreaElement).value).toBe('fix the build');
    expect(toggle().getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByTestId('composer-agent-intent-strip')).toBeNull();
  });
});
