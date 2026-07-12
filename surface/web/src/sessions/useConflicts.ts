// Live conflict feed for a session (A3). Polls the gap-free change-feed for
// status=conflict rows, hydrates each via the conflict-detail endpoint, and
// exposes a resolve() that maps a ResolveChoice to the right write-back (chosen
// side bytes / merged text / stay-deleted). Drives the WorkDrawer Conflicts tab.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ArtifactConflict, ResolveChoice } from './ConflictSurface';

interface ChangeRow {
  path: string;
  status: 'normal' | 'conflict';
}

export interface UseConflicts {
  conflicts: ArtifactConflict[];
  resolve: (artifactId: string, choice: ResolveChoice) => Promise<void>;
  refresh: () => Promise<void>;
}

export function useConflicts(
  sessionId: string | null,
  opts: { pollMs?: number; enabled?: boolean } = {},
): UseConflicts {
  const { pollMs = 5000, enabled = true } = opts;
  const [conflicts, setConflicts] = useState<ArtifactConflict[]>([]);
  const cursorRef = useRef('0.0');
  const pathsRef = useRef<Set<string>>(new Set());

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    try {
      // 1. Drain new change rows; a path's newest row decides if it's conflicted.
      const feed = await fetch(`/api/sessions/${sessionId}/artifacts/changes?since=${cursorRef.current}`, {
        credentials: 'same-origin',
      });
      if (!feed.ok) return;
      const { rows, next_cursor } = (await feed.json()) as { rows: ChangeRow[]; next_cursor: string };
      cursorRef.current = next_cursor;
      for (const r of rows) {
        if (r.status === 'conflict') pathsRef.current.add(r.path);
        else pathsRef.current.delete(r.path); // a later normal version resolved it
      }
      // 2. Hydrate detail for each still-conflicted path; drop any that 404 (raced-resolved).
      const details = await Promise.all(
        [...pathsRef.current].map(async (path) => {
          const r = await fetch(`/api/sessions/${sessionId}/artifacts/conflict?path=${encodeURIComponent(path)}`, {
            credentials: 'same-origin',
          });
          if (!r.ok) {
            pathsRef.current.delete(path);
            return null;
          }
          return (await r.json()) as ArtifactConflict;
        }),
      );
      setConflicts(details.filter((d): d is ArtifactConflict => d != null));
    } catch {
      // Network/parse hiccup or no backend (mock mode) — stay inert, retry next tick.
    }
  }, [sessionId]);

  useEffect(() => {
    if (!enabled || !sessionId) return;
    let alive = true;
    void refresh();
    const t = setInterval(() => {
      if (alive) void refresh();
    }, pollMs);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [enabled, sessionId, pollMs, refresh]);

  const resolve = useCallback(
    async (artifactId: string, choice: ResolveChoice) => {
      if (!sessionId) return;
      const conflict = conflicts.find((c) => c.artifactId === artifactId);
      const side = choice.kind === 'left' ? conflict?.left : choice.kind === 'right' ? conflict?.right : null;
      const headers: Record<string, string> = { 'content-type': 'text/plain' };
      let body = '';
      if (choice.kind === 'merged') body = choice.text;
      else if (side && side.sha === null)
        headers['x-artifact-delete'] = 'true'; // stay-deleted
      else body = side?.text ?? '';
      await fetch(`/api/sessions/${sessionId}/artifacts/${artifactId}/resolve`, {
        method: 'POST',
        credentials: 'same-origin',
        headers,
        body,
      });
      await refresh();
    },
    [sessionId, conflicts, refresh],
  );

  return { conflicts, resolve, refresh };
}
