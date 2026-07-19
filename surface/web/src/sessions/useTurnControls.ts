import { useCallback, useEffect, useState } from 'react';
import { EscapeLayer, escapeHasLocalMeaning, useEscapeLayer } from '../lib/escapeLayers';
import type { ReportSessionActionError } from './useSessionActionError';

// Re-exported for callers that still import these from here (e.g. SessionPane);
// the definitions now live with the layered-escape dispatcher.
export { escapeHasLocalMeaning, isPlainEscape } from '../lib/escapeLayers';

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

  // A ConversationPanel keeps this body mounted-but-hidden in thread mode; the
  // `visible` gate keeps an offscreen pane from stopping a turn. Escape yields
  // to any editable field or menu with its own meaning (escapeHasLocalMeaning).
  useEscapeLayer(
    EscapeLayer.turn,
    (event) => {
      if (escapeHasLocalMeaning(event)) return false;
      onCancel();
      return true;
    },
    visible && canStopTurn && (isSpawner || isDriver),
  );

  return { displayCancelAsk, onCancel };
}
