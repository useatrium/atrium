import { describe, expect, it } from 'vitest';
import { matchSteerProvenance, maxSessionStatus, type SessionSuggestion } from './sessions';

describe('maxSessionStatus', () => {
  it('keeps completed ahead of failed regardless of event order', () => {
    expect(maxSessionStatus('completed', 'failed')).toBe('completed');
    expect(maxSessionStatus('failed', 'completed')).toBe('completed');
  });

  it('ranks completed ahead of cancelled', () => {
    expect(maxSessionStatus('completed', 'cancelled')).toBe('completed');
  });

  it('ranks completed ahead of running', () => {
    expect(maxSessionStatus('running', 'completed')).toBe('completed');
  });
});

describe('matchSteerProvenance', () => {
  const suggestion = (overrides: Partial<SessionSuggestion> = {}): SessionSuggestion => ({
    id: 'suggestion-1',
    authorId: 'proposer-1',
    authorName: 'Allan Niemerg',
    text: 'Please inspect the failing test',
    status: 'sent',
    resolvedBy: 'driver-1',
    resolvedByName: 'Gary Basin',
    sentText: null,
    createdAt: '2026-07-06T18:35:00.000Z',
    resolvedAt: '2026-07-06T18:41:00.000Z',
    ...overrides,
  });

  it('matches an exact sent suggestion by text and time', () => {
    const matched = matchSteerProvenance(
      [
        {
          id: 'msg-1',
          text: 'Please inspect the failing test',
          ts: '2026-07-06T18:41:02.000Z',
        },
      ],
      [suggestion()],
    );

    expect(matched.get('msg-1')).toEqual({
      proposerName: 'Allan Niemerg',
      resolvedByName: 'Gary Basin',
      edited: false,
      resolvedAt: '2026-07-06T18:41:00.000Z',
    });
  });

  it('matches edited suggestions using sentText', () => {
    const matched = matchSteerProvenance(
      [
        {
          id: 'msg-1',
          text: 'Please inspect the failing Vitest test',
          ts: '2026-07-06T18:41:02.000Z',
        },
      ],
      [
        suggestion({
          sentText: 'Please inspect the failing Vitest test',
        }),
      ],
    );

    expect(matched.get('msg-1')?.edited).toBe(true);
  });

  it('consumes duplicate-text transcript rows in resolvedAt order', () => {
    const matched = matchSteerProvenance(
      [
        {
          id: 'msg-early',
          text: 'retry the deploy',
          ts: '2026-07-06T18:41:01.000Z',
        },
        {
          id: 'msg-late',
          text: 'retry the deploy',
          ts: '2026-07-06T18:45:02.000Z',
        },
      ],
      [
        suggestion({
          id: 'suggestion-late',
          text: 'retry the deploy',
          resolvedAt: '2026-07-06T18:45:00.000Z',
        }),
        suggestion({
          id: 'suggestion-early',
          text: 'retry the deploy',
          authorName: 'Maya Chen',
          resolvedAt: '2026-07-06T18:41:00.000Z',
        }),
      ],
    );

    expect(matched.get('msg-early')?.proposerName).toBe('Maya Chen');
    expect(matched.get('msg-late')?.proposerName).toBe('Allan Niemerg');
  });

  it('does not match normal driver-typed steers', () => {
    const matched = matchSteerProvenance(
      [
        {
          id: 'msg-1',
          text: 'A driver typed this directly',
          ts: '2026-07-06T18:41:02.000Z',
        },
      ],
      [suggestion()],
    );

    expect(matched.size).toBe(0);
  });

  it('ignores dismissed and pending suggestions', () => {
    const matched = matchSteerProvenance(
      [
        {
          id: 'msg-1',
          text: 'Please inspect the failing test',
          ts: '2026-07-06T18:41:02.000Z',
        },
      ],
      [
        suggestion({ id: 'pending', status: 'pending', resolvedAt: null }),
        suggestion({ id: 'dismissed', status: 'dismissed' }),
      ],
    );

    expect(matched.size).toBe(0);
  });
});
