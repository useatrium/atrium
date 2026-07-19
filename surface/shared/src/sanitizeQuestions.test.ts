import { describe, expect, it } from 'vitest';
import { sanitizeQuestionPrompts } from './sanitizeQuestions';

describe('sanitizeQuestionPrompts', () => {
  it('passes through well-formed Atrium prompts untouched', () => {
    const { questions, unrenderable } = sanitizeQuestionPrompts([
      {
        id: 'choice',
        header: 'Pick one',
        question: 'Pick one',
        options: [{ label: 'A', description: '' }],
      },
    ]);
    expect(unrenderable).toBe(false);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toMatchObject({ id: 'choice', header: 'Pick one', question: 'Pick one' });
    expect(questions[0]!.options).toEqual([{ label: 'A', description: '' }]);
  });

  it('preserves multiSelect / isOther / isSecret and option previews', () => {
    const { questions } = sanitizeQuestionPrompts([
      {
        id: 'q1',
        header: 'Sections',
        question: 'Which?',
        multiSelect: true,
        isOther: true,
        isSecret: true,
        options: [{ label: 'Summary', description: 'd', preview: 'CODE', previewFormat: 'markdown' }],
      },
    ]);
    expect(questions[0]).toMatchObject({ multiSelect: true, isOther: true, isSecret: true });
    expect(questions[0]!.options?.[0]).toEqual({
      label: 'Summary',
      description: 'd',
      preview: 'CODE',
      previewFormat: 'markdown',
    });
  });

  it('drops an unrenderable question with no text and no options', () => {
    // A prompt object with only a stray non-answerable field, alongside a valid
    // one: the valid survives, the empty is dropped.
    const { questions, unrenderable } = sanitizeQuestionPrompts([
      { id: 'good', header: 'Real', question: 'Answer me' },
      { id: 'empty', somethingElse: 42 },
    ]);
    expect(unrenderable).toBe(false);
    expect(questions).toHaveLength(1);
    expect(questions[0]!.id).toBe('good');
  });

  it('synthesizes a free-text prompt when nothing is renderable but string content exists', () => {
    // Simulates a malformed payload that slipped past validation: a bare label
    // with no header/question/options. We still let the human answer.
    const { questions, unrenderable } = sanitizeQuestionPrompts([{ id: 'raw', label: 'Just a label' }]);
    expect(unrenderable).toBe(false);
    expect(questions).toHaveLength(1);
    expect(questions[0]!.question).toBe('Just a label');
    // Salvaged id is preserved so answers round-trip when possible.
    expect(questions[0]!.id).toBe('raw');
    expect(questions[0]!.options).toBeUndefined();
  });

  it('reports unrenderable when the payload has entries but no salvageable text', () => {
    const { questions, unrenderable } = sanitizeQuestionPrompts([{ foo: 1 }, 42, null]);
    expect(questions).toHaveLength(0);
    expect(unrenderable).toBe(true);
  });

  it('reports not-unrenderable for a genuinely empty set (nothing was asked)', () => {
    expect(sanitizeQuestionPrompts([])).toEqual({ questions: [], unrenderable: false });
    expect(sanitizeQuestionPrompts(null)).toEqual({ questions: [], unrenderable: false });
    expect(sanitizeQuestionPrompts(undefined)).toEqual({ questions: [], unrenderable: false });
  });

  it('derives a short header when only a long question is present', () => {
    const { questions } = sanitizeQuestionPrompts([
      { id: 'q', question: 'This is a very long question prompt that should be truncated for the header' },
    ]);
    expect(questions[0]!.header.length).toBeLessThanOrEqual(25);
    expect(questions[0]!.header.endsWith('…')).toBe(true);
  });

  it('keeps options whose entries are answerable and drops label-less ones', () => {
    const { questions } = sanitizeQuestionPrompts([
      {
        id: 'q',
        header: 'H',
        question: 'Q',
        options: [{ label: 'Keep', description: '' }, { description: 'no label' }, 'not-an-object'],
      },
    ]);
    expect(questions[0]!.options).toEqual([{ label: 'Keep', description: '' }]);
  });
});
