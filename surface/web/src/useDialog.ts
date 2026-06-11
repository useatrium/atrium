import { useEffect, type RefObject } from 'react';

const TABBABLE =
  'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';

function tabbables(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (el) => !el.hasAttribute('disabled') && el.getAttribute('aria-hidden') !== 'true',
  );
}

export function focusFirstIn(container: HTMLElement): void {
  const first = tabbables(container)[0] ?? container;
  first.focus();
}

export function useDialog({
  open,
  containerRef,
  initialFocusRef,
  restoreFocus = true,
  onClose,
  closeOnOutsidePointer = false,
  invokerRef,
}: {
  open: boolean;
  containerRef: RefObject<HTMLElement | null>;
  initialFocusRef?: RefObject<HTMLElement | null>;
  restoreFocus?: boolean;
  onClose: () => void;
  closeOnOutsidePointer?: boolean;
  invokerRef?: RefObject<HTMLElement | null>;
}) {
  useEffect(() => {
    if (!open) return;
    const invoker = invokerRef?.current ?? (document.activeElement as HTMLElement | null);
    const focusTimer = window.setTimeout(() => {
      const target = initialFocusRef?.current;
      if (target) target.focus();
      else if (containerRef.current) focusFirstIn(containerRef.current);
    });

    const onKeyDown = (event: KeyboardEvent) => {
      const container = containerRef.current;
      if (!container) return;
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = tabbables(container);
      if (focusable.length === 0) {
        event.preventDefault();
        container.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !container.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    const onPointerDown = (event: PointerEvent) => {
      if (!closeOnOutsidePointer) return;
      const target = event.target as Node;
      if (containerRef.current?.contains(target) || invokerRef?.current?.contains(target)) return;
      onClose();
    };

    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
      if (restoreFocus && invoker?.isConnected) invoker.focus();
    };
  }, [closeOnOutsidePointer, containerRef, initialFocusRef, invokerRef, onClose, open, restoreFocus]);
}
