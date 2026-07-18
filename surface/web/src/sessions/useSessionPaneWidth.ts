// Drag-resizable split-view session pane width, persisted per browser.
// No stored preference → the adaptive default class (`min(520px,42vw)`, the
// pre-resize behavior, so narrow windows keep a proportional pane). Once the
// user drags, the stored px width applies, clamped live against the viewport
// so a size saved on a wide monitor can't swallow a narrow window.

import { useCallback, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from 'react';
import {
  AGENT_DOCK_WIDTH_STORAGE_KEY,
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

type PaneSizeMaximum = { maxVw: number; maxPx?: never } | { maxPx: number; maxVw?: never };

export type PaneSizeConfig = PaneSizeMaximum & {
  storageKey: string;
  legacyStorageKey: string;
  /** Omit to emit the fallback size as an inline default. */
  defaultClassName?: string;
  minSize: number;
  fallbackSize: number;
  axis?: 'x' | 'y';
  /** An optional responsive CSS cap, independent of the fixed JS clamp. */
  maxPercent?: number;
  cssVar?: `--${string}`;
  dragDirection?: 'left' | 'right' | 'up' | 'down';
};

function sizeCss(config: PaneSizeConfig, size: number): string {
  const cssMax =
    config.maxPercent !== undefined
      ? `${config.maxPercent}%`
      : config.maxVw !== undefined
        ? `${config.maxVw}vw`
        : `${config.maxPx}px`;
  return `min(${size}px, ${cssMax})`;
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
  config: PaneSizeConfig,
  size: number | null,
): {
  className: string;
  style: CSSProperties | undefined;
} {
  if (size === null && config.defaultClassName !== undefined) {
    return { className: config.defaultClassName, style: undefined };
  }

  const renderedSize = size ?? config.fallbackSize;
  const value = sizeCss(config, renderedSize);
  return {
    className: '',
    style: config.cssVar
      ? ({ [config.cssVar]: value } as CSSProperties)
      : config.axis === 'y'
        ? { height: value }
        : { width: value },
  };
}

function maxSize(config: PaneSizeConfig): number {
  if (config.maxPx !== undefined) return Math.max(config.minSize, config.maxPx);
  if (typeof window === 'undefined') return config.fallbackSize;
  return Math.max(config.minSize, Math.round((window.innerWidth * config.maxVw) / 100));
}

function clamp(config: PaneSizeConfig, size: number): number {
  return Math.min(Math.max(Math.round(size), config.minSize), maxSize(config));
}

/** The stored width, or null when the user has never resized. */
export function loadSessionPaneWidth(): number | null {
  return loadPaneSize(sessionPaneWidthConfig);
}

function loadPaneSize(config: PaneSizeConfig): number | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = readWithLegacy(config.storageKey, config.legacyStorageKey);
    const parsed = raw === null ? NaN : Number(raw);
    return Number.isFinite(parsed) ? clamp(config, parsed) : null;
  } catch {
    return null;
  }
}

function save(config: PaneSizeConfig, size: number | null): void {
  try {
    if (size === null) window.localStorage.removeItem(config.storageKey);
    else window.localStorage.setItem(config.storageKey, String(size));
  } catch {
    /* storage unavailable (private mode) — width stays session-local */
  }
}

