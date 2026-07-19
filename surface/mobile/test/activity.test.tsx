// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatExactTimestamp, type ActivityItem } from '@atrium/surface-client';
import { Text } from 'react-native';
import ActivityScreen from '../app/(app)/(tabs)/activity';
import { pressWhenReady, renderWithTheme } from './rnTestUtils';

vi.mock('@expo/vector-icons', () => ({
  Ionicons: () => null,
  MaterialCommunityIcons: () => null,
}));

const routerMock = vi.hoisted(() => ({ push: vi.fn() }));

const chatMock = vi.hoisted(() => ({
  api: {
    listSessions: vi.fn(),
    getActivity: vi.fn(),
    markActivityRead: vi.fn(),
    markActivityItemRead: vi.fn(),
    markActivityItemUnread: vi.fn(),
  },
  me: { id: 'u-me', handle: 'me', displayName: 'Me' },
  state: { wsStatus: 'open' as const },
  resolveUser: () => null,
}));

vi.mock('expo-router', () => ({ router: routerMock }));
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: unknown }) => children,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
vi.mock('../src/lib/chat', () => ({ useChat: () => chatMock }));
vi.mock('../src/components/Markdown', () => ({
  MarkdownText: ({ text }: { text: string }) => <Text>{text}</Text>,
}));
vi.mock('react-native-gesture-handler', () => {
  const React = require('react');
  return {
    Swipeable: ({ children }: { children: unknown }) => React.createElement(React.Fragment, null, children),
  };
});

function activity(overrides: Partial<ActivityItem> = {}): ActivityItem {
  return {
    eventId: '1',
    kind: 'mention',
    channelId: 'ch-general',
    channelName: 'general',
    actorId: 'u-alice',
    actorName: 'Alice',
    snippet: 'Can you take a look?',
    createdAt: '2026-01-01T00:01:00.000Z',
    attention: false,
    ...overrides,
  };
}

function activityResponse(items: ActivityItem[], unread = items.length) {
  return {
    items,
    nextCursor: null,
    lastReadEventId: '0',
    unreadExceptionIds: [],
    counts: { attention: 4, unread },
  };
}

beforeEach(() => {
  routerMock.push.mockReset();
  vi.clearAllMocks();
  chatMock.api.markActivityRead.mockResolvedValue({ lastReadEventId: '0', unreadExceptionIds: [] });
  chatMock.api.markActivityItemRead.mockResolvedValue({ lastReadEventId: '0', unreadExceptionIds: [] });
  chatMock.api.markActivityItemUnread.mockResolvedValue({ lastReadEventId: '0', unreadExceptionIds: [] });
});

afterEach(cleanup);

describe('mobile Inbox screen', () => {
  it('loads only activity and renders people events while excluding every agent event', async () => {
    chatMock.api.getActivity.mockResolvedValue(
      activityResponse([
        activity({ eventId: '11', snippet: 'hello **@me** with `code` and [docs](https://example.com)' }),
        activity({
          eventId: '10',
          kind: 'dm',
          channelId: 'ch-gdm',
          channelName: 'gdm:u-a:u-b:u-c',
          actorName: 'Cara',
          snippet: 'moving the retro',
        }),
        activity({ eventId: '9', kind: 'reaction', actorName: 'Ben' }),
        activity({ eventId: '8', kind: 'thread_reply', actorName: 'Dana' }),
        activity({ eventId: '7', kind: 'channel_invite', actorName: 'Eli' }),
        activity({ eventId: '6', kind: 'missed_call', actorName: 'Fran' }),
        activity({ eventId: '5', kind: 'call_declined', actorName: 'Gus' }),
        activity({ eventId: '4', kind: 'agent_question', sessionTitle: 'Question agent' }),
        activity({ eventId: '3', kind: 'agent_auth', sessionTitle: 'Blocked agent' }),
        activity({ eventId: '2', kind: 'session_completed', sessionTitle: 'Completed agent' }),
        activity({ eventId: '1', kind: 'session_failed', sessionTitle: 'Failed agent' }),
        activity({ eventId: '12', kind: 'seat_request', sessionTitle: 'Driver request' }),
      ]),
    );

    renderWithTheme(<ActivityScreen />);

    expect(await screen.findByText('Alice mentioned you')).toBeInTheDocument();
    expect(screen.getByText(/hello @me with code and docs/)).toBeInTheDocument();
    expect(screen.getByText('Cara messaged the group')).toBeInTheDocument();
    expect(screen.getByText('Ben reacted to your message')).toBeInTheDocument();
    expect(screen.getByText('Dana replied in a thread')).toBeInTheDocument();
    expect(screen.getByText('Eli added you')).toBeInTheDocument();
    expect(screen.getByText('Fran called you')).toBeInTheDocument();
    expect(screen.getByText('Gus called · you declined')).toBeInTheDocument();
    expect(screen.queryByText(/agent/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Activity source/)).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Filter Reviewed')).not.toBeInTheDocument();
    expect(chatMock.api.listSessions).not.toHaveBeenCalled();
  });

  it('opens people activity in its channel and marks unread activity read', async () => {
    const item = activity({ eventId: '21', unread: true });
    chatMock.api.getActivity.mockResolvedValue(activityResponse([item], 1));
    chatMock.api.markActivityItemRead.mockResolvedValue({ lastReadEventId: '21', unreadExceptionIds: [] });

    renderWithTheme(<ActivityScreen />);

    expect(
      await screen.findByLabelText(
        `Unread, Alice mentioned you, Can you take a look?, #general, ${formatExactTimestamp(item.createdAt)}`,
      ),
    ).toBeInTheDocument();
    await pressWhenReady(screen.findByText('Alice mentioned you'));

    expect(routerMock.push).toHaveBeenCalledWith('/channel/ch-general');
    await waitFor(() => expect(chatMock.api.markActivityItemRead).toHaveBeenCalledWith(21));
  });

  it('marks through the newest visible people event, not a filtered agent event', async () => {
    const mention = activity({ eventId: '40', unread: true });
    const agent = activity({ eventId: '50', kind: 'session_failed', sessionTitle: 'Hidden agent', unread: true });
    chatMock.api.getActivity.mockResolvedValue(activityResponse([agent, mention], 1));
    chatMock.api.markActivityRead.mockResolvedValue({ lastReadEventId: '40', unreadExceptionIds: [] });

    renderWithTheme(<ActivityScreen />);

    await pressWhenReady(screen.findByLabelText('Mark all read'));
    await waitFor(() => expect(chatMock.api.markActivityRead).toHaveBeenCalledWith(40));
    expect(screen.queryByText('Hidden agent')).not.toBeInTheDocument();
  });

  it('keeps the Inbox, Unread, and All read-state filters', async () => {
    chatMock.api.getActivity.mockResolvedValue(
      activityResponse([
        activity({ eventId: '2', actorName: 'Unread person', unread: true }),
        activity({ eventId: '1', actorName: 'Read person', unread: false }),
      ]),
    );

    renderWithTheme(<ActivityScreen />);

    expect(await screen.findByText('Unread person mentioned you')).toBeInTheDocument();
    expect(screen.getByText('Read person mentioned you')).toBeInTheDocument();
    await pressWhenReady(screen.findByLabelText('Filter Unread'));
    expect(screen.getByText('Unread person mentioned you')).toBeInTheDocument();
    expect(screen.queryByText('Read person mentioned you')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Filter All')).toBeInTheDocument();
  });
});
