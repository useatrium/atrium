// Drag-resizable split-view session pane width, persisted per browser.
// The pane sits on the right edge, so dragging the left-edge handle left
// widens it. Width is clamped live against the viewport (70%) so a size saved
// on a wide monitor can't swallow a narrow window.

import { useCallback, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

const STORAGE_KEY = 'atrium.sessionPaneWidth';
export const SESSION_PANE_DEFAULT_WIDTH = 520;
const MIN_WIDTH = 360;

function maxWidth(): number {
  if (typeof window === 'undefined') return SESSION_PANE_DEFAULT_WIDTH;
  return Math.max(MIN_WIDTH, Math.round(window.innerWidth * 0.7));
}

function clamp(width: number): number {
  return Math.min(Math.max(Math.round(width), MIN_WIDTH), maxWidth());
}

export function loadSessionPaneWidth(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw === null ? NaN : Number(raw);
    return Number.isFinite(parsed) ? clamp(parsed) : SESSION_PANE_DEFAULT_WIDTH;
  } catch {
    return SESSION_PANE_DEFAULT_WIDTH;
  }
}

function save(width: number): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(width));
  } catch {
    /* storage unavailable (private mode) — width stays session-local */
  }
}

export function useSessionPaneWidth(): {
  width: number;
  resizing: boolean;
  startResize: (e: ReactPointerEvent<HTMLElement>) => void;
  resetWidth: () => void;
} {
  const [width, setWidth] = useState(loadSessionPaneWidth);
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  const startResize = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const handle = e.currentTarget;
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        /* jsdom / older browsers: drag still works while the pointer stays on the handle */
      }
      drag.current = { startX: e.clientX, startWidth: width };
      setResizing(true);

      const onMove = (ev: globalThis.PointerEvent) => {
        if (!drag.current) return;
        setWidth(clamp(drag.current.startWidth + (drag.current.startX - ev.clientX)));
      };
      const onUp = (ev: globalThis.PointerEvent) => {
        if (!drag.current) return;
        const final = clamp(drag.current.startWidth + (drag.current.startX - ev.clientX));
        drag.current = null;
        setResizing(false);
        setWidth(final);
        save(final);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    },
    [width],
  );

  const resetWidth = useCallback(() => {
    setWidth(SESSION_PANE_DEFAULT_WIDTH);
    save(SESSION_PANE_DEFAULT_WIDTH);
  }, []);

  return { width, resizing, startResize, resetWidth };
}
