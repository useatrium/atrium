import type {
  AmpAssistantEvent,
  CodexAgentMessageDeltaEvent,
  CodexCommandExecutionOutputDeltaEvent,
  CodexItem,
  CodexItemCompletedEvent,
  CodexItemStartedEvent,
  AmpToolEvent,
  AnthropicTextBlock,
  AnthropicToolUseBlock,
  ArtifactCaptured,
  CentaurEventFrame,
  ExecutionStatus,
  JsonObject,
  QuestionPrompt,
  QuestionResolved,
} from "./types.js";
import { isTerminalExecutionStatus } from "./types.js";

export interface TextItem {
  type: "text";
  id: string;
  text: string;
  messageId?: string;
  uuid?: string;
  sourceEventIds: number[];
}

export interface ToolCallItem {
  type: "tool_call";
  id: string;
  name: string;
  input: JsonObject;
  result?: {
    content: string;
    is_error: boolean;
  };
  sourceEventIds: number[];
}

export interface QuestionItem {
  type: "question";
  id: string;
  questionId: string;
  turnId?: string;
  questions: QuestionPrompt[];
  status: "pending" | "resolved";
  reason?: QuestionResolved["reason"];
  sourceEventIds: number[];
}

export interface UserMessageItem {
  type: "user_message";
  id: string;
  text: string;
  sourceEventIds: number[];
}

export type SessionItem = TextItem | ToolCallItem | QuestionItem | UserMessageItem;

export type FileChangeKind = "add" | "update" | "delete";

/** A file edit a session made — the unit of the Changes work-surface. Sourced
 * from Claude/amp edit tool_calls (derived) and codex `fileChange` frames (here).
 * `path` may be absolute; the surface strips the sandbox prefix for display. */
export interface FileChange {
  id: string;
  path: string;
  kind: FileChangeKind;
  diff: string;
  toolName: string;
  sourceEventIds: number[];
}

export type ArtifactKind = "created" | "modified" | "deleted";

/** A work-product file the sandbox capture sidecar surfaced — the unit of the
 * Artifacts work-surface. `ref` keys the bytes in Centaur staging (null =
 * manifest-only); atrium offloads them to its own store + serves. `path` may be
 * absolute; the surface strips the sandbox prefix for display. */
export interface Artifact {
  id: string;
  path: string;
  kind: ArtifactKind;
  mime: string;
  size: number;
  sha256: string;
  ref: string | null;
  /** Execution that captured this artifact, used to fetch its bytes from the
   * right Centaur execution. Null for events emitted before Centaur added it. */
  executionId: string | null;
  sourceEventIds: number[];
}

export interface SessionState {
  status: ExecutionStatus | "idle";
  items: SessionItem[];
  /** Codex `fileChange` edits (claude/amp edits are derived from items instead). */
  fileChanges: FileChange[];
  /** Captured work-product files (Artifacts surface), from artifact.captured frames. */
  artifacts: Artifact[];
  resultText: string;
  models: string[];
  costUsd: number;
  lastEventId: number;
  pendingQuestion: {
    questionId: string;
    turnId?: string;
    questions: QuestionPrompt[];
  } | null;
}

export function initialSessionState(): SessionState {
  return {
    status: "idle",
    items: [],
    fileChanges: [],
    artifacts: [],
    resultText: "",
    models: [],
    costUsd: 0,
    lastEventId: 0,
    pendingQuestion: null,
  };
}

