import { describe, expect, it } from 'vitest';
import { listItemGlance } from '../src/lib/sessionGlance';
import type { Session } from '@atrium/surface-client';

const now = Date.parse('2026-07-16T12:00:00.000Z');

const listRow = {
  status: 'running' as const,
  createdAt: new Date(now - 10 * 60_000).toISOString(),
  completedAt: null,
};

describe('listItemGlance', () => {
  it('honors the list-wire needsAttention flag when no live entity proves it', () => {
    const glance = listItemGlance({ ...listRow, needsAttention: true }, undefined, now);
    expect(glance.kind).toBe('needs_you');
    expect(glance.label).toBe('Needs you');
  });

  it('stays working without the flag', () => {
    const glance = listItemGlance({ ...listRow, needsAttention: false }, undefined, now);
    expect(glance.kind).toBe('working');
  });

  it('lets a live entity win over the flag', () => {
    const live = {
      status: 'running',
      pendingQuestion: null,
      providerAuthRequired: null,
      pendingSeatRequests: [],
      createdAt: listRow.createdAt,
      completedAt: null,
    } as unknown as Session;
    // The live entity says nothing is blocked — a stale list flag must not
    // resurrect a needs-you chip the socket has already cleared.
    const glance = listItemGlance({ ...listRow, needsAttention: true }, live, now);
    expect(glance.kind).toBe('working');
  });
});
