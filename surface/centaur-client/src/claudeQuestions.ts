import type { QuestionPrompt, QuestionRequested } from './types.js';

export type ClaudeQuestionPreviewFormat = 'markdown' | 'html';

export interface ClaudeAskUserQuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface ClaudeAskUserQuestionPrompt {
  question: string;
  header: string;
  options: ClaudeAskUserQuestionOption[];
  multiSelect: boolean;
}

export interface ClaudeAskUserQuestionInput {
  questions: ClaudeAskUserQuestionPrompt[];
}

export interface ClaudeQuestionBridgeOptions {
  questionId: string;
  turnId: string;
  previewFormat?: ClaudeQuestionPreviewFormat;
}

export type ClaudeQuestionAnswerBody = Record<string, { answers: string[] }>;

export interface ClaudeAskUserQuestionUpdatedInput {
  questions: ClaudeAskUserQuestionPrompt[];
  answers: Record<string, string>;
}

export interface ClaudeAskUserQuestionPermissionResult {
  behavior: 'allow';
  updatedInput: ClaudeAskUserQuestionUpdatedInput;
}

export function claudeAskUserQuestionToFrame(
  input: ClaudeAskUserQuestionInput,
  options: ClaudeQuestionBridgeOptions,
): QuestionRequested {
  return {
    type: 'question_requested',
    question_id: options.questionId,
    turn_id: options.turnId,
    questions: input.questions.map((question, index) =>
      claudePromptToAtriumPrompt(question, index, options.previewFormat),
    ),
  };
}

export function claudeAnswersToUpdatedInput(
  input: ClaudeAskUserQuestionInput,
  answers: ClaudeQuestionAnswerBody,
): ClaudeAskUserQuestionUpdatedInput {
  return {
    questions: input.questions,
    answers: Object.fromEntries(
      input.questions.map((question, index) => {
        const promptId = claudePromptId(index);
        const selected = answers[promptId]?.answers ?? [];
        return [question.question, selected.join(', ')];
      }),
    ),
  };
}

export function claudeAnswersToPermissionResult(
  input: ClaudeAskUserQuestionInput,
  answers: ClaudeQuestionAnswerBody,
): ClaudeAskUserQuestionPermissionResult {
  return {
    behavior: 'allow',
    updatedInput: claudeAnswersToUpdatedInput(input, answers),
  };
}

function claudePromptToAtriumPrompt(
  question: ClaudeAskUserQuestionPrompt,
  index: number,
  previewFormat: ClaudeQuestionPreviewFormat | undefined,
): QuestionPrompt {
  return {
    id: claudePromptId(index),
    header: question.header,
    question: question.question,
    multiSelect: question.multiSelect,
    options: question.options.map((option) => ({
      label: option.label,
      description: option.description,
      ...(option.preview !== undefined ? { preview: option.preview } : {}),
      ...(option.preview !== undefined && previewFormat !== undefined ? { previewFormat } : {}),
    })),
  };
}

function claudePromptId(index: number): string {
  return `question-${index + 1}`;
}
