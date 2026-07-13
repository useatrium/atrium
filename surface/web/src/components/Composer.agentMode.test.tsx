// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Composer } from './Composer';

const channelMode = { scope: 'channel' as const, channelLabel: '#engineering' };

function renderComposer(props: Partial<React.ComponentProps<typeof Composer>> = {}) {
  const onSend = vi.fn();
  const onAgentSend = vi.fn();
  render(
    <Composer placeholder="Message" onSend={onSend} agentMode={channelMode} onAgentSend={onAgentSend} {...props} />,
  );
  return { onSend, onAgentSend };
}

const pill = () => screen.getByTestId('composer-audience-pill');

afterEach(cleanup);

describe('Composer audience pill', () => {
  it('names the chat audience by default and the agent target in agent mode', () => {
    renderComposer();

    expect(pill().textContent).toContain('💬#engineering');
    expect(pill().getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(pill());

    expect(pill().textContent).toContain('⚡New agent · #engineering');
    expect(pill().getAttribute('aria-pressed')).toBe('true');
  });

  it('turns a leading !! into agent mode and swallows the sigil', () => {
    renderComposer();
    const input = screen.getByLabelText('Message input') as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: '!!Research this' } });

    expect(input.value).toBe('Research this');
    expect(pill().textContent).toContain('⚡New agent · #engineering');
  });

  it('resolves a non-driver thread target to Suggest', () => {
    renderComposer({
      agentMode: {
        scope: 'thread',
        channelLabel: 'this thread',
        threadRootEventId: 17,
        meId: 'me',
        attachedSession: { id: 's-1', title: 'Fix tests', driverId: 'someone-else' },
      },
    });

    expect(pill().textContent).toContain('💬this thread');
    fireEvent.click(pill());
    expect(pill().textContent).toContain('Suggest · “Fix tests”');
  });

  it('shows the retired @agent guidance', () => {
    renderComposer();
    fireEvent.change(screen.getByLabelText('Message input'), { target: { value: '@agent please help' } });

    expect(screen.getByText(/Summon agents with !! or ⚡/)).toBeTruthy();
  });

  it('dispatches a channel spawn request and returns to chat audience after send', () => {
    const { onAgentSend } = renderComposer();
    const input = screen.getByLabelText('Message input');
    fireEvent.click(pill());
    fireEvent.change(input, { target: { value: 'Research the incident' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onAgentSend).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'spawn-channel' }),
      'Research the incident',
      undefined,
      undefined,
    );
    expect(pill().textContent).toContain('💬#engineering');
  });
});

describe('Composer draft audience', () => {
  it('keeps the task on Escape and says the draft is still for an agent', () => {
    renderComposer();
    const input = screen.getByLabelText('Message input') as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '!!fix the build' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(input.value).toBe('fix the build');
    expect(pill().textContent).toContain('💬#engineering');
    expect(screen.getByTestId('composer-agent-intent-strip').textContent).toContain('Agent mode off — draft kept');
  });

  it('persists the agent intent alongside the draft text', () => {
    const onDraftChange = vi.fn();
    renderComposer({ draftKey: 'channel:c1', onDraftChange });
    const input = screen.getByLabelText('Message input');
    fireEvent.change(input, { target: { value: '!!fix the build' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(onDraftChange).toHaveBeenLastCalledWith('channel:c1', 'fix the build', true);
  });

  it('restores a cross-device agent draft wearing its strip, never as a naked chat draft', () => {
    renderComposer({ draftKey: 'channel:c1', initialDraft: 'fix the build', initialDraftAgentIntent: true });

    expect((screen.getByLabelText('Message input') as HTMLTextAreaElement).value).toBe('fix the build');
    expect(screen.getByTestId('composer-agent-intent-strip')).toBeTruthy();
    expect(pill().textContent).toContain('💬#engineering');
  });

  it('Resume ⚡ puts the kept draft back on the agent', () => {
    const { onAgentSend, onSend } = renderComposer({
      draftKey: 'channel:c1',
      initialDraft: 'fix the build',
      initialDraftAgentIntent: true,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Resume ⚡' }));
    expect(pill().textContent).toContain('⚡New agent · #engineering');

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).not.toHaveBeenCalled();
    expect(onAgentSend).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'spawn-channel' }),
      'fix the build',
      undefined,
      undefined,
    );
  });

  it('Clear draft drops the text and the intent', () => {
    const onDraftChange = vi.fn();
    renderComposer({
      draftKey: 'channel:c1',
      initialDraft: 'fix the build',
      initialDraftAgentIntent: true,
      onDraftChange,
    });

    fireEvent.click(screen.getByRole('button', { name: 'Clear draft' }));

    expect((screen.getByLabelText('Message input') as HTMLTextAreaElement).value).toBe('');
    expect(screen.queryByTestId('composer-agent-intent-strip')).toBeNull();
    expect(onDraftChange).toHaveBeenLastCalledWith('channel:c1', '', false);
  });

  it('sends as chat only once the kept-draft strip has been on screen', () => {
    const { onSend } = renderComposer({
      draftKey: 'channel:c1',
      initialDraft: 'fix the build',
      initialDraftAgentIntent: true,
    });

    // The strip is on screen from the restore, so the deliberate chat send lands.
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('fix the build', undefined, undefined);
    expect(screen.queryByTestId('composer-agent-intent-strip')).toBeNull();
  });
});
