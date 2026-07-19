// @vitest-environment jsdom

import type { SessionPendingQuestion } from '@atrium/surface-client';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const proposeAnswer = vi.fn().mockResolvedValue(undefined);

vi.mock('./api', () => ({
  sessionsApi: {
    proposeAnswer: (...args: unknown[]) => proposeAnswer(...args),
  },
}));

import { QuestionCard } from './SessionBanners';

afterEach(() => {
  cleanup();
  proposeAnswer.mockClear();
});

function pending(questions: unknown[]): SessionPendingQuestion {
  return {
    questionId: 'q-frame',
    turnId: 'turn-1',
    questions: questions as SessionPendingQuestion['questions'],
    eventId: 1,
  };
}

describe('QuestionCard degenerate state', () => {
  it('renders an explanatory strip (no answer form) for an empty question set', () => {
    render(<QuestionCard sessionId="s1" pending={pending([])} isDriver driverName="Alice" proposals={[]} />);
    expect(screen.getByTestId('question-unrenderable')).toBeTruthy();
    expect(screen.queryByTestId('question-banner')).toBeNull();
    // No enabled Answer button that would submit nothing.
    expect(screen.queryByRole('button', { name: /answer/i })).toBeNull();
  });

  it('explains an unrenderable payload the client cannot display', () => {
    render(<QuestionCard sessionId="s1" pending={pending([{ foo: 1 }])} isDriver driverName="Alice" proposals={[]} />);
    const strip = screen.getByTestId('question-unrenderable');
    expect(strip.textContent).toContain("can't render");
  });

  it('renders a bare label-only prompt as an answerable free-text question', () => {
    render(
      <QuestionCard
        sessionId="s1"
        pending={pending([{ id: 'raw', label: 'Just a label' }])}
        isDriver={false}
        driverName="Alice"
        proposals={[]}
      />,
    );
    // A label-only prompt (no header/question/options) is salvaged into a real,
    // answerable banner rather than a dead one. The label seeds both the header
    // and the question text.
    expect(screen.getByTestId('question-banner')).toBeTruthy();
    expect(screen.getAllByText('Just a label').length).toBeGreaterThan(0);
    expect(screen.getByRole('textbox')).toBeTruthy(); // free-text input present
  });
});

describe('QuestionCard multiSelect "Other"', () => {
  const multi = pending([
    {
      id: 'sections',
      header: 'Sections',
      question: 'Which sections?',
      multiSelect: true,
      options: [
        { label: 'Summary', description: '' },
        { label: 'Timeline', description: '' },
      ],
    },
  ]);

  it('joins the free-text "also add:" value with the picked labels', async () => {
    render(<QuestionCard sessionId="s1" pending={multi} isDriver={false} driverName="Alice" proposals={[]} />);

    fireEvent.click(screen.getByRole('checkbox', { name: /Summary/i }));
    fireEvent.change(screen.getByPlaceholderText('type it…'), { target: { value: 'Custom section' } });

    fireEvent.click(screen.getByRole('button', { name: /propose answer/i }));

    await waitFor(() => expect(proposeAnswer).toHaveBeenCalledTimes(1));
    const [, questionId, answers] = proposeAnswer.mock.calls[0]!;
    expect(questionId).toBe('q-frame');
    expect(answers).toEqual({ sections: { answers: ['Summary', 'Custom section'] } });
  });

  it('keeps the answer available from the free-text row alone (no checkbox picked)', async () => {
    render(<QuestionCard sessionId="s1" pending={multi} isDriver={false} driverName="Alice" proposals={[]} />);

    // Answering must be blocked until there is something to submit.
    expect(screen.getByRole('button', { name: /propose answer/i })).toHaveProperty('disabled', true);

    fireEvent.change(screen.getByPlaceholderText('type it…'), { target: { value: 'Only custom' } });
    fireEvent.click(screen.getByRole('button', { name: /propose answer/i }));

    await waitFor(() => expect(proposeAnswer).toHaveBeenCalledTimes(1));
    expect(proposeAnswer.mock.calls[0]![2]).toEqual({ sections: { answers: ['Only custom'] } });
  });
});
