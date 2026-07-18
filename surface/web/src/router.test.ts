// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { filePathRefFromPath, initialInAppRoute, navigate, parseInAppRoute, routePath, useLocation } from './router';

function LocationProbe() {
  const location = useLocation();
  return createElement('div', { 'data-testid': 'location' }, `${location.pathname}${location.search}${location.hash}`);
}

describe('router', () => {
  beforeEach(() => {
    window.history.replaceState(null, '', '/');
  });

  afterEach(() => {
    cleanup();
  });

  it('parses the in-app URL grammar', () => {
    expect(parseInAppRoute('/')).toEqual({
      surface: 'chat',
      channelId: null,
      sessionId: null,
      threadRootId: null,
      membersOpen: false,
      settingsSection: null,
      focusSession: false,
    });
    expect(parseInAppRoute('/c/ch_1')).toMatchObject({ surface: 'chat', channelId: 'ch_1', sessionId: null });
    expect(parseInAppRoute('/c/ch_1/s/sess_1')).toMatchObject({
      surface: 'chat',
      channelId: 'ch_1',
      sessionId: 'sess_1',
      focusSession: false,
    });
    expect(parseInAppRoute('/s/sess_1')).toMatchObject({
      surface: 'chat',
      channelId: null,
      sessionId: 'sess_1',
      focusSession: false,
    });
    expect(parseInAppRoute('/files')).toMatchObject({ surface: 'files' });
    expect(parseInAppRoute('/activity')).toMatchObject({ surface: 'activity' });
    expect(parseInAppRoute('/agents')).toBeNull();
    expect(parseInAppRoute('/settings')).toMatchObject({ surface: 'settings', settingsSection: null });
    expect(parseInAppRoute('/settings/connections')).toMatchObject({
      surface: 'settings',
      settingsSection: 'connections',
    });
    expect(parseInAppRoute('/c/ch_1/t/evt_9')).toMatchObject({
      surface: 'chat',
      channelId: 'ch_1',
      threadRootId: 'evt_9',
      sessionId: null,
    });
    expect(parseInAppRoute('/c/ch_1/members')).toMatchObject({
      surface: 'chat',
      channelId: 'ch_1',
      membersOpen: true,
    });
    expect(parseInAppRoute('/s/sess_1/pane')).toBeNull();
    expect(parseInAppRoute('/settings/a/b')).toBeNull();
    expect(parseInAppRoute('/c/ch_1/t/')).toBeNull();
  });

  it('builds canonical in-app paths', () => {
    expect(routePath({ surface: 'chat', channelId: null, sessionId: null, focusSession: false })).toBe('/');
    expect(routePath({ surface: 'chat', channelId: 'ch 1', sessionId: null, focusSession: false })).toBe('/c/ch%201');
    expect(routePath({ surface: 'chat', channelId: 'ch_1', sessionId: 'sess_1', focusSession: false })).toBe(
      '/c/ch_1/s/sess_1',
    );
    expect(
      routePath({
        surface: 'chat',
        channelId: 'ch_1',
        sessionId: null,
        panelSessionId: 'sess_1',
        focusSession: false,
      }),
    ).toBe('/c/ch_1');
    expect(routePath({ surface: 'files', channelId: null, sessionId: null, focusSession: false })).toBe('/files');
    expect(routePath({ surface: 'activity', channelId: null, sessionId: null, focusSession: false })).toBe('/activity');
    expect(routePath({ surface: 'settings', channelId: null, sessionId: null, focusSession: false })).toBe('/settings');
    expect(
      routePath({
        surface: 'settings',
        channelId: null,
        sessionId: null,
        settingsSection: 'connections',
        focusSession: false,
      }),
    ).toBe('/settings/connections');
    expect(
      routePath({ surface: 'chat', channelId: 'ch_1', sessionId: null, threadRootId: 'evt_9', focusSession: false }),
    ).toBe('/c/ch_1/t/evt_9');
    expect(
      routePath({ surface: 'chat', channelId: 'ch_1', sessionId: null, membersOpen: true, focusSession: false }),
    ).toBe('/c/ch_1/members');
    // A session pane takes precedence over thread/members segments.
    expect(
      routePath({
        surface: 'chat',
        channelId: 'ch_1',
        sessionId: 'sess_1',
        threadRootId: 'evt_9',
        focusSession: false,
      }),
    ).toBe('/c/ch_1/s/sess_1');
  });

  it('recognizes canonical file links and raw self-describing sandbox paths', () => {
    const channelId = '121a247c-e270-4783-a9d4-cb80ec984188';
    expect(filePathRefFromPath(`/f/shared/channels/${channelId}/notes%20v2.md`)).toEqual(
      expect.objectContaining({ kind: 'shared-channel', relPath: 'notes v2.md' }),
    );
    expect(filePathRefFromPath(`/home/agent/shared/channels/${channelId}/notes.md`)).toEqual(
      expect.objectContaining({ kind: 'shared-channel' }),
    );
    expect(filePathRefFromPath('/home/agent/notes.md')).toBeNull();
    expect(initialInAppRoute(`/f/shared/channels/${channelId}/notes.md`)).toMatchObject({ surface: 'files' });
  });

  it('notifies useLocation for navigate and popstate changes', async () => {
    render(createElement(LocationProbe));
    expect(screen.getByTestId('location').textContent).toBe('/');

    navigate('/c/ch_1?s=1#top');
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/c/ch_1?s=1#top'));

    navigate('/files');
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/files'));

    window.history.back();
    window.dispatchEvent(new PopStateEvent('popstate'));
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/c/ch_1?s=1#top'));
  });
});
