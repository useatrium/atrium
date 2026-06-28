import { useEffect, useState } from 'react';
import { api } from './api';

export function useCallsAvailable(): boolean {
  const [callsAvailable, setCallsAvailable] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .authMethods()
      .then((methods) => {
        if (!cancelled) setCallsAvailable(methods.calls === true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return callsAvailable;
}
