// Artifacts surface (Phase 4): the work-product files a session produced,
// surfaced by the sandbox capture sidecar as `artifact.captured` frames and
// folded into SessionState.artifacts by the reducer. Unlike Changes (derived
// from edit tool_calls) the bytes are captured out-of-band; `ref` keys them in
// Centaur staging until atrium offloads them to its own store.

import type { Artifact, ArtifactPresentation, SessionState } from "./reducer.js";
import { displayPath } from "./fileChanges.js";

export type { Artifact, ArtifactKind, ArtifactPresentation } from "./reducer.js";

/** Every captured artifact, paths stripped to display form. A file captured
 * across turns yields one entry per distinct content (version history). */
export function collectArtifacts(state: SessionState): Artifact[] {
  return state.artifacts.map((a) => ({ ...a, path: displayPath(a.path) }));
}

/** Artifacts the agent intentionally presented, paths stripped to the same
 * display form as captured artifacts so UI matching works across absolute
 * sandbox paths and shared/... paths. */
export function collectArtifactPresentations(state: SessionState): ArtifactPresentation[] {
  return state.artifactPresentations.map((presentation) => ({
    ...presentation,
    path: displayPath(presentation.path),
  }));
}

/** Distinct file paths captured — drives the "Artifacts·N" strip count. */
export function artifactPaths(artifacts: Artifact[]): string[] {
  const seen = new Set<string>();
  for (const a of artifacts) seen.add(a.path);
  return [...seen];
}

export function artifactCount(artifacts: Artifact[]): number {
  return artifacts.length;
}
