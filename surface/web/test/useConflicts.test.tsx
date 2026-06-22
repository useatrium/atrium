// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useConflicts } from '../src/sessions/useConflicts';

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

const detail = {
  artifactId: 'art-1',
  path: 'proj-x/plan.md',
  kind: 'diff3',
  conflictSeq: 6,
  baseSeq: 4,
  base: { sha: 'b', text: 'a\nb\n' },
  left: { label: 'theirs', author: 'human:alice', sha: 'l', text: 'a\nLEFT\n' },
  right: { label: 'yours', author: 'agent:s1', sha: 'r', text: 'a\nRIGHT\n' },
  markers: '<<<\nLEFT\n===\nRIGHT\n>>>\n',
};

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useConflicts', () => {
  it('surfaces a conflict from the feed + detail, then resolves it', async () => {
    // poll 1: feed has a conflict row → detail fetched.
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/artifacts/changes')) {
        return Promise.resolve(
          jsonResponse({ rows: [{ path: 'proj-x/plan.md', status: 'conflict' }], next_cursor: '5.5' }),
        );
      }
      if (url.includes('/artifacts/conflict')) return Promise.resolve(jsonResponse(detail));
      return Promise.resolve(jsonResponse({}));
    });

    const { result } = renderHook(() => useConflicts('s-1', { pollMs: 100000 }));
    await waitFor(() => expect(result.current.conflicts).toHaveLength(1));
    expect(result.current.conflicts[0]!.path).toBe('proj-x/plan.md');

    // resolve "Keep theirs" → POST with the left side's text.
    await act(async () => {
      await result.current.resolve('art-1', { kind: 'left' });
    });
    const post = fetchMock.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('/resolve'),
    );
    expect(post).toBeTruthy();
    expect(post![1]).toMatchObject({ method: 'POST', body: 'a\nLEFT\n' });
  });

  it('drops a conflict when a later normal version resolves it', async () => {
    let phase = 0;
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/artifacts/changes')) {
        phase += 1;
        // first drain: conflict; second drain: a normal row for the same path.
        const rows =
          phase === 1
            ? [{ path: 'proj-x/plan.md', status: 'conflict' }]
            : [{ path: 'proj-x/plan.md', status: 'normal' }];
        return Promise.resolve(jsonResponse({ rows, next_cursor: `${phase}.${phase}` }));
      }
      if (url.includes('/artifacts/conflict')) return Promise.resolve(jsonResponse(detail));
      return Promise.resolve(jsonResponse({}));
    });

    const { result } = renderHook(() => useConflicts('s-1', { pollMs: 100000 }));
    await waitFor(() => expect(result.current.conflicts).toHaveLength(1));
    await act(async () => {
      await result.current.refresh();
    });
    await waitFor(() => expect(result.current.conflicts).toHaveLength(0));
  });

  it('sends the stay-deleted header when the chosen side is a delete', async () => {
    const delDetail = {
      ...detail,
      kind: 'delete_vs_edit',
      left: { label: 'deleted', author: 'agent:s1', sha: null, text: '' },
    };
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/artifacts/changes')) {
        return Promise.resolve(
          jsonResponse({ rows: [{ path: 'proj-x/plan.md', status: 'conflict' }], next_cursor: '1.1' }),
        );
      }
      if (url.includes('/artifacts/conflict')) return Promise.resolve(jsonResponse(delDetail));
      return Promise.resolve(jsonResponse({}));
    });
    const { result } = renderHook(() => useConflicts('s-1', { pollMs: 100000 }));
    await waitFor(() => expect(result.current.conflicts).toHaveLength(1));
    await act(async () => {
      await result.current.resolve('art-1', { kind: 'left' });
    });
    const post = fetchMock.mock.calls.find(
      (c) => typeof c[0] === 'string' && c[0].includes('/resolve'),
    );
    expect((post![1] as RequestInit).headers).toMatchObject({ 'x-artifact-delete': 'true' });
  });
});
