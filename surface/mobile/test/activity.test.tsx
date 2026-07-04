// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatExactTimestamp } from '@atrium/surface-client';
import ActivityScreen from '../app/(app)/(tabs)/activity';
import { renderWithTheme } from './rnTestUtils';
import { Text } from 'react-native';

const routerMock = vi.hoisted(() => ({
  push: vi.fn(),
}));

const chatMock = vi.hoisted(() => ({
  api: {
    listSessions: vi.fn(),
    getActivity: vi.fn(),
    messages: vi.fn(),
  },
  me: { id: 'u-me', handle: 'me', displayName: 'Me' },
  state: {
    wsStatus: 'open' as const,
    sessions: {},
  },
  queuedChangesCount: 0,
}));

vi.mock('expo-router', () => ({
  router: routerMock,
}));

vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: unknown }) => children,
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
  chatMock.api.messages.mockReset();
  chatMock.state.sessions = {};
  chatMock.queuedChangesCount = 0;
});

describe('mobile Activity screen', () => {
  it('adds server activity rows alongside session attention rows', async () => {
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
    expect(screen.getByText('Investigate failure')).toBeInTheDocument();
    expect(
      screen.getByLabelText(`Agent needs your input, #general, ${formatExactTimestamp('2026-01-01T00:02:00.000Z')}`),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(`Alice mentioned you, #general, ${formatExactTimestamp('2026-01-01T00:01:00.000Z')}`),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText(
        `Investigate failure, running, #general, started ${formatExactTimestamp('2026-01-01T00:00:00.000Z')}`,
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByText('Alice mentioned you'));
    expect(routerMock.push).toHaveBeenCalledWith('/channel/ch-general');

    fireEvent.click(screen.getByText('Agent needs your input'));
    await waitFor(() => expect(routerMock.push).toHaveBeenCalledWith('/session/s-question'));
  });
});
