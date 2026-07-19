// Consumer-boundary sanitizer for agent HITL question prompts.
//
// The harness side (centaur codex adapter, Claude SDK bridge) is responsible
// for emitting Atrium-shaped `{id, header, question, options?}` prompts, and
// the server's `parsePendingQuestion` validates them. This module is the
// last-line guard on the render side: it never trusts that the questions it was
// handed are renderable, so a malformed or empty question set can NOT produce
// the old failure mode — an enabled "Answer" button over an empty banner that
// submits nothing.
//
// It is a pure function (no React, no I/O) so it is trivially testable and can
// be shared by every question consumer (web QuestionCard, mobile
// InlineQuestionAnswer).

import type { QuestionOption, QuestionPrompt } from './sessions';

export interface SanitizedQuestions {
  /** Renderable, answerable prompts. Empty only when nothing was salvageable. */
  questions: QuestionPrompt[];
  /**
   * The payload carried question entries but none were renderable and no
   * free-text prompt could be synthesized from them. The consumer should show
   * an explanatory strip with answering disabled instead of a dead form.
   */
  unrenderable: boolean;
}

const HEADER_MAX = 24;

/**
 * Filter a question set down to renderable prompts. If none survive but the raw
 * payload still carries human-readable text, synthesize a single free-text
 * prompt so the person can answer *something* meaningful rather than face a
 * broken banner. If the payload is genuinely empty/opaque, report it as
 * unrenderable so the consumer can explain the situation and disable answering.
 */
export function sanitizeQuestionPrompts(raw: readonly unknown[] | null | undefined): SanitizedQuestions {
  const source = Array.isArray(raw) ? raw : [];
  const questions: QuestionPrompt[] = [];
  for (const entry of source) {
    const prompt = coerceRenderablePrompt(entry, questions.length);
    if (prompt) questions.push(prompt);
  }
  if (questions.length > 0) return { questions, unrenderable: false };

  const salvaged = firstStringContent(source);
  if (salvaged) {
    return {
      questions: [{ id: firstId(source) ?? 'question-1', header: 'Question', question: salvaged }],
      unrenderable: false,
    };
  }
  return { questions: [], unrenderable: source.length > 0 };
}

/**
 * Coerce one entry into a renderable prompt, or null if it carries neither a
 * question/header string nor any answerable option. Preserves the original `id`
 * verbatim so answers round-trip keyed by it.
 */
function coerceRenderablePrompt(entry: unknown, index: number): QuestionPrompt | null {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const raw = entry as Record<string, unknown>;

  const question = pickString(raw, ['question', 'label', 'text', 'prompt']);
  const headerRaw = pickString(raw, ['header']);
  const options = coerceOptions(raw.options);

  // Renderable requires something to ask OR something to pick. Otherwise there
  // is no form to show.
  if (!question && !headerRaw && options.length === 0) return null;

  const header = headerRaw ?? deriveHeader(question ?? '', index);
  const prompt: QuestionPrompt = {
    id: pickString(raw, ['id']) ?? `question-${index + 1}`,
    header,
    question: question ?? header,
  };
  if (options.length > 0) prompt.options = options;
  if (raw.multiSelect === true) prompt.multiSelect = true;
  if (raw.isOther === true) prompt.isOther = true;
  if (raw.isSecret === true) prompt.isSecret = true;
  return prompt;
}

function coerceOptions(value: unknown): QuestionOption[] {
  if (!Array.isArray(value)) return [];
  const options: QuestionOption[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const label = pickString(raw, ['label', 'value', 'text']);
    if (!label) continue;
    const option: QuestionOption = { label, description: pickString(raw, ['description', 'detail']) ?? '' };
    const preview = pickString(raw, ['preview']);
    if (preview) option.preview = preview;
    const format = raw.previewFormat;
    if (format === 'markdown' || format === 'html') option.previewFormat = format;
    options.push(option);
  }
  return options;
}

/** First non-empty string across the payload's answerable text fields. */
function firstStringContent(source: readonly unknown[]): string | null {
  for (const entry of source) {
    if (typeof entry === 'string') {
      const trimmed = entry.trim();
      if (trimmed) return trimmed;
      continue;
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const raw = entry as Record<string, unknown>;
    const text = pickString(raw, ['question', 'label', 'text', 'prompt', 'header']);
    if (text) return text;
  }
  return null;
}

function firstId(source: readonly unknown[]): string | null {
  for (const entry of source) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const id = pickString(entry as Record<string, unknown>, ['id']);
    if (id) return id;
  }
  return null;
}

function deriveHeader(prompt: string, index: number): string {
  const trimmed = prompt.trim();
  if (!trimmed) return `Question ${index + 1}`;
  if (trimmed.length <= HEADER_MAX) return trimmed;
  return `${trimmed.slice(0, HEADER_MAX)}…`;
}

function pickString(raw: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}
