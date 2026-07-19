// One Escape press dismisses exactly one layer — the topmost. Instead of every
// component racing its own window/document listener (registration order decides
// who wins, and it reshuffles as effects re-run), each interested component
// registers a layer here. A single window capture-phase listener routes each
// press to the highest-priority active layer that claims it, then stops. Order
// is priority first, most-recent registration second — never effect timing.

import { useEffect, useRef } from 'react';
import { isModalDialogOpen } from '../useDialog';

// Higher wins. Modal dialogs, menus and popovers are not layers: they run on
// useDialog and own Escape while open (see the isModalDialogOpen guard below).
export const EscapeLayer = {
  turn: 60,
  workSurface: 50,
  surface: 40,
  dock: 20,
  sidebar: 10,
} as const;

// A layer returns true when it consumed the press; the dispatcher then calls
// preventDefault/stopPropagation and stops. Return false to pass to the next
// layer down (e.g. when the Escape belongs to an editable field or a menu).
export type EscapeLayerHandler = (event: KeyboardEvent) => boolean;

interface Layer {
  priority: number;
  seq: number;
  handler: EscapeLayerHandler;
}

const layers = new Set<Layer>();
let seq = 0;
let listening = false;

export function isEditableEscapeTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, select, .ProseMirror')) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  const editable = target.closest('[contenteditable]');
  return editable instanceof HTMLElement && editable.isContentEditable;
}

export function escapeHasLocalMeaning(event: KeyboardEvent): boolean {
  const target = event.target instanceof Element ? event.target : document.activeElement;
  if (isEditableEscapeTarget(target)) return true;
  return Boolean(target?.closest('[role="dialog"], [role="menu"], [role="listbox"], [aria-modal="true"]'));
}

export function isPlainEscape(event: KeyboardEvent): boolean {
  return (
    event.key === 'Escape' && !event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
  );
}

function dispatchEscape(event: KeyboardEvent): void {
  if (!isPlainEscape(event) || event.defaultPrevented) return;
  // A useDialog modal/menu/popover owns Escape while open; it closes exactly
  // itself on document capture (which runs after this window-capture pass).
  // Stand down entirely so a layer underneath can't dismiss alongside it.
  if (isModalDialogOpen()) return;
  const ordered = [...layers].sort((a, b) => b.priority - a.priority || b.seq - a.seq);
  for (const layer of ordered) {
    if (layer.handler(event)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
  }
}

function registerEscapeLayer(priority: number, handler: EscapeLayerHandler): () => void {
  const layer: Layer = { priority, seq: seq++, handler };
  layers.add(layer);
  if (!listening && typeof window !== 'undefined') {
    window.addEventListener('keydown', dispatchEscape, true);
    listening = true;
  }
  return () => {
    layers.delete(layer);
    if (layers.size === 0 && listening && typeof window !== 'undefined') {
      window.removeEventListener('keydown', dispatchEscape, true);
      listening = false;
    }
  };
}

export function useEscapeLayer(priority: number, handler: EscapeLayerHandler, enabled = true): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  useEffect(() => {
    if (!enabled) return;
    return registerEscapeLayer(priority, (event) => handlerRef.current(event));
  }, [enabled, priority]);
}
