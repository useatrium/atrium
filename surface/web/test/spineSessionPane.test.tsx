// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { initialSessionState, type SessionState } from '@atrium/centaur-client';
import type { UserRef } from '@atrium/surface-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionPaneHarness as SessionPane } from './renderConversation';
import type { Session } from '../src/sessions/types';
import { TRANSCRIPT_VIEW_STORAGE_KEY } from '../src/sessions/useTranscriptView';
import { ThemeProvider } from '../src/theme';

const mocks = vi.hoisted(() => ({ stream: null as SessionState | null }));

vi.mock('../src/sessions/useSessionStream', () => ({
  useSessionStream: () => ({
    stream: mocks.stream!,
    connected: true,
    lastFrameAt: null,
    clockSkewMs: null,
  }),
}));

vi.mock('../src/sessions/useConflicts', () => ({
  useConflicts: () => ({ conflicts: [], resolve: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('../src/sessions/useArtifactPresentations', () => ({
  useArtifactPresentations: () => [],
}));

const me: UserRef = { id: 'u-1', handle: 'ada', displayName: 'Ada Lovelace' };

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's-1',
    workspaceId: 'ws-1',
    channelId: 'ch-1',
    threadRootEventId: null,
    title: 'Inspect the build',
    status: 'completed',
    harness: 'codex',
    repo: null,
    branch: null,
    repos: null,
    spawnedBy: me.id,
    driverId: me.id,
    pendingSeatRequests: [],
    suggestions: [],
    answerProposals: [],
    pendingQuestion: null,
    providerAuthRequired: null,
    githubIdentityMode: null,
    providerConnectionId: null,
    agentProfileVersionId: null,
    modelEffort: null,
    questionEvents: [],
    seatEvents: [],
    costUsd: 0,
    resultText: 'Done',
    createdAt: '2026-07-14T12:00:00.000Z',
    completedAt: '2026-07-14T12:00:04.000Z',
    archivedAt: null,
    pinned: false,
    lastEventId: 4,
    permalink: '/s/s-1',
    ...overrides,
  };
}

function completedStream(): SessionState {
  return {
    ...initialSessionState(),
    status: 'completed',
    lastEventId: 4,
    items: [
      {
        type: 'user_message',
        id: 'ask',
        text: 'Please inspect the build.',
        executionId: 'exe-1',
        ts: '2026-07-14T12:00:00.000Z',
        sourceEventIds: [1],
      },
      {
        type: 'tool_call',
        id: 'tool',
        name: 'Bash',
        input: { command: 'pnpm test' },
        executionId: 'exe-1',
        result: { content: 'passed', is_error: false },
        ts: '2026-07-14T12:00:01.000Z',
        sourceEventIds: [2],
      },
      {
        type: 'text',
        id: 'answer',
        text: 'The build passes.',
        executionId: 'exe-1',
        ts: '2026-07-14T12:00:04.000Z',
        sourceEventIds: [3],
      },
    ],
    fileChanges: [
      {
        id: 'change',
        path: '/workspace/src/app.ts',
        kind: 'update',
        diff: '+ fixed',
        toolName: 'apply_patch',
        sourceEventIds: [2],
      },
    ],
  };
}

function renderPane(value = session()) {
  return render(
    <ThemeProvider>
      <SessionPane session={value} me={me} watchers={[]} onClose={vi.fn()} onAnswerQuestion={vi.fn(async () => {})} />
    </ThemeProvider>,
  );
}

beforeEach(() => {
  mocks.stream = completedStream();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ files: [], nextCursor: null }), { status: 200 })),
  );
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe('SessionPane spine integration', () => {
  it('interleaves a completed work fold between its user turn and agent reply', () => {
    renderPane();

    const ask = screen.getByTestId('user-steer');
    const fold = screen.getByTestId('work-fold-collapsed');
    const answer = screen.getByText('The build passes.');
    expect(ask.compareDocumentPosition(fold) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(fold.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByTestId('tool-card')).toBeNull();
  });

  it('expands all folds from the header menu and persists the migrated preference', () => {
    renderPane();
    fireEvent.click(screen.getByRole('button', { name: 'Agent actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Expand all work' }));

    expect(screen.getByTestId('work-fold-expanded')).toBeTruthy();
    expect(window.localStorage.getItem(TRANSCRIPT_VIEW_STORAGE_KEY)).toBe('full');
  });

  it('opens the matching drawer tabs from the compact work strips', () => {
    renderPane();
    expect(screen.getByTestId('spine-work-strips')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '≡ What changed · 1' }));
    expect(screen.getByTestId('work-drawer')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'What changed · 1' }).getAttribute('data-state')).toBe('active');
    fireEvent.click(screen.getByRole('button', { name: 'Close work drawer' }));

    fireEvent.click(screen.getByRole('button', { name: '⚙ What it ran · 1' }));
    expect(screen.getByRole('tab', { name: 'What it ran · 1' }).getAttribute('data-state')).toBe('active');
    fireEvent.click(screen.getByRole('button', { name: 'Close work drawer' }));

    fireEvent.click(screen.getByRole('button', { name: '▣ Files' }));
    expect(screen.getByRole('tab', { name: 'Files' }).getAttribute('data-state')).toBe('active');
  });

  it('streams the live turn open with its in-flight step pulsing', () => {
    const live = completedStream();
    live.status = 'running';
    live.items = live.items.slice(0, 2);
    const tool = live.items[1];
    if (tool?.type === 'tool_call') tool.result = undefined;
    mocks.stream = live;

    renderPane(session({ status: 'running', completedAt: null, resultText: null }));
    expect(screen.getByTestId('work-fold-expanded')).toBeTruthy();
    expect(screen.getByText('●').className).toContain('animate-pulse');
  });
});
