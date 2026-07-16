// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatExactTimestamp, type Channel, type Session } from '@atrium/surface-client';
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
    markSessionActivityRead: vi.fn(),
    messages: vi.fn(),
  },
  me: { id: 'u-me', handle: 'me', displayName: 'Me' },
  state: {
    wsStatus: 'open' as const,
    sessions: {} as Record<string, Session>,
    channels: [] as Channel[],
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

function liveSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 's-live',
    workspaceId: 'ws-1',
    channelId: 'ch-agent',
    threadRootEventId: null,
    title: 'Live agent',
    status: 'running',
    harness: 'codex',
    spawnedBy: 'u-me',
    driverId: 'u-me',
    pendingSeatRequests: [],
    suggestions: [],
    answerProposals: [],
    pendingQuestion: null,
    providerAuthRequired: null,
    seatEvents: [],
    costUsd: 0,
    resultText: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    completedAt: null,
    archivedAt: null,
    pinned: false,
    lastEventId: 1,
    permalink: '/session/s-live',
    ...overrides,
  };
}

beforeEach(() => {
  routerMock.push.mockReset();
  chatMock.api.listSessions.mockReset();
  chatMock.api.getActivity.mockReset();
  chatMock.api.markActivityRead.mockReset();
  chatMock.api.markActivityItemRead.mockReset();
  chatMock.api.markActivityItemUnread.mockReset();
  chatMock.api.markSessionActivityRead.mockReset();
  chatMock.api.messages.mockReset();
  chatMock.state.sessions = {};
  chatMock.state.channels = [];
  chatMock.api.markActivityRead.mockResolvedValue({ lastReadEventId: '0', unreadExceptionIds: [] });
  chatMock.api.markActivityItemRead.mockResolvedValue({ lastReadEventId: '0', unreadExceptionIds: [] });
  chatMock.api.markActivityItemUnread.mockResolvedValue({ lastReadEventId: '0', unreadExceptionIds: [] });
  chatMock.api.markSessionActivityRead.mockResolvedValue(undefined);
});

vi.mock('react-native-gesture-handler', () => {
  const React = require('react');
  return {
    Swipeable: ({ children }: { children: unknown }) => React.createElement(React.Fragment, null, children),
  };
});

