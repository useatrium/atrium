// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FilesSurface } from '../src/sessions/FilesSurface';

function jsonResponse(body: unknown, ok = true) {
  return { ok, json: async () => body } as Response;
}

function textResponse(body: string, ok = true, headers: Record<string, string> = {}) {
  return { ok, headers: new Headers(headers), text: async () => body } as Response;
}

const rootRows = [
  { path: 'repo/src', backing: 'git', type: 'dir' },
  { path: 'repo/README.md', backing: 'git', type: 'file' },
  { path: 'proj-x/plan.md', backing: 'ledger', type: 'file' },
];

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (init?.method === 'PUT') return Promise.resolve(jsonResponse({ backing: 'ledger', seq: 3 }));
    if (url.includes('/files/content')) return Promise.resolve(textResponse('initial contents'));
    if (url.includes('/files/history')) {
      return Promise.resolve(jsonResponse({ backing: 'git', entries: [{ sha: 'abc12345', author: 'a', date: 'today', subject: 'init' }] }));
    }
    if (url.includes('/files?dir=repo%2Fsrc')) {
      return Promise.resolve(jsonResponse({ rows: [{ path: 'repo/src/a.ts', backing: 'git', type: 'file' }] }));
    }
    if (url.includes('/files?dir=')) return Promise.resolve(jsonResponse({ rows: rootRows }));
    return Promise.resolve(jsonResponse({}));
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('FilesSurface', () => {
  it('lists rows with backing badges', async () => {
    render(<FilesSurface sessionId="s-1" onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy());
    expect(screen.getByText('src')).toBeTruthy();
    expect(screen.getByText('plan.md')).toBeTruthy();
    expect(screen.getAllByText('git').length).toBeGreaterThan(0);
    expect(screen.getByText('ledger')).toBeTruthy();
  });

  it('clicking a file fetches and shows its content', async () => {
    render(<FilesSurface sessionId="s-1" onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText('plan.md')).toBeTruthy());
    fireEvent.click(screen.getByText('plan.md'));

    await waitFor(() => expect(screen.getByText('initial contents')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s-1/files/content?path=proj-x%2Fplan.md', {
      credentials: 'same-origin',
    });
  });

  it('renders git-backed files read-only', async () => {
    render(<FilesSurface sessionId="s-1" onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText('README.md')).toBeTruthy());
    fireEvent.click(screen.getByText('README.md'));

    await waitFor(() => expect(screen.getByText('initial contents')).toBeTruthy());
    expect(screen.getByText('read-only (repo)')).toBeTruthy();
    expect(screen.queryByText('Edit')).toBeNull();
    expect(screen.queryByText('Save')).toBeNull();
    expect(screen.queryByLabelText('File contents')).toBeNull();
  });

  it('renders a version skew badge for a ledger file with a newer conflict seq', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'PUT') return Promise.resolve(jsonResponse({ backing: 'ledger', seq: 3 }));
      if (url.includes('/files/content')) {
        return Promise.resolve(
          textResponse('initial contents', true, {
            'X-Artifact-Seq': '5',
            'X-Artifact-Conflicted': 'true',
            'X-Artifact-Conflict-Seq': '7',
          }),
        );
      }
      if (url.includes('/files?dir=')) return Promise.resolve(jsonResponse({ rows: rootRows }));
      return Promise.resolve(jsonResponse({}));
    });

    render(<FilesSurface sessionId="s-1" onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText('plan.md')).toBeTruthy());
    fireEvent.click(screen.getByText('plan.md'));

    await waitFor(() => expect(screen.getByText('newer: v7')).toBeTruthy());
  });

  it('does not render a version skew badge when ledger seqs are equal', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'PUT') return Promise.resolve(jsonResponse({ backing: 'ledger', seq: 3 }));
      if (url.includes('/files/content')) {
        return Promise.resolve(
          textResponse('initial contents', true, {
            'X-Artifact-Seq': '5',
            'X-Artifact-Conflicted': 'true',
            'X-Artifact-Conflict-Seq': '5',
          }),
        );
      }
      if (url.includes('/files?dir=')) return Promise.resolve(jsonResponse({ rows: rootRows }));
      return Promise.resolve(jsonResponse({}));
    });

    render(<FilesSurface sessionId="s-1" onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText('plan.md')).toBeTruthy());
    fireEvent.click(screen.getByText('plan.md'));

    await waitFor(() => expect(screen.getByText('initial contents')).toBeTruthy());
    expect(screen.queryByText(/^newer:/)).toBeNull();
  });

  it('navigating into a dir refetches with the new dir', async () => {
    render(<FilesSurface sessionId="s-1" onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText('src')).toBeTruthy());
    fireEvent.click(screen.getByText('src'));

    await waitFor(() => expect(screen.getByText('a.ts')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/sessions/s-1/files?dir=repo%2Fsrc',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
  });

  it('editing and saving PUTs the new text', async () => {
    render(<FilesSurface sessionId="s-1" onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText('plan.md')).toBeTruthy());
    fireEvent.click(screen.getByText('plan.md'));
    await waitFor(() => expect(screen.getByText('initial contents')).toBeTruthy());

    expect(screen.getByText('Edit')).toBeTruthy();
    fireEvent.click(screen.getByText('Edit'));
    const editor = screen.getByLabelText('File contents');
    fireEvent.change(editor, { target: { value: 'updated contents' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'PUT');
      expect(put).toBeTruthy();
      expect(put![0]).toBe('/api/sessions/s-1/files?path=proj-x%2Fplan.md');
      expect(put![1]).toMatchObject({
        method: 'PUT',
        credentials: 'same-origin',
        body: 'updated contents',
      });
    });
  });

  it('surfaces a save error without throwing', async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === 'PUT') return Promise.resolve(textResponse('stale base', false));
      if (url.includes('/files/content')) return Promise.resolve(textResponse('initial contents'));
      if (url.includes('/files?dir=')) return Promise.resolve(jsonResponse({ rows: rootRows }));
      return Promise.resolve(jsonResponse({}));
    });

    render(<FilesSurface sessionId="s-1" onClose={() => {}} />);

    await waitFor(() => expect(screen.getByText('plan.md')).toBeTruthy());
    fireEvent.click(screen.getByText('plan.md'));
    await waitFor(() => expect(screen.getByText('initial contents')).toBeTruthy());

    fireEvent.click(screen.getByText('Edit'));
    fireEvent.change(screen.getByLabelText('File contents'), { target: { value: 'conflicting edit' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(screen.getByText('stale base')).toBeTruthy());
  });
});
