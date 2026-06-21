import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from './api';
import type { AuthMethods, UserRef } from '@atrium/surface-client';

function friendlyLoginError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 400) return err.message || 'That handle won’t work — try another.';
    return 'Something went wrong on the server — try again.';
  }
  return 'Can’t reach the server — check your connection and try again.';
}

export function Login({ onLogin }: { onLogin: (user: UserRef) => void }) {
  const [methods, setMethods] = useState<AuthMethods>({ open: true, email: false, google: false, calls: false });
  const [path, setPath] = useState<'handle' | 'email' | 'code'>('handle');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .authMethods()
      .then(setMethods)
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (path === 'handle' && !methods.open && methods.email) setPath('email');
    if ((path === 'email' || path === 'code') && !methods.email && methods.open) setPath('handle');
  }, [methods, path]);

  const showHandle = methods.open && path === 'handle';
  const showEmail = methods.email && (path === 'email' || path === 'code' || !methods.open);

  const requestCode = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.requestEmailCode(email.trim());
      setPath('code');
    } catch (err) {
      setError(friendlyLoginError(err));
    } finally {
      setBusy(false);
    }
  };

  const verifyCode = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.verifyEmailCode(email.trim(), code.trim());
      onLogin(user);
    } catch (err) {
      setError(friendlyLoginError(err));
    } finally {
      setBusy(false);
    }
  };

  const submitHandle = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Blank display name = server keeps the existing one (or defaults to
      // the handle for brand-new users) — re-logins don't rewrite history.
      const { user } = await api.login(handle.trim(), displayName.trim());
      onLogin(user);
    } catch (err) {
      setError(friendlyLoginError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-dvh items-center justify-center bg-surface">
      <div className="w-80 rounded-xl border border-edge bg-surface-raised/60 p-6 shadow-2xl">
        <h1 className="text-lg font-bold tracking-tight text-fg">Atrium</h1>
        <p className="mb-5 mt-1 text-xs text-pretty text-fg-muted">
          Where your team and AI agents work side by side.
        </p>

        {showHandle && (
          <form onSubmit={submitHandle}>
            <label htmlFor="login-handle" className="mb-1 block text-2xs font-medium uppercase tracking-wide text-fg-muted">
              Handle
            </label>
            <input
              id="login-handle"
              value={handle}
              aria-describedby={error ? 'login-error' : undefined}
              onChange={(e) => setHandle(e.target.value)}
              placeholder="gary"
              autoFocus
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className="mb-3 w-full rounded-md border border-edge-strong bg-surface px-3 py-2 text-sm text-fg placeholder-fg-faint outline-none focus:border-accent-hover"
            />
            <label htmlFor="login-display-name" className="mb-1 block text-2xs font-medium uppercase tracking-wide text-fg-muted">
              Display name{' '}
              <span className="font-normal normal-case text-fg-faint">· optional</span>
            </label>
            <input
              id="login-display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Gary Basin"
              className="mb-4 w-full rounded-md border border-edge-strong bg-surface px-3 py-2 text-sm text-fg placeholder-fg-faint outline-none focus:border-accent-hover"
            />
            {error && <div id="login-error" role="alert" className="mb-3 text-xs text-danger">{error}</div>}
            <button
              type="submit"
              disabled={busy || !handle.trim()}
              className="w-full rounded-md bg-accent py-2 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover disabled:bg-surface-overlay disabled:text-fg-muted"
            >
              {busy ? 'Joining...' : 'Continue with a handle'}
            </button>
          </form>
        )}

        {methods.email && showHandle && (
          <button
            type="button"
            onClick={() => {
              setPath('email');
              setError(null);
            }}
            className="mt-3 w-full text-xs font-medium text-fg-muted hover:text-fg-secondary"
          >
            Sign in with email instead
          </button>
        )}

        {showEmail && (
          <form onSubmit={path === 'email' ? requestCode : verifyCode}>
            <label htmlFor="login-email" className="mb-1 block text-2xs font-medium uppercase tracking-wide text-fg-muted">
              Email
            </label>
            <input
              id="login-email"
              type="email"
              autoFocus={path === 'email'}
              value={email}
              aria-describedby={error && path === 'email' ? 'login-error' : undefined}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="gary@example.com"
              autoComplete="email"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              disabled={path === 'code'}
              className="mb-3 w-full rounded-md border border-edge-strong bg-surface px-3 py-2 text-sm text-fg placeholder-fg-faint outline-none focus:border-accent-hover disabled:text-fg-muted"
            />
            {path === 'code' && (
              <>
                <label htmlFor="login-code" className="mb-1 block text-2xs font-medium uppercase tracking-wide text-fg-muted">
                  Code
                </label>
                <input
                  id="login-code"
                  value={code}
                  aria-describedby={error ? 'login-error' : undefined}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  placeholder="123456"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  className="mb-3 w-full rounded-md border border-edge-strong bg-surface px-3 py-2 text-sm text-fg placeholder-fg-faint outline-none focus:border-accent-hover"
                />
              </>
            )}
            {error && <div id="login-error" role="alert" className="mb-3 text-xs text-danger">{error}</div>}
            <button
              type="submit"
              disabled={
                busy ||
                !email.trim() ||
                (path === 'code' && code.trim().length !== 6)
              }
              className={`w-full rounded-md py-2 text-sm font-semibold transition-colors disabled:bg-surface-overlay disabled:text-fg-muted ${
                methods.open
                  ? 'border border-edge-strong bg-surface-raised/40 text-fg hover:bg-surface-overlay'
                  : 'bg-accent text-on-accent hover:bg-accent-hover'
              }`}
            >
              {busy ? 'Working...' : path === 'email' ? 'Email me a code' : 'Sign in'}
            </button>
          </form>
        )}

        {path === 'code' && methods.email && (
          <>
            <button
              type="button"
              onClick={() => {
                setPath('email');
                setCode('');
                setError(null);
              }}
              className="mt-3 w-full text-xs text-fg-muted hover:text-fg-secondary"
            >
              Use a different email
            </button>
            {methods.open && (
              <button
                type="button"
                onClick={() => {
                  setPath('handle');
                  setCode('');
                  setError(null);
                }}
                className="mt-2 w-full text-xs font-medium text-fg-muted hover:text-fg-secondary"
              >
                Didn&apos;t get a code? Use a handle
              </button>
            )}
          </>
        )}

        {methods.open && path === 'email' && (
          <button
            type="button"
            onClick={() => {
              setPath('handle');
              setError(null);
            }}
            className="mt-3 w-full text-xs text-fg-muted hover:text-fg-secondary"
          >
            Use a handle instead
          </button>
        )}

        {!methods.open && !methods.email && error && (
          <div id="login-error" role="alert" className="mb-3 text-xs text-danger">{error}</div>
        )}

        {methods.google && (
          <a
            href="/auth/oauth/google"
            className="mt-3 block w-full rounded-md border border-edge-strong py-2 text-center text-sm font-semibold text-fg transition-colors hover:bg-surface-overlay"
          >
            Continue with Google
          </a>
        )}
      </div>
    </div>
  );
}
