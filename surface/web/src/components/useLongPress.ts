import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';

export function useLongPress({
  disabled,
  delayMs = 400,
  moveTolerance = 10,
  onLongPress,
}: {
  disabled?: boolean;
  delayMs?: number;
  moveTolerance?: number;
  onLongPress: () => void;
}) {
  const timerRef = useRef<number | null>(null);
  const pointerRef = useRef<{ id: number; x: number; y: number } | null>(null);
  const suppressContextMenuUntilRef = useRef(0);
  const [pressing, setPressing] = useState(false);

  const clear = useCallback(() => {
    if (timerRef.current != null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pointerRef.current = null;
    setPressing(false);
  }, []);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (disabled || event.pointerType !== 'touch' || isInteractiveTarget(event.target)) return;
      pointerRef.current = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
      };
      suppressContextMenuUntilRef.current = Date.now() + delayMs + 500;
      setPressing(true);
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        pointerRef.current = null;
        setPressing(false);
        onLongPress();
      }, delayMs);
    },
    [delayMs, disabled, onLongPress],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const pointer = pointerRef.current;
      if (!pointer || pointer.id !== event.pointerId) return;
      const dx = event.clientX - pointer.x;
      const dy = event.clientY - pointer.y;
      if (Math.hypot(dx, dy) > moveTolerance) clear();
    },
    [clear, moveTolerance],
  );

  useEffect(() => clear, [clear]);

  const onContextMenu = useCallback((event: { preventDefault: () => void }) => {
    if (Date.now() <= suppressContextMenuUntilRef.current) event.preventDefault();
  }, []);

  return {
    pressing,
    onPointerDown,
    onPointerMove,
    onPointerUp: clear,
    onPointerCancel: clear,
    onLostPointerCapture: clear,
    onContextMenu,
  };
}

function isInteractiveTarget(target: EventTarget): boolean {
  return target instanceof Element && target.closest('button,a,input,textarea,select,[role="button"],[contenteditable="true"]') != null;
}
