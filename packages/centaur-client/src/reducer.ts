import type {
  AmpAssistantEvent,
  AmpToolEvent,
  AnthropicTextBlock,
  AnthropicToolUseBlock,
  CentaurEventFrame,
  ExecutionStatus,
  JsonObject,
} from "./types.js";

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
}

export function initialSessionState(): SessionState {
  return {
    status: "idle",
    items: [],
    resultText: "",
    models: [],
    costUsd: 0,
    lastEventId: 0,
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
  } else if (frame.data.type === "result" || frame.data.type === "turn.done") {
    next.resultText = frame.data.type === "result" ? frame.data.text : frame.data.result;
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
