// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@atrium/surface-client';
import SessionsScreen, { groupMobileSessions } from '../app/(app)/(tabs)/sessions';
import { renderWithTheme } from './rnTestUtils';

vi.mock('@expo/vector-icons', () => ({ Ionicons: () => null }));
vi.mock('expo-router', () => ({ router: { push: vi.fn() } }));
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: ({ children }: { children: unknown }) => children,
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const chatMock = vi.hoisted(() => ({
  api: { listSessions: vi.fn() },
  me: { id: 'u-me', displayName: 'Me', handle: 'me' },
  state: { wsStatus: 'open' as const, sessions: {} as Record<string, Session>, channels: [] },
  startDemoSession: vi.fn(),
  setSessionArchived: vi.fn(),
  setSessionPinned: vi.fn(),
}));

vi.mock('../src/lib/chat', () => ({ useChat: () => chatMock }));

afterEach(cleanup);

const terminalSession = {
  id: 's-done',
  channelId: 'ch-agent',
  channelName: 'agents',
  title: 'Ship the fix',
  status: 'completed',
  harness: 'codex',
  spawnedBy: 'u-me',
  spawnerName: 'Me',
  costUsd: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  completedAt: '2026-01-01T00:00:42.000Z',
  archivedAt: null,
  pinned: false,
  needsAttention: false,
  attentionReason: null,
  resultText: 'All checks passed.',
};

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
  chatMock.api.listSessions.mockReset();
  chatMock.state.sessions = {};
  chatMock.api.listSessions.mockResolvedValue({ sessions: [terminalSession] });
});

describe('mobile Agents screen', () => {
  it('uses server list attention fields for the Needs you group', () => {
    const sections = groupMobileSessions([
      { ...terminalSession, id: 's-needs', status: 'running', needsAttention: true, attentionReason: 'question' },
    ]);

    expect(sections.map((section) => section.title)).toEqual(['Needs you']);
  });

  it('counts a live seat request in the Needs you group', () => {
    const row = {
      ...terminalSession,
      id: 's-seat',
      status: 'running' as const,
      completedAt: null,
      needsAttention: false,
      live: liveSession({
        id: 's-seat',
        pendingSeatRequests: [{ userId: 'u-driver', displayName: 'Driver' }],
      }),
    };

    expect(groupMobileSessions([row]).map((section) => section.title)).toEqual(['Needs you']);
  });

  it('groups Active by channel with the freshest channel and session first', () => {
    const sections = groupMobileSessions([
      {
        ...terminalSession,
        id: 's-alpha-old',
        channelId: 'ch-alpha',
        channelName: 'alpha',
        status: 'running' as const,
        createdAt: '2026-01-01T00:01:00.000Z',
        completedAt: null,
        resultText: null,
      },
      {
        ...terminalSession,
        id: 's-beta',
        channelId: 'ch-beta',
        channelName: 'beta',
        status: 'running' as const,
        createdAt: '2026-01-01T00:03:00.000Z',
        completedAt: null,
        resultText: null,
      },
      {
        ...terminalSession,
        id: 's-alpha-new',
        channelId: 'ch-alpha',
        channelName: 'alpha',
        status: 'running' as const,
        createdAt: '2026-01-01T00:02:00.000Z',
        completedAt: null,
        resultText: null,
      },
    ]);

    expect(sections.map((section) => section.key)).toEqual(['active:ch-beta', 'active:ch-alpha']);
    expect(sections.map((section) => section.channelName)).toEqual(['beta', 'alpha']);
    expect(sections.map((section) => section.showTitle)).toEqual([true, false]);
    expect(sections[1]?.data.map((session) => session.id)).toEqual(['s-alpha-new', 's-alpha-old']);
  });

  it('uses shared outcome grammar and shows the terminal result excerpt', async () => {
    renderWithTheme(<SessionsScreen />);

    expect(await screen.findByText('Done in 42s')).toBeInTheDocument();
    expect(screen.getByText('All checks passed.')).toBeInTheDocument();
  });

  it('does not let fold-only unknown override a known REST outcome', async () => {
    chatMock.state.sessions = {
      's-done': liveSession({ id: 's-done', status: 'unknown' as never }),
    };

    renderWithTheme(<SessionsScreen />);

    expect(await screen.findByText('Done in 42s')).toBeInTheDocument();
    expect(screen.queryByText('Status unavailable')).not.toBeInTheDocument();
  });

  it('does not render unknown lifecycle state as a finished outcome', async () => {
    chatMock.api.listSessions.mockResolvedValue({
      sessions: [
        {
          ...terminalSession,
          id: 's-unknown',
          title: 'Lifecycle unavailable',
          status: 'unknown' as never,
          completedAt: null,
          resultText: null,
        },
      ],
    });

    renderWithTheme(<SessionsScreen />);

    expect(await screen.findByText('STATUS UNAVAILABLE')).toBeInTheDocument();
    expect(screen.queryByText(/Done in/)).not.toBeInTheDocument();
  });
});
