// Drag-resizable split-view session pane width, persisted per browser.
// No stored preference → the adaptive default class (`min(520px,42vw)`, the
// pre-resize behavior, so narrow windows keep a proportional pane). Once the
// user drags, the stored px width applies, clamped live against the viewport
// so a size saved on a wide monitor can't swallow a narrow window.

import { useCallback, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';

const STORAGE_KEY = 'atrium.sessionPaneWidth';
const MIN_WIDTH = 320;
const MAX_VW = 70;
/** Drag-start fallback when the pane can't be measured (jsdom). */
const FALLBACK_WIDTH = 520;

function widthCss(width: number): string {
  return `min(${width}px, ${MAX_VW}vw)`;
}

/**
 * The pane's width sizing (class for the adaptive default, inline style for a
 * dragged width). Single source shared by SessionPane and Chat's loading
 * placeholder — if they computed this independently and drifted, the pane
 * would jump when it replaces the placeholder.
 */
export function sessionPaneSizing(width: number | null): {
  className: string;
  style: CSSProperties | undefined;
} {
  return width === null
    ? { className: 'w-[min(520px,42vw)]', style: undefined }
    : { className: '', style: { width: widthCss(width) } };
}

function maxWidth(): number {
  if (typeof window === 'undefined') return FALLBACK_WIDTH;
  return Math.max(MIN_WIDTH, Math.round((window.innerWidth * MAX_VW) / 100));
}

function clamp(width: number): number {
  return Math.min(Math.max(Math.round(width), MIN_WIDTH), maxWidth());
}

/** The stored width, or null when the user has never resized. */
export function loadSessionPaneWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed = raw === null ? NaN : Number(raw);
    return Number.isFinite(parsed) ? clamp(parsed) : null;
  } catch {
    return null;
  }
}

function save(width: number | null): void {
  try {
    if (width === null) window.localStorage.removeItem(STORAGE_KEY);
    else window.localStorage.setItem(STORAGE_KEY, String(width));
  } catch {
    /* storage unavailable (private mode) — width stays session-local */
  }
}

export function useSessionPaneWidth(): {
  /** Dragged width in px, or null for the adaptive default. */
  width: number | null;
  resizing: boolean;
  startResize: (e: ReactPointerEvent<HTMLElement>) => void;
  resetWidth: () => void;
} {
  const [width, setWidth] = useState<number | null>(loadSessionPaneWidth);
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ startX: number; startWidth: number } | null>(null);

  const startResize = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const handle = e.currentTarget;
      // The aside hosting the handle. Width is written to it imperatively
      // during the drag — a ~60Hz pointermove driving React state would
      // re-render the whole transcript per frame; state commits once on up.
      const aside = handle.parentElement;
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        /* jsdom / older browsers: drag still works while the pointer stays on the handle */
      }
      const measured = aside?.getBoundingClientRect().width ?? 0;
      drag.current = { startX: e.clientX, startWidth: measured > 0 ? measured : (width ?? FALLBACK_WIDTH) };
      setResizing(true);

      const widthAt = (ev: globalThis.PointerEvent) =>
        drag.current ? clamp(drag.current.startWidth + (drag.current.startX - ev.clientX)) : null;
      const onMove = (ev: globalThis.PointerEvent) => {
        const w = widthAt(ev);
        if (w !== null && aside) aside.style.width = widthCss(w);
      };
      const onUp = (ev: globalThis.PointerEvent) => {
        const final = widthAt(ev);
        if (final === null) return;
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
    setWidth(null);
    save(null);
  }, []);

  return { width, resizing, startResize, resetWidth };
}
