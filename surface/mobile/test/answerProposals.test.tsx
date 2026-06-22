// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import type { QuestionPrompt, SessionAnswerProposal } from '@atrium/surface-client';
import { renderWithTheme as renderUI } from './rnTestUtils';
import { AnswerProposals } from '../src/components/work/AnswerProposals';

afterEach(cleanup);

function prompt(over: Partial<QuestionPrompt> = {}): QuestionPrompt {
  return {
    id: 'choice',
    header: 'Decision',
    question: 'Which path should the agent take?',
    ...over,
  };
}

function proposal(over: Partial<SessionAnswerProposal> = {}): SessionAnswerProposal {
  return {
    id: 'proposal-1',
    questionId: 'question-1',
    authorId: 'user-1',
    authorName: 'Riley',
    answers: {
      choice: { answers: ['Restart service'] },
      note: { answers: ['Keep the cache warm'] },
    },
    status: 'pending',
    createdAt: '2026-06-21T12:00:00.000Z',
    ...over,
  };
}

describe('AnswerProposals (mobile)', () => {
  it('renders a proposal author and prompt-labelled values', () => {
    renderUI(
      <AnswerProposals
        proposals={[proposal()]}
        prompts={[prompt(), prompt({ id: 'note', header: 'Context', question: 'Anything else?' })]}
        onSubmit={() => {}}
        onDismiss={() => {}}
      />,
    );

    expect(screen.getByText('Proposed answers · 1')).toBeInTheDocument();
    expect(screen.getByText('Riley')).toBeInTheDocument();
    expect(screen.getByText('Decision')).toBeInTheDocument();
    expect(screen.getByText('Restart service')).toBeInTheDocument();
    expect(screen.getByText('Context')).toBeInTheDocument();
    expect(screen.getByText('Keep the cache warm')).toBeInTheDocument();
  });

  it('fires onSubmit with the proposal id', () => {
    const onSubmit = vi.fn();
    renderUI(
      <AnswerProposals
        proposals={[proposal()]}
        prompts={[prompt()]}
        onSubmit={onSubmit}
        onDismiss={() => {}}
      />,
    );

    fireEvent.click(screen.getByLabelText('Submit proposal from Riley'));
    expect(onSubmit).toHaveBeenCalledWith('proposal-1');
  });

  it('fires onDismiss with the proposal id', () => {
    const onDismiss = vi.fn();
    renderUI(
      <AnswerProposals
        proposals={[proposal()]}
        prompts={[prompt()]}
        onSubmit={() => {}}
        onDismiss={onDismiss}
      />,
    );

    fireEvent.click(screen.getByLabelText('Dismiss proposal from Riley'));
    expect(onDismiss).toHaveBeenCalledWith('proposal-1');
  });

  it('renders nothing when there are no proposals', () => {
    const { container } = renderUI(
      <AnswerProposals proposals={[]} prompts={[prompt()]} onSubmit={() => {}} onDismiss={() => {}} />,
    );

    expect(container).toBeEmptyDOMElement();
  });
});
