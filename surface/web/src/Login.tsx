import { useState, type FormEvent } from 'react';
import { api } from './api';
import type { UserRef } from './state';

export function Login({ onLogin }: { onLogin: (user: UserRef) => void }) {
  const [handle, setHandle] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = await api.login(handle.trim(), displayName.trim() || handle.trim());
      onLogin(user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-screen items-center justify-center bg-zinc-950">
      <form
        onSubmit={submit}
        className="w-80 rounded-xl border border-zinc-800 bg-zinc-900/60 p-6 shadow-2xl"
      >
        <h1 className="text-lg font-bold tracking-tight text-zinc-100">Atrium</h1>
        <p className="mb-5 mt-1 text-xs text-zinc-500">
          Places — pick a handle to join the workspace.
        </p>
        <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-zinc-500">
          Handle
        </label>
        <input
          autoFocus
          value={handle}
          onChange={(e) => setHandle(e.target.value)}
          placeholder="gary"
          className="mb-3 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-indigo-500"
        />
        <label className="mb-1 block text-[11px] font-medium uppercase tracking-wide text-zinc-500">
          Display name
        </label>
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="Gary Basin"
          className="mb-4 w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder-zinc-600 outline-none focus:border-indigo-500"
        />
        {error && <div className="mb-3 text-xs text-red-400">{error}</div>}
        <button
          type="submit"
          disabled={busy || !handle.trim()}
          className="w-full rounded-md bg-indigo-600 py-2 text-sm font-semibold text-white transition-colors hover:bg-indigo-500 disabled:bg-zinc-800 disabled:text-zinc-500"
        >
          {busy ? 'Joining…' : 'Join'}
        </button>
      </form>
    </div>
  );
}
