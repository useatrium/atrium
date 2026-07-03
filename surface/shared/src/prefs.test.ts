import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, normalizePrefs, normalizeNotificationPrefs } from './prefs';

describe('normalizeNotificationPrefs', () => {
  it('defaults missing notification prefs', () => {
    expect(normalizeNotificationPrefs(undefined)).toEqual(DEFAULT_PREFS.notifications);
    expect(normalizePrefs({}).notifications).toEqual(DEFAULT_PREFS.notifications);
  });

  it('keeps valid notification prefs', () => {
    expect(
      normalizePrefs({
        notifications: {
          messages: 'all',
          sessions: false,
          calls: false,
        },
      }).notifications,
    ).toEqual({
      messages: 'all',
      sessions: false,
      calls: false,
    });
  });

  it('normalizes invalid notification values to defaults', () => {
    expect(
      normalizePrefs({
        notifications: {
          messages: 'mentions',
          sessions: 'yes',
          calls: null,
        },
      }).notifications,
    ).toEqual(DEFAULT_PREFS.notifications);
  });
});
