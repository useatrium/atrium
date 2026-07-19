// @vitest-environment jsdom

import { createRef } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { Composer, type ComposerHandle } from './Composer';

// Radix dropdown menus rely on pointer-capture and scroll APIs jsdom lacks; stub them
// so the change-target menu can open and roving focus can settle.
beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.setPointerCapture = vi.fn();
  Element.prototype.releasePointerCapture = vi.fn();
  Element.prototype.scrollIntoView = vi.fn();
});

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
  it('does not render an anchor chip without an explicit anchor', () => {
    renderComposer();
    fireEvent.click(toggle());

    expect(screen.queryByRole('button', { name: 'Jump to anchored message' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Clear anchor' })).toBeNull();
    expect(screen.queryByText('latest message')).toBeNull();
  });

  it('jumps from an explicit anchor without clearing it, then clears it separately', () => {
    const ref = createRef<ComposerHandle>();
    const onJumpToEvent = vi.fn();
    const onAgentSend = vi.fn();
    render(
      <Composer
        ref={ref}
        placeholder="Message"
        onSend={vi.fn()}
        onJumpToEvent={onJumpToEvent}
        routing={{ kind: 'managed', context: channelContext, onAgentSend }}
      />,
    );

    act(() => ref.current?.activateAgentMode({ eventId: 42, label: 'Ada: Investigate the flaky test' }));
    const jump = screen.getByRole('button', { name: 'Jump to anchored message' });
    expect(jump.textContent).toContain('Ada: Investigate the flaky test');

    fireEvent.click(jump);
    expect(onJumpToEvent).toHaveBeenCalledWith(42);
    expect(screen.getByRole('button', { name: 'Clear anchor' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Clear anchor' }));
    expect(screen.queryByRole('button', { name: 'Jump to anchored message' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Message input'), { target: { value: 'Continue without an anchor' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(onAgentSend).toHaveBeenCalledWith(
      expect.not.objectContaining({ anchorEventId: expect.anything() }),
      'Continue without an anchor',
      undefined,
      undefined,
    );
  });

  it('uses an icon-only switch plus persistent destination feedback', () => {
    renderComposer();

    expect(toggle().textContent).toBe('');
    expect(toggle().querySelectorAll('svg')).toHaveLength(2);
    expect(toggle().getAttribute('role')).toBe('switch');
    expect(toggle().getAttribute('aria-checked')).toBe('false');
    expect(toggle().getAttribute('aria-label')).toBe('Agent prompt mode');
    expect(screen.getByPlaceholderText('Message people…')).toBeTruthy();

    fireEvent.click(toggle());

    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(screen.getByPlaceholderText('Prompt agent…')).toBeTruthy();
  });

  it('turns a leading !! into agent mode and swallows the sigil', () => {
    renderComposer();
    const input = screen.getByLabelText('Message input') as HTMLTextAreaElement;

    fireEvent.change(input, { target: { value: '!!Research this' } });

    expect(input.value).toBe('Research this');
    expect(toggle().getAttribute('aria-checked')).toBe('true');
  });

  it('preserves Mod+J and Escape audience switching', () => {
    renderComposer();
    const input = screen.getByLabelText('Message input');

    fireEvent.keyDown(input, { key: 'j', metaKey: true });
    expect(toggle().getAttribute('aria-checked')).toBe('true');

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(toggle().getAttribute('aria-checked')).toBe('false');
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
    expect(toggle().getAttribute('aria-checked')).toBe('true');
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

    expect(toggle().getAttribute('aria-checked')).toBe('false');
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
    expect(toggle().getAttribute('aria-checked')).toBe('false');
  });

  it('offers the Configure bridge in agent mode and hands the task to the caller', () => {
    const onConfigureAgent = vi.fn();
    renderComposer({ onConfigureAgent });

    // No agent draft yet — the chip stays hidden.
    expect(screen.queryByRole('button', { name: 'Configure and start an agent' })).toBeNull();

    fireEvent.click(toggle());
    fireEvent.change(screen.getByLabelText('Message input'), { target: { value: 'Investigate the flake' } });

    const chip = screen.getByRole('button', { name: 'Configure and start an agent' });
    fireEvent.click(chip);
    // In managed agent mode the sigil is already swallowed, so the task is the raw draft.
    expect(onConfigureAgent).toHaveBeenCalledWith('Investigate the flake');
  });

  it('does not offer the Configure bridge without an onConfigureAgent handler', () => {
    renderComposer();
    fireEvent.click(toggle());
    fireEvent.change(screen.getByLabelText('Message input'), { target: { value: 'anything' } });
    expect(screen.queryByRole('button', { name: 'Configure and start an agent' })).toBeNull();
  });

  it('offers the Configure bridge from a literal !! draft on an agentAware composer', () => {
    const onConfigureAgent = vi.fn();
    // No routing → the sigil is not swallowed, so the literal "!!task" form drives the chip.
    render(<Composer placeholder="Message" onSend={vi.fn()} agentAware onConfigureAgent={onConfigureAgent} />);
    fireEvent.change(screen.getByLabelText('Message input'), { target: { value: '!!fix the build' } });

    fireEvent.click(screen.getByRole('button', { name: 'Configure and start an agent' }));
    expect(onConfigureAgent).toHaveBeenCalledWith('!!fix the build');
  });

  it('changes the agent target through the Radix menu primitive', async () => {
    const onAgentSend = vi.fn();
    renderComposer({
      routing: {
        kind: 'managed',
        context: {
          scope: 'thread',
          channelLabel: 'this thread',
          threadRootEventId: 17,
          meId: 'me',
          attachedSession: { id: 's-1', title: 'Fix tests', driverId: 'me' },
        },
        onAgentSend,
      },
    });

    // Attached-thread agent mode is the default; the menu trigger replaces the old
    // hand-rolled role="menu" popover.
    const trigger = screen.getByRole('button', { name: /Change target/ });
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');

    // Keyboard opening is the reliable path in jsdom (no PointerEvent); Radix gives the
    // arrow-roving/escape/focus-return behaviour the old hand-rolled popover lacked.
    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter' });

    const item = await screen.findByRole('menuitem', { name: 'New session in this thread' });
    fireEvent.click(item);

    fireEvent.change(screen.getByLabelText('Message input'), { target: { value: 'Start a fresh run' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(onAgentSend).toHaveBeenCalledWith(
      expect.objectContaining({ target: 'spawn-thread', threadRootEventId: 17 }),
      'Start a fresh run',
      undefined,
      undefined,
    );
  });

  it('reserves a disabled voice control while Agent is selected', () => {
    renderComposer({ allowAttachments: true, allowVoice: true });
    expect(screen.getByRole('button', { name: 'Record a voice message' })).toBeTruthy();

    fireEvent.click(toggle());

    const microphone = screen.getByRole('button', {
      name: 'Voice messages are only available for People messages',
    });
    expect((microphone as HTMLButtonElement).disabled).toBe(true);
    expect(microphone.getAttribute('title')).toBe('Voice messages are only available for People messages');
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
    expect(toggle().getAttribute('aria-checked')).toBe('true');
    expect(screen.queryByTestId('composer-agent-intent-strip')).toBeNull();
  });
});
