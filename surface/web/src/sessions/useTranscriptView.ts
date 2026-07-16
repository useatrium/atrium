import { useCallback, useState } from 'react';
import { TRANSCRIPT_VIEW_STORAGE_KEY } from '../storageKeys';

export { TRANSCRIPT_VIEW_STORAGE_KEY };

/**
 * The old transcript Focus/Full preference now controls fold disclosure.
 * Keeping both the key and its stored values migrates existing users without a
 * one-off storage rewrite: `full` means expand every fold, `focus` means each
 * completed fold starts collapsed.
 */
export function loadExpandAllWork(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(TRANSCRIPT_VIEW_STORAGE_KEY) === 'full';
  } catch {
    return false;
  }
}

function saveExpandAllWork(expandAll: boolean): void {
  try {
    window.localStorage.setItem(TRANSCRIPT_VIEW_STORAGE_KEY, expandAll ? 'full' : 'focus');
  } catch {
    /* storage unavailable — the preference remains active for this pane */
  }
}

export function useExpandAllWork(): [boolean, (expandAll: boolean) => void] {
  const [expandAll, setExpandAllState] = useState(loadExpandAllWork);
  const setExpandAll = useCallback((next: boolean) => {
    setExpandAllState(next);
    saveExpandAllWork(next);
  }, []);
  return [expandAll, setExpandAll];
}
