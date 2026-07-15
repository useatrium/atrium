// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Artifact, ArtifactPresentation } from '@atrium/centaur-client';
import { AppsSurface } from '../src/sessions/AppsSurface';
import { sessionsApi, type AppListRow } from '../src/sessions/api';

function art(over: Partial<Artifact>): Artifact {
  return {
    id: 'a1',
    path: 'shared/apps/demo/index.html',
    kind: 'created',
    mime: 'text/html',
    size: 2048,
    sha256: 'x',
    ref: 'b1',
    executionId: null,
    sourceEventIds: [3],
    ...over,
  };
}

function app(over: Partial<AppListRow>): AppListRow {
  return {
    id: 'app-1',
    workspaceId: 'w-1',
    channelId: null,
    name: 'demo',
    scope: 'workspace',
    status: 'published',
    currentVersion: 2,
    entryPath: 'shared/apps/demo/index.html',
    updatedAt: '2026-06-25T12:00:00Z',
    ...over,
  };
}

function presentation(over: Partial<ArtifactPresentation>): ArtifactPresentation {
  return {
    id: 'artifact-presented:shared/apps/demo/index.html',
    path: 'shared/apps/demo/index.html',
    title: 'Pipeline Dashboard',
    renderer: 'html-app',
    description: 'Live business view',
    executionId: 'exe-1',
    sourceEventIds: [9],
    ...over,
  };
}

describe('AppsSurface', () => {
  beforeEach(() => {
    vi.spyOn(sessionsApi, 'listApps').mockResolvedValue({ apps: [] });
    vi.spyOn(sessionsApi, 'publishApp').mockResolvedValue({
      appId: 'app-1',
      version: 1,
      files: 1,
      entry: 'index.html',
      actions: 0,
    });
    vi.spyOn(sessionsApi, 'launchApp').mockResolvedValue({
      url: 'https://apps.example/demo',
      expires: 1_782_391_600,
      version: 2,
      actions: [],
    });
    vi.spyOn(window, 'open').mockImplementation(() => null);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('detects app roots from captured shared/apps artifacts', async () => {
    render(
      <AppsSurface
        sessionId="s-1"
        artifacts={[
          art({ path: '/home/agent/workspace/shared/apps/demo/atrium.app.json', mime: 'application/json' }),
          art({ path: 'shared/apps/demo/index.html' }),
        ]}
        embedded
      />,
    );

    await waitFor(() => expect(screen.getByText('Detected app directories')).toBeTruthy());
    expect(screen.getByText('demo')).toBeTruthy();
    expect(screen.getByText('shared/apps/demo/')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeTruthy();
  });

  it('publishes a detected root with workspace scope', async () => {
    render(<AppsSurface sessionId="s-1" artifacts={[art({ path: 'shared/apps/demo/index.html' })]} embedded />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Publish' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));

    await waitFor(() =>
      expect(sessionsApi.publishApp).toHaveBeenCalledWith(
        's-1',
        expect.objectContaining({ name: 'demo', scope: 'workspace', entry: 'index.html' }),
      ),
    );
  });

  it('renders and previews generated apps from presentations without live artifact rows', async () => {
    render(<AppsSurface sessionId="s-1" artifacts={[]} presentations={[presentation({})]} embedded />);

    await waitFor(() => expect(screen.getByText('Generated apps')).toBeTruthy());
    expect(screen.getByText('Pipeline Dashboard')).toBeTruthy();
    expect(screen.getByText('shared/apps/demo/index.html')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    const frame = await screen.findByTitle('Artifact preview: index.html');
    expect(frame.getAttribute('src')).toBe(
      '/api/sessions/s-1/artifacts/preview?path=shared%2Fapps%2Fdemo%2Findex.html&renderer=html-app',
    );
  });

  it('publishes a presentation-backed generated app root', async () => {
    render(<AppsSurface sessionId="s-1" artifacts={[]} presentations={[presentation({})]} embedded />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Publish' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));

    await waitFor(() =>
      expect(sessionsApi.publishApp).toHaveBeenCalledWith(
        's-1',
        expect.objectContaining({ name: 'demo', scope: 'workspace', entry: 'index.html' }),
      ),
    );
  });

  it('launches a published app in a new tab', async () => {
    vi.mocked(sessionsApi.listApps).mockResolvedValue({ apps: [app({ id: 'app-9', name: 'demo' })] });

    render(<AppsSurface sessionId="s-1" artifacts={[art({ path: 'shared/apps/demo/index.html' })]} embedded />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Launch' })).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));

    await waitFor(() => expect(sessionsApi.launchApp).toHaveBeenCalledWith('app-9'));
    expect(window.open).toHaveBeenCalledWith('https://apps.example/demo', '_blank', 'noopener,noreferrer');
  });

  it('keeps preview available after a generated app is published', async () => {
    vi.mocked(sessionsApi.listApps).mockResolvedValue({ apps: [app({ id: 'app-9', name: 'demo' })] });

    render(<AppsSurface sessionId="s-1" artifacts={[]} presentations={[presentation({})]} embedded />);

    await waitFor(() => expect(screen.getByText('Published apps')).toBeTruthy());
    expect(screen.queryByText('Generated apps')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    const frame = await screen.findByTitle('Artifact preview: index.html');
    expect(frame.getAttribute('src')).toBe(
      '/api/sessions/s-1/artifacts/preview?path=shared%2Fapps%2Fdemo%2Findex.html&renderer=html-app',
    );
  });

  it('uses custom presentation preview path when provided', async () => {
    render(
      <AppsSurface
        sessionId="s-1"
        artifacts={[]}
        presentations={[presentation({ previewUrl: 'preview.html?preview=1' })]}
        embedded
      />,
    );

    await waitFor(() => expect(screen.getByText('Generated apps')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));

    const frame = await screen.findByTitle('Artifact preview: index.html');
    expect(frame.getAttribute('src')).toBe(
      '/api/sessions/s-1/artifacts/preview?path=shared%2Fapps%2Fdemo%2Fpreview.html&renderer=html-app&preview=1',
    );
  });

  it('shows an empty state when nothing is detected or published', async () => {
    render(<AppsSurface sessionId="s-1" artifacts={[]} embedded />);

    await waitFor(() => expect(screen.getByText('No published apps')).toBeTruthy());
    expect(screen.getByText('Agent-built apps under shared/apps will appear here.')).toBeTruthy();
  });
});
