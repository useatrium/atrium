import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';

type SelectionStyleSnapshot = {
  element: HTMLElement;
  userSelect: string;
  webkitUserSelect: string;
  webkitTouchCallout: string;
};

type TouchEndGuard = {
  element: HTMLElement;
  listener: (event: TouchEvent) => void;
};

type WebkitUserSelectStyle = CSSStyleDeclaration & { webkitUserSelect?: string };

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
  const selectionStyleRef = useRef<SelectionStyleSnapshot | null>(null);
  const touchEndGuardRef = useRef<TouchEndGuard | null>(null);
  const touchEndGuardCleanupTimerRef = useRef<number | null>(null);
  const suppressNextTouchEndRef = useRef(false);
  const suppressContextMenuUntilRef = useRef(0);
  const [pressing, setPressing] = useState(false);

  const restoreSelectionStyles = useCallback(() => {
    const snapshot = selectionStyleRef.current;
    if (!snapshot) return;
    snapshot.element.style.userSelect = snapshot.userSelect;
    (snapshot.element.style as WebkitUserSelectStyle).webkitUserSelect = snapshot.webkitUserSelect;
    if (snapshot.webkitTouchCallout) {
      snapshot.element.style.setProperty('-webkit-touch-callout', snapshot.webkitTouchCallout);
    } else {
      snapshot.element.style.removeProperty('-webkit-touch-callout');
    }
    selectionStyleRef.current = null;
  }, []);

  const removeTouchEndGuard = useCallback(() => {
    if (touchEndGuardCleanupTimerRef.current != null) {
      window.clearTimeout(touchEndGuardCleanupTimerRef.current);
      touchEndGuardCleanupTimerRef.current = null;
    }
    const guard = touchEndGuardRef.current;
    if (!guard) return;
    guard.element.removeEventListener('touchend', guard.listener);
    touchEndGuardRef.current = null;
  }, []);

  const clear = useCallback(
    ({ keepTouchEndGuard = false }: { keepTouchEndGuard?: boolean } = {}) => {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      pointerRef.current = null;
      restoreSelectionStyles();
      setPressing(false);
      if (keepTouchEndGuard) {
        if (touchEndGuardCleanupTimerRef.current == null) {
          touchEndGuardCleanupTimerRef.current = window.setTimeout(() => {
            suppressNextTouchEndRef.current = false;
            removeTouchEndGuard();
          }, 1000);
        }
        return;
      }
      suppressNextTouchEndRef.current = false;
      removeTouchEndGuard();
    },
    [removeTouchEndGuard, restoreSelectionStyles],
  );

  const installTouchEndGuard = useCallback(
    (element: HTMLElement) => {
      removeTouchEndGuard();
      if (!canListenForTouchEnd()) return;
      const listener = (event: TouchEvent) => {
        if (suppressNextTouchEndRef.current) event.preventDefault();
        clear();
      };
      element.addEventListener('touchend', listener, { passive: false });
      touchEndGuardRef.current = { element, listener };
    },
    [clear, removeTouchEndGuard],
  );

  const applySelectionSuppression = useCallback((element: HTMLElement) => {
    restoreSelectionStyles();
    selectionStyleRef.current = {
      element,
      userSelect: element.style.userSelect,
      webkitUserSelect: (element.style as WebkitUserSelectStyle).webkitUserSelect ?? '',
      webkitTouchCallout: element.style.getPropertyValue('-webkit-touch-callout'),
    };
    element.style.userSelect = 'none';
    (element.style as WebkitUserSelectStyle).webkitUserSelect = 'none';
    element.style.setProperty('-webkit-touch-callout', 'none');
  }, [restoreSelectionStyles]);

  const onPointerUp = useCallback(() => {
    clear({ keepTouchEndGuard: suppressNextTouchEndRef.current });
  }, [clear]);

  const onPointerCancel = useCallback(() => {
    clear({ keepTouchEndGuard: suppressNextTouchEndRef.current });
  }, [clear]);

  useEffect(() => clear, [clear]);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (disabled || event.pointerType !== 'touch' || isInteractiveTarget(event.target)) return;
      clear();
      const element = event.currentTarget;
      applySelectionSuppression(element);
      installTouchEndGuard(element);
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
        suppressNextTouchEndRef.current = true;
        setPressing(false);
        onLongPress();
      }, delayMs);
    },
    [applySelectionSuppression, clear, delayMs, disabled, installTouchEndGuard, onLongPress],
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

  const onContextMenu = useCallback((event: { preventDefault: () => void }) => {
    if (Date.now() <= suppressContextMenuUntilRef.current) event.preventDefault();
  }, []);

  return {
    pressing,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onLostPointerCapture: onPointerCancel,
    onContextMenu,
  };
}

function canListenForTouchEnd(): boolean {
  return typeof window !== 'undefined' && 'TouchEvent' in window;
}

function isInteractiveTarget(target: EventTarget): boolean {
  return target instanceof Element && target.closest('button,a,input,textarea,select,[role="button"],[contenteditable="true"]') != null;
}
