// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatExactTimestamp } from '@atrium/surface-client';
import ActivityScreen from '../app/(app)/(tabs)/activity';
import { pressWhenReady, renderWithTheme } from './rnTestUtils';
import { Text } from 'react-native';

// MobileHeader (rendered by ActivityScreen) imports Ionicons; @expo/vector-icons
// doesn't resolve under vitest, so mock it like the other component tests do.
vi.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
  MaterialCommunityIcons: () => null,
}));

const routerMock = vi.hoisted(() => ({
  push: vi.fn(),
}));

const chatMock = vi.hoisted(() => ({
  api: {
    listSessions: vi.fn(),
    getActivity: vi.fn(),
    markActivityRead: vi.fn(),
    markActivityItemRead: vi.fn(),
    markActivityItemUnread: vi.fn(),
    messages: vi.fn(),
  },
  me: { id: 'u-me', handle: 'me', displayName: 'Me' },
  state: {
    wsStatus: 'open' as const,
    sessions: {},
  },
  resolveUser: () => null,
}));

vi.mock('expo-router', () => ({
  router: routerMock,
}));

vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: unknown }) => children,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

vi.mock('../src/lib/chat', () => ({
  useChat: () => chatMock,
}));

vi.mock('../src/components/Markdown', () => ({
  MarkdownText: ({ text }: { text: string }) => (
    <Text>
      {text
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
        .replace(/\*\*/g, '')
        .replace(/`/g, '')}
    </Text>
  ),
}));

afterEach(cleanup);

beforeEach(() => {
  routerMock.push.mockReset();
  chatMock.api.listSessions.mockReset();
  chatMock.api.getActivity.mockReset();
  chatMock.api.markActivityRead.mockReset();
  chatMock.api.markActivityItemRead.mockReset();
  chatMock.api.markActivityItemUnread.mockReset();
  chatMock.api.messages.mockReset();
  chatMock.state.sessions = {};
  chatMock.api.markActivityRead.mockResolvedValue({ lastReadEventId: '0', unreadExceptionIds: [] });
  chatMock.api.markActivityItemRead.mockResolvedValue({ lastReadEventId: '0', unreadExceptionIds: [] });
  chatMock.api.markActivityItemUnread.mockResolvedValue({ lastReadEventId: '0', unreadExceptionIds: [] });
});

vi.mock('react-native-gesture-handler', () => {
  const React = require('react');
  return {
    Swipeable: ({ children }: { children: unknown }) => React.createElement(React.Fragment, null, children),
  };
});

describe('mobile Activity screen', () => {
  it('keeps healthy running work out of Attention while preserving server activity', async () => {
    chatMock.api.listSessions.mockResolvedValue({
      sessions: [
        {
          id: 's-running',
          channelId: 'ch-agent',
          channelName: 'general',
          title: 'Investigate failure',
          status: 'running',
          createdAt: '2026-01-01T00:00:00.000Z',
        },
      ],
    });
    chatMock.api.getActivity.mockResolvedValue({
      items: [
        {
          eventId: '22',
          kind: 'agent_question',
          channelId: 'ch-agent',
          channelName: 'general',
          actorId: 'u-me',
          actorName: 'Me',
          snippet: 'Deploy now?',
          createdAt: '2026-01-01T00:02:00.000Z',
        },
        {
          eventId: '21',
          kind: 'mention',
          channelId: 'ch-general',
          channelName: 'general',
          actorId: 'u-alice',
          actorName: 'Alice',
          snippet: 'hello **@me** with `code` and [docs](https://example.com)',
          createdAt: '2026-01-01T00:01:00.000Z',
        },
      ],
      nextCursor: null,
    });
    chatMock.api.messages.mockResolvedValue({
      events: [
        {
          id: 22,
          workspaceId: 'ws-1',
          channelId: 'ch-agent',
          threadRootEventId: 1,
          type: 'session.question_requested',
          actorId: 'u-me',
          payload: { sessionId: 's-question' },
          createdAt: '2026-01-01T00:02:00.000Z',
        },
      ],
      hasMore: false,
    });

    renderWithTheme(<ActivityScreen />);

    expect(await screen.findByText('Agent needs your input')).toBeInTheDocument();
    expect(screen.getByText('Alice mentioned you')).toBeInTheDocument();
    expect(screen.getByText(/hello @me with code and docs/)).toBeInTheDocument();
    expect(screen.queryByText('Investigate failure')).not.toBeInTheDocument();
    expect(
      screen.getByLabelText(
        `Unread, Agent needs your input, Deploy now?, #general, ${formatExactTimestamp('2026-01-01T00:02:00.000Z')}`,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(
        `Unread, Alice mentioned you, hello @me with code and docs, #general, ${formatExactTimestamp('2026-01-01T00:01:00.000Z')}`,
      ),
    ).toBeInTheDocument();
    await pressWhenReady(screen.findByText('Alice mentioned you'));
    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith('/channel/ch-general'));

    await pressWhenReady(screen.findByText('Agent needs your input'));
    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith('/session/s-question'));
  });

  it('pins server-flagged attention items, shows unread dots, and marks all read', async () => {
    chatMock.api.listSessions.mockResolvedValue({ sessions: [] });
    const items = [
      {
        eventId: '31',
        kind: 'session_failed',
        channelId: 'ch-agent',
        channelName: 'general',
        actorId: 'u-me',
        actorName: 'Me',
        snippet: 'The run crashed before finishing.',
        createdAt: '2026-01-01T00:05:00.000Z',
        sessionId: 's-failed',
        sessionTitle: 'Build docs',
        sessionStatus: 'failed',
        attention: true,
      },
      {
        eventId: '8',
        kind: 'dm',
        channelId: 'ch-gdm',
        channelName: 'gdm:u-a:u-b:u-c',
        actorId: 'u-cara',
        actorName: 'Cara',
        snippet: 'moving the retro',
        createdAt: '2026-01-01T00:01:00.000Z',
        sessionId: null,
        sessionTitle: null,
        sessionStatus: null,
        attention: false,
      },
    ];
    chatMock.api.getActivity
      .mockResolvedValueOnce({
        items,
        nextCursor: null,
        lastReadEventId: '8',
        counts: { attention: 1, unread: 1 },
      })
      .mockResolvedValueOnce({
        items,
        nextCursor: null,
        lastReadEventId: '31',
        counts: { attention: 1, unread: 0 },
      });
    chatMock.api.markActivityRead.mockResolvedValue({ lastReadEventId: '31', unreadExceptionIds: [] });

    renderWithTheme(<ActivityScreen />);

    expect(await screen.findByText('Needs attention · 1')).toBeInTheDocument();
    expect(screen.getByText('Activity')).toBeInTheDocument();
    expect(screen.getByText('Build docs failed')).toBeInTheDocument();
    // GDM items name the group, not a private DM.
    expect(screen.getByText('Cara messaged the group')).toBeInTheDocument();
    // The failed row (31) is past the watermark (8): announced as unread.
    expect(screen.getByLabelText(/^Unread, Build docs failed/)).toBeInTheDocument();
    expect(screen.getByLabelText('Filter Inbox')).toBeInTheDocument();
    expect(screen.getByLabelText('Filter Done')).toBeInTheDocument();

    await pressWhenReady(screen.findByLabelText('Mark all read'));
    await waitFor(() => expect(chatMock.api.markActivityRead).toHaveBeenCalledWith(31));
    await waitFor(() => expect(screen.queryByLabelText(/^Unread, Build docs failed/)).not.toBeInTheDocument());
  });
});
