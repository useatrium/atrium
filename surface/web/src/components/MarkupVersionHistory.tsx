// Version history for a markup artifact, surfaced inside the MarkupPane so a reader can
// see that a (persistent, shared) markup doc has evolved across suggestion rounds — and
// view or revert prior versions — without having to hunt for the file in the Files hub.
//
// STUB: fleshed out by the `hist` fan-out lane. The prop contract below is the seam the
// MarkupPane (`pane` lane) codes against and must not change.

export interface MarkupVersionHistoryProps {
  /** Artifact whose version history to show. */
  artifactId: string;
  /** Display path of the artifact (for labelling / building a PreviewFile). */
  path: string;
  /** The seq currently open in the editor (the head being marked up). */
  currentSeq: number;
  /** Whether the current viewer may revert to a prior version. */
  canManage?: boolean;
  /** Fired after a successful revert; passes the new head seq so the pane can reload. */
  onReverted?: (seq: number) => void;
  /** Fired when the panel requests to close. */
  onClose?: () => void;
}

export function MarkupVersionHistory(_props: MarkupVersionHistoryProps) {
  return null;
}
