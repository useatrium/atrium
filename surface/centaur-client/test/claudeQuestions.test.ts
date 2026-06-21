import { describe, expect, it } from "vitest";
import {
  claudeAnswersToPermissionResult,
  claudeAnswersToUpdatedInput,
  claudeAskUserQuestionToFrame,
  type ClaudeAskUserQuestionInput,
} from "../src/claudeQuestions.js";

const sdkQuestion: ClaudeAskUserQuestionInput = {
  questions: [
    {
      header: "Layout",
      question: "Which card layout should I use?",
      multiSelect: false,
      options: [
        {
          label: "Compact",
          description: "Use a tight row layout.",
          preview: "<div style=\"border:1px solid #ddd;padding:8px\">Compact</div>",
        },
        {
          label: "Spacious",
          description: "Use a roomier card layout.",
        },
      ],
    },
    {
      header: "Sections",
      question: "Which sections should be visible?",
      multiSelect: true,
      options: [
        { label: "Summary", description: "Show a brief overview." },
        { label: "Timeline", description: "Show recent activity." },
      ],
    },
  ],
};

describe("Claude AskUserQuestion mapping", () => {
  it("converts SDK questions into Atrium question_requested frames", () => {
    expect(
      claudeAskUserQuestionToFrame(sdkQuestion, {
        questionId: "toolu_123",
        turnId: "turn-1",
        previewFormat: "html",
      }),
    ).toEqual({
      type: "question_requested",
      question_id: "toolu_123",
      turn_id: "turn-1",
      questions: [
        {
          id: "question-1",
          header: "Layout",
          question: "Which card layout should I use?",
          multiSelect: false,
          options: [
            {
              label: "Compact",
              description: "Use a tight row layout.",
              preview: "<div style=\"border:1px solid #ddd;padding:8px\">Compact</div>",
              previewFormat: "html",
            },
            {
              label: "Spacious",
              description: "Use a roomier card layout.",
            },
          ],
        },
        {
          id: "question-2",
          header: "Sections",
          question: "Which sections should be visible?",
          multiSelect: true,
          options: [
            { label: "Summary", description: "Show a brief overview." },
            { label: "Timeline", description: "Show recent activity." },
          ],
        },
      ],
    });
  });

  it("converts Atrium prompt-id answers back into Claude's question-text answer map", () => {
    expect(
      claudeAnswersToUpdatedInput(sdkQuestion, {
        "question-1": { answers: ["Compact"] },
        "question-2": { answers: ["Summary", "Timeline"] },
      }),
    ).toEqual({
      questions: sdkQuestion.questions,
      answers: {
        "Which card layout should I use?": "Compact",
        "Which sections should be visible?": "Summary, Timeline",
      },
    });
  });

  it("builds the canUseTool allow result expected by the Claude Agent SDK", () => {
    expect(
      claudeAnswersToPermissionResult(sdkQuestion, {
        "question-1": { answers: ["Spacious"] },
      }),
    ).toEqual({
      behavior: "allow",
      updatedInput: {
        questions: sdkQuestion.questions,
        answers: {
          "Which card layout should I use?": "Spacious",
          "Which sections should be visible?": "",
        },
      },
    });
  });
});
