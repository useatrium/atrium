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

afterEach(cleanup);

describe('Composer agent mode', () => {
  it('turns a leading !! into agent mode and swallows the sigil', () => {
    renderComposer();
    const input = screen.getByLabelText('Message input') as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: '!!Research this' } });

    expect(input.value).toBe('Research this');
    expect(screen.getAllByRole('button', { name: 'Exit agent mode' }).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/New agent · #engineering/).length).toBeGreaterThan(0);
  });

  it('exits with Escape without losing the typed task', () => {
    renderComposer();
    const input = screen.getByLabelText('Message input') as HTMLTextAreaElement;
    fireEvent.click(screen.getByRole('button', { name: 'Enter agent mode' }));
    fireEvent.change(input, { target: { value: 'Keep this task' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(input.value).toBe('Keep this task');
    expect(screen.getByRole('button', { name: 'Enter agent mode' })).toBeTruthy();
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
    fireEvent.click(screen.getByRole('button', { name: 'Enter agent mode' }));

    expect(screen.getAllByText(/Suggest · “Fix tests”/).length).toBeGreaterThan(0);
  });

  it('shows the retired @agent guidance', () => {
    renderComposer();
    fireEvent.change(screen.getByLabelText('Message input'), { target: { value: '@agent please help' } });

    expect(screen.getByText(/Summon agents with !! or ⚡/)).toBeTruthy();
  });

  it('dispatches a channel spawn request and returns to chat mode after send', () => {
    const { onAgentSend } = renderComposer();
    const input = screen.getByLabelText('Message input');
    fireEvent.click(screen.getByRole('button', { name: 'Enter agent mode' }));
    fireEvent.change(input, { target: { value: 'Research the incident' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onAgentSend).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'spawn-channel' }),
      'Research the incident',
      undefined,
      undefined,
    );
    expect(screen.getByRole('button', { name: 'Enter agent mode' })).toBeTruthy();
  });
});
