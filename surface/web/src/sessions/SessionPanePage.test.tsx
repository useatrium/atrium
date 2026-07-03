import { describe, expect, it } from 'vitest';
import { paneRouteFromPath } from '../App';
import { sessionPaneDocumentTitle } from './SessionPanePage';
import type { Session } from './types';

function session(overrides: Partial<Session> = {}): Session {
  return {
    id: 's-1',
    workspaceId: 'ws-1',
    channelId: 'ch-1',
    threadRootEventId: null,
    title: 'Ship the pane',
    status: 'running',
    harness: 'codex',
    repo: null,
    branch: null,
    repos: null,
    spawnedBy: 'u-1',
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
    createdAt: '2026-07-03T12:00:00.000Z',
    completedAt: null,
    lastEventId: 0,
    permalink: '/s/s-1',
    ...overrides,
  };
}

describe('paneRouteFromPath', () => {
  it('parses the lean pane route', () => {
    expect(paneRouteFromPath('/s/abc/pane')).toEqual({ sessionId: 'abc' });
    expect(paneRouteFromPath('/s/session-123/pane')).toEqual({ sessionId: 'session-123' });
  });

  it('returns null for the full app route, work routes, and extra path segments', () => {
    expect(paneRouteFromPath('/s/abc')).toBeNull();
    expect(paneRouteFromPath('/s/abc/work/changes')).toBeNull();
    expect(paneRouteFromPath('/s/abc/pane/extra')).toBeNull();
    expect(paneRouteFromPath('/')).toBeNull();
  });
});

describe('sessionPaneDocumentTitle', () => {
  it('uses the session title and the same public status wording as the pane chip', () => {
    expect(
      sessionPaneDocumentTitle(session({ status: 'spawning' }), {
        now: Date.parse('2026-07-03T12:00:01.000Z'),
      }),
    ).toBe('Ship the pane · starting');
    expect(
      sessionPaneDocumentTitle(session({ status: 'completed' }), {
        now: Date.parse('2026-07-03T12:00:01.000Z'),
      }),
    ).toBe('Ship the pane · completed');
  });

  it('has a single seam for the future unseen-output marker', () => {
    expect(
      sessionPaneDocumentTitle(session(), {
        now: Date.parse('2026-07-03T12:00:01.000Z'),
        unseen: true,
      }),
    ).toBe('● Ship the pane · running');
  });
});
