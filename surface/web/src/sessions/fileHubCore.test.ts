import { describe, expect, it } from 'vitest';
import type { HubFile } from '@atrium/surface-client';
import { fileMatchesSessionScope, hubFileToPreview } from './fileHubCore';

function hubFile(overrides: Partial<HubFile> = {}): HubFile {
  return {
    artifactId: 'art-1',
    workspaceId: 'ws-1',
    path: 'reports/result.md',
    name: 'result.md',
    mime: 'text/markdown',
    mediaKind: 'text',
    isText: true,
    sizeBytes: 1200,
    origin: 'agent',
    channelId: null,
    sessionId: null,
    sourceMessageId: null,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    versionSeq: 1,
    labels: [],
    starred: false,
    tombstoned: false,
    ...overrides,
  };
}

describe('fileMatchesSessionScope', () => {
  it('matches exact paths', () => {
    expect(fileMatchesSessionScope('src/app.ts', ['src/app.ts'])).toBe(true);
  });

  it('matches descendants of touched directories', () => {
    expect(fileMatchesSessionScope('src/components/Button.tsx', ['src/components'])).toBe(true);
  });

  it('does not match unrelated paths', () => {
    expect(fileMatchesSessionScope('src/components/Button.tsx', ['docs/components'])).toBe(false);
  });

  it('normalizes ledger prefixes, workspace absolute paths, and backslashes', () => {
    expect(
      fileMatchesSessionScope('shared/channels/22222222-2222-4222-8222-222222222222/src/app.ts', [
        '/home/agent/workspace/src/app.ts',
      ]),
    ).toBe(true);
    expect(
      fileMatchesSessionScope('scratch/11111111-1111-4111-8111-111111111111/out/chart.png', ['out\\chart.png']),
    ).toBe(true);
  });
});

describe('hubFileToPreview', () => {
  it('maps a hub row onto the media preview shape with a content URL', () => {
    const preview = hubFileToPreview(
      hubFile({ artifactId: 'art_image', name: 'diagram.png', path: 'images/diagram.png', mediaKind: 'image' }),
    );
    expect(preview.id).toBe('art_image');
    expect(preview.name).toBe('diagram.png');
    expect(preview.mediaKind).toBe('image');
    expect(preview.contentUrl).toBe('/api/files/artifact/art_image/content');
  });

  it('coerces unknown media kinds to opaque and derives the source scope', () => {
    const preview = hubFileToPreview(hubFile({ mediaKind: 'not-a-kind' as HubFile['mediaKind'], channelId: 'ch-1' }));
    expect(preview.mediaKind).toBe('opaque');
    expect(preview.source).toEqual({ kind: 'channel', id: 'ch-1' });
  });
});
