// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ThemeProvider } from '../theme';
import { ConversationHeader } from './ConversationHeader';
import { SessionMetaLine } from './SessionCard';
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

  it('slots the session meta line under the identity, whole', () => {
    render(
      <ThemeProvider>
        <ConversationHeader
          variant="card"
          identity={{ kind: 'session', session: session() }}
          meta={<SessionMetaLine session={session()} spectators={2} />}
        />
      </ThemeProvider>,
    );

    expect(screen.getByText('by Ada Lovelace')).toBeTruthy();
    expect(screen.getByText('codex agent')).toBeTruthy();
    expect(screen.getByText('acme/web@main')).toBeTruthy();
    expect(screen.getByText('2 watching')).toBeTruthy();
  });

  /**
   * #434 fixed a real bug here: at 390px flexbox was ellipsizing the AUTHOR to
   * "b…" while preserving boilerplate. The fix is a shrink priority that only
   * works while the tokens are flat flex children. Moving the row into the
   * shared header is exactly the kind of change that would quietly re-wrap them
   * and undo it — so the header must slot the row whole, and this pins that.
   */
  it('keeps the meta row flat, so #434 shrink priority survives the header', () => {
    render(
      <ThemeProvider>
        <ConversationHeader
          variant="card"
          identity={{ kind: 'session', session: session() }}
          meta={<SessionMetaLine session={session()} spectators={0} />}
        />
      </ThemeProvider>,
    );

    // The author sits DIRECTLY on the one-line row — no wrapper between them,
    // or the wrapper (not the token) would be what flexbox shrinks.
    const author = screen.getByText('by Ada Lovelace');
    const row = author.parentElement;
    expect(row?.className).toContain('whitespace-nowrap');
    expect(row?.className).not.toContain('flex-wrap');
    expect(row).toBe(screen.getByText('codex agent').parentElement);

    // The author is the headline: structurally incapable of ellipsizing.
    expect(author.className.split(' ')).toContain('shrink-0');
    expect(author.className.split(' ')).not.toContain('truncate');
    expect(author.className.split(' ')).not.toContain('min-w-0');
    // The start time likewise holds its ground.
    expect(screen.getByText(/^started /).className.split(' ')).toContain('shrink-0');
    // The long, low-information harness label is what yields space.
    expect(screen.getByText('codex agent').className).toContain('shrink-[3]');
    expect(screen.getByText('codex agent').className).toContain('truncate');
    // The repo is dropped below `sm`, not stubbed to "acme…".
    expect(screen.getByText('acme/web@main').className.split(' ')).toContain('hidden');
    expect(screen.getByText('acme/web@main').className).toContain('sm:inline');
  });
});
