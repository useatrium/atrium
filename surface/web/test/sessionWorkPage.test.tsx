// @vitest-environment jsdom
// Detach rung (Phase 4): /s/:id/work/:slug route parsing + the standalone
// single-surface page that folds the same live session stream.

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CentaurEventFrame } from '@atrium/centaur-client';
import { workRouteFromPath } from '../src/App';
import { SessionWorkPage } from '../src/sessions/SessionWorkPage';
import { sessionsApi } from '../src/sessions/api';
import { FakeEventSource, installFakeEventSource } from './helpers/fakeEventSource';

describe('workRouteFromPath', () => {
  it('parses the work-surface slugs', () => {
    expect(workRouteFromPath('/s/abc/work/changes')).toEqual({ sessionId: 'abc', tab: 'changes' });
    expect(workRouteFromPath('/s/abc/work/side-effects')).toEqual({ sessionId: 'abc', tab: 'sideEffects' });
    expect(workRouteFromPath('/s/abc/work/artifacts')).toEqual({ sessionId: 'abc', tab: 'changes' });
    expect(workRouteFromPath('/s/abc/work/apps')).toEqual({ sessionId: 'abc', tab: 'apps' });
  });

  it('returns null for an unknown slug, the bare permalink, or an over-long path', () => {
    expect(workRouteFromPath('/s/abc/work/bogus')).toBeNull();
    expect(workRouteFromPath('/s/abc')).toBeNull();
    expect(workRouteFromPath('/s/abc/work/changes/extra')).toBeNull();
    expect(workRouteFromPath('/')).toBeNull();
  });
});

describe('SessionWorkPage', () => {
  beforeEach(() => {
    FakeEventSource.reset();
    installFakeEventSource();
    vi.spyOn(sessionsApi, 'listPresentations').mockResolvedValue({ presentations: [] });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function renderPage(tab: 'changes' | 'artifacts', frames: CentaurEventFrame[]) {
    render(<SessionWorkPage sessionId="s-x" tab={tab} />);
    const es = FakeEventSource.last();
    expect(es.url).toBe('/api/sessions/s-x/stream?after_event_id=0');
    await act(async () => {
      es.open();
      es.emitAll(frames);
      await new Promise((r) => setTimeout(r, 60));
    });
  }

  it('renders the What changed surface full-page from the live stream (codex edit)', async () => {
    await renderPage('changes', [
      { event: 'execution_state', event_id: 1, data: { type: 'execution.state', status: 'running', execution_id: 'exe_c' } },
      {
        event: 'amp_raw_event',
        event_id: 2,
        data: {
          type: 'item.completed',
          item: { id: 'cfc1', type: 'fileChange', changes: [{ path: '/home/agent/workspace/src/config.ts', kind: 'update', diff: '@@\n-x\n+y' }] },
        },
      },
    ] as unknown as CentaurEventFrame[]);

    const page = screen.getByTestId('session-work-page');
    // Header: title + count + a link back to the full session.
    expect(within(page).getByText('What changed')).toBeTruthy();
    expect(within(page).getByRole('link', { name: /full session/i }).getAttribute('href')).toBe('/s/s-x');
    // Body: the edited file from the codex fileChange.
    expect(within(page).getByText('Edited in repo')).toBeTruthy();
    expect(within(page).getByText('src/config.ts')).toBeTruthy();
  });

  it('renders artifacts inside the What changed surface, serving bytes via the session route', async () => {
    await renderPage('artifacts', [
      { event: 'execution_state', event_id: 1, data: { type: 'execution.state', status: 'running', execution_id: 'exe_a' } },
      {
        event: 'artifact.captured',
        event_id: 2,
        data: {
          type: 'artifact.captured',
          artifact_id: 'art-1',
          path: '/tmp/chart.png',
          kind: 'created',
          mime: 'image/png',
          size_bytes: 4821,
          sha256: 'art-1',
          ref: 'blob-1',
        },
      },
    ] as unknown as CentaurEventFrame[]);

    const page = screen.getByTestId('session-work-page');
    expect(within(page).getByText('What changed')).toBeTruthy();
    expect(within(page).getByText('Created artifacts')).toBeTruthy();
    const img = within(page).getByRole('img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe('/api/sessions/s-x/artifacts/by-path?path=%2Ftmp%2Fchart.png');
  });

  it('hydrates artifact presentations and promotes the presented app tile', async () => {
    vi.mocked(sessionsApi.listPresentations).mockResolvedValue({
      presentations: [
        {
          id: 'artifact-presented:shared/apps/demo/index.html',
          path: 'shared/apps/demo/index.html',
          title: 'Pipeline Dashboard',
          renderer: 'html-app',
          description: 'Live business view',
          executionId: 'exe_a',
          sourceEventIds: [9],
        },
      ],
    });

    await renderPage('changes', [
      { event: 'execution_state', event_id: 1, data: { type: 'execution.state', status: 'running', execution_id: 'exe_a' } },
      {
        event: 'artifact.captured',
        event_id: 2,
        data: {
          type: 'artifact.captured',
          artifact_id: 'app-1',
          path: 'shared/apps/demo/index.html',
          kind: 'created',
          mime: 'text/html',
          size_bytes: 4821,
          sha256: 'app-1',
          ref: 'blob-1',
        },
      },
    ] as unknown as CentaurEventFrame[]);

    const page = screen.getByTestId('session-work-page');
    await waitFor(() => expect(within(page).getByText('Presented apps')).toBeTruthy());
    expect(within(page).getByText('Pipeline Dashboard')).toBeTruthy();
    expect(within(page).getByText('Presented app · Live business view')).toBeTruthy();
  });
});
