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
  CentaurEventFrame,
  ExecutionStatus,
  JsonObject,
  QuestionPrompt,
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

export type SessionItem = TextItem | ToolCallItem;

export interface SessionState {
  status: ExecutionStatus | "idle";
  items: SessionItem[];
  resultText: string;
  models: string[];
  costUsd: number;
  lastEventId: number;
  pendingQuestion: {
    questionId: string;
    questions: QuestionPrompt[];
  } | null;
}

export function initialSessionState(): SessionState {
  return {
    status: "idle",
    items: [],
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
    }
    return next;
  }

  if (frame.event === "question_requested") {
    next.pendingQuestion = {
      questionId: frame.data.question_id,
      questions: frame.data.questions,
    };
    return next;
  }

  if (frame.event === "question_resolved") {
    next.pendingQuestion = null;
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

  if (frame.data.type === "assistant") {
    reduceAssistant(next, frame.event_id, frame.data);
  } else if (frame.data.type === "tool") {
    reduceToolResult(next, frame.event_id, frame.data);
  } else if (frame.data.type === "result") {
    next.resultText = frame.data.text;
  } else if (frame.data.type === "item.agentMessage.delta") {
    reduceCodexAgentMessageDelta(next, frame.event_id, frame.data);
  } else if (frame.data.type === "item.started") {
    reduceCodexItemStarted(next, frame.event_id, frame.data);
  } else if (frame.data.type === "item.commandExecution.outputDelta") {
    reduceCodexCommandOutputDelta(next, frame.event_id, frame.data);
  } else if (frame.data.type === "item.completed") {
    reduceCodexItemCompleted(next, frame.event_id, frame.data);
  }

  return next;
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

  if (event.item.type === "commandExecution") {
    upsertCodexCommandExecution(state, eventId, event.item);
    completeCodexCommandExecution(state, eventId, event.item);
  }
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
