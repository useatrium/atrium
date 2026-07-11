// Absolute base for links meant to be shared OUTSIDE the app (clipboard).
// Prod build injects VITE_PUBLIC_URL via web/.env.production; dev leaves it unset -> window.origin.
function publicBaseUrl(): string {
  const configured = import.meta.env.VITE_PUBLIC_URL?.trim();
  const base = configured || (typeof window === 'undefined' ? '' : window.location.origin);
  return base.replace(/\/+$/, '');
}

export function entryShareUrl(handle: string): string {
  return `${publicBaseUrl()}/e/${handle}`;
}

export function sessionShareUrl(sessionId: string): string {
  return `${publicBaseUrl()}/s/${sessionId}`;
}

export function fileShareUrl(fileId: string): string {
  return `${publicBaseUrl()}/api/files/${fileId}`;
}
