import { describe, expect, it } from 'vitest';
import { FILE_CATEGORIES, fileTypeLabel, isAppPath, matchesCategory } from './files-hub';

const f = (over: Partial<Parameters<typeof matchesCategory>[0]>) => ({
  mediaKind: null as string | null,
  path: 'shared/global/x',
  origin: 'agent' as const,
  ...over,
});

describe('matchesCategory', () => {
  it('images match by media kind', () => {
    expect(matchesCategory(f({ mediaKind: 'image', path: 'a/b/chart.png' }), 'image')).toBe(true);
    expect(matchesCategory(f({ mediaKind: 'document' }), 'image')).toBe(false);
  });

  it('docs match documents, pdfs, markdown, and plain text', () => {
    expect(matchesCategory(f({ mediaKind: 'document' }), 'doc')).toBe(true);
    expect(matchesCategory(f({ mediaKind: 'pdf', path: 'r.pdf' }), 'doc')).toBe(true);
    expect(matchesCategory(f({ mediaKind: 'text', path: 'notes.md' }), 'doc')).toBe(true);
    // a .csv classified as text is data, not a doc
    expect(matchesCategory(f({ mediaKind: 'text', path: 'report.csv' }), 'doc')).toBe(false);
  });

  it('data matches csv/json/yaml by kind or extension', () => {
    expect(matchesCategory(f({ mediaKind: 'json' }), 'data')).toBe(true);
    expect(matchesCategory(f({ mediaKind: 'text', path: 'report.csv' }), 'data')).toBe(true);
    expect(matchesCategory(f({ path: 'config.yaml' }), 'data')).toBe(true);
  });

  it('apps match by canonical path, workspace-flat or channel-scoped', () => {
    expect(matchesCategory(f({ path: 'shared/apps/button-page/index.html' }), 'app')).toBe(true);
    expect(matchesCategory(f({ path: 'shared/channels/c1/apps/foo/index.html' }), 'app')).toBe(true);
    expect(matchesCategory(f({ path: 'shared/global/notes.md' }), 'app')).toBe(false);
  });

  it('uploads match by human-upload origin', () => {
    expect(matchesCategory(f({ origin: 'upload' }), 'upload')).toBe(true);
    expect(matchesCategory(f({ origin: 'agent' }), 'upload')).toBe(false);
  });
});

describe('fileTypeLabel', () => {
  it('labels apps as APP regardless of extension', () => {
    expect(fileTypeLabel({ path: 'shared/apps/x/index.html', mime: null, mediaKind: 'text' })).toBe('APP');
  });
  it('uses the file extension when present', () => {
    expect(fileTypeLabel({ path: 'a/chart.png', mime: null, mediaKind: 'image' })).toBe('PNG');
    expect(fileTypeLabel({ path: 'a/report.CSV', mime: null, mediaKind: 'data' })).toBe('CSV');
  });
  it('falls back to media kind then FILE', () => {
    expect(fileTypeLabel({ path: 'noext', mime: null, mediaKind: 'binary' })).toBe('BINA');
    expect(fileTypeLabel({ path: 'noext', mime: null, mediaKind: null })).toBe('FILE');
  });
});

describe('FILE_CATEGORIES', () => {
  it('exposes the five gallery chips in order', () => {
    expect(FILE_CATEGORIES.map((c) => c.key)).toEqual(['image', 'doc', 'data', 'app', 'upload']);
  });
  it('isAppPath agrees with the app category', () => {
    expect(isAppPath('shared/apps/x/index.html')).toBe(true);
    expect(isAppPath('scratch/s1/x.txt')).toBe(false);
  });
});
