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
  const [methods, setMethods] = useState<AuthMethods>({ open: true, email: true, google: false });
  const [step, setStep] = useState<'email' | 'code'>('email');
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

  const requestCode = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.requestEmailCode(email.trim());
      setStep('code');
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
    <div className="flex h-dvh items-center justify-center bg-zinc-950">
      <div className="w-80 rounded-xl border border-zinc-800 bg-zinc-900/60 p-6 shadow-2xl">
        <h1 className="text-lg font-bold tracking-tight text-zinc-100">Atrium</h1>
        <p className="mb-5 mt-1 text-xs text-pretty text-zinc-500">
          Sign in to your team's workspace.
        </p>

        <form onSubmit={step === 'email' ? requestCode : verifyCode}>
          <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-zinc-500">
            Email
          </label>
          <input
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="gary@example.com"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            disabled={step === 'code'}
            className="mb-3 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-indigo-500 disabled:text-zinc-500"
          />
          {step === 'code' && (
            <>
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                Code
              </label>
              <input
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="123456"
                inputMode="numeric"
                autoComplete="one-time-code"
                className="mb-3 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-indigo-500"
              />
            </>
          )}
          {error && <div className="mb-3 text-xs text-red-400">{error}</div>}
          <button
            type="submit"
            disabled={
              busy ||
              !email.trim() ||
              (step === 'code' && code.trim().length !== 6)
            }
            className="w-full rounded-md bg-indigo-600 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-500"
          >
            {busy ? 'Working...' : step === 'email' ? 'Email me a code' : 'Sign in'}
          </button>
        </form>

        {step === 'code' && (
          <button
            type="button"
            onClick={() => {
              setStep('email');
              setCode('');
              setError(null);
            }}
            className="mt-3 w-full text-xs text-zinc-500 hover:text-zinc-300"
          >
            Use a different email
          </button>
        )}

        {methods.google && (
          <a
            href="/auth/oauth/google"
            className="mt-3 block w-full rounded-md border border-zinc-700 py-2 text-center text-sm font-semibold text-zinc-100 transition-colors hover:bg-zinc-800"
          >
            Continue with Google
          </a>
        )}

        {methods.open && (
          <details className="mt-5 border-t border-zinc-800 pt-4">
            <summary className="cursor-pointer text-center text-xs text-zinc-500">
              dev login
            </summary>
            <form onSubmit={submitHandle} className="mt-4">
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                Handle
              </label>
              <input
                value={handle}
                onChange={(e) => setHandle(e.target.value)}
                placeholder="gary"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className="mb-3 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-indigo-500"
              />
              <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                Display name{' '}
                <span className="font-normal normal-case text-zinc-600">· optional</span>
              </label>
              <input
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Gary Basin"
                className="mb-4 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-indigo-500"
              />
              <button
                type="submit"
                disabled={busy || !handle.trim()}
                className="w-full rounded-md bg-zinc-800 py-2 text-sm font-semibold text-zinc-100 transition-colors hover:bg-zinc-700 disabled:text-zinc-500"
              >
                {busy ? 'Joining...' : 'Join with handle'}
              </button>
            </form>
          </details>
        )}
      </div>
    </div>
  );
}
