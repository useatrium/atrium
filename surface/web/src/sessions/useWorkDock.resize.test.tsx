// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WORK_DOCK_SIDE_WIDTH_STORAGE_KEY, WORK_DOCK_TOP_HEIGHT_STORAGE_KEY } from '../storageKeys';
import {
  useWorkDockSideWidth,
  useWorkDockTopHeight,
  WORK_DOCK_MAX_SIDE_WIDTH,
  WORK_DOCK_MAX_TOP_HEIGHT,
  WORK_DOCK_MIN_SIDE_WIDTH,
  WORK_DOCK_MIN_TOP_HEIGHT,
} from './useWorkDock';

function SideDock() {
  const dock = useWorkDockSideWidth();
  return (
    <div ref={dock.containerRef} data-testid="work-dock-side" style={dock.style}>
      {/* biome-ignore lint/a11y/useSemanticElements: mirrors the pointer-capture resize separator. */}
      <div
        role="separator"
        tabIndex={0}
        aria-valuemin={WORK_DOCK_MIN_SIDE_WIDTH}
        aria-valuemax={WORK_DOCK_MAX_SIDE_WIDTH}
        aria-valuenow={dock.width}
        data-testid="work-dock-side-resize-handle"
        onPointerDown={dock.startResize}
        onDoubleClick={dock.resetWidth}
      />
    </div>
  );
}

function TopDock() {
  const dock = useWorkDockTopHeight();
  return (
    <div ref={dock.containerRef} data-testid="work-dock-top" style={dock.style}>
      {/* biome-ignore lint/a11y/useSemanticElements: mirrors the pointer-capture resize separator. */}
      <div
        role="separator"
        tabIndex={0}
        aria-valuemin={WORK_DOCK_MIN_TOP_HEIGHT}
        aria-valuemax={WORK_DOCK_MAX_TOP_HEIGHT}
        aria-valuenow={dock.height}
        data-testid="work-dock-top-resize-handle"
        onPointerDown={dock.startResize}
        onDoubleClick={dock.resetHeight}
      />
    </div>
  );
}

function pointerMouseEvent(type: string, clientX: number, clientY: number): MouseEvent {
  const event = new MouseEvent(type, { button: 0, clientX, clientY, bubbles: true });
  Object.defineProperty(event, 'pointerId', { value: 1 });
  return event;
}

function rect(width: number, height: number): DOMRect {
  return {
    width,
    height,
    top: 0,
    right: width,
    bottom: height,
    left: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  };
}

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe('work dock resize', () => {
  it('resizes the side dock to the left within fixed clamps, persists, and resets', () => {
    render(<SideDock />);
    const dock = screen.getByTestId('work-dock-side') as HTMLElement;
    const handle = screen.getByTestId('work-dock-side-resize-handle') as HTMLElement;
    handle.setPointerCapture = vi.fn();
    vi.spyOn(dock, 'getBoundingClientRect').mockReturnValue(rect(420, 600));

    act(() => {
      handle.dispatchEvent(pointerMouseEvent('pointerdown', 400, 0));
      handle.dispatchEvent(pointerMouseEvent('pointermove', -500, 0));
    });
    expect(dock.style.width).toBe('min(640px, 55%)');

    act(() => handle.dispatchEvent(pointerMouseEvent('pointermove', 600, 0)));
    expect(dock.style.width).toBe('min(300px, 55%)');
    expect(window.localStorage.getItem(WORK_DOCK_SIDE_WIDTH_STORAGE_KEY)).toBeNull();

    act(() => handle.dispatchEvent(pointerMouseEvent('pointerup', 350, 0)));
    expect(dock.style.width).toBe('min(470px, 55%)');
    expect(window.localStorage.getItem(WORK_DOCK_SIDE_WIDTH_STORAGE_KEY)).toBe('470');
    expect(handle.getAttribute('aria-valuenow')).toBe('470');

    act(() => handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(dock.style.width).toBe('min(420px, 55%)');
    expect(window.localStorage.getItem(WORK_DOCK_SIDE_WIDTH_STORAGE_KEY)).toBeNull();
    expect(handle.getAttribute('aria-valuenow')).toBe('420');
  });

  it('resizes the top dock downward within fixed clamps, persists, and resets', () => {
    render(<TopDock />);
    const dock = screen.getByTestId('work-dock-top') as HTMLElement;
    const handle = screen.getByTestId('work-dock-top-resize-handle') as HTMLElement;
    handle.setPointerCapture = vi.fn();
    vi.spyOn(dock, 'getBoundingClientRect').mockReturnValue(rect(800, 300));

    act(() => {
      handle.dispatchEvent(pointerMouseEvent('pointerdown', 0, 300));
      handle.dispatchEvent(pointerMouseEvent('pointermove', 0, 1000));
    });
    expect(dock.style.height).toBe('min(520px, 55%)');

    act(() => handle.dispatchEvent(pointerMouseEvent('pointermove', 0, 0)));
    expect(dock.style.height).toBe('min(180px, 55%)');
    expect(window.localStorage.getItem(WORK_DOCK_TOP_HEIGHT_STORAGE_KEY)).toBeNull();

    act(() => handle.dispatchEvent(pointerMouseEvent('pointerup', 0, 420)));
    expect(dock.style.height).toBe('min(420px, 55%)');
    expect(window.localStorage.getItem(WORK_DOCK_TOP_HEIGHT_STORAGE_KEY)).toBe('420');
    expect(handle.getAttribute('aria-valuenow')).toBe('420');

    act(() => handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })));
    expect(dock.style.height).toBe('min(300px, 55%)');
    expect(window.localStorage.getItem(WORK_DOCK_TOP_HEIGHT_STORAGE_KEY)).toBeNull();
    expect(handle.getAttribute('aria-valuenow')).toBe('300');
  });
});
