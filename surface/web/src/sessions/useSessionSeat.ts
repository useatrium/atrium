import { useEffect, useState } from 'react';
import { ApiError } from '../api';
import { sessionsApi } from './api';
import type { Session } from './types';
import type { ReportSessionActionError } from './useSessionActionError';

export type SeatAsk = 'idle' | 'confirm-take' | 'requested' | 'seat-held';

export function useSessionSeat({
  sessionId,
  isDriver,
  pendingSeatRequests,
  meId,
  reportError,
}: {
  sessionId: string;
  isDriver: boolean;
  pendingSeatRequests: Session['pendingSeatRequests'];
  meId: string;
  reportError: ReportSessionActionError;
}) {
  const [seatAsk, setSeatAsk] = useState<SeatAsk>('idle');

  useEffect(() => {
    if (isDriver) setSeatAsk('idle');
  }, [isDriver]);

  useEffect(() => {
    if (seatAsk !== 'confirm-take') return;
    const t = setTimeout(() => setSeatAsk('idle'), 5000);
    return () => clearTimeout(t);
  }, [seatAsk]);

  const seatRequested =
    seatAsk === 'requested' || seatAsk === 'seat-held' || pendingSeatRequests.some((r) => r.userId === meId);

  const requestSeat = () => {
    setSeatAsk('requested');
    sessionsApi.requestSeat(sessionId).catch((err: unknown) => {
      setSeatAsk('idle');
      reportError(err, "Couldn't request the seat.");
    });
  };

  const takeSeat = () => {
    setSeatAsk('idle');
    sessionsApi.takeSeat(sessionId).catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 409) {
        // Seat actually held (driver is watching after all) — note it and
        // fall back to a polite request.
        setSeatAsk('seat-held');
        sessionsApi.requestSeat(sessionId).catch((requestErr: unknown) => {
          setSeatAsk('idle');
          reportError(requestErr, "Couldn't request the seat.");
        });
      } else {
        reportError(err, "Couldn't take the seat.");
      }
    });
  };

  return { seatAsk, setSeatAsk, seatRequested, requestSeat, takeSeat };
}
