import { useCallback, useState } from 'react';

export type TranscriptView = 'focus' | 'full';

export const TRANSCRIPT_VIEW_STORAGE_KEY = 'atrium:transcript-view';

export function loadTranscriptView(): TranscriptView {
  if (typeof window === 'undefined') return 'focus';
  try {
    return window.localStorage.getItem(TRANSCRIPT_VIEW_STORAGE_KEY) === 'full' ? 'full' : 'focus';
  } catch {
    return 'focus';
  }
}

function saveTranscriptView(view: TranscriptView): void {
  try {
    window.localStorage.setItem(TRANSCRIPT_VIEW_STORAGE_KEY, view);
  } catch {
    /* storage unavailable — the preference remains active for this pane */
  }
}

export function useTranscriptView(): [TranscriptView, (view: TranscriptView) => void] {
  const [view, setViewState] = useState<TranscriptView>(loadTranscriptView);
  const setView = useCallback((next: TranscriptView) => {
    setViewState(next);
    saveTranscriptView(next);
  }, []);
  return [view, setView];
}
