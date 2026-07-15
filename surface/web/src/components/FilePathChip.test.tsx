// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseAgentPathHref } from '@atrium/surface-client/agent-paths';
import { FilePathChip } from './FilePathChip';

const navigateMock = vi.hoisted(() => vi.fn());
const showErrorToastMock = vi.hoisted(() => vi.fn());

vi.mock('../router', async (importOriginal) => {
  const original = await importOriginal<typeof import('../router')>();
  return { ...original, navigate: navigateMock };
});

vi.mock('./Toasts', () => ({ showErrorToast: showErrorToastMock }));

const CHANNEL_ID = '121a247c-e270-4783-a9d4-cb80ec984188';

beforeEach(() => {
  navigateMock.mockReset();
  showErrorToastMock.mockReset();
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('FilePathChip', () => {
  it('resolves metadata and navigates to the Files lightbox', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          artifactId: 'artifact-1',
          path: `shared/channels/${CHANNEL_ID}/reports/notes.md`,
          tombstoned: false,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    const refInfo = parseAgentPathHref(`/home/agent/shared/channels/${CHANNEL_ID}/reports/notes.md`)!;
    render(<FilePathChip refInfo={refInfo} />);

    fireEvent.click(screen.getByRole('button', { name: 'notes.md' }));

    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith(
        `/files?dir=shared%2Fchannels%2F${CHANNEL_ID}%2Freports&file=artifact-1`,
      ),
    );
  });

  it('toasts on a failed resolution and stays clickable for retry', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 404 }));
    const refInfo = parseAgentPathHref(`/home/agent/shared/channels/${CHANNEL_ID}/missing.md`)!;
    render(<FilePathChip refInfo={refInfo} />);

    const chip = screen.getByRole('button', { name: 'missing.md' });
    fireEvent.click(chip);

    await waitFor(() =>
      expect(showErrorToastMock).toHaveBeenCalledWith(
        "Couldn't open missing.md — the file wasn't captured or was removed.",
      ),
    );
    expect(chip.hasAttribute('disabled')).toBe(false);
    expect(navigateMock).not.toHaveBeenCalled();

    // Capture landed later: a retry on the same chip now resolves.
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          artifactId: 'artifact-2',
          path: `shared/channels/${CHANNEL_ID}/missing.md`,
          tombstoned: false,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    fireEvent.click(chip);
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith(`/files?dir=shared%2Fchannels%2F${CHANNEL_ID}&file=artifact-2`),
    );
  });

  it('toasts a distinct message for transient failures', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError('network down'));
    const refInfo = parseAgentPathHref(`/home/agent/shared/channels/${CHANNEL_ID}/flaky.md`)!;
    render(<FilePathChip refInfo={refInfo} />);

    fireEvent.click(screen.getByRole('button', { name: 'flaky.md' }));

    await waitFor(() => expect(showErrorToastMock).toHaveBeenCalledWith("Couldn't open flaky.md — try again."));
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
