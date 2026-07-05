// Version history for a markup artifact, surfaced inside the MarkupPane so a reader can
// see that a (persistent, shared) markup doc has evolved across suggestion rounds — and
// view or revert prior versions — without having to hunt for the file in the Files hub.
//
// STUB: fleshed out by the `hist` fan-out lane. The prop contract below is the seam the
// MarkupPane (`pane` lane) codes against and must not change.

import { useCallback, useMemo } from 'react';
import type { HubFileVersionsResponse } from '@atrium/surface-client';
import { VersionHistoryPanel } from './media/VersionHistoryPanel';
import type { PreviewFile } from './media/types';

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

async function responseError(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.clone().json()) as { message?: string; error?: string };
    return body.message ?? body.error ?? fallback;
  } catch {
    try {
      const text = await response.text();
      return text.trim() || fallback;
    } catch {
      return fallback;
    }
  }
}

export function MarkupVersionHistory(props: MarkupVersionHistoryProps) {
  const { artifactId, path, currentSeq, canManage, onClose, onReverted } = props;

  const file = useMemo<PreviewFile>(
    () => ({
      id: artifactId,
      name: path.split('/').pop() ?? path,
      mime: 'text/markdown',
      mediaKind: 'text',
      contentUrl: `/api/files/artifact/${artifactId}/content`,
      path,
    }),
    [artifactId, path],
  );

  const onListVersions = useCallback(
    async (_file: PreviewFile, signal?: AbortSignal) => {
      const response = await fetch(`/api/files/${artifactId}/versions`, {
        credentials: 'same-origin',
        signal,
      });
      if (!response.ok) throw new Error(await responseError(response, 'Could not load version history'));
      const body = (await response.json()) as HubFileVersionsResponse;
      return body.versions;
    },
    [artifactId],
  );

  const onFetchVersionContent = useCallback(
    async (_file: PreviewFile, seq?: number, signal?: AbortSignal) => {
      const params = new URLSearchParams();
      if (seq != null) params.set('at', String(seq));
      const suffix = params.toString() ? `?${params.toString()}` : '';
      const response = await fetch(`/api/files/artifact/${artifactId}/content${suffix}`, {
        credentials: 'same-origin',
        signal,
      });
      if (!response.ok) throw new Error(await responseError(response, 'Could not load version content'));
      return await response.blob();
    },
    [artifactId],
  );

  const onRevertVersion = useCallback(
    async (_file: PreviewFile, seq: number) => {
      const response = await fetch(`/api/files/${artifactId}/revert`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ seq }),
      });
      if (!response.ok)
        throw new Error(
          await responseError(
            response,
            response.status === 409 ? 'That version cannot be restored' : 'Could not restore version',
          ),
        );
      const body = (await response.json()) as { artifactId: string; seq: number };
      onReverted?.(body.seq);
    },
    [artifactId, onReverted],
  );

  const onRestoreFile = useCallback(
    async (_file: PreviewFile) => {
      const response = await fetch(`/api/files/${artifactId}/restore`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error(await responseError(response, 'Could not restore file'));
      const body = (await response.json()) as { artifactId: string; seq?: number };
      if (typeof body.seq === 'number') onReverted?.(body.seq);
    },
    [artifactId, onReverted],
  );

  return (
    <section className="flex h-full min-h-0 w-[min(460px,46vw)] min-w-80 flex-col border-l border-edge bg-surface">
      <div className="shrink-0 border-b border-edge px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-xs font-semibold text-fg">Version history</h2>
            <div className="mt-0.5 truncate text-3xs text-fg-muted" title={path}>
              {path} / current v{currentSeq}
            </div>
          </div>
          <button
            type="button"
            className="rounded-md border border-edge-strong px-2 py-1 text-3xs font-semibold text-fg-secondary hover:bg-surface-overlay hover:text-fg"
            onClick={() => onClose?.()}
          >
            Close
          </button>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden [&>aside]:h-full [&>aside]:w-full [&>aside]:min-w-0 [&>aside]:border-l-0">
        <VersionHistoryPanel
          file={file}
          canManage={canManage ?? true}
          onListVersions={onListVersions}
          onFetchVersionContent={onFetchVersionContent}
          onRevertVersion={onRevertVersion}
          onRestoreFile={onRestoreFile}
        />
      </div>
    </section>
  );
}
