// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreviewFile } from '../types';
import { OfficeRenderer } from './OfficeRenderer';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('OfficeRenderer tiles', () => {
  it.each([
    ['report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ])('uses the thumbnail without fetching the full %s body', async (name, mime) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const file: PreviewFile = {
      id: `art_${name}`,
      name,
      mime,
      mediaKind: 'document',
      contentUrl: `/content/${name}`,
      thumbnailUrl: `/thumbnail/${name}`,
    };

    render(<OfficeRenderer file={file} variant="tile" />);
    await act(async () => Promise.resolve());

    expect(screen.getByRole('img', { name })).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['report.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'DOCX'],
    ['sheet.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'XLSX'],
  ])('uses a file fallback without fetching an unthumbnailed %s body', async (name, mime, extension) => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const file: PreviewFile = {
      id: `art_${name}`,
      name,
      mime,
      mediaKind: 'document',
      contentUrl: `/content/${name}`,
    };

    render(<OfficeRenderer file={file} variant="tile" />);
    await act(async () => Promise.resolve());

    expect(screen.getByText(name)).toBeTruthy();
    expect(screen.getByText(extension)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
