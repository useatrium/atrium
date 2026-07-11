import type { HubFile } from '@atrium/surface-client';
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
