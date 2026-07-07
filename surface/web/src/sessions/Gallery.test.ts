import { describe, expect, it } from 'vitest';
import { FILE_CATEGORIES } from '@atrium/surface-client';
import { galleryApiSearchParams, galleryPathForScope, galleryStateFromSearch } from './Gallery';

describe('Gallery query helpers', () => {
  it('defaults to workspace scope with explicit safe API defaults', () => {
    const state = galleryStateFromSearch('', { channelId: 'ch_1', sessionId: 'sess_1' });
    const params = galleryApiSearchParams(state);

    expect(state.scope).toBe('everything');
    expect(state.sort).toBe('recent');
    expect(state.includeScratch).toBe(false);
    expect(state.includeDeleted).toBe(false);
    expect(params.get('sort')).toBe('recent');
    expect(params.get('includeScratch')).toBe('false');
    expect(params.get('includeDeleted')).toBe('false');
    expect(params.has('channelId')).toBe(false);
    expect(params.has('sessionId')).toBe(false);
  });

  it('maps category, search, and channel scope into list params', () => {
    const category = FILE_CATEGORIES[0]!.key;
    const state = galleryStateFromSearch(
      `?q=logo&category=${category}&channelId=ch_1&sort=name&includeScratch=true&includeDeleted=true&starred=true&label=final`,
    );
    const params = galleryApiSearchParams(state);

    expect(state.scope).toBe('channel');
    expect(params.get('q')).toBe('logo');
    expect(params.get('category')).toBe(category);
    expect(params.get('channelId')).toBe('ch_1');
    expect(params.get('sort')).toBe('name');
    expect(params.get('includeScratch')).toBe('true');
    expect(params.get('includeDeleted')).toBe('true');
    expect(params.get('starred')).toBe('true');
    expect(params.get('label')).toBe('final');
  });

  it('prefers session scope over channel scope and builds session gallery links', () => {
    const state = galleryStateFromSearch('?channelId=ch_1&sessionId=sess_1');
    const params = galleryApiSearchParams(state);

    expect(state.scope).toBe('session');
    expect(params.get('sessionId')).toBe('sess_1');
    expect(params.has('channelId')).toBe(false);
    expect(galleryPathForScope({ sessionId: 'sess_1' })).toBe('/files?sessionId=sess_1');
  });
});
