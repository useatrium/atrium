// @vitest-environment jsdom

import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserRef } from '@atrium/surface-client';
import { ConversationPanel } from './ConversationPanel';
import type { SessionPaneProps } from './SessionPane';
import { sessionsApi } from './api';
import type { Session } from './types';

vi.mock('../components/ThreadPanel', () => ({
  ThreadPanelContent: () => <div data-testid="thread-mode" />,
}));

vi.mock('./SessionPane', () => ({
  SessionPaneContent: () => <div data-testid="work-mode" />,
}));

vi.mock('./api', () => ({
  sessionsApi: {
    openStream: vi.fn(),
  },
}));

const openStream = vi.mocked(sessionsApi.openStream);

const me: UserRef = { id: 'u-1', handle: 'ada', displayName: 'Ada' };
const session: Session = {
  id: 's-1',
  workspaceId: 'ws-1',
  channelId: 'ch-1',
  threadRootEventId: 42,
  title: 'Keep one stream',
  status: 'running',
  harness: 'codex',
  repo: null,
  branch: null,
  repos: null,
  spawnedBy: me.id,
  spawnerName: me.displayName,
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
  resultText: null,
  createdAt: '2026-07-15T12:00:00.000Z',
  completedAt: null,
  archivedAt: null,
  pinned: false,
  lastEventId: 0,
  permalink: '/s/s-1',
};

const sessionProps: SessionPaneProps = {
  session,
  me,
  watchers: [],
  onClose: vi.fn(),
  onAnswerQuestion: vi.fn(async () => {}),
};

describe('ConversationPanel stream identity', () => {
  const close = vi.fn();

  beforeEach(() => {
    close.mockReset();
    openStream.mockReset();
    openStream.mockReturnValue({ close });
  });

  afterEach(cleanup);

  it('does not close or reopen the SSE when the route changes modes', () => {
    const view = render(<ConversationPanel mode="work" session={sessionProps} />);
    expect(openStream).toHaveBeenCalledTimes(1);

    view.rerender(<ConversationPanel mode="thread" session={sessionProps} />);
    view.rerender(<ConversationPanel mode="work" session={sessionProps} />);

    expect(openStream).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();

    view.unmount();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
