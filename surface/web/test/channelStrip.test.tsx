// @vitest-environment jsdom

import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelStrip } from '../src/sessions/ChannelStrip';
import type { Session } from '../src/sessions/types';

let sequence = 0;

function session(overrides: Partial<Session> = {}): Session {
  sequence += 1;
  return {
    id: `session-${sequence}`,
    workspaceId: 'ws-1',
    channelId: 'channel-1',
    threadRootEventId: null,
    title: `Task ${sequence}`,
    status: 'running',
    harness: 'codex',
    spawnedBy: 'u-1',
    driverId: 'u-1',
    pendingSeatRequests: [],
    suggestions: [],
    answerProposals: [],
    costUsd: 0,
    resultText: null,
    createdAt: new Date(Date.now() - sequence * 1_000).toISOString(),
    completedAt: null,
    archivedAt: null,
    pinned: false,
    lastEventId: 0,
    permalink: `/s/session-${sequence}`,
    ...overrides,
  } as Session;
}

function asMap(...sessions: Session[]): Record<string, Session> {
  return Object.fromEntries(sessions.map((value) => [value.id, value]));
}

function renderStrip(
  sessions: Record<string, Session>,
  channelId: string | null = 'channel-1',
  channelCounts = { needsYou: 0, running: 0, toReview: 0 },
) {
  const onOpenSession = vi.fn();
  const onOpenInbox = vi.fn();
  render(
    <ChannelStrip
      channelId={channelId}
      channelCounts={channelCounts}
      sessions={sessions}
      onOpenSession={onOpenSession}
      onOpenInbox={onOpenInbox}
    />,
  );
  return { onOpenSession, onOpenInbox };
}

afterEach(() => {
  cleanup();
  sequence = 0;
});

describe('ChannelStrip', () => {
  it('is absent when the active channel is idle', () => {
    renderStrip(
      asMap(session({ status: 'completed', completedAt: new Date(Date.now() - 49 * 60 * 60 * 1_000).toISOString() })),
    );

    expect(screen.queryByTestId('channel-strip')).toBeNull();
  });

  it('shows counts per bucket and an accessible summary', () => {
    const needs = session({
      pendingQuestion: { questionId: 'q-1', questions: [{ id: 'p-1', header: 'Confirm', question: 'Ship it?' }] },
    });
    const running = session();
    const reviewed = session({
      status: 'completed',
      completedAt: new Date().toISOString(),
      resultText: 'Shipped.',
    });
    renderStrip(asMap(needs, running, reviewed), 'channel-1', { needsYou: 1, running: 1, toReview: 1 });

    const toggle = screen.getByRole('button', {
      name: 'Agent work in this channel: 1 needs you, 1 running, 1 to review',
    });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.textContent).toContain('⚠ 1');
    expect(toggle.textContent).toContain('● 1');
    expect(toggle.textContent).toContain('✓ 1');
  });

  it('expands in bucket order, caps rows, and routes the remainder to Inbox', () => {
    const needs = session({
      title: 'Needs answer',
      pendingQuestion: { questionId: 'q-1', questions: [{ id: 'p-1', header: 'Confirm', question: 'Ship it?' }] },
    });
    const running = session({ title: 'Running now' });
    const review = Array.from({ length: 4 }, (_, index) =>
      session({
        title: `Review ${index + 1}`,
        status: 'completed',
        completedAt: new Date(Date.now() - index * 1_000).toISOString(),
        resultText: 'Completed work.',
      }),
    );
    const { onOpenInbox } = renderStrip(asMap(needs, running, ...review), 'channel-1', {
      needsYou: 1,
      running: 1,
      toReview: 4,
    });

    fireEvent.click(screen.getByRole('button', { name: /Agent work in this channel/ }));
    const rows = screen.getAllByTestId(/channel-strip-row-/);
    expect(rows[0]?.textContent).toContain('Needs answer');
    expect(rows[1]?.textContent).toContain('Running now');
    expect(rows[2]?.textContent).toContain('Review 1');
    expect(rows).toHaveLength(5);
    expect(screen.getByRole('button', { name: '1 more → Inbox' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '1 more → Inbox' }));
    expect(onOpenInbox).toHaveBeenCalledOnce();
  });

  it('opens a selected row and only consumes Escape while expanded', () => {
    const value = session({ title: 'Answer me', pendingQuestion: { questionId: 'q-1', questions: [] } });
    const { onOpenSession } = renderStrip(asMap(value), 'channel-1', { needsYou: 1, running: 0, toReview: 0 });
    const strip = screen.getByTestId('channel-strip');
    const collapsedEscape = createEvent.keyDown(strip, { key: 'Escape' });
    fireEvent(strip, collapsedEscape);
    expect(collapsedEscape.defaultPrevented).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /Agent work in this channel/ }));
    fireEvent.click(screen.getByTestId(`channel-strip-row-${value.id}`));
    expect(onOpenSession).toHaveBeenCalledWith(value.id);

    const expandedEscape = createEvent.keyDown(strip, { key: 'Escape' });
    fireEvent(strip, expandedEscape);
    expect(expandedEscape.defaultPrevented).toBe(true);
    expect(screen.getByRole('button', { name: /Agent work in this channel/ }).getAttribute('aria-expanded')).toBe(
      'false',
    );
  });
});
