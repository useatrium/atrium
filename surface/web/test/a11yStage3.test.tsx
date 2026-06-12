// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useRef, useState } from 'react';
import type { ChatMessage } from '@atrium/surface-client';
import { Chat } from '../src/Chat';
import { QuickSwitcher } from '../src/components/QuickSwitcher';
import { Timeline } from '../src/components/Timeline';
import { Toasts, showErrorToast } from '../src/components/Toasts';
import { ThemeProvider } from '../src/theme';
import { useDialog } from '../src/useDialog';

const me = { id: 'u-me', handle: 'me', displayName: 'Me' };
const workspace = { id: 'ws-1', name: 'Test workspace', createdAt: '' };

class NoopWebSocket {
  static OPEN = 1;
  readyState = NoopWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];

  constructor() {
    setTimeout(() => this.onopen?.(), 0);
  }

  send(message: string) {
    this.sent.push(message);
  }

  close() {
    this.onclose?.();
  }
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function DialogHarness() {
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  useDialog({
    open,
    containerRef: dialogRef,
    initialFocusRef: closeRef,
    onClose: () => setOpen(false),
  });
  return (
    <>
      <button onClick={() => setOpen(true)}>Open dialog</button>
      {open && (
        <div ref={dialogRef} role="dialog" aria-label="Test dialog">
          <button ref={closeRef} onClick={() => setOpen(false)}>
            Close dialog
          </button>
        </div>
      )}
    </>
  );
}

describe('dialog focus management', () => {
  it('moves focus in and restores it to the invoker on close', async () => {
    render(<DialogHarness />);
    const opener = screen.getByRole('button', { name: 'Open dialog' });
    opener.focus();
    fireEvent.click(opener);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Close dialog' })).toBe(document.activeElement),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));
    await waitFor(() => expect(opener).toBe(document.activeElement));
  });
});

describe('QuickSwitcher accessibility', () => {
  it('uses combobox/listbox semantics without nested option buttons', () => {
    render(
      <QuickSwitcher
        channels={[
          { id: 'ch-1', workspaceId: 'ws-1', name: 'general', createdAt: '' },
          { id: 'ch-2', workspaceId: 'ws-1', name: 'ops', createdAt: '' },
        ]}
        activeChannelId="ch-1"
        meId={me.id}
        onSelect={() => {}}
        onJumpToMessage={() => {}}
        onClose={() => {}}
      />,
    );

    const input = screen.getByRole('combobox', { name: 'Channel and message search' });
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-controls')).toBe('quick-switcher-results');
    expect(input.getAttribute('aria-activedescendant')).toBe('quick-switcher-option-0');
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(2);
    expect(options[0]!.querySelector('button')).toBeNull();
  });
});

describe('Timeline unread divider', () => {
  const msg = (id: number, text: string): ChatMessage => ({
    id,
    clientMsgId: null,
    channelId: 'ch-1',
    threadRootEventId: null,
    text,
    edited: false,
    author: me,
    createdAt: new Date(2026, 0, 1, 9, id).toISOString(),
    replyCount: 0,
    lastReplyId: 0,
    status: 'confirmed',
  });
  const common = {
    loaded: true,
    hasMoreBefore: false,
    sessions: {},
    spectators: {},
    meId: me.id,
    onLoadEarlier: () => Promise.resolve(),
    onOpenThread: () => {},
    onOpenSession: () => {},
    onRetry: () => {},
  };

  it('renders New before the first message after the captured read cursor only', () => {
    const { rerender } = render(
      <ThemeProvider>
        <Timeline {...common} messages={[msg(1, 'old'), msg(2, 'new')]} unreadDividerAfterId={1} />
      </ThemeProvider>,
    );
    const divider = screen.getByLabelText('New messages');
    expect(divider.compareDocumentPosition(screen.getByText('new'))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );

    rerender(
      <ThemeProvider>
        <Timeline {...common} messages={[msg(1, 'old'), msg(2, 'caught up')]} unreadDividerAfterId={2} />
      </ThemeProvider>,
    );
    expect(screen.queryByLabelText('New messages')).toBeNull();
  });
});

describe('Toast live region', () => {
  it('keeps a persistent assertive live container with inner dismiss buttons', async () => {
    render(<Toasts />);
    const live = document.querySelector('[aria-live="assertive"]');
    expect(live).toBeTruthy();
    expect(live?.textContent).toBe('');

    showErrorToast('explicit failure');
    expect(await screen.findByText('explicit failure')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
  });
});

describe('private channel leave confirmation', () => {
  it('requires a second click before leaving', async () => {
    vi.stubGlobal('WebSocket', NoopWebSocket);
    const privateChannel = {
      id: 'ch-private',
      workspaceId: 'ws-1',
      name: 'secret',
      createdAt: '',
      kind: 'private' as const,
      members: [me],
      latestEventId: 1,
      lastReadEventId: 1,
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/sync?')) {
        return new Response(
          JSON.stringify({
            events: [],
            nextCursor: 1,
            limited: false,
            state: {
              readCursors: { 'ch-private': 1 },
              mutes: [],
              prefs: {},
              drafts: {},
              channels: [privateChannel],
            },
          }),
        );
      }
      if (url === '/api/channels') {
        return new Response(
          JSON.stringify({
            channels: [privateChannel],
          }),
        );
      }
      if (url === '/api/channels/ch-private/messages?limit=50') {
        return new Response(JSON.stringify({ events: [], hasMore: false }));
      }
      if (url === '/api/channels/ch-private/read') {
        return new Response(JSON.stringify({ lastReadEventId: 1 }));
      }
      if (url.startsWith('/api/sessions')) {
        return new Response(JSON.stringify({ sessions: [] }));
      }
      if (url === '/api/channels/ch-private/members' && !init) {
        return new Response(JSON.stringify({ members: [me] }));
      }
      if (url === '/api/channels/ch-private/members/me' && init?.method === 'DELETE') {
        return new Response(JSON.stringify({ ok: true }));
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <ThemeProvider>
        <Chat me={me} workspace={workspace} onLogout={() => {}} />
      </ThemeProvider>,
    );

    // Settle the app's initial async work before interacting: the Members
    // button proves the channel snapshot was applied, the connection badge
    // proves the (macrotask-deferred) socket open fired, and one flushed
    // timer turn drains straggler fetch continuations. Each await below
    // yields to the event loop, so interleaving them with clicks lets late
    // re-renders race the popover — keep all interactions after this block
    // synchronous.
    await screen.findByRole('button', { name: 'Members' });
    await screen.findByTitle('connection: open');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    fireEvent.click(screen.getByRole('button', { name: 'Members' }));
    expect(screen.getByRole('dialog', { name: 'Channel members' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Leave channel' }));
    expect(fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/members/me') && init?.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm leave channel' }));
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([url, init]) => String(url).endsWith('/members/me') && init?.method === 'DELETE'),
      ).toBe(true),
    );
  });
});
