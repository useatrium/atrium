import { useEffect, useMemo, useState } from 'react';
import {
  collectArtifactPresentations,
  type ArtifactPresentation,
  type SessionState,
} from '@atrium/centaur-client';
import { sessionsApi } from './api';

const APP_MANIFEST_RE = /shared\/apps\/[^/]+\/atrium\.app\.json$/;

export function useArtifactPresentations(
  sessionId: string,
  stream: SessionState,
): ArtifactPresentation[] {
  const [hydrated, setHydrated] = useState<ArtifactPresentation[]>([]);

  const manifestKey = useMemo(
    () =>
      stream.artifacts
        .filter((artifact) => APP_MANIFEST_RE.test(artifact.path))
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
  }, [sessionId, manifestKey]);

  const frameDerived = useMemo(
    () => collectArtifactPresentations(stream),
    [stream.artifactPresentations],
  );

  return useMemo(() => {
    const byPath = new Map<string, ArtifactPresentation>();
    for (const presentation of frameDerived) byPath.set(presentation.path, presentation);
    for (const presentation of hydrated) byPath.set(presentation.path, presentation);
    return [...byPath.values()];
  }, [frameDerived, hydrated]);
}