export function reduceSession(state: SessionState, frame: CentaurEventFrame): SessionState {
  const next: SessionState = {
    ...state,
    items: state.items.map((item) => ({ ...item, sourceEventIds: [...item.sourceEventIds] })),
    fileChanges: [...state.fileChanges],
    artifacts: [...state.artifacts],
    models: [...state.models],
    lastEventId: Math.max(state.lastEventId, frame.event_id),
  };

  if (frame.event === "execution_state") {
    next.status = frame.data.status;
    if (frame.data.result_text) {
      next.resultText = frame.data.result_text;
    }
    if (isTerminalExecutionStatus(frame.data.status)) {
      next.pendingQuestion = null;
      resolveOpenQuestions(next, frame.event_id, "cancelled");
    }
    return next;
  }

  if (frame.event === "question_requested") {
    next.pendingQuestion = {
      questionId: frame.data.question_id,
      ...(frame.data.turn_id !== undefined ? { turnId: frame.data.turn_id } : {}),
      questions: frame.data.questions,
    };
    upsertQuestionItem(next, frame.event_id, frame.data);
    return next;
  }

  if (frame.event === "question_resolved") {
    next.pendingQuestion = null;
    resolveQuestionItem(next, frame.event_id, frame.data.question_id, frame.data.reason);
    return next;
  }

  if (frame.event === "artifact.captured") {
    reduceArtifactCaptured(next, frame.event_id, frame.data);
    return next;
  }

  if (frame.event === "execution_summary") {
    next.status = frame.data.status;
    next.models = mergeModels(next.models, frame.data.models);
    return next;
  }

  if (frame.event === "usage_observed") {
    next.costUsd += typeof frame.data.cost_usd === "number" ? frame.data.cost_usd : 0;
    next.models = mergeModels(next.models, [frame.data.model]);
    return next;
  }

  if (frame.event !== "amp_raw_event") {
    return next;
  }

  const raw = normalizeRawEvent(frame.data);
  if (raw.type === "assistant") {
    reduceAssistant(next, frame.event_id, raw);
  } else if (raw.type === "tool") {
    reduceToolResult(next, frame.event_id, raw);
  } else if (raw.type === "result") {
    next.resultText = raw.text;
  } else if (raw.type === "item.agentMessage.delta") {
    reduceCodexAgentMessageDelta(next, frame.event_id, raw);
  } else if (raw.type === "item.started") {
    reduceCodexItemStarted(next, frame.event_id, raw);
  } else if (raw.type === "item.commandExecution.outputDelta") {
    reduceCodexCommandOutputDelta(next, frame.event_id, raw);
  } else if (raw.type === "item.completed") {
    reduceCodexItemCompleted(next, frame.event_id, raw);
  }

  return next;
}

