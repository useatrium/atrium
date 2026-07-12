import { useEffect, useMemo, useState } from 'react';
import type { ArtifactPresentation, SessionState } from '@atrium/centaur-client';
import { sessionsApi } from './api';

// Presentation is automatic: any file captured under an app dir can change what
// the presentations endpoint returns (a new index.html dir, or an atrium.app.json
// metadata edit), so refetch whenever the set of shared/apps/<slug>/ files shifts.
const APP_DIR_RE = /shared\/apps\/[^/]+\//;

export function useArtifactPresentations(sessionId: string, stream: SessionState): ArtifactPresentation[] {
  const [hydrated, setHydrated] = useState<ArtifactPresentation[]>([]);

  const appDirKey = useMemo(
    () =>
      stream.artifacts
        .filter((artifact) => APP_DIR_RE.test(artifact.path))
        .map((artifact) => artifact.path)
        .sort()
        .join('|'),
    [stream.artifacts],
  );

  useEffect(() => {
    let disposed = false;
    sessionsApi
      .listPresentations(sessionId)
      .then(({ presentations }) => {
        if (!disposed) setHydrated(Array.isArray(presentations) ? presentations : []);
      })
      .catch(() => {
        if (!disposed) setHydrated([]);
      });
    return () => {
      disposed = true;
    };
  }, [sessionId, appDirKey]);

  return hydrated;
}
