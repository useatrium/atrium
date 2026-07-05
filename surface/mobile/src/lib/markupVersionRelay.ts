import type { Api, HubFileVersion } from '@atrium/surface-client';
import type { MarkupVersionOp } from './markupAuthoring';

export interface MarkupVersionRelayDeps {
  api: Pick<Api, 'listFileVersions' | 'revertFileVersion' | 'restoreFile'>;
  serverUrl: string;
  fileHeaders?: Record<string, string>;
  artifactId: string;
}

export interface MarkupVersionRelayResponse {
  reqId: string;
  ok: boolean;
  versions?: HubFileVersion[];
  content?: string;
  seq?: number;
  error?: string;
}

export async function runMarkupVersionRequest(
  deps: MarkupVersionRelayDeps,
  req: { reqId: string; op: MarkupVersionOp; seq?: number },
): Promise<MarkupVersionRelayResponse> {
  try {
    if (req.op === 'list') {
      const res = await deps.api.listFileVersions(deps.artifactId);
      return { reqId: req.reqId, ok: true, versions: res.versions };
    }

    if (req.op === 'content') {
      const response = await fetch(
        `${deps.serverUrl.replace(/\/+$/, '')}/api/files/artifact/${encodeURIComponent(deps.artifactId)}/content${
          req.seq != null ? `?at=${req.seq}` : ''
        }`,
        { headers: deps.fileHeaders },
      );
      if (!response.ok) {
        throw new Error('Could not load file content');
      }
      return { reqId: req.reqId, ok: true, content: await response.text() };
    }

    if (req.op === 'revert') {
      const res = await deps.api.revertFileVersion(deps.artifactId, req.seq!);
      return { reqId: req.reqId, ok: true, seq: res.seq };
    }

    const res = await deps.api.restoreFile(deps.artifactId);
    const restoredSeq = (res as { seq?: number }).seq;
    return {
      reqId: req.reqId,
      ok: true,
      ...(typeof restoredSeq === 'number' ? { seq: restoredSeq } : {}),
    };
  } catch (err) {
    return {
      reqId: req.reqId,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
