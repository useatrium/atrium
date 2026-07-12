// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DEFAULT_PREFS, type UserPrefs } from '@atrium/surface-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsSurface } from './SettingsSurface';

const mockTheme = vi.hoisted(() => ({
  prefs: null as UserPrefs | null,
  setPrefs: vi.fn(),
}));

vi.mock('../theme', () => ({
  useTheme: () => ({
    prefs: mockTheme.prefs,
    resolvedScheme: 'dark',
    setPrefs: mockTheme.setPrefs,
  }),
}));

vi.mock('../notify', () => ({
  notificationState: vi.fn(() => 'off'),
  toggleNotifications: vi.fn(async () => 'on'),
}));

function renderSettings() {
  render(<SettingsSurface connectionsAvailable claudeStatus={undefined} codexStatus={undefined} />);
}

function activeSectionLabel() {
  return screen.getByRole('button', { current: 'page' }).textContent;
}

beforeEach(() => {
  window.history.replaceState(null, '', '/settings');
  mockTheme.prefs = { ...DEFAULT_PREFS, notifications: { ...DEFAULT_PREFS.notifications } };
  mockTheme.setPrefs.mockClear();
});

afterEach(cleanup);

describe('SettingsSurface sections', () => {
  it('restores the section from /settings/:section on render', () => {
    window.history.replaceState(null, '', '/settings/agents');

    renderSettings();

    expect(activeSectionLabel()).toBe('Agents');
  });

  it('falls back to the default section for unknown slugs', () => {
    window.history.replaceState(null, '', '/settings/not-real');

    renderSettings();

    expect(activeSectionLabel()).toBe('Appearance');
  });

  it('pushes section URLs from the settings navigation', async () => {
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Connections' }));

    await waitFor(() => expect(window.location.pathname).toBe('/settings/connections'));
    expect(activeSectionLabel()).toBe('Connections');
  });

  it('updates the active section on back navigation', async () => {
    renderSettings();

    fireEvent.click(screen.getByRole('button', { name: 'Connections' }));
    await waitFor(() => expect(window.location.pathname).toBe('/settings/connections'));
    fireEvent.click(screen.getByRole('button', { name: 'Agents' }));
    await waitFor(() => expect(window.location.pathname).toBe('/settings/agents'));

    window.history.back();
    window.dispatchEvent(new PopStateEvent('popstate'));

    await waitFor(() => expect(activeSectionLabel()).toBe('Connections'));
  });
});
