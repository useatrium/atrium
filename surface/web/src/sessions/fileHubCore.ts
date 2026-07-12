import type { HubFile, HubFileVersionsResponse } from '@atrium/surface-client';
import { entryShareUrl } from '../lib/publicUrl';
import { URL_PARAMS } from '../router';
import type { ArtifactConflict, ResolveChoice } from './ConflictSurface';
import type { LightboxCallbacks } from '../components/media';

export function artifactContentUrl(artifactId: string): string {
  return `/api/files/artifact/${artifactId}/content`;
}

export function cleanId(value: string | null | undefined): string {
  return value?.trim() ?? '';
}

export function pathWithSearch(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export function lightboxPanelFromSearch(search: string): 'info' | 'history' | null {
  const value = new URLSearchParams(search).get(URL_PARAMS.panel);
  return value === 'info' || value === 'history' ? value : null;
}

export function artifactEntryHandle(artifactId: string): string {
  return `art_${artifactId}`;
}

export function artifactEntryUrl(artifactId: string): string {
  return entryShareUrl(artifactEntryHandle(artifactId));
}

export async function responseError(response: Response, fallback: string): Promise<string> {
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

export async function listArtifactVersions(artifactId: string, signal?: AbortSignal) {
  const response = await fetch(`/api/files/${artifactId}/versions`, {
    credentials: 'same-origin',
    signal,
  });
  if (!response.ok) throw new Error(await responseError(response, 'Could not load version history'));
  return ((await response.json()) as HubFileVersionsResponse).versions;
}

export async function fetchArtifactVersionContent(
  artifactId: string,
  seq?: number | null,
  signal?: AbortSignal,
): Promise<Blob> {
  const suffix = seq == null ? '' : `?at=${encodeURIComponent(seq)}`;
  const response = await fetch(`${artifactContentUrl(artifactId)}${suffix}`, {
    credentials: 'same-origin',
    signal,
  });
  if (!response.ok) throw new Error(await responseError(response, 'Could not load version content'));
  return response.blob();
}

export function mergeFile(files: HubFile[], next: HubFile): HubFile[] {
  return files.map((file) => (file.artifactId === next.artifactId ? next : file));
}

export function updateFile(files: HubFile[], artifactId: string, patch: Partial<HubFile>): HubFile[] {
  return files.map((file) => (file.artifactId === artifactId ? { ...file, ...patch } : file));
}

export function resolvedConflictText(conflict: ArtifactConflict, choice: ResolveChoice): string {
  if (choice.kind === 'left') return conflict.left.text;
  if (choice.kind === 'right') return conflict.right.text;
  return choice.text;
}

type SharedLightboxCallbacks = Pick<
  LightboxCallbacks,
  | 'onDownload'
  | 'onRename'
  | 'onDelete'
  | 'onListVersions'
  | 'onFetchVersionContent'
  | 'onRevertVersion'
  | 'onRestoreFile'
  | 'onSaveText'
  | 'onLoadConflict'
  | 'onResolveConflict'
  | 'canManage'
>;

export function createFileLightboxCallbacks({
  files,
  setFiles,
  includeDeleted,
  reload,
  showError,
}: {
  files: HubFile[];
  setFiles: (update: (current: HubFile[]) => HubFile[]) => void;
  includeDeleted: boolean;
  reload: () => Promise<unknown>;
  showError: (message: string) => void;
}): SharedLightboxCallbacks {
  return {
    onDownload: (file) => window.open(artifactContentUrl(file.id), '_blank', 'noopener,noreferrer'),
    onRename: async (file, name) => {
      const previous = files.find((item) => item.artifactId === file.id);
      if (!previous) return;
      setFiles((current) => updateFile(current, file.id, { name }));
      try {
        const response = await fetch(`/api/files/${file.id}`, {
          method: 'PATCH',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        if (!response.ok) {
          throw new Error(
            await responseError(
              response,
              response.status === 409 ? 'A file with that name already exists' : 'Could not rename file',
            ),
          );
        }
        const body = (await response.json()) as { artifactId: string; path: string; name: string };
        setFiles((current) => updateFile(current, body.artifactId, { name: body.name, path: body.path }));
      } catch (err) {
        setFiles((current) => mergeFile(current, previous));
        showError(err instanceof Error ? err.message : 'Could not rename file');
        throw err;
      }
    },
    onDelete: async (file) => {
      const previous = files.find((item) => item.artifactId === file.id);
      if (!previous) return;
      setFiles((current) =>
        includeDeleted
          ? updateFile(current, file.id, { tombstoned: true })
          : current.filter((item) => item.artifactId !== file.id),
      );
      try {
        const response = await fetch(`/api/files/${file.id}`, { method: 'DELETE', credentials: 'same-origin' });
        if (!response.ok) {
          const fallback =
            response.status === 403 ? 'You do not have permission to delete this file' : 'Could not delete file';
          throw new Error(await responseError(response, fallback));
        }
      } catch (err) {
        setFiles((current) =>
          current.some((item) => item.artifactId === previous.artifactId)
            ? mergeFile(current, previous)
            : [...current, previous],
        );
        showError(err instanceof Error ? err.message : 'Could not delete file');
        throw err;
      }
    },
    onListVersions: async (file, signal) => {
      try {
        return await listArtifactVersions(file.id, signal);
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          showError(err instanceof Error ? err.message : 'Could not load version history');
        }
        throw err;
      }
    },
    onFetchVersionContent: async (file, seq, signal) => {
      try {
        return await fetchArtifactVersionContent(file.id, seq, signal);
      } catch (err) {
        if (!(err instanceof DOMException && err.name === 'AbortError')) {
          showError(err instanceof Error ? err.message : 'Could not load version content');
        }
        throw err;
      }
    },
    onRevertVersion: async (file, seq) => {
      try {
        const response = await fetch(`/api/files/${file.id}/revert`, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ seq }),
        });
        if (!response.ok) {
          throw new Error(
            await responseError(
              response,
              response.status === 409 ? 'That version cannot be restored' : 'Could not restore version',
            ),
          );
        }
        const body = (await response.json()) as { artifactId: string; seq: number; tombstoned: false };
        setFiles((current) => updateFile(current, body.artifactId, { versionSeq: body.seq, tombstoned: false }));
        await reload();
      } catch (err) {
        showError(err instanceof Error ? err.message : 'Could not restore version');
        throw err;
      }
    },
    onRestoreFile: async (file) => {
      try {
        const response = await fetch(`/api/files/${file.id}/restore`, {
          method: 'POST',
          credentials: 'same-origin',
        });
        if (!response.ok) throw new Error(await responseError(response, 'Could not restore file'));
        const body = (await response.json()) as { artifactId: string; tombstoned: false };
        setFiles((current) => updateFile(current, body.artifactId, { tombstoned: body.tombstoned }));
        await reload();
      } catch (err) {
        showError(err instanceof Error ? err.message : 'Could not restore file');
        throw err;
      }
    },
    onSaveText: async (file, text, baseSeq) => {
      const response = await fetch(`/api/files/${file.id}/content`, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: {
          'X-Artifact-Base-Seq': String(baseSeq),
          'Content-Type': file.mime || 'text/plain',
        },
        body: text,
      });
      if (response.status === 409) {
        const message = 'File changed on the server — reload and retry';
        showError(message);
        await reload();
        throw new Error(message);
      }
      if (response.status === 415) {
        const message = 'This file cannot be edited as text.';
        showError(message);
        throw new Error(message);
      }
      if (response.status === 403) {
        const message = "You don't have permission to edit this file.";
        showError(message);
        throw new Error(message);
      }
      if (!response.ok) {
        const message = await responseError(response, 'Could not save file');
        showError(message);
        throw new Error(message);
      }
      const body = (await response.json()) as { seq: number; status: 'normal' | 'conflict' };
      setFiles((current) => updateFile(current, file.id, { versionSeq: body.seq, tombstoned: false }));
      await reload();
      return body;
    },
    onLoadConflict: async (file) => {
      const response = await fetch(`/api/files/${file.id}/conflict`, { credentials: 'same-origin' });
      if (!response.ok) {
        const fallback = response.status === 404 ? 'No conflict found for this file' : 'Could not load file conflict';
        const message = await responseError(response, fallback);
        showError(message);
        throw new Error(message);
      }
      return (await response.json()) as ArtifactConflict;
    },
    onResolveConflict: async (file, conflict, choice) => {
      const headers: Record<string, string> = {
        'X-Artifact-Base-Seq': String(conflict.conflictSeq),
        'Content-Type': file.mime || 'text/plain',
      };
      if (
        (choice.kind === 'left' && conflict.left.sha === null) ||
        (choice.kind === 'right' && conflict.right.sha === null)
      ) {
        headers['X-Artifact-Delete'] = 'true';
      }
      const response = await fetch(`/api/files/${file.id}/resolve`, {
        method: 'POST',
        credentials: 'same-origin',
        headers,
        body: resolvedConflictText(conflict, choice),
      });
      if (response.status === 403) {
        const message = "You don't have permission to edit this file.";
        showError(message);
        throw new Error(message);
      }
      if (!response.ok) {
        const message = await responseError(response, 'Could not resolve file conflict');
        showError(message);
        throw new Error(message);
      }
      const body = (await response.json()) as { seq: number; status: string };
      setFiles((current) => updateFile(current, file.id, { versionSeq: body.seq, tombstoned: false }));
      await reload();
      return body;
    },
    canManage: () => true,
  };
}
