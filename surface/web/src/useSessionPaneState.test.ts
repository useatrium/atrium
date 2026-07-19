import { describe, expect, it } from 'vitest';
import { channelMainVisible } from './useSessionPaneState';

describe('channelMainVisible', () => {
  it('shows the channel for channel and split views', () => {
    expect(channelMainVisible('channel', false)).toBe(true);
    expect(channelMainVisible('split', false)).toBe(true);
  });

  it('hides the channel while an agent owns MAIN in focus view', () => {
    expect(channelMainVisible('focus', false)).toBe(false);
  });

  it('shows the channel on a thread route even while the attached session stays selected', () => {
    // Regression: opening the origin thread from a focused agent kept
    // `openSessionId` set (by design), which held the view in 'focus' and
    // unmounted the channel — the thread panel floated beside a blank MAIN.
    expect(channelMainVisible('focus', true)).toBe(true);
  });
});
