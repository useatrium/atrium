import { useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import {
  LEGACY_WORK_DOCK_SIDE_WIDTH_STORAGE_KEY,
  LEGACY_WORK_DOCK_TOP_HEIGHT_STORAGE_KEY,
  WORK_DOCK_SIDE_WIDTH_STORAGE_KEY,
  WORK_DOCK_TOP_HEIGHT_STORAGE_KEY,
} from '../storageKeys';
import { type PaneSizeConfig, usePaneSize } from './useSessionPaneWidth';
const DEFAULT_SIDE_WIDTH = 420;
const DEFAULT_TOP_HEIGHT = 300;
export const WORK_DOCK_MIN_SIDE_WIDTH = 300;
export const WORK_DOCK_MAX_SIDE_WIDTH = 640;
export const WORK_DOCK_MIN_TOP_HEIGHT = 180;
export const WORK_DOCK_MAX_TOP_HEIGHT = 520;

/**
 * A side dock needs room for both a useful transcript (~420px) and work
 * surface (~360px), including the divider. Below this container width the
 * work surface becomes a top band instead of squeezing either column.
 */
export const WORK_DOCK_SIDE_BREAKPOINT_PX = 800;

export function useWorkDockPlacement(ref: RefObject<HTMLElement | null>): 'top' | 'side' {
  const [placement, setPlacement] = useState<'top' | 'side'>('top');

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const update = (width: number) => setPlacement(width >= WORK_DOCK_SIDE_BREAKPOINT_PX ? 'side' : 'top');
    update(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry) update(entry.contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);

  return placement;
}

const workDockSideWidthConfig: PaneSizeConfig = {
  storageKey: WORK_DOCK_SIDE_WIDTH_STORAGE_KEY,
  legacyStorageKey: LEGACY_WORK_DOCK_SIDE_WIDTH_STORAGE_KEY,
  minSize: WORK_DOCK_MIN_SIDE_WIDTH,
  maxPx: WORK_DOCK_MAX_SIDE_WIDTH,
  maxPercent: 55,
  fallbackSize: DEFAULT_SIDE_WIDTH,
};

const workDockTopHeightConfig: PaneSizeConfig = {
  storageKey: WORK_DOCK_TOP_HEIGHT_STORAGE_KEY,
  legacyStorageKey: LEGACY_WORK_DOCK_TOP_HEIGHT_STORAGE_KEY,
  minSize: WORK_DOCK_MIN_TOP_HEIGHT,
  maxPx: WORK_DOCK_MAX_TOP_HEIGHT,
  maxPercent: 55,
  fallbackSize: DEFAULT_TOP_HEIGHT,
  axis: 'y',
  dragDirection: 'down',
};

export function useWorkDockSideWidth() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { size, resetSize, ...pane } = usePaneSize(workDockSideWidthConfig, containerRef);
  return {
    ...pane,
    containerRef,
    width: size ?? DEFAULT_SIDE_WIDTH,
    resetWidth: resetSize,
  };
}

export function useWorkDockTopHeight() {
  const containerRef = useRef<HTMLDivElement>(null);
  const { size, resetSize, ...pane } = usePaneSize(workDockTopHeightConfig, containerRef);
  return {
    ...pane,
    containerRef,
    height: size ?? DEFAULT_TOP_HEIGHT,
    resetHeight: resetSize,
  };
}