describe('mobile Activity screen', () => {
  it('keeps a REST-flagged row pinned when its fold-only live status is unknown', async () => {
    chatMock.state.sessions = {
      's-needs': liveSession({ id: 's-needs', title: 'Answer the agent', status: 'unknown' as never }),
    };
    chatMock.api.listSessions.mockResolvedValue({
      sessions: [
        {
          id: 's-needs',
          channelId: 'ch-agent',
          channelName: 'agents',
          title: 'Answer the agent',
          status: 'running',
          createdAt: '2026-01-01T00:00:00.000Z',
          completedAt: null,
          archivedAt: null,
          pinned: false,
          costUsd: 0,
          needsAttention: true,
          attentionReason: 'question',
          resultText: null,
        },
      ],
    });
    chatMock.api.getActivity.mockResolvedValue({
      items: [],
      nextCursor: null,
      lastReadEventId: '0',
      counts: { attention: 1, unread: 0, needsYou: 1, running: 0, toReview: 0 },
    });

    renderWithTheme(<ActivityScreen />);

    expect(await screen.findByText('Needs you · 1')).toBeInTheDocument();
    expect(screen.getByText('Answer the agent')).toBeInTheDocument();
  });

  it('resolves a snapshot-only running session channel without leaking its UUID', async () => {
    chatMock.state.sessions = {
      's-running': liveSession({ id: 's-running', title: 'Snapshot-only agent' }),
    };
    chatMock.state.channels = [
      {
        id: 'ch-agent',
        workspaceId: 'ws-1',
        name: 'agents',
        createdAt: '2026-01-01T00:00:00.000Z',
        archivedAt: null,
        pinned: false,
      },
    ];
    chatMock.api.listSessions.mockResolvedValue({ sessions: [] });
    chatMock.api.getActivity.mockResolvedValue({
      items: [],
      nextCursor: null,
      lastReadEventId: '0',
      counts: { attention: 0, unread: 0, needsYou: 0, running: 1, toReview: 0 },
    });

    renderWithTheme(<ActivityScreen />);

    expect(await screen.findByText('Snapshot-only agent')).toBeInTheDocument();
    expect(screen.getByText(/#agents/)).toBeInTheDocument();
    expect(screen.queryByText(/ch-agent/)).not.toBeInTheDocument();
  });

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

    expect(await screen.findByText('Needs you · 1')).toBeInTheDocument();
    expect(screen.getByText('Activity')).toBeInTheDocument();
    expect(screen.getByText('Build docs failed')).toBeInTheDocument();
    // GDM items name the group, not a private DM.
    expect(screen.getByText('Cara messaged the group')).toBeInTheDocument();
    // The failed row (31) is past the watermark (8): announced as unread.
    expect(screen.getByLabelText(/^Unread, Build docs failed/)).toBeInTheDocument();
    expect(screen.getByLabelText('Filter Inbox')).toBeInTheDocument();
    expect(screen.getByLabelText('Filter Reviewed')).toBeInTheDocument();

    await pressWhenReady(screen.findByLabelText('Mark all read'));
    await waitFor(() => expect(chatMock.api.markActivityRead).toHaveBeenCalledWith(31));
    await waitFor(() => expect(screen.queryByLabelText(/^Unread, Build docs failed/)).not.toBeInTheDocument());
  });

  it('shelves running work and terminal results, then composes source filtering with Inbox predicates', async () => {
    chatMock.state.sessions = {
      's-running': liveSession({ id: 's-running', title: 'Keep the rollout moving' }),
    };
    chatMock.api.listSessions.mockResolvedValue({
      sessions: [
        {
          id: 's-running',
          channelId: 'ch-agent',
          channelName: 'agents',
          title: 'Keep the rollout moving',
          status: 'running',
          createdAt: '2026-01-01T00:00:00.000Z',
          completedAt: null,
          archivedAt: null,
          pinned: false,
          costUsd: 0,
          needsAttention: false,
          attentionReason: null,
          resultText: null,
        },
        {
          id: 's-done',
          channelId: 'ch-agent',
          channelName: 'agents',
          title: 'Ship the fix',
          status: 'completed',
          createdAt: '2026-01-01T00:00:00.000Z',
          completedAt: '2026-01-01T00:00:42.000Z',
          archivedAt: null,
          pinned: false,
          costUsd: 0,
          needsAttention: false,
          attentionReason: null,
          resultText: 'All checks passed.',
        },
      ],
    });
    const items = [
      {
        eventId: '41',
        kind: 'session_completed',
        channelId: 'ch-agent',
        channelName: 'agents',
        actorId: 'u-me',
        actorName: 'Me',
        snippet: 'The session completed.',
        createdAt: '2026-01-01T00:00:42.000Z',
        sessionId: 's-done',
        sessionTitle: 'Ship the fix',
        sessionStatus: 'completed',
        attention: false,
      },
      {
        eventId: '40',
        kind: 'mention',
        channelId: 'ch-people',
        channelName: 'general',
        actorId: 'u-alice',
        actorName: 'Alice',
        snippet: 'Can you take a look?',
        createdAt: '2026-01-01T00:00:01.000Z',
        attention: false,
      },
    ];
    chatMock.api.getActivity.mockResolvedValue({
      items,
      nextCursor: null,
      lastReadEventId: '0',
      counts: { attention: 0, unread: 2, needsYou: 0, running: 1, toReview: 1 },
    });

    renderWithTheme(<ActivityScreen />);

    expect(await screen.findByText('Running · 1')).toBeInTheDocument();
    expect(screen.getByText('To review · 1')).toBeInTheDocument();
    expect(screen.getByText('Done in 42s')).toBeInTheDocument();
    expect(screen.getByText('All checks passed.')).toBeInTheDocument();

    await pressWhenReady(screen.findByLabelText('Filter source People'));
    expect(screen.queryByText('Running · 1')).not.toBeInTheDocument();
    expect(screen.queryByText('To review · 1')).not.toBeInTheDocument();
    expect(screen.getByText('Alice mentioned you')).toBeInTheDocument();

    await pressWhenReady(screen.findByLabelText('Filter source Agents'));
    expect(screen.queryByText('Alice mentioned you')).not.toBeInTheDocument();
    expect(screen.getByText('To review · 1')).toBeInTheDocument();

    await pressWhenReady(screen.findByText('Ship the fix · completed'));
    await waitFor(() => expect(chatMock.api.markSessionActivityRead).toHaveBeenCalledWith('s-done'));
    expect(routerMock.push).toHaveBeenCalledWith('/session/s-done');
  });
});
