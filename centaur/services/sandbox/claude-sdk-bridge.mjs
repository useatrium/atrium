#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pendingAnswers = new Map();
const queuedInputs = [];
let waitingForInput = null;
let inputClosed = false;
let activeAbortController = null;
let sdkSessionId = process.env.CENTAUR_CLAUDE_RESUME_SESSION_ID || "";
let currentTurnId = "";

function log(message) {
  console.error(`[claude-sdk-bridge] ${message}`);
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function errorText(error) {
  if (error instanceof Error) {
    return error.message || error.stack || String(error);
  }
  return String(error);
}

function bridgeTurnId() {
  return `turn-${randomUUID().replaceAll("-", "")}`;
}

function enqueueInput(value) {
  if (waitingForInput) {
    const resolve = waitingForInput;
    waitingForInput = null;
    resolve(value);
  } else {
    queuedInputs.push(value);
  }
}

function nextInput() {
  if (queuedInputs.length > 0) {
    return Promise.resolve(queuedInputs.shift());
  }
  if (inputClosed) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    waitingForInput = resolve;
  });
}

function resolvePendingAnswer(questionId, value) {
  const pending = pendingAnswers.get(questionId);
  if (!pending) {
    return false;
  }
  pendingAnswers.delete(questionId);
  pending.resolve(value);
  return true;
}

function settleAllPendingAnswers(value) {
  for (const [questionId, pending] of pendingAnswers) {
    pendingAnswers.delete(questionId);
    pending.resolve(value);
  }
}

function waitForAnswer(questionId, signal) {
  if (signal?.aborted) {
    return Promise.resolve({ type: "interrupt" });
  }
  return new Promise((resolve) => {
    const onAbort = () => {
      pendingAnswers.delete(questionId);
      resolve({ type: "interrupt" });
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    pendingAnswers.set(questionId, {
      resolve: (value) => {
        if (signal) {
          signal.removeEventListener("abort", onAbort);
        }
        resolve(value);
      },
    });
  });
}

function handleInputLine(line) {
  if (!line.trim()) {
    return;
  }
  let value;
  try {
    value = JSON.parse(line);
  } catch (error) {
    log(`ignoring invalid JSON input: ${errorText(error)}`);
    return;
  }

  if (value?.type === "question_answer") {
    const questionId = typeof value.question_id === "string" ? value.question_id : "";
    if (!questionId || !resolvePendingAnswer(questionId, value)) {
      log(`question_answer ignored: no pending question ${questionId || "<missing>"}`);
    }
    return;
  }

  if (value?.type === "interrupt") {
    activeAbortController?.abort(new Error("interrupted by host"));
    settleAllPendingAnswers({ type: "interrupt" });
    return;
  }

  enqueueInput(value);
}

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
  terminal: false,
});
rl.on("line", handleInputLine);
rl.on("close", () => {
  inputClosed = true;
  activeAbortController?.abort(new Error("stdin closed"));
  settleAllPendingAnswers({ type: "closed" });
  if (waitingForInput) {
    const resolve = waitingForInput;
    waitingForInput = null;
    resolve(null);
  }
});

function moduleCandidates() {
  return [
    process.env.CLAUDE_AGENT_SDK_MODULE,
    path.join(scriptDir, "node_modules", "@anthropic-ai", "claude-agent-sdk", "sdk.mjs"),
    "/usr/lib/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
    "/usr/local/lib/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
    "@anthropic-ai/claude-agent-sdk",
  ].filter(Boolean);
}

async function importCandidate(candidate) {
  if (candidate.startsWith("/") || candidate.startsWith(".") || candidate.endsWith(".mjs")) {
    const absolute = path.resolve(candidate);
    if (!fs.existsSync(absolute)) {
      throw new Error(`module path does not exist: ${absolute}`);
    }
    return import(pathToFileURL(absolute).href);
  }
  return import(candidate);
}

async function loadSdk() {
  const errors = [];
  for (const candidate of moduleCandidates()) {
    try {
      return await importCandidate(candidate);
    } catch (error) {
      errors.push(`${candidate}: ${errorText(error)}`);
    }
  }
  throw new Error(`could not load @anthropic-ai/claude-agent-sdk\n${errors.join("\n")}`);
}

function configuredPreviewFormat() {
  const raw = (process.env.CLAUDE_ASK_USER_PREVIEW_FORMAT || "html").trim().toLowerCase();
  return raw === "markdown" ? "markdown" : "html";
}

function stringValue(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function normalizeQuestions(input) {
  const previewFormat = configuredPreviewFormat();
  const sourceQuestions = Array.isArray(input?.questions) ? input.questions : [];
  return sourceQuestions.slice(0, 4).map((question, index) => ({
    id: `question-${index + 1}`,
    question: stringValue(question?.question, `Question ${index + 1}?`),
    header: stringValue(question?.header, `Question ${index + 1}`),
    multiSelect: Boolean(question?.multiSelect),
    options: (Array.isArray(question?.options) ? question.options : [])
      .slice(0, 4)
      .map((option) => {
        const normalized = {
          label: stringValue(option?.label),
          description: stringValue(option?.description),
        };
        if (typeof option?.preview === "string" && option.preview.length > 0) {
          normalized.preview = option.preview;
          normalized.previewFormat = previewFormat;
        }
        return normalized;
      }),
  }));
}

function labelsFromAnswer(value) {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.filter((item) => typeof item === "string");
  }
  if (value && typeof value === "object") {
    if (Array.isArray(value.answers)) {
      return labelsFromAnswer(value.answers);
    }
    for (const key of ["answer", "label", "value", "text"]) {
      if (typeof value[key] === "string") {
        return [value[key]];
      }
    }
  }
  return [];
}

