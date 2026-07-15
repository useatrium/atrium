import { useCallback, useLayoutEffect, useState } from 'react';
import type { CSSProperties, PointerEvent as ReactPointerEvent, RefObject } from 'react';

const SIDE_SIZE_KEY = 'atrium.workDockSideWidth';
const TOP_SIZE_KEY = 'atrium.workDockTopHeight';
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

function loadSize(key: string, fallback: number): number {
  if (typeof window === 'undefined') return fallback;
  const parsed = Number(window.localStorage.getItem(key));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

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

export function useWorkDockSize() {
  const [sideWidth, setSideWidth] = useState(() => loadSize(SIDE_SIZE_KEY, DEFAULT_SIDE_WIDTH));
  const [topHeight, setTopHeight] = useState(() => loadSize(TOP_SIZE_KEY, DEFAULT_TOP_HEIGHT));
  const [resizing, setResizing] = useState<'top' | 'side' | null>(null);

  const startResize = useCallback(
    (placement: 'top' | 'side') => (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const target = event.currentTarget;
      target.setPointerCapture?.(event.pointerId);
      const startX = event.clientX;
      const startY = event.clientY;
      const initialSide = sideWidth;
      const initialTop = topHeight;
      setResizing(placement);

      const onMove = (move: PointerEvent) => {
        if (placement === 'side') {
          setSideWidth(clamp(initialSide + startX - move.clientX, WORK_DOCK_MIN_SIDE_WIDTH, WORK_DOCK_MAX_SIDE_WIDTH));
        } else {
          setTopHeight(clamp(initialTop + move.clientY - startY, WORK_DOCK_MIN_TOP_HEIGHT, WORK_DOCK_MAX_TOP_HEIGHT));
        }
      };
      const onEnd = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onEnd);
        setResizing(null);
        setSideWidth((value) => {
          window.localStorage.setItem(SIDE_SIZE_KEY, String(value));
          return value;
        });
        setTopHeight((value) => {
          window.localStorage.setItem(TOP_SIZE_KEY, String(value));
          return value;
        });
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onEnd, { once: true });
    },
    [sideWidth, topHeight],
  );

  const sideStyle: CSSProperties = { width: `min(${sideWidth}px, 55%)` };
  const topStyle: CSSProperties = { height: `${topHeight}px`, maxHeight: '55%' };
  return { resizing, sideStyle, sideWidth, startResize, topHeight, topStyle };
}
