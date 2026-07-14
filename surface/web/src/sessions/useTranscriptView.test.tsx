// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { loadExpandAllWork, TRANSCRIPT_VIEW_STORAGE_KEY, useExpandAllWork } from './useTranscriptView';

afterEach(() => window.localStorage.clear());

describe('expand-all work preference migration', () => {
  it('maps the old full/focus values onto expanded/collapsed folds', () => {
    window.localStorage.setItem(TRANSCRIPT_VIEW_STORAGE_KEY, 'full');
    expect(loadExpandAllWork()).toBe(true);

    window.localStorage.setItem(TRANSCRIPT_VIEW_STORAGE_KEY, 'focus');
    expect(loadExpandAllWork()).toBe(false);
  });

  it('persists the toggle using the existing storage key and values', () => {
    const { result } = renderHook(() => useExpandAllWork());
    expect(result.current[0]).toBe(false);

    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
    expect(window.localStorage.getItem(TRANSCRIPT_VIEW_STORAGE_KEY)).toBe('full');

    act(() => result.current[1](false));
    expect(window.localStorage.getItem(TRANSCRIPT_VIEW_STORAGE_KEY)).toBe('focus');
  });
});
