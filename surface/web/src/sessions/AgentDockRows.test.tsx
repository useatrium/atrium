// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentGroup, AgentRow, type AgentRowContext } from './AgentDockRows';
import type { Session } from './types';
import type { AgentDockGroup } from './useAgentDock';

afterEach(cleanup);

const NOW = Date.parse('2026-07-18T12:00:00.000Z');

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 'session-1',
    workspaceId: 'workspace-1',
    channelId: 'channel-1',
    threadRootEventId: null,
    title: 'Agent session',
    status: 'running',
    harness: 'codex',
    spawnedBy: 'user-1',
    driverId: 'user-1',
    pendingSeatRequests: [],
    suggestions: [],
    answerProposals: [],
    seatEvents: [],
    costUsd: 0,
    resultText: null,
    createdAt: '2026-07-18T10:00:00.000Z',
    completedAt: null,
    archivedAt: null,
    pinned: false,
    lastEventId: 1,
    permalink: '/s/session-1',
    ...overrides,
  };
}

function context(overrides: Partial<AgentRowContext> = {}): AgentRowContext {
  return {
    meId: 'user-1',
    channelNames: new Map([
      ['channel-1', 'engineering'],
      ['channel-2', 'launch'],
    ]),
    ...overrides,
  };
}

function renderRow(
  row: Session,
  overrides: Partial<{
    context: AgentRowContext;
    groupKind: AgentDockGroup['kind'];
    onFocus: () => void;
  }> = {},
) {
  return render(
    <AgentRow
      session={row}
      now={NOW}
      selected={false}
      onFocus={overrides.onFocus ?? vi.fn()}
      context={overrides.context ?? context()}
      groupKind={overrides.groupKind ?? 'channel'}
    />,
  );
}

describe('AgentRow', () => {
  it('shows a pending question as the warning subtitle and falls back when its text is absent', () => {
    const question = 'Which migration strategy should I use?';
    const view = renderRow(
      session({
        pendingQuestion: {
          questionId: 'question-1',
          questions: [{ id: 'prompt-1', header: 'Migration', question }],
          askedAt: '2026-07-18T11:00:00.000Z',
        },
        latestActivity: { summary: 'running a stale command', at: '2026-07-18T11:30:00.000Z' },
      }),
    );

    const subtitle = screen.getByText(`“${question}”`);
    expect(subtitle.getAttribute('title')).toBe(question);
    expect(subtitle.className).toContain('text-warning-text-strong');
    expect(screen.queryByTestId('session-presence-ticker')).toBeNull();

    view.rerender(
      <AgentRow
        session={session({
          pendingQuestion: {
            questionId: 'question-2',
            questions: [],
            askedAt: '2026-07-18T11:00:00.000Z',
          },
        })}
        now={NOW}
        selected={false}
        onFocus={vi.fn()}
        context={context()}
        groupKind="channel"
      />,
    );
    expect(screen.getByText('Waiting for activity…')).toBeTruthy();
  });

  it('keeps Answer visible in reserved space and makes the age invisible for question rows', () => {
    const onFocus = vi.fn();
    renderRow(
      session({
        pendingQuestion: {
          questionId: 'question-1',
          questions: [{ id: 'prompt-1', header: 'Choice', question: 'Choose one?' }],
          askedAt: '2026-07-18T11:00:00.000Z',
        },
      }),
      { onFocus },
    );

    const answer = screen.getByRole('button', { name: 'Answer' });
    expect(answer.className).toContain('min-h-6');
    expect(answer.className).not.toContain('opacity-0');
    expect(screen.getByTestId('agent-dock-age-session-1').className).toContain('invisible');
    expect(screen.getByRole('button', { name: 'Focus agent Agent session' }).className).toContain('pr-14');

    fireEvent.click(answer);
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  it('marks mine and subtly dims named rows driven by someone else', () => {
    const view = renderRow(session({ driverName: 'Mine Name' }));
    expect(screen.getByTestId('agent-dock-row-session-1').getAttribute('data-mine')).toBe('true');
    expect(screen.getByTestId('agent-dock-row-content-session-1').className).not.toContain('opacity-70');
    expect(screen.queryByTestId('agent-dock-driver-session-1')).toBeNull();

    view.rerender(
      <AgentRow
        session={session({ driverId: 'user-2', driverName: 'Ada Lovelace' })}
        now={NOW}
        selected={false}
        onFocus={vi.fn()}
        context={context()}
        groupKind="channel"
      />,
    );
    expect(screen.getByTestId('agent-dock-row-session-1').getAttribute('data-mine')).toBeNull();
    expect(screen.getByTestId('agent-dock-row-session-1').getAttribute('data-owned-by-other')).toBe('true');
    expect(screen.getByTestId('agent-dock-row-content-session-1').className).toContain('opacity-70');
    expect(screen.getByTestId('agent-dock-driver-session-1').textContent).toBe('AL');
    expect(screen.getByTestId('agent-dock-driver-session-1').getAttribute('title')).toBe('Driven by Ada Lovelace');
  });

  it('fires pin and History archive callbacks with target and previous values', () => {
    const onFocus = vi.fn();
    const onSetArchived = vi.fn();
    const onSetPinned = vi.fn();
    renderRow(
      session({
        status: 'completed',
        completedAt: '2026-07-18T11:00:00.000Z',
        pinned: true,
        title: 'Finished task',
      }),
      {
        groupKind: 'recent',
        onFocus,
        context: context({ onSetArchived, onSetPinned }),
      },
    );

    const unpin = screen.getByRole('button', { name: 'Unpin Finished task' });
    const archive = screen.getByRole('button', { name: 'Archive Finished task' });
    expect(unpin.className).toContain('size-6');
    expect(archive.className).toContain('size-6');

    fireEvent.click(unpin);
    fireEvent.click(archive);

    expect(onSetPinned).toHaveBeenCalledWith('session-1', false, true);
    expect(onSetArchived).toHaveBeenCalledWith('session-1', true, null);
    expect(onFocus).not.toHaveBeenCalled();
  });
});

describe('AgentGroup channel tags', () => {
  it('filters without focusing in cross-channel groups and omits tags in channel groups', () => {
    const onFilterChannel = vi.fn();
    const onFocusAgent = vi.fn();
    const row = session({ channelId: 'channel-2', title: 'Launch task' });
    const view = render(
      <AgentGroup
        group={{ key: 'needs', label: 'Needs you', kind: 'needs', sessions: [row] }}
        now={NOW}
        focusedSessionId={null}
        onFocusAgent={onFocusAgent}
        context={context({ onFilterChannel })}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Filter agents to #launch' }));
    expect(onFilterChannel).toHaveBeenCalledWith('channel-2');
    expect(onFocusAgent).not.toHaveBeenCalled();

    view.rerender(
      <AgentGroup
        group={{ key: 'channel:channel-2', label: 'launch', kind: 'channel', sessions: [row] }}
        now={NOW}
        focusedSessionId={null}
        onFocusAgent={onFocusAgent}
        context={context({ onFilterChannel })}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Filter agents to #launch' })).toBeNull();

    view.rerender(
      <AgentGroup
        group={{ key: 'recent', label: 'History', kind: 'recent', sessions: [row] }}
        now={NOW}
        focusedSessionId={null}
        onFocusAgent={onFocusAgent}
        context={context({ onFilterChannel })}
      />,
    );
    expect(screen.getByRole('button', { name: 'Filter agents to #launch' })).toBeTruthy();
  });
});
