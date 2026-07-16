// Drag-resizable split-view session pane width, persisted per browser.
// No stored preference → the adaptive default class (`min(520px,42vw)`, the
// pre-resize behavior, so narrow windows keep a proportional pane). Once the
// user drags, the stored px width applies, clamped live against the viewport
// so a size saved on a wide monitor can't swallow a narrow window.

import { useCallback, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';
import {
  LEGACY_SESSION_PANE_WIDTH_STORAGE_KEY,
  LEGACY_SIDEBAR_WIDTH_STORAGE_KEY,
  LEGACY_THREAD_PANE_WIDTH_STORAGE_KEY,
  readWithLegacy,
  SESSION_PANE_WIDTH_STORAGE_KEY,
  SIDEBAR_WIDTH_STORAGE_KEY,
  THREAD_PANE_WIDTH_STORAGE_KEY,
} from '../storageKeys';
export const SESSION_PANE_MIN_WIDTH = 320;
export const SESSION_PANE_MAX_VW = 70;
/** Drag-start fallback when the pane can't be measured (jsdom). */
export const SESSION_PANE_FALLBACK_WIDTH = 520;

interface PaneWidthConfig {
  storageKey: string;
  legacyStorageKey: string;
  defaultClassName: string;
  minWidth: number;
  maxVw: number;
  fallbackWidth: number;
  cssVar?: `--${string}`;
  dragDirection?: 'left' | 'right';
}

function widthCss(config: PaneWidthConfig, width: number): string {
  return `min(${width}px, ${config.maxVw}vw)`;
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
  return paneSizing(sessionPaneWidthConfig, width);
}

function paneSizing(
  config: PaneWidthConfig,
  width: number | null,
): {
  className: string;
  style: CSSProperties | undefined;
} {
  return width === null
    ? { className: config.defaultClassName, style: undefined }
    : {
        className: '',
        style: config.cssVar
          ? ({ [config.cssVar]: widthCss(config, width) } as CSSProperties)
          : { width: widthCss(config, width) },
      };
}

function maxWidth(config: PaneWidthConfig): number {
  if (typeof window === 'undefined') return config.fallbackWidth;
  return Math.max(config.minWidth, Math.round((window.innerWidth * config.maxVw) / 100));
}

function clamp(config: PaneWidthConfig, width: number): number {
  return Math.min(Math.max(Math.round(width), config.minWidth), maxWidth(config));
}

/** The stored width, or null when the user has never resized. */
export function loadSessionPaneWidth(): number | null {
  return loadPaneWidth(sessionPaneWidthConfig);
}

function loadPaneWidth(config: PaneWidthConfig): number | null {
  try {
    const raw = readWithLegacy(config.storageKey, config.legacyStorageKey);
    const parsed = raw === null ? NaN : Number(raw);
    return Number.isFinite(parsed) ? clamp(config, parsed) : null;
  } catch {
    return null;
  }
}

function save(config: PaneWidthConfig, width: number | null): void {
  try {
    if (width === null) window.localStorage.removeItem(config.storageKey);
    else window.localStorage.setItem(config.storageKey, String(width));
  } catch {
    /* storage unavailable (private mode) — width stays session-local */
  }
}

function usePaneWidth(config: PaneWidthConfig): {
  /** Dragged width in px, or null for the adaptive default. */
  width: number | null;
  resizing: boolean;
  startResize: (e: ReactPointerEvent<HTMLElement>) => void;
  resetWidth: () => void;
} {
  const [width, setWidth] = useState<number | null>(() => loadPaneWidth(config));
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
      drag.current = { startX: e.clientX, startWidth: measured > 0 ? measured : (width ?? config.fallbackWidth) };
      setResizing(true);

      const widthAt = (ev: globalThis.PointerEvent) =>
        drag.current
          ? clamp(
              config,
              drag.current.startWidth +
                (config.dragDirection === 'right'
                  ? ev.clientX - drag.current.startX
                  : drag.current.startX - ev.clientX),
            )
          : null;
      const onMove = (ev: globalThis.PointerEvent) => {
        const w = widthAt(ev);
        if (w !== null && aside) {
          if (config.cssVar) aside.style.setProperty(config.cssVar, widthCss(config, w));
          else aside.style.width = widthCss(config, w);
        }
      };
      const onUp = (ev: globalThis.PointerEvent) => {
        const final = widthAt(ev);
        if (final === null) return;
        drag.current = null;
        setResizing(false);
        setWidth(final);
        save(config, final);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    },
    [config, width],
  );

  const resetWidth = useCallback(() => {
    setWidth(null);
    save(config, null);
  }, [config]);

  return { width, resizing, startResize, resetWidth };
}

