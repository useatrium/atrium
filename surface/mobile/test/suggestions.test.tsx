// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { SessionSuggestion } from '@atrium/surface-client';
import { SuggestionsStrip, type OptimisticSuggestionSend } from '../src/components/work/SuggestionsStrip';
import { renderWithTheme as renderUI } from './rnTestUtils';

afterEach(cleanup);

function suggestion(overrides: Partial<SessionSuggestion> = {}): SessionSuggestion {
  return {
    id: 'sug-1',
    authorId: 'user-1',
    authorName: 'Ada',
    text: 'Try asking for a smaller patch.',
    status: 'pending',
    createdAt: '2026-06-21T12:00:00.000Z',
    ...overrides,
  };
}

function renderStrip(
  overrides: {
    suggestions?: SessionSuggestion[];
    isDriver?: boolean;
    onSend?: (suggestionId: string) => void | Promise<void>;
    onEditSend?: (suggestionId: string, text: string) => void | Promise<void>;
    onDismiss?: (suggestionId: string, note?: string) => void | Promise<void>;
    onOptimisticSend?: (input: OptimisticSuggestionSend) => string | undefined;
    onOptimisticSendFailed?: (pendingId: string) => void;
  } = {},
) {
  const props = {
    suggestions: overrides.suggestions ?? [suggestion()],
    isDriver: overrides.isDriver ?? true,
    onSend: overrides.onSend ?? vi.fn(),
    onEditSend: overrides.onEditSend ?? vi.fn(),
    onDismiss: overrides.onDismiss ?? vi.fn(),
    onOptimisticSend: overrides.onOptimisticSend,
    onOptimisticSendFailed: overrides.onOptimisticSendFailed,
  };

  return {
    ...renderUI(<SuggestionsStrip {...props} />),
    props,
  };
}

describe('SuggestionsStrip (mobile)', () => {
  it('shows pending driver actions and sends the selected suggestion', () => {
    const onSend = vi.fn();
    renderStrip({
      onSend,
      suggestions: [suggestion({ id: 'sug-1' }), suggestion({ id: 'sug-sent', status: 'sent', text: 'Already sent.' })],
    });

    const strip = screen.getByTestId('suggestion-strip');
    expect(within(strip).getByText('Suggestions · 1')).toBeInTheDocument();
    expect(within(strip).getByText('Ada')).toBeInTheDocument();
    expect(within(strip).getByText('Try asking for a smaller patch.')).toBeInTheDocument();
    expect(screen.queryByText('Already sent.')).toBeNull();

    fireEvent.click(within(strip).getByRole('button', { name: 'Send' }));
    expect(onSend).toHaveBeenCalledWith('sug-1');
  });

  it('fires optimistic send when the driver sends a suggestion', () => {
    const onOptimisticSend = vi.fn(() => 'pending-1');
    renderStrip({ onOptimisticSend });

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(onOptimisticSend).toHaveBeenCalledWith({
      suggestion: expect.objectContaining({ id: 'sug-1', authorName: 'Ada' }),
      text: 'Try asking for a smaller patch.',
      edited: false,
    });
  });

  it('sends an edited suggestion with the new text', () => {
    const onEditSend = vi.fn();
    renderStrip({ onEditSend });

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Edit suggestion'), {
      target: { value: 'Try asking for a focused patch and tests.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send edited' }));

    expect(onEditSend).toHaveBeenCalledWith('sug-1', 'Try asking for a focused patch and tests.');
  });

  it('fires optimistic edited send with the edited text', () => {
    const onOptimisticSend = vi.fn(() => 'pending-1');
    renderStrip({ onOptimisticSend });

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.change(screen.getByLabelText('Edit suggestion'), {
      target: { value: 'Try asking for a focused patch and tests.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send edited' }));

    expect(onOptimisticSend).toHaveBeenCalledWith({
      suggestion: expect.objectContaining({ id: 'sug-1', authorName: 'Ada' }),
      text: 'Try asking for a focused patch and tests.',
      edited: true,
    });
  });

  it('removes the optimistic steer when accepting a suggestion fails', async () => {
    const onSend = vi.fn(() => Promise.reject(new Error('network')));
    const onOptimisticSend = vi.fn(() => 'pending-1');
    const onOptimisticSendFailed = vi.fn();
    renderStrip({ onSend, onOptimisticSend, onOptimisticSendFailed });

    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(onOptimisticSendFailed).toHaveBeenCalledWith('pending-1'));
  });

  it('dismisses a suggestion with an optional note', () => {
    const onDismiss = vi.fn();
    renderStrip({ onDismiss });

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    fireEvent.change(screen.getByLabelText('Dismiss reason'), {
      target: { value: 'Not relevant now' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(onDismiss).toHaveBeenCalledWith('sug-1', 'Not relevant now');
  });

  it('renders spectator suggestions as read-only', () => {
    renderStrip({ isDriver: false });

    expect(screen.getByText('Suggestions · 1')).toBeInTheDocument();
    expect(screen.getByText('Try asking for a smaller patch.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });

  it('renders nothing when there are no pending suggestions', () => {
    const { container } = renderStrip({
      suggestions: [suggestion({ id: 'sent', status: 'sent' }), suggestion({ id: 'dismissed', status: 'dismissed' })],
    });

    expect(container).toBeEmptyDOMElement();
  });
});
