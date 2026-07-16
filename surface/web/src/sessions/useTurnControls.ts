import { useCallback, useEffect, useState } from 'react';
import type { ReportSessionActionError } from './useSessionActionError';

function isTextEditingEscapeTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, select, .ProseMirror')) return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  const editable = target.closest('[contenteditable]');
  return editable instanceof HTMLElement && editable.isContentEditable;
}

export function escapeHasLocalMeaning(event: KeyboardEvent): boolean {
  const target = event.target instanceof Element ? event.target : document.activeElement;
  if (isTextEditingEscapeTarget(target)) return true;
  return Boolean(target?.closest('[role="dialog"], [role="menu"], [role="listbox"], [aria-modal="true"]'));
}

export function isPlainEscape(event: KeyboardEvent): boolean {
  return (
    event.key === 'Escape' && !event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
  );
}

export function useTurnControls({
  sessionId,
  canStopTurn,
  isSpawner,
  isDriver,
  visible,
  failedCancel,
  onStopTurn,
  onCancelSession,
  onClearFailedCancel,
  reportError,
}: {
  sessionId: string;
  canStopTurn: boolean;
  isSpawner: boolean;
  isDriver: boolean;
  visible: boolean;
  failedCancel: boolean;
  onStopTurn: (sessionId: string) => Promise<void>;
  onCancelSession: (sessionId: string) => Promise<void>;
  onClearFailedCancel: () => void;
  reportError: ReportSessionActionError;
}) {
  const [cancelAsk, setCancelAsk] = useState<'idle' | 'confirm' | 'failed'>('idle');
  const displayCancelAsk = failedCancel ? 'failed' : cancelAsk;

  useEffect(() => {
    if (cancelAsk !== 'confirm') return;
    const t = setTimeout(() => setCancelAsk('idle'), 5000);
    return () => clearTimeout(t);
  }, [cancelAsk]);

  const onCancel = useCallback(() => {
    if (canStopTurn) {
      setCancelAsk('idle');
      onClearFailedCancel();
      onStopTurn(sessionId).catch((err: unknown) => {
        setCancelAsk('failed');
        reportError(err, "Couldn't stop the turn.", { toast: false });
      });
      return;
    }
    if (displayCancelAsk === 'idle') {
      setCancelAsk('confirm');
      return;
    }
    setCancelAsk('idle');
    onClearFailedCancel();
    onCancelSession(sessionId).catch((err: unknown) => {
      setCancelAsk('failed');
      reportError(err, "Couldn't cancel the session.", { toast: false });
    });
  }, [canStopTurn, displayCancelAsk, onCancelSession, onClearFailedCancel, onStopTurn, reportError, sessionId]);

  useEffect(() => {
    // A ConversationPanel keeps this body mounted-but-hidden in thread mode;
    // its window-level Escape must not stop a turn from offscreen.
    if (!visible || !canStopTurn || (!isSpawner && !isDriver)) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isPlainEscape(event) || escapeHasLocalMeaning(event)) return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [canStopTurn, isDriver, isSpawner, onCancel, visible]);

  return { displayCancelAsk, onCancel };
}