const sessionPaneWidthConfig: PaneWidthConfig = {
  storageKey: SESSION_PANE_WIDTH_STORAGE_KEY,
  legacyStorageKey: LEGACY_SESSION_PANE_WIDTH_STORAGE_KEY,
  defaultClassName: 'w-[min(520px,42vw)]',
  minWidth: SESSION_PANE_MIN_WIDTH,
  maxVw: SESSION_PANE_MAX_VW,
  fallbackWidth: SESSION_PANE_FALLBACK_WIDTH,
};

export function useSessionPaneWidth(): {
  /** Dragged width in px, or null for the adaptive default. */
  width: number | null;
  resizing: boolean;
  startResize: (e: ReactPointerEvent<HTMLElement>) => void;
  resetWidth: () => void;
} {
  return usePaneWidth(sessionPaneWidthConfig);
}

// # === resize additions ===
export const THREAD_PANE_MIN_WIDTH = 320;
export const THREAD_PANE_MAX_VW = 60;
/** Drag-start fallback when the pane can't be measured (jsdom). */
export const THREAD_PANE_FALLBACK_WIDTH = 380;

const threadPaneWidthConfig: PaneWidthConfig = {
  storageKey: THREAD_PANE_WIDTH_STORAGE_KEY,
  legacyStorageKey: LEGACY_THREAD_PANE_WIDTH_STORAGE_KEY,
  defaultClassName: 'w-[min(380px,38vw)]',
  minWidth: THREAD_PANE_MIN_WIDTH,
  maxVw: THREAD_PANE_MAX_VW,
  fallbackWidth: THREAD_PANE_FALLBACK_WIDTH,
};

export function threadPaneSizing(width: number | null): {
  className: string;
  style: CSSProperties | undefined;
} {
  return paneSizing(threadPaneWidthConfig, width);
}

export function useThreadPaneWidth(): {
  /** Dragged width in px, or null for the adaptive default. */
  width: number | null;
  resizing: boolean;
  startResize: (e: ReactPointerEvent<HTMLElement>) => void;
  resetWidth: () => void;
} {
  return usePaneWidth(threadPaneWidthConfig);
}

// === sidebar resize additions ===
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_VW = 40;
export const SIDEBAR_FALLBACK_WIDTH = 224;

const sidebarWidthConfig: PaneWidthConfig = {
  storageKey: SIDEBAR_WIDTH_STORAGE_KEY,
  legacyStorageKey: LEGACY_SIDEBAR_WIDTH_STORAGE_KEY,
  defaultClassName: '',
  minWidth: SIDEBAR_MIN_WIDTH,
  maxVw: SIDEBAR_MAX_VW,
  fallbackWidth: SIDEBAR_FALLBACK_WIDTH,
  cssVar: '--sidebar-w',
  dragDirection: 'right',
};

export function sidebarSizing(width: number | null): {
  className: string;
  style: CSSProperties | undefined;
} {
  return paneSizing(sidebarWidthConfig, width);
}

export function useSidebarWidth(): {
  width: number | null;
  resizing: boolean;
  startResize: (e: ReactPointerEvent<HTMLElement>) => void;
  resetWidth: () => void;
} {
  return usePaneWidth(sidebarWidthConfig);
}
