import type { HubFile, HubFileVersionsResponse } from '@atrium/surface-client';
import { entryShareUrl } from '../lib/publicUrl';
import { URL_PARAMS } from '../router';
import type { ArtifactConflict, ResolveChoice } from './ConflictSurface';

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
