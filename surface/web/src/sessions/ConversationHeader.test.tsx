// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../theme';
import { ConversationHeader } from './ConversationHeader';
import type { Session } from './types';

afterEach(cleanup);

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's-1',
    workspaceId: 'ws-1',
    channelId: 'ch-1',
    threadRootEventId: 1,
    title: 'Fix the flaky login test',
    status: 'running',
    harness: 'codex',
    repo: 'acme/web',
    branch: 'main',
    repos: null,
    spawnedBy: 'u-1',
    spawnerName: 'Ada Lovelace',
    driverId: 'u-1',
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
    createdAt: '2026-07-05T12:00:00.000Z',
    completedAt: null,
    archivedAt: null,
    pinned: false,
    lastEventId: 0,
    permalink: '/s/s-1',
    ...overrides,
  };
}

describe('ConversationHeader — one identity across the zooms', () => {
  it('names a session the same way in the card row and in the panel header', () => {
    const s = session();
    const { unmount } = render(
      <ThemeProvider>
        <ConversationHeader variant="card" identity={{ kind: 'session', session: s }} />
      </ThemeProvider>,
    );
    const cardTitle = screen.getByTestId('conversation-title').textContent;
    const cardGlance = screen.getByTestId('glance-chip').getAttribute('data-kind');
    unmount();

    render(
      <ThemeProvider>
        <ConversationHeader identity={{ kind: 'session', session: s }} />
      </ThemeProvider>,
    );

    // Same chip, same title — the thing that stays the same across the zoom is
    // visibly the same thing.
    expect(screen.getByTestId('conversation-title').textContent).toBe(cardTitle);
    expect(screen.getByTestId('conversation-title').textContent).toBe('Fix the flaky login test');
    expect(screen.getByTestId('glance-chip').getAttribute('data-kind')).toBe(cardGlance);
  });

  it('makes the identity the panel’s heading', () => {
    render(
      <ThemeProvider>
        <ConversationHeader identity={{ kind: 'session', session: session() }} />
      </ThemeProvider>,
    );
    // The panel's name is the conversation's name — screen readers (and the e2e
    // suite) navigate the right panel by this heading.
    expect(screen.getByRole('heading', { name: 'Fix the flaky login test' })).toBeTruthy();
  });

  it('gives the hidden-title session opener a distinct status-aware name', () => {
    const { rerender } = render(
      <ThemeProvider>
        <ConversationHeader
          variant="card"
          hideTitle
          onOpenTitle={() => {}}
          identity={{ kind: 'session', session: session() }}
        />
      </ThemeProvider>,
    );

    expect(screen.getByRole('button', { name: 'Fix the flaky login test — Working' })).toBeTruthy();

    rerender(
      <ThemeProvider>
        <ConversationHeader
          variant="card"
          hideTitle
          onOpenTitle={() => {}}
          identity={{
            kind: 'session',
            session: session({ status: 'completed', completedAt: '2026-07-05T12:00:42.000Z' }),
          }}
        />
      </ThemeProvider>,
    );

    expect(screen.getByRole('button', { name: 'Fix the flaky login test — Done, Done in 42s' })).toBeTruthy();
  });

  it('holds the panel header still while the panel expands around it', () => {
    render(
      <ThemeProvider>
        <ConversationHeader identity={{ kind: 'session', session: session() }} />
      </ThemeProvider>,
    );
    // The `.pane-zoom-in` slide+fade runs on the panel's other children; the
    // identity row opts out via this anchor (see index.css).
    expect(screen.getByTestId('conversation-header').hasAttribute('data-zoom-anchor')).toBe(true);
  });

  it('renders the zoom crumbs, with the current level inert', () => {
    const onOpenChannel = vi.fn();
    const onOpenThread = vi.fn();
    render(
      <ThemeProvider>
        <ConversationHeader
          identity={{ kind: 'session', session: session() }}
          crumbs={[
            { label: '#eng', onClick: onOpenChannel },
            { label: 'thread', onClick: onOpenThread },
            { label: 'work' },
          ]}
        />
      </ThemeProvider>,
    );

    const crumb = screen.getByTestId('conversation-crumb');
    expect(crumb.textContent).toContain('#eng');
    expect(crumb.textContent).toContain('thread');
    expect(crumb.textContent).toContain('work');

    fireEvent.click(screen.getByRole('button', { name: '#eng' }));
    expect(onOpenChannel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'thread' }));
    expect(onOpenThread).toHaveBeenCalledTimes(1);
    // You're already at 'work' — it names the level, it isn't a way back to it.
    expect(screen.queryByRole('button', { name: 'work' })).toBeNull();
  });

  it('gives a human conversation its own identity — author and opening line', () => {
    render(
      <ThemeProvider>
        <ConversationHeader
          identity={{
            kind: 'thread',
            authorId: 'u-2',
            authorName: 'Grace Hopper',
            snippet: 'Can we ship the migration today?',
          }}
        />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('conversation-title').textContent).toBe('Grace Hopper');
    expect(screen.getByText('Can we ship the migration today?')).toBeTruthy();
    // No session, so no status chip to fake — and no generic chrome either.
    expect(screen.queryByTestId('glance-chip')).toBeNull();
  });
});