function sdkAnswersForQuestions(questions, answerPayload) {
  const out = {};
  const answers = answerPayload && typeof answerPayload === "object" ? answerPayload : {};
  questions.forEach((question, index) => {
    const raw =
      answers[question.id] ??
      answers[question.question] ??
      answers[String(index)] ??
      answers[String(index + 1)];
    out[question.question] = labelsFromAnswer(raw).join(", ");
  });
  return out;
}

async function canUseTool(toolName, input, options) {
  if (toolName !== "AskUserQuestion") {
    return {
      behavior: "allow",
      toolUseID: options.toolUseID,
    };
  }

  const toolUseID = options.toolUseID || `toolu_${randomUUID().replaceAll("-", "")}`;
  const questions = normalizeQuestions(input);
  if (questions.length === 0) {
    return {
      behavior: "deny",
      message: "AskUserQuestion did not include any questions.",
      toolUseID,
      decisionClassification: "user_reject",
    };
  }

  writeJson({
    type: "question_requested",
    question_id: toolUseID,
    turn_id: currentTurnId,
    questions,
  });

  const answer = await waitForAnswer(toolUseID, options.signal);
  if (!answer || answer.type === "interrupt" || answer.type === "closed") {
    return {
      behavior: "deny",
      message: "The user did not answer the question.",
      interrupt: true,
      toolUseID,
      decisionClassification: "user_reject",
    };
  }

  return {
    behavior: "allow",
    toolUseID,
    decisionClassification: "user_temporary",
    updatedInput: {
      questions: Array.isArray(input?.questions) ? input.questions : [],
      answers: sdkAnswersForQuestions(questions, answer.answers),
    },
  };
}

function readSystemPrompt() {
  const promptPath = process.env.CENTAUR_CLAUDE_SYSTEM_PROMPT_FILE || "AGENTS.md";
  if (!fs.existsSync(promptPath)) {
    return undefined;
  }
  const append = fs.readFileSync(promptPath, "utf8").trim();
  if (!append) {
    return undefined;
  }
  return {
    type: "preset",
    preset: "claude_code",
    append,
  };
}

function queryOptions(abortController) {
  const permissionMode = process.env.CLAUDE_PERMISSION_MODE || "bypassPermissions";
  const options = {
    abortController,
    cwd: process.cwd(),
    includePartialMessages: true,
    permissionMode,
    canUseTool,
    toolConfig: {
      askUserQuestion: {
        previewFormat: configuredPreviewFormat(),
      },
    },
    env: {
      ...process.env,
      CLAUDE_AGENT_SDK_CLIENT_APP:
        process.env.CLAUDE_AGENT_SDK_CLIENT_APP || "centaur/claude-sdk-bridge",
    },
  };
  if (permissionMode === "bypassPermissions") {
    options.allowDangerouslySkipPermissions = true;
  }

  const model = process.env.CENTAUR_CLAUDE_MODEL || process.env.CLAUDE_MODEL || "";
  if (model) {
    options.model = model;
  }

  const executable =
    process.env.CENTAUR_CLAUDE_CODE_EXECUTABLE || process.env.CLAUDE_BIN || "";
  if (executable) {
    options.pathToClaudeCodeExecutable = executable;
  }

  const systemPrompt = readSystemPrompt();
  if (systemPrompt) {
    options.systemPrompt = systemPrompt;
  }

  if (sdkSessionId) {
    options.resume = sdkSessionId;
  } else if (process.env.CENTAUR_CLAUDE_SESSION_ID) {
    options.sessionId = process.env.CENTAUR_CLAUDE_SESSION_ID;
  }

  return options;
}

async function* promptFromInput(input) {
  const message =
    input?.message && typeof input.message === "object"
      ? input.message
      : {
          role: "user",
          content: [{ type: "text", text: "continue" }],
        };
  yield {
    type: "user",
    message,
    parent_tool_use_id: null,
  };
}

function captureSessionId(message) {
  const sessionId = message?.session_id || message?.sessionId;
  if (typeof sessionId === "string" && sessionId.length > 0) {
    sdkSessionId = sessionId;
  }
}

async function runTurn(query, input) {
  currentTurnId = stringValue(input?.turn_id) || bridgeTurnId();
  const abortController = new AbortController();
  activeAbortController = abortController;
  try {
    const stream = query({
      prompt: promptFromInput(input),
      options: queryOptions(abortController),
    });
    for await (const message of stream) {
      captureSessionId(message);
      writeJson(message);
    }
  } finally {
    if (activeAbortController === abortController) {
      activeAbortController = null;
    }
    currentTurnId = "";
  }
}

async function main() {
  const sdk = await loadSdk();
  if (typeof sdk.query !== "function") {
    throw new Error("loaded Claude Agent SDK module does not export query()");
  }

  while (true) {
    const input = await nextInput();
    if (input === null) {
      break;
    }
    if (input?.type !== "user") {
      log(`ignoring unsupported input type: ${input?.type || "<missing>"}`);
      continue;
    }

    try {
      await runTurn(sdk.query, input);
    } catch (error) {
      writeJson({
        type: "error",
        message: errorText(error),
      });
    }
  }
}

main().catch((error) => {
  writeJson({
    type: "error",
    message: errorText(error),
  });
  process.exitCode = 1;
});
