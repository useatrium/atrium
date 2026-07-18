// Persisted Agent Dock preferences: whether the dock is open and whether it is
// immersed survive reloads per browser, like the sidebar width and the
// channel│agent split opt-in. The dock's *width* uses the shared PaneSizeConfig
// machinery (useSessionPaneWidth) and its own storage key, configured where the
// resize handle lives.

import { useCallback, useState } from 'react';
import { AGENT_DOCK_IMMERSED_STORAGE_KEY, AGENT_DOCK_OPEN_STORAGE_KEY } from '../storageKeys';

function readBoolean(key: string): boolean {
  return typeof window !== 'undefined' && window.localStorage.getItem(key) === 'true';
}

function usePersistedBoolean(key: string): [boolean, (next: boolean | ((current: boolean) => boolean)) => void] {
  const [value, setValue] = useState(() => readBoolean(key));
  const set = useCallback(
    (next: boolean | ((current: boolean) => boolean)) => {
      setValue((current) => {
        const resolved = typeof next === 'function' ? next(current) : next;
        if (typeof window !== 'undefined') window.localStorage.setItem(key, String(resolved));
        return resolved;
      });
    },
    [key],
  );
  return [value, set];
}

export function useAgentDockOpen() {
  return usePersistedBoolean(AGENT_DOCK_OPEN_STORAGE_KEY);
}

export function useAgentDockImmersed() {
  return usePersistedBoolean(AGENT_DOCK_IMMERSED_STORAGE_KEY);
}
