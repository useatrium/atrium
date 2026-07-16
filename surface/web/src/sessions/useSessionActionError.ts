import { useCallback } from 'react';
import { ApiError } from '../api';
import { showErrorToast } from '../components/Toasts';

export type ReportSessionActionError = (err: unknown, fallback: string, options?: { toast?: boolean }) => void;

export function useSessionActionError(onApiError: (err: unknown) => void): ReportSessionActionError {
  return useCallback(
    (err: unknown, fallback: string, options: { toast?: boolean } = {}) => {
      onApiError(err);
      if (err instanceof ApiError && err.status === 401) return;
      if (options.toast === false) return;
      showErrorToast(err instanceof ApiError && err.message ? err.message : fallback);
    },
    [onApiError],
  );
}