export function usePaneSize<T extends HTMLElement = HTMLElement>(
  config: PaneSizeConfig,
  targetRef?: RefObject<T | null>,
): {
  /** Dragged size in px, or null for the configured default. */
  size: number | null;
  resizing: boolean;
  startResize: (e: ReactPointerEvent<HTMLElement>) => void;
  resetSize: () => void;
  className: string;
  style: CSSProperties | undefined;
} {
  const [size, setSize] = useState<number | null>(() => loadPaneSize(config));
  const [resizing, setResizing] = useState(false);
  const drag = useRef<{ startPosition: number; startSize: number } | null>(null);

  const startResize = useCallback(
    (e: ReactPointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const handle = e.currentTarget;
      // The element hosting the handle. Size is written to it imperatively
      // during the drag — a ~60Hz pointermove driving React state would
      // re-render the whole transcript per frame; state commits once on up.
      const target = targetRef?.current ?? handle.parentElement;
      try {
        handle.setPointerCapture(e.pointerId);
      } catch {
        /* jsdom / older browsers: drag still works while the pointer stays on the handle */
      }
      const measuredRect = target?.getBoundingClientRect();
      const measured = config.axis === 'y' ? measuredRect?.height : measuredRect?.width;
      drag.current = {
        startPosition: config.axis === 'y' ? e.clientY : e.clientX,
        startSize: measured && measured > 0 ? measured : (size ?? config.fallbackSize),
      };
      setResizing(true);

      const sizeAt = (ev: globalThis.PointerEvent) => {
        if (!drag.current) return null;
        const position = config.axis === 'y' ? ev.clientY : ev.clientX;
        const growsWithPointer = config.dragDirection === 'right' || config.dragDirection === 'down';
        const delta = growsWithPointer ? position - drag.current.startPosition : drag.current.startPosition - position;
        return clamp(config, drag.current.startSize + delta);
      };
      const onMove = (ev: globalThis.PointerEvent) => {
        const nextSize = sizeAt(ev);
        if (nextSize !== null && target) {
          if (config.cssVar) target.style.setProperty(config.cssVar, sizeCss(config, nextSize));
          else if (config.axis === 'y') target.style.height = sizeCss(config, nextSize);
          else target.style.width = sizeCss(config, nextSize);
        }
      };
      const onUp = (ev: globalThis.PointerEvent) => {
        const final = sizeAt(ev);
        if (final === null) return;
        drag.current = null;
        setResizing(false);
        setSize(final);
        save(config, final);
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    },
    [config, size, targetRef],
  );

  const resetSize = useCallback(() => {
    setSize(null);
    save(config, null);
  }, [config]);

  return { size, resizing, startResize, resetSize, ...paneSizing(config, size) };
}

const sessionPaneWidthConfig: PaneSizeConfig = {
  storageKey: SESSION_PANE_WIDTH_STORAGE_KEY,
  legacyStorageKey: LEGACY_SESSION_PANE_WIDTH_STORAGE_KEY,
  defaultClassName: 'w-[min(520px,42vw)]',
  minSize: SESSION_PANE_MIN_WIDTH,
  maxVw: SESSION_PANE_MAX_VW,
  fallbackSize: SESSION_PANE_FALLBACK_WIDTH,
};

export function useSessionPaneWidth(): {
  /** Dragged width in px, or null for the adaptive default. */
  width: number | null;
  resizing: boolean;
  startResize: (e: ReactPointerEvent<HTMLElement>) => void;
  resetWidth: () => void;
} {
  const { size, resizing, startResize, resetSize } = usePaneSize(sessionPaneWidthConfig);
  return { width: size, resizing, startResize, resetWidth: resetSize };
}

// # === resize additions ===
export const THREAD_PANE_MIN_WIDTH = 320;
export const THREAD_PANE_MAX_VW = 60;
/** Drag-start fallback when the pane can't be measured (jsdom). */
export const THREAD_PANE_FALLBACK_WIDTH = 380;

const threadPaneWidthConfig: PaneSizeConfig = {
  storageKey: THREAD_PANE_WIDTH_STORAGE_KEY,
  legacyStorageKey: LEGACY_THREAD_PANE_WIDTH_STORAGE_KEY,
  defaultClassName: 'w-[min(380px,38vw)]',
  minSize: THREAD_PANE_MIN_WIDTH,
  maxVw: THREAD_PANE_MAX_VW,
  fallbackSize: THREAD_PANE_FALLBACK_WIDTH,
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
  const { size, resizing, startResize, resetSize } = usePaneSize(threadPaneWidthConfig);
  return { width: size, resizing, startResize, resetWidth: resetSize };
}

// === sidebar resize additions ===
export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_VW = 40;
export const SIDEBAR_FALLBACK_WIDTH = 224;

const sidebarWidthConfig: PaneSizeConfig = {
  storageKey: SIDEBAR_WIDTH_STORAGE_KEY,
  legacyStorageKey: LEGACY_SIDEBAR_WIDTH_STORAGE_KEY,
  defaultClassName: '',
  minSize: SIDEBAR_MIN_WIDTH,
  maxVw: SIDEBAR_MAX_VW,
  fallbackSize: SIDEBAR_FALLBACK_WIDTH,
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
  const { size, resizing, startResize, resetSize } = usePaneSize(sidebarWidthConfig);
  return { width: size, resizing, startResize, resetWidth: resetSize };
}

// === agent dock resize additions ===
export const AGENT_DOCK_MIN_WIDTH = 224;
export const AGENT_DOCK_MAX_VW = 40;
export const AGENT_DOCK_FALLBACK_WIDTH = 256;

export const agentDockWidthConfig: PaneSizeConfig = {
  storageKey: AGENT_DOCK_WIDTH_STORAGE_KEY,
  // The key was reserved before resize shipped, so there is no legacy value
  // to migrate. Using the same key keeps the generic config shape additive.
  legacyStorageKey: AGENT_DOCK_WIDTH_STORAGE_KEY,
  defaultClassName: '',
  minSize: AGENT_DOCK_MIN_WIDTH,
  maxVw: AGENT_DOCK_MAX_VW,
  fallbackSize: AGENT_DOCK_FALLBACK_WIDTH,
  cssVar: '--agent-dock-w',
  dragDirection: 'left',
};
