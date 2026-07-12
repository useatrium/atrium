type ClientErrorKind = 'error' | 'unhandledrejection' | 'react_error';

export function installClientTelemetry(): void {
  window.addEventListener('error', (event) => {
    void reportClientError({
      kind: 'error',
      errorName: event.error instanceof Error ? event.error.name : undefined,
      message: event.message,
      stack: event.error instanceof Error ? event.error.stack : undefined,
      component: 'window',
    });
  });

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    void reportClientError({
      kind: 'unhandledrejection',
      errorName: reason instanceof Error ? reason.name : undefined,
      message: reason instanceof Error ? reason.message : String(reason ?? ''),
      stack: reason instanceof Error ? reason.stack : undefined,
      component: 'window',
    });
  });
}

async function reportClientError(args: {
  kind: ClientErrorKind;
  errorName?: string;
  message?: string;
  stack?: string;
  component?: string;
}): Promise<void> {
  await fetch('/api/client-errors', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      ...args,
      url: window.location.href,
    }),
    keepalive: true,
  }).catch(() => {});
}