function normalizeRawEvent(event: CentaurEventFrame["data"]): CentaurEventFrame["data"] {
  if (typeof event.type === "string") return event;
  const raw = event as JsonObject;
  if (typeof raw.method !== "string" || !isJsonObject(raw.params)) return event;
  const params = raw.params;
  switch (raw.method) {
    case "item/started":
      return { type: "item.started", ...params } as CentaurEventFrame["data"];
    case "item/completed":
      return { type: "item.completed", ...params } as CentaurEventFrame["data"];
    case "item/agentMessage/delta":
      return {
        type: "item.agentMessage.delta",
        ...params,
        itemId: stringValue(params.itemId) ?? stringValue(params.item_id),
      } as CentaurEventFrame["data"];
    case "item/commandExecution/outputDelta":
      return {
        type: "item.commandExecution.outputDelta",
        ...params,
        itemId: stringValue(params.itemId) ?? stringValue(params.item_id),
      } as CentaurEventFrame["data"];
    default:
      return event;
  }
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function upsertQuestionItem(
  state: SessionState,
  eventId: number,
  event: { question_id: string; turn_id?: string; questions: QuestionPrompt[] },
): void {
  const existing = state.items.find(
    (item): item is QuestionItem => item.type === "question" && item.questionId === event.question_id,
  );

  if (existing) {
    if (event.turn_id !== undefined) {
      existing.turnId = event.turn_id;
    } else {
      delete existing.turnId;
    }
    existing.questions = event.questions;
    existing.status = "pending";
    delete existing.reason;
    pushSourceEventId(existing, eventId);
    return;
  }

  state.items.push({
    type: "question",
    id: `question:${event.question_id}`,
    questionId: event.question_id,
    ...(event.turn_id !== undefined ? { turnId: event.turn_id } : {}),
    questions: event.questions,
    status: "pending",
    sourceEventIds: [eventId],
  });
}

function resolveQuestionItem(
  state: SessionState,
  eventId: number,
  questionId: string,
  reason: QuestionResolved["reason"],
): void {
  const existing = state.items.find(
    (item): item is QuestionItem => item.type === "question" && item.questionId === questionId,
  );
  if (existing) {
    existing.status = "resolved";
    existing.reason = reason;
    pushSourceEventId(existing, eventId);
    return;
  }

  state.items.push({
    type: "question",
    id: `question:${questionId}`,
    questionId,
    questions: [],
    status: "resolved",
    reason,
    sourceEventIds: [eventId],
  });
}

function resolveOpenQuestions(
  state: SessionState,
  eventId: number,
  reason: QuestionResolved["reason"],
): void {
  for (const item of state.items) {
    if (item.type !== "question" || item.status !== "pending") continue;
    item.status = "resolved";
    item.reason = reason;
    pushSourceEventId(item, eventId);
  }
}

function pushSourceEventId(item: SessionItem, eventId: number): void {
  if (!item.sourceEventIds.includes(eventId)) {
    item.sourceEventIds.push(eventId);
  }
}

function reduceAssistant(state: SessionState, eventId: number, event: AmpAssistantEvent): void {
  const text = event.message.content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join("");
  const toolBlocks = event.message.content.filter(isToolUseBlock);

  if (event.uuid) {
    if (text) {
      reconcileCompleteText(state, eventId, event.uuid, event.message.id, text);
    }
    for (const block of toolBlocks) {
      upsertToolCall(state, eventId, block);
    }
    return;
  }

  if (text) {
    appendStreamingText(state, eventId, text);
  }
  for (const block of toolBlocks) {
    upsertToolCall(state, eventId, block);
  }
}

function appendStreamingText(state: SessionState, eventId: number, text: string): void {
  const last = state.items[state.items.length - 1];
  if (last?.type === "text" && !last.uuid) {
    last.text += text;
    last.sourceEventIds.push(eventId);
    return;
  }

  state.items.push({
    type: "text",
    id: `text:${eventId}`,
    text,
    sourceEventIds: [eventId],
  });
}

function reconcileCompleteText(
  state: SessionState,
  eventId: number,
  uuid: string,
  messageId: string | undefined,
  text: string,
): void {
  const existing = state.items.find((item) =>
    item.type === "text" && (item.uuid === uuid || item.messageId === messageId),
  ) as TextItem | undefined;
  if (existing) {
    existing.text = text;
    existing.uuid = uuid;
    existing.messageId = messageId;
    existing.sourceEventIds.push(eventId);
    return;
  }

  const last = state.items[state.items.length - 1];
  if (last?.type === "text" && !last.uuid) {
    last.id = messageId ? `text:${messageId}` : `text:${uuid}`;
    last.text = text;
    last.uuid = uuid;
    last.messageId = messageId;
    last.sourceEventIds.push(eventId);
    return;
  }

  state.items.push({
    type: "text",
    id: messageId ? `text:${messageId}` : `text:${uuid}`,
    text,
    uuid,
    messageId,
    sourceEventIds: [eventId],
  });
}

function upsertToolCall(state: SessionState, eventId: number, block: AnthropicToolUseBlock): void {
  const existing = state.items.find((item) =>
    item.type === "tool_call" && item.id === block.id,
  ) as ToolCallItem | undefined;

  if (existing) {
    existing.name = block.name;
    existing.input = block.input;
    existing.sourceEventIds.push(eventId);
    return;
  }

  state.items.push({
    type: "tool_call",
    id: block.id,
    name: block.name,
    input: block.input,
    sourceEventIds: [eventId],
  });
}

function reduceToolResult(state: SessionState, eventId: number, event: AmpToolEvent): void {
  for (const result of event.content) {
    const item = result.tool_use_id
      ? state.items.find((candidate) => candidate.type === "tool_call" && candidate.id === result.tool_use_id)
      : [...state.items].reverse().find((candidate) => candidate.type === "tool_call");

    if (!item || item.type !== "tool_call") {
      continue;
    }

    item.result = {
      content: result.content,
      is_error: result.is_error,
    };
    item.sourceEventIds.push(eventId);
  }
}

function reduceCodexAgentMessageDelta(
  state: SessionState,
  eventId: number,
  event: CodexAgentMessageDeltaEvent,
): void {
  if (!event.delta) {
    return;
  }
  appendCodexStreamingText(state, eventId, codexItemId(event), event.delta);
}

function reduceCodexItemStarted(state: SessionState, eventId: number, event: CodexItemStartedEvent): void {
  if (event.item.type !== "commandExecution") {
    return;
  }
  upsertCodexCommandExecution(state, eventId, event.item);
}

function reduceCodexCommandOutputDelta(
  state: SessionState,
  eventId: number,
  event: CodexCommandExecutionOutputDeltaEvent,
): void {
  const delta = typeof event.delta === "string" ? event.delta : typeof event.output === "string" ? event.output : "";
  if (!delta) {
    return;
  }

  const item = findCodexToolCall(state, codexItemId(event));
  if (!item) {
    return;
  }

  item.result = {
    content: `${item.result?.content ?? ""}${delta}`,
    is_error: item.result?.is_error ?? false,
  };
  item.sourceEventIds.push(eventId);
}

function reduceCodexItemCompleted(state: SessionState, eventId: number, event: CodexItemCompletedEvent): void {
  if (event.item.type === "agentMessage") {
    const text = typeof event.item.text === "string" ? event.item.text : codexContentText(event.item);
    if (text) {
      reconcileCodexCompleteText(state, eventId, event.item.id, text);
    }
    return;
  }

  if (event.item.type === "userMessage") {
    const raw = typeof event.item.text === "string" ? event.item.text : codexContentText(event.item);
    const text = stripInjectedContext(raw);
    if (text) {
      upsertUserMessage(state, eventId, event.item.id, text);
    }
    return;
  }

  if (event.item.type === "commandExecution") {
    upsertCodexCommandExecution(state, eventId, event.item);
    completeCodexCommandExecution(state, eventId, event.item);
    return;
  }

  if (event.item.type === "fileChange") {
    captureCodexFileChange(state, eventId, event.item);
  }
}

const CODEX_KIND: Record<string, FileChangeKind> = {
  add: "add",
  create: "add",
  added: "add",
  update: "update",
  modify: "update",
  modified: "update",
  edit: "update",
  delete: "delete",
  deleted: "delete",
  remove: "delete",
};

/** Fold a codex `fileChange` item.completed — `changes[].{path,kind,diff}` —
 * into state.fileChanges. Defensive: tolerates a single change on the item and
 * unknown kind strings. */
function captureCodexFileChange(state: SessionState, eventId: number, item: CodexItem): void {
  const changesField = (item as { changes?: unknown }).changes;
  if (!Array.isArray(changesField)) return; // verified shape is always changes[]
  changesField.forEach((entry, idx) => {
    if (!entry || typeof entry !== "object") return;
    const e = entry as Record<string, unknown>;
    const path = typeof e["path"] === "string" ? e["path"] : null;
    if (!path) return;
    const id = `${item.id ?? `fc:${eventId}`}:${idx}`;
    if (state.fileChanges.some((c) => c.id === id)) return;
    const kindRaw = typeof e["kind"] === "string" ? e["kind"].toLowerCase() : "";
    state.fileChanges.push({
      id,
      path,
      kind: CODEX_KIND[kindRaw] ?? "update",
      diff: typeof e["diff"] === "string" ? e["diff"] : "",
      toolName: "fileChange",
      sourceEventIds: [eventId],
    });
  });
}

/** Fold an `artifact.captured` frame into state.artifacts. Dedup by stable
 * artifact_id (content-hash; reconnect replays the same ids), mirroring the
 * fileChange dedup — a re-captured identical file is one entry, distinct content
 * (new id) is a new version. */
function reduceArtifactCaptured(state: SessionState, eventId: number, event: ArtifactCaptured): void {
  if (state.artifacts.some((a) => a.id === event.artifact_id)) return;
  state.artifacts.push({
    id: event.artifact_id,
    path: event.path,
    kind: event.kind,
    mime: event.mime,
    size: event.size_bytes,
    sha256: event.sha256,
    ref: event.ref ?? null,
    executionId: event.execution_id ?? null,
    sourceEventIds: [eventId],
  });
}

function appendCodexStreamingText(
  state: SessionState,
  eventId: number,
  itemId: string | undefined,
  text: string,
): void {
  const existing = itemId
    ? (state.items.find((item) => item.type === "text" && item.messageId === itemId) as TextItem | undefined)
    : undefined;
  if (existing) {
    existing.text += text;
    existing.sourceEventIds.push(eventId);
    return;
  }

  const lastCodexText = [...state.items]
    .reverse()
    .find((item) => item.type === "text" && isOpenCodexTextItem(item)) as TextItem | undefined;
  if (!itemId && lastCodexText) {
    lastCodexText.text += text;
    lastCodexText.sourceEventIds.push(eventId);
    return;
  }

  state.items.push({
    type: "text",
    id: itemId ? `text:codex:${itemId}` : `text:codex:${eventId}`,
    text,
    messageId: itemId,
    sourceEventIds: [eventId],
  });
}

function reconcileCodexCompleteText(
  state: SessionState,
  eventId: number,
  itemId: string | undefined,
  text: string,
): void {
  const existing = itemId
    ? (state.items.find((item) => item.type === "text" && item.messageId === itemId) as TextItem | undefined)
    : undefined;
  if (existing) {
    existing.text = text;
    existing.sourceEventIds.push(eventId);
    return;
  }

  const lastCodexText = [...state.items]
    .reverse()
    .find((item) => item.type === "text" && isOpenCodexTextItem(item)) as TextItem | undefined;
  if (lastCodexText) {
    lastCodexText.id = itemId ? `text:codex:${itemId}` : lastCodexText.id;
    lastCodexText.messageId = itemId;
    lastCodexText.text = text;
    lastCodexText.sourceEventIds.push(eventId);
    return;
  }

  state.items.push({
    type: "text",
    id: itemId ? `text:codex:${itemId}` : `text:codex:${eventId}`,
    text,
    messageId: itemId,
    sourceEventIds: [eventId],
  });
}

function upsertCodexCommandExecution(state: SessionState, eventId: number, item: CodexItem): ToolCallItem {
  const id = item.id ? `tool:codex:${item.id}` : `tool:codex:${eventId}`;
  const input = codexCommandInput(item);
  const existing = state.items.find((candidate) =>
    candidate.type === "tool_call" && candidate.id === id,
  ) as ToolCallItem | undefined;

  if (existing) {
    existing.name = "command";
    if (hasCodexCommandInput(item)) {
      existing.input = input;
    }
    existing.sourceEventIds.push(eventId);
    return existing;
  }

  const created: ToolCallItem = {
    type: "tool_call",
    id,
    name: "command",
    input,
    sourceEventIds: [eventId],
  };
  state.items.push(created);
  return created;
}

function completeCodexCommandExecution(state: SessionState, eventId: number, item: CodexItem): void {
  const tool = findCodexToolCall(state, item.id);
  if (!tool) {
    return;
  }

  const content = codexCommandOutput(item, tool.result?.content ?? "");
  const exitCode = typeof item.exit_code === "number" ? item.exit_code : item.exitCode;
  const status = typeof item.status === "string" ? item.status : "";
  tool.result = {
    content,
    is_error: exitCodeIsError(exitCode) || status === "failed" || status === "error",
  };
  tool.sourceEventIds.push(eventId);
}

function upsertUserMessage(
  state: SessionState,
  eventId: number,
  itemId: string | undefined,
  text: string,
): UserMessageItem {
  const id = itemId ?? `user:${eventId}`;
  const existing = state.items.find((candidate) =>
    candidate.type === "user_message" && candidate.id === id,
  ) as UserMessageItem | undefined;

  if (existing) {
    existing.text = text;
    pushSourceEventId(existing, eventId);
    return existing;
  }

  const created: UserMessageItem = {
    type: "user_message",
    id,
    text,
    sourceEventIds: [eventId],
  };
  state.items.push(created);
  return created;
}

function findCodexToolCall(state: SessionState, itemId: string | undefined): ToolCallItem | undefined {
  if (itemId) {
    const id = `tool:codex:${itemId}`;
    return state.items.find((candidate) => candidate.type === "tool_call" && candidate.id === id) as
      | ToolCallItem
      | undefined;
  }
  return [...state.items].reverse().find((candidate) =>
    candidate.type === "tool_call" && candidate.id.startsWith("tool:codex:"),
  ) as ToolCallItem | undefined;
}

function codexItemId(event: {
  item_id?: string;
  itemId?: string;
  id?: string;
  item?: { id?: string };
}): string | undefined {
  return event.item_id ?? event.itemId ?? event.item?.id ?? event.id;
}

function codexContentText(item: CodexItem): string {
  return item.content?.filter((content) => content.type === "text").map((content) => content.text).join("") ?? "";
}

function stripInjectedContext(raw: string): string {
  return raw.split("\n# Session Context", 1)[0]?.trim() ?? "";
}

function codexCommandInput(item: CodexItem): JsonObject {
  if (item.input) {
    return item.input;
  }
  return typeof item.command === "string" ? { command: item.command } : {};
}

function hasCodexCommandInput(item: CodexItem): boolean {
  return item.input !== undefined || typeof item.command === "string";
}

function codexCommandOutput(item: CodexItem, fallback: string): string {
  if (typeof item.output === "string") {
    return item.output;
  }
  if (typeof item.stdout === "string" || typeof item.stderr === "string") {
    return [item.stdout, item.stderr].filter((part): part is string => typeof part === "string" && part.length > 0).join("");
  }
  if (typeof item.text === "string") {
    return item.text;
  }
  return fallback;
}

function exitCodeIsError(exitCode: unknown): boolean {
  return typeof exitCode === "number" && exitCode !== 0;
}

function isOpenCodexTextItem(item: SessionItem): item is TextItem {
  return item.type === "text" && item.uuid === undefined && item.id.startsWith("text:codex:");
}

function mergeModels(current: string[], incoming: string[]): string[] {
  const seen = new Set(current);
  for (const model of incoming) {
    if (!seen.has(model)) {
      seen.add(model);
      current.push(model);
    }
  }
  return current;
}

function isTextBlock(block: { type: string }): block is AnthropicTextBlock {
  return block.type === "text";
}

function isToolUseBlock(block: { type: string }): block is AnthropicToolUseBlock {
  return block.type === "tool_use";
}
