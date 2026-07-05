// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApplyMarkupMenu } from '../src/components/ApplyMarkupMenu';
import type { Session } from '../src/sessions/types';

const mocks = vi.hoisted(() => {
  class MockApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  }
  return {
    applyArtifactMarkup: vi.fn(),
    showErrorToast: vi.fn(),
    MockApiError,
  };
});

vi.mock('../src/api', () => ({
  ApiError: mocks.MockApiError,
  api: {
    applyArtifactMarkup: mocks.applyArtifactMarkup,
  },
}));

vi.mock('../src/components/Toasts', () => ({
  showErrorToast: mocks.showErrorToast,
}));

function session(overrides: Partial<Session>): Session {
  return {
    id: 'sess-1',
    channelId: 'ch-1',
    title: 'Edit run',
    status: 'running',
    createdAt: '2026-07-03T12:00:00.000Z',
    ...overrides,
  } as Session;
}

beforeEach(() => {
  mocks.applyArtifactMarkup.mockReset();
  mocks.showErrorToast.mockReset();
  vi.spyOn(crypto, 'randomUUID').mockReturnValue('00000000-0000-4000-8000-000000000001');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function openApplyMenu() {
  const trigger = screen.getByRole('button', { name: /Apply with agent/ });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: 'ArrowDown' });
}

describe('ApplyMarkupMenu', () => {
  it('applies markup to the selected channel session with an op id', async () => {
    mocks.applyArtifactMarkup.mockResolvedValue({ seq: 7, status: 'normal', steered: true, applied: true });
    render(
      <ApplyMarkupMenu
        artifactId="art-1"
        path="docs/plan.md"
        channelId="ch-1"
        sessions={{ 'sess-1': session({ id: 'sess-1', title: 'Edit run' }) }}
      />,
    );

    await openApplyMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: /Edit run/ }));

    await waitFor(() =>
      expect(mocks.applyArtifactMarkup).toHaveBeenCalledWith('art-1', {
        sessionId: 'sess-1',
        opId: '00000000-0000-4000-8000-000000000001',
      }),
    );
    expect(await screen.findByText('Sent to Edit run')).toBeTruthy();
  });

  it('shows a no-markup toast for 400 no_markup responses', async () => {
    mocks.applyArtifactMarkup.mockRejectedValue(new mocks.MockApiError(400, 'no_markup'));
    render(
      <ApplyMarkupMenu
        artifactId="art-1"
        path="docs/plan.md"
        channelId="ch-1"
        sessions={{ 'sess-1': session({}) }}
      />,
    );

    await openApplyMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: /Edit run/ }));

    await waitFor(() => expect(mocks.showErrorToast).toHaveBeenCalledWith('No markup in this document'));
  });

  it('emits the prefilled new-agent task', async () => {
    const onSpawnNewAgent = vi.fn();
    render(
      <ApplyMarkupMenu
        artifactId="art-1"
        path="docs/plan.md"
        channelId="ch-1"
        sessions={{}}
        onSpawnNewAgent={onSpawnNewAgent}
      />,
    );

    await openApplyMenu();
    fireEvent.click(await screen.findByRole('menuitem', { name: 'New agent...' }));

    expect(onSpawnNewAgent).toHaveBeenCalledWith(
      'Apply the markup in docs/plan.md (my tracked changes + comments): read it, apply the edits, address the comments, and produce a clean revision of the file.',
    );
  });
});
