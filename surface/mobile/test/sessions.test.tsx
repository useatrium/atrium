// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  state: { wsStatus: 'open' as const, sessions: {}, channels: [] },
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

  it('uses shared outcome grammar and shows the terminal result excerpt', async () => {
    renderWithTheme(<SessionsScreen />);

    expect(await screen.findByText('Done in 42s')).toBeInTheDocument();
    expect(screen.getByText('All checks passed.')).toBeInTheDocument();
  });
});
