// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnnotatedTranscriptRow, useIsHoverNone, type TranscriptDiscussPayload } from './SessionPane';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function mockHoverNoneMatchMedia(matches = true) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn().mockImplementation((query: string) => ({
      matches: query === '(hover: none)' ? matches : false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  );
}

function TouchTranscriptHarness({
  children = <div>Transcript text</div>,
  onDiscussEntry = vi.fn(),
  onMarkupEntry = vi.fn(),
}: {
  children?: ReactNode;
  onDiscussEntry?: (payload: TranscriptDiscussPayload) => void;
  onMarkupEntry?: (handle: string) => void;
}) {
  const hoverNone = useIsHoverNone();
  const [activeHandle, setActiveHandle] = useState<string | null>(null);
  return (
    <AnnotatedTranscriptRow
      handle="rec_1"
      discussContext={{ channelId: 'ch_1', threadRootEventId: 123 }}
      onDiscussEntry={onDiscussEntry}
      onMarkupEntry={onMarkupEntry}
      touchActionsEnabled={hoverNone}
      touchActionsActive={activeHandle === 'rec_1'}
      onActivateTouchActions={setActiveHandle}
    >
      {children}
    </AnnotatedTranscriptRow>
  );
}

function dispatchPointer(
  target: Element,
  type: string,
  init: {
    clientX?: number;
    clientY?: number;
    pointerId?: number;
    pointerType?: string;
  } = {},
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: init.clientX ?? 20,
    clientY: init.clientY ?? 20,
  });
  Object.defineProperties(event, {
    pointerId: { value: init.pointerId ?? 1 },
    pointerType: { value: init.pointerType ?? 'touch' },
  });
  fireEvent(target, event);
  return event;
}

