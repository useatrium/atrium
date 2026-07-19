// Artifacts surface (Phase 4): the work-product files a session produced,
// folded into SessionState.artifacts by the reducer. Modern byte serving goes
// through Atrium's by-path CAS route; legacy `artifact.captured` frames remain
// display metadata in older transcripts.

import type { Artifact, SessionState } from './reducer.js';
import { displayPath } from './fileChanges.js';

export type { Artifact, ArtifactKind, ArtifactPresentation } from './reducer.js';

/** Every captured artifact, paths stripped to display form. A file captured
 * across turns yields one entry per distinct content (version history). */
export function collectArtifacts(state: SessionState): Artifact[] {
  return state.artifacts.map((a) => ({ ...a, path: displayPath(a.path) }));
}

export function artifactCount(artifacts: Artifact[]): number {
  return artifacts.length;
}
