import { useCallback, useMemo, useRef, useState, type PointerEvent, type WheelEvent } from 'react';

export interface ZoomPanState {
  scale: number;
  x: number;
  y: number;
}

const MIN_SCALE = 1;
const MAX_SCALE = 6;

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export function useZoomPan() {
  const [state, setState] = useState<ZoomPanState>({ scale: 1, x: 0, y: 0 });
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(
    null,
  );

  const reset = useCallback(() => setState({ scale: 1, x: 0, y: 0 }), []);

  const zoomBy = useCallback((delta: number) => {
    setState((prev) => {
      const scale = clamp(prev.scale + delta, MIN_SCALE, MAX_SCALE);
      return scale === 1 ? { scale, x: 0, y: 0 } : { ...prev, scale };
    });
  }, []);

  const onWheel = useCallback((event: WheelEvent<HTMLElement>) => {
    event.preventDefault();
    const step = event.deltaY > 0 ? -0.25 : 0.25;
    setState((prev) => {
      const nextScale = clamp(prev.scale + step, MIN_SCALE, MAX_SCALE);
      return nextScale === 1 ? { scale: nextScale, x: 0, y: 0 } : { ...prev, scale: nextScale };
    });
  }, []);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (state.scale <= 1) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      dragRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: state.x,
        originY: state.y,
      };
    },
    [state.scale, state.x, state.y],
  );

  const onPointerMove = useCallback((event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setState((prev) => ({
      ...prev,
      x: drag.originX + event.clientX - drag.startX,
      y: drag.originY + event.clientY - drag.startY,
    }));
  }, []);

  const endDrag = useCallback((event: PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const transform = useMemo(
    () => ({
      transform: `translate3d(${state.x}px, ${state.y}px, 0) scale(${state.scale})`,
      cursor: state.scale > 1 ? 'grab' : 'default',
    }),
    [state.scale, state.x, state.y],
  );

  return {
    state,
    transform,
    reset,
    zoomIn: () => zoomBy(0.5),
    zoomOut: () => zoomBy(-0.5),
    onWheel,
    onPointerDown,
    onPointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
  };
}