describe('AnnotatedTranscriptRow Discuss affordance', () => {
  it('removes the transcript-row comment affordance', () => {
    render(
      <AnnotatedTranscriptRow handle="rec_1">
        <div>Transcript text</div>
      </AnnotatedTranscriptRow>,
    );
    expect(screen.queryByRole('button', { name: 'Comment on entry' })).toBeNull();
  });

  it('copies the entry deep link and exposes a copied state', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText },
    });

    render(
      <AnnotatedTranscriptRow handle="rec_1">
        <div>Transcript text</div>
      </AnnotatedTranscriptRow>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Copy entry link' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/e/rec_1`));
    expect(screen.getByRole('button', { name: 'Copied entry link' })).toBeTruthy();
  });

  it('copies rendered transcript row text without action labels', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', {
      ...navigator,
      clipboard: { writeText },
    });

    render(
      <AnnotatedTranscriptRow handle="rec_1">
        <div>
          <span>Transcript text</span>
        </div>
      </AnnotatedTranscriptRow>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Copy block text' }));

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('Transcript text'));
    expect(screen.getByRole('button', { name: 'Copied block text' })).toBeTruthy();
  });

  it('does not show block text copy when rendered row text is empty', () => {
    render(
      <AnnotatedTranscriptRow handle="rec_1">
        <div />
      </AnnotatedTranscriptRow>,
    );

    expect(screen.getByRole('button', { name: 'Copy entry link' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Copy block text' })).toBeNull();
  });

  it('hides Discuss without thread context, such as popouts', () => {
    render(
      <AnnotatedTranscriptRow
        handle="rec_1"
        discussContext={null}
        onDiscussEntry={vi.fn()}
      >
        <div>Transcript text</div>
      </AnnotatedTranscriptRow>,
    );
    expect(screen.queryByRole('button', { name: 'Discuss in thread' })).toBeNull();
  });

  it('emits a prefilled thread draft payload', () => {
    const onDiscussEntry = vi.fn<(payload: TranscriptDiscussPayload) => void>();
    render(
      <AnnotatedTranscriptRow
        handle="rec_1"
        discussContext={{ channelId: 'ch_1', threadRootEventId: 123 }}
        onDiscussEntry={onDiscussEntry}
      >
        <div>Transcript text</div>
      </AnnotatedTranscriptRow>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Discuss in thread' }));
    expect(onDiscussEntry).toHaveBeenCalledWith({
      handle: 'rec_1',
      channelId: 'ch_1',
      threadRootEventId: 123,
      draft: '/e/rec_1 ',
    });
  });

  it('does not force the transcript action bar visible on small or coarse-pointer screens', async () => {
    render(
      <AnnotatedTranscriptRow
        handle="rec_1"
        discussContext={{ channelId: 'ch_1', threadRootEventId: 123 }}
        onDiscussEntry={vi.fn()}
        onMarkupEntry={vi.fn()}
      >
        <div>Transcript text</div>
      </AnnotatedTranscriptRow>,
    );

    const actionBar = screen.getByTestId('transcript-entry-action-bar');
    expect(actionBar.className).not.toContain('max-md:');
    expect(actionBar.className).not.toContain('[@media(hover:none)]');
    expect(actionBar.className).toContain('opacity-0');
    expect(actionBar.className).toContain('group-hover:opacity-100');

    for (const button of await screen.findAllByRole('button')) {
      expect(button.className).not.toContain('max-md:size-11');
      expect(button.className).not.toContain('max-md:min-h-11');
      expect(button.className).not.toContain('[@media(pointer:coarse)]');
    }
  });

  it('reveals one touch affordance on a no-hover tap and opens transcript-only actions', async () => {
    mockHoverNoneMatchMedia(true);
    render(<TouchTranscriptHarness />);

    // No inline bar at all on no-hover devices: even at opacity-0 it would
    // reserve flex space and misplace the tap-revealed overflow button.
    expect(screen.queryByTestId('transcript-entry-action-bar')).toBeNull();

    fireEvent.click(screen.getByText('Transcript text'));
    fireEvent.click(await screen.findByRole('button', { name: 'More transcript actions' }));

    const dialog = screen.getByRole('dialog', { name: 'Message actions' });
    expect(within(dialog).getByRole('button', { name: 'Copy entry link' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Copy block text' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Discuss in thread' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Mark up & reply' })).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(dialog.textContent).not.toContain('Edit');
    expect(dialog.textContent).not.toContain('Delete');
    expect(screen.queryByRole('button', { name: /React with/u })).toBeNull();
  });

  it('opens the transcript action sheet on long-press', () => {
    vi.useFakeTimers();
    const touchEventDescriptor = Object.getOwnPropertyDescriptor(window, 'TouchEvent');
    Object.defineProperty(window, 'TouchEvent', { configurable: true, value: Event });
    try {
      render(<TouchTranscriptHarness />);
      const target = screen.getByText('Transcript text');

      dispatchPointer(target, 'pointerdown');
      act(() => vi.advanceTimersByTime(400));

      const dialog = screen.getByRole('dialog', { name: 'Message actions' });
      expect(dialog).toBeTruthy();
      expect(within(dialog).getByRole('button', { name: 'Cancel' })).toBeTruthy();
    } finally {
      if (touchEventDescriptor) {
        Object.defineProperty(window, 'TouchEvent', touchEventDescriptor);
      } else {
        Reflect.deleteProperty(window, 'TouchEvent');
      }
    }
  });

  it('opens a transcript action popover on desktop right-click', () => {
    render(<TouchTranscriptHarness />);

    fireEvent.contextMenu(screen.getByText('Transcript text'), { clientX: 64, clientY: 96 });

    const dialog = screen.getByRole('dialog', { name: 'Message actions' });
    expect(dialog).toBeTruthy();
    expect(within(dialog).getByRole('button', { name: 'Copy entry link' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });

  it('does not activate the touch affordance when tapping an interactive target', () => {
    mockHoverNoneMatchMedia(true);
    render(
      <TouchTranscriptHarness>
        <div>
          <span>Transcript text</span>
          <button type="button">Expand details</button>
        </div>
      </TouchTranscriptHarness>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Expand details' }));

    expect(screen.queryByRole('button', { name: 'More transcript actions' })).toBeNull();
  });
});
