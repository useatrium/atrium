import { describe, expect, it } from 'vitest';
import { parsePendingQuestion } from './session-runs.js';

// The DB `pending_question` column stores the SessionPendingQuestionJson shape.
// `parsePendingQuestion` is the validation seam: if ANY question fails
// `isQuestionPrompt`, the whole pending set nulls out and the client shows an
// empty "needs input" banner. These tests pin the wire contract the harness
// codex adapter must satisfy.

function stored(questions: unknown[]): unknown {
  return { questionId: 'q-frame', turnId: 'turn-1', questions, eventId: 7 };
}

describe('parsePendingQuestion + codex-adapted question shape', () => {
  it('accepts the Atrium-shaped question the codex adapter emits', () => {
    const parsed = parsePendingQuestion(
      stored([
        {
          id: 'choice',
          header: 'Pick one',
          question: 'Pick one',
          options: [
            { label: 'A', description: '' },
            { label: 'B', description: '' },
          ],
        },
      ]),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.questions).toHaveLength(1);
    // The codex question id is preserved so answers round-trip keyed by it.
    expect(parsed?.questions[0]?.id).toBe('choice');
  });

  it('accepts an adapted multiSelect question with option previews', () => {
    const parsed = parsePendingQuestion(
      stored([
        {
          id: 'sections',
          header: 'Sections',
          question: 'Which sections?',
          multiSelect: true,
          options: [{ label: 'Summary', description: 'Overview', preview: 'CODE', previewFormat: 'markdown' }],
        },
      ]),
    );
    expect(parsed?.questions[0]?.multiSelect).toBe(true);
    expect(parsed?.questions[0]?.options?.[0]?.previewFormat).toBe('markdown');
  });

  it('rejects the raw codex-native {label,kind,choices} shape (the pre-adapter bug)', () => {
    // Without the harness-side adapter this is exactly what reaches the server;
    // it fails isQuestionPrompt (no header/question) → the whole set nulls out →
    // the empty banner. Documenting the failure the adapter removes.
    const parsed = parsePendingQuestion(
      stored([{ id: 'choice', label: 'Pick one', kind: 'choice', choices: ['A', 'B'] }]),
    );
    expect(parsed).toBeNull();
  });

  it('rejects an options entry missing its description (contract guard)', () => {
    const parsed = parsePendingQuestion(stored([{ id: 'q', header: 'H', question: 'Q', options: [{ label: 'A' }] }]));
    expect(parsed).toBeNull();
  });
});
