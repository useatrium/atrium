import type {
  AmpAssistantEvent,
  CodexAgentMessageDeltaEvent,
  CodexCommandExecutionOutputDeltaEvent,
  CodexItem,
  CodexItemCompletedEvent,
  CodexItemStartedEvent,
  CodexReasoningSummaryTextDeltaEvent,
  CodexReasoningTextDeltaEvent,
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
import { isTerminalExecutionStatus, isUserStoppedExecutionState } from "./types.js";

export interface TextItem {
  type: "text";
  id: string;
  text: string;
  messageId?: string;
  uuid?: string;
  handle?: string | null;
  /** Wall-clock time of the frame that created this item (from `CentaurEventFrame.ts`, the proxy stamp). */
  ts?: string;
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
  handle?: string | null;
  ts?: string;
  sourceEventIds: number[];
}

export interface ReasoningItem {
  type: "reasoning";
  id: string;
  text: string;
  summary?: string;
  messageId?: string;
  handle?: string | null;
  ts?: string;
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
  handle?: string | null;
  ts?: string;
  sourceEventIds: number[];
}

export interface UserMessageItem {
  type: "user_message";
  id: string;
  text: string;
  handle?: string | null;
  ts?: string;
  sourceEventIds: number[];
}

export type SessionItem =
  | TextItem
  | ReasoningItem
  | ToolCallItem
  | QuestionItem
  | UserMessageItem;

export interface TodoEntry {
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

interface RecordHandleHint {
  handle: string;
  kind?: string;
  actor?: string;
  meta: JsonObject;
}

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

/** A work-product file surfaced in the Artifacts work-surface. `ref` is legacy
 * transcript metadata; current bytes are served by Atrium's by-path CAS route.
 * `path` may be absolute; the surface strips the sandbox prefix for display. */
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

/** An artifact the agent intentionally surfaced as a primary result. Derived by
 * Atrium from a committed `shared/apps/<slug>/atrium.app.json` manifest (see the
 * `/artifacts/presentations` endpoint) and matched to a captured Artifact by
 * display path so the surface can render it as "the answer". */
export interface ArtifactPresentation {
  id: string;
  presentationId?: string;
  version?: number;
  appSlug?: string;
  path: string;
  title: string | null;
  renderer: string;
  description: string | null;
  previewUrl?: string | null;
  previewSizePolicy?: unknown;
  statePolicy?: unknown;
  executionId: string | null;
  sourceEventIds: number[];
}

export interface SessionState {
  status: ExecutionStatus | "idle";
  /** Server-stamped start of the current turn — `turn/started` when the harness
   * emits it, else the execution_state frame that flipped us into running. */
  turnStartTs?: string;
  /** Server-stamped end of the last turn (`turn/completed` or a terminal
   * execution_state). Cleared when a new turn starts. */
  turnEndTs?: string;
  /** Server stamp of the newest folded frame — the "agent last spoke" clock. */
  lastFrameTs?: string;
  /** Monotonic count of folded frames; the UI heartbeat pulses on change. */
  frameSeq: number;
  /** Real output-token count when the stream reports one (codex
   * `thread/tokenUsage/updated` snapshots, `usage_observed` increments). */
  tokensUsed?: number;
  /** Characters of streamed text/reasoning deltas — ÷4 approximates tokens for
   * harnesses that never report usage mid-turn (claude/amp). A ticking count is
   * the liveness instrument; the UI marks the estimate with ≈. */
  deltaChars: number;
  /** Sandbox stdout pipe health, from api-rs `session.stdout_pump_*` events. */
  transport: "ok" | "reattaching";
  items: SessionItem[];
  /** Codex `fileChange` edits (claude/amp edits are derived from items instead). */
  fileChanges: FileChange[];
  /** Captured work-product files (Artifacts surface), from artifact.captured frames. */
  artifacts: Artifact[];
  resultText: string;
  /** The last turn ended because the user interrupted it (terminal `cancelled`
   * with `reason: "turn_interrupted"`, or legacy
   * `completion_reason: "stopped_by_user"`). Rendered as "stopped by you";
   * cleared when a new turn starts. Folded from the durable event, so it's the
   * same for every viewer and survives replay/reload. */
  stoppedByUser?: boolean;
  models: string[];
  costUsd: number;
  lastEventId: number;
  todos?: TodoEntry[];
  plan?: {
    text: string;
    sourceEventIds: number[];
  } | null;
  pendingQuestion: {
    questionId: string;
    turnId?: string;
    questions: QuestionPrompt[];
  } | null;
}

export function initialSessionState(): SessionState {
  return {
    status: "idle",
    frameSeq: 0,
    deltaChars: 0,
    transport: "ok",
    items: [],
    fileChanges: [],
    artifacts: [],
    resultText: "",
    models: [],
    costUsd: 0,
    lastEventId: 0,
    plan: null,
    pendingQuestion: null,
  };
}

export function reduceSession(state: SessionState, frame: CentaurEventFrame): SessionState {
  const next = reduceSessionFrame(state, frame);
  if (frame.ts) {
    // Stamp only items this frame CREATED (their first source event). Matching
    // any touched event id would let a stamped update-frame (tool result,
    // question resolution, delta) mis-stamp an item created by an unstamped
    // frame — reachable when a stream mixes pre- and post-stamping servers.
    for (const item of next.items) {
      if (item.ts === undefined && item.sourceEventIds[0] === frame.event_id) {
        item.ts = frame.ts;
      }
    }
  }
  return next;
}

function reduceSessionFrame(state: SessionState, frame: CentaurEventFrame): SessionState {
  const next: SessionState = {
    ...state,
    items: state.items.map((item) => ({ ...item, sourceEventIds: [...item.sourceEventIds] })),
    fileChanges: [...state.fileChanges],
    artifacts: [...state.artifacts],
    models: [...state.models],
    ...(state.todos ? { todos: state.todos.map((todo) => ({ ...todo })) } : {}),
    ...(state.plan !== undefined
      ? { plan: state.plan ? { ...state.plan, sourceEventIds: [...state.plan.sourceEventIds] } : null }
      : {}),
    lastEventId: Math.max(state.lastEventId, frame.event_id),
    frameSeq: state.frameSeq + 1,
    ...(frame.ts ? { lastFrameTs: frame.ts } : {}),
  };
  const recordHandles = recordHandleHints(frame);

  if (frame.event === "execution_state") {
    const wasActive = state.status !== "idle" && !isTerminalExecutionStatus(state.status);
    next.status = frame.data.status;
    if (frame.data.result_text) {
      next.resultText = frame.data.result_text;
    }
    if (isTerminalExecutionStatus(frame.data.status)) {
      next.pendingQuestion = null;
      if (frame.ts && next.turnEndTs === undefined) next.turnEndTs = frame.ts;
      if (isUserStoppedExecutionState(frame.data)) next.stoppedByUser = true;
      resolveOpenQuestions(next, frame.event_id, "cancelled");
    } else if (!wasActive) {
      // A fresh execution began (first turn, or a steer after completion).
      // `turn/started` refines this anchor when the harness emits one.
      if (frame.ts) next.turnStartTs = frame.ts;
      delete next.turnEndTs;
      // A new turn supersedes the prior user-stop.
      next.stoppedByUser = false;
    }
    return next;
  }

  if (frame.event === "system_event_observed") {
    const subtype = (frame.data as { subtype?: unknown }).subtype;
    if (subtype === "session.stdout_pump_failed") {
      next.transport = "reattaching";
    } else if (
      subtype === "session.stdout_pump_reattached" ||
      subtype === "session.stdout_pump_recovered"
    ) {
      next.transport = "ok";
    }
    return next;
  }

  if (frame.event === "question_requested") {
    next.pendingQuestion = {
      questionId: frame.data.question_id,
      ...(frame.data.turn_id !== undefined ? { turnId: frame.data.turn_id } : {}),
      questions: frame.data.questions,
    };
    upsertQuestionItem(next, frame.event_id, frame.data, handleForQuestion(recordHandles, frame.data.question_id));
    return next;
  }

  if (frame.event === "question_resolved") {
    next.pendingQuestion = null;
    resolveQuestionItem(
      next,
      frame.event_id,
      frame.data.question_id,
      frame.data.reason,
      handleForQuestion(recordHandles, frame.data.question_id),
    );
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
    if (typeof frame.data.output_tokens === "number") {
      next.tokensUsed = (next.tokensUsed ?? 0) + frame.data.output_tokens;
    }
    next.models = mergeModels(next.models, [frame.data.model]);
    return next;
  }

  if (frame.event !== "amp_raw_event") {
    return next;
  }

  // Real harness output on the wire proves the sandbox pipe is healthy.
  next.transport = "ok";

  const raw = normalizeRawEvent(frame.data);
  if (raw.type === "turn.started") {
    if (frame.ts) next.turnStartTs = frame.ts;
    delete next.turnEndTs;
  } else if (raw.type === "thread.tokenUsage") {
    reduceThreadTokenUsage(next, raw);
  } else if (raw.type === "turn.completed") {
    if (frame.ts) next.turnEndTs = frame.ts;
  } else if (raw.type === "assistant") {
    reduceAssistant(next, frame.event_id, raw, recordHandles);
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
  } else if (raw.type === "item.reasoning.textDelta") {
    reduceReasoningTextDelta(next, frame.event_id, raw);
  } else if (raw.type === "item.reasoning.summaryTextDelta") {
    reduceReasoningSummaryTextDelta(next, frame.event_id, raw);
  } else if (raw.type === "item.completed") {
    reduceCodexItemCompleted(next, frame.event_id, raw, recordHandles);
  }

  return next;
}

function normalizeRawEvent(event: CentaurEventFrame["data"]): CentaurEventFrame["data"] {
  if (typeof event.type === "string") return event;
  const raw = event as unknown as JsonObject;
  if (typeof raw.method !== "string" || !isJsonObject(raw.params)) return event;
  const params = raw.params;
  switch (raw.method) {
    case "turn/started":
      return { type: "turn.started", ...params } as CentaurEventFrame["data"];
    case "turn/completed":
      return { type: "turn.completed", ...params } as CentaurEventFrame["data"];
    case "thread/tokenUsage/updated":
      return { type: "thread.tokenUsage", ...params } as CentaurEventFrame["data"];
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
    case "item/reasoning/textDelta":
      return {
        type: "item.reasoning.textDelta",
        ...params,
        itemId: stringValue(params.itemId) ?? stringValue(params.item_id),
      } as CentaurEventFrame["data"];
    case "item/reasoning/summaryTextDelta":
      return {
        type: "item.reasoning.summaryTextDelta",
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

function recordHandleHints(frame: CentaurEventFrame): RecordHandleHint[] {
  const raw = (frame.data as { recordHandles?: unknown }).recordHandles;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((entry): RecordHandleHint | null => {
      if (!isJsonObject(entry)) return null;
      const handle = stringValue(entry.handle);
      if (!handle) return null;
      return {
        handle,
        ...(typeof entry.kind === "string" ? { kind: entry.kind } : {}),
        ...(typeof entry.actor === "string" ? { actor: entry.actor } : {}),
        meta: isJsonObject(entry.meta) ? entry.meta : {},
      };
    })
    .filter((entry): entry is RecordHandleHint => entry !== null);
}

function handleForQuestion(hints: RecordHandleHint[], questionId: string): string | undefined {
  return handleForRecord(hints, (hint) =>
    hint.kind === "question" && stringValue(hint.meta.questionId) === questionId,
  );
}

function handleForAmpMessage(
  hints: RecordHandleHint[],
  actor: "agent" | "user",
  messageId: string | undefined,
  uuid: string | undefined,
): string | undefined {
  return handleForRecord(hints, (hint) => {
    if (hint.kind !== "message" || hint.actor !== actor) return false;
    const metaMessageId = stringValue(hint.meta.messageId);
    const metaUuid = stringValue(hint.meta.uuid);
    return (
      (messageId !== undefined && metaMessageId === messageId) ||
      (uuid !== undefined && metaUuid === uuid) ||
      (messageId === undefined && uuid === undefined)
    );
  });
}

function handleForToolUse(hints: RecordHandleHint[], toolUseId: string): string | undefined {
  return handleForRecord(hints, (hint) => {
    const metaToolUseId = stringValue(hint.meta.toolUseId) ?? stringValue(hint.meta.tool_use_id);
    return metaToolUseId === toolUseId;
  });
}

function handleForCodexItem(
  hints: RecordHandleHint[],
  itemId: string | undefined,
  kind: string,
  actor?: "agent" | "user" | "system",
): string | undefined {
  if (!itemId) return undefined;
  return handleForRecord(hints, (hint) =>
    hint.kind === kind &&
    (actor === undefined || hint.actor === actor) &&
    stringValue(hint.meta.itemId) === itemId,
  );
}

function handleForRecord(
  hints: RecordHandleHint[],
  predicate: (hint: RecordHandleHint) => boolean,
): string | undefined {
  return hints.find(predicate)?.handle;
}

function assignHandle(item: SessionItem, handle: string | undefined): void {
  if (handle) item.handle = handle;
}

function assignMessageId(item: TextItem, messageId: string | undefined): void {
  if (messageId !== undefined) {
    item.messageId = messageId;
  } else {
    delete item.messageId;
  }
}

function optionalProp<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
}

function upsertQuestionItem(
  state: SessionState,
  eventId: number,
  event: { question_id: string; turn_id?: string; questions: QuestionPrompt[] },
  handle?: string,
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
    assignHandle(existing, handle);
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
    ...(handle ? { handle } : {}),
    sourceEventIds: [eventId],
  });
}

function resolveQuestionItem(
  state: SessionState,
  eventId: number,
  questionId: string,
  reason: QuestionResolved["reason"],
  handle?: string,
): void {
  const existing = state.items.find(
    (item): item is QuestionItem => item.type === "question" && item.questionId === questionId,
  );
  if (existing) {
    existing.status = "resolved";
    existing.reason = reason;
    assignHandle(existing, handle);
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
    ...(handle ? { handle } : {}),
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

function reduceAssistant(
  state: SessionState,
  eventId: number,
  event: AmpAssistantEvent,
  handles: RecordHandleHint[],
): void {
  const text = event.message.content
    .filter(isTextBlock)
    .map((block) => block.text)
    .join("");
  const toolBlocks = event.message.content.filter(isToolUseBlock);

  if (event.uuid) {
    if (text) {
      reconcileCompleteText(
        state,
        eventId,
        event.uuid,
        event.message.id,
        text,
        handleForAmpMessage(handles, "agent", event.message.id, event.uuid),
      );
    }
    for (const block of toolBlocks) {
      applyToolDerivedState(state, eventId, upsertToolCall(state, eventId, block, handleForToolUse(handles, block.id)));
    }
    return;
  }

  if (text) {
    appendStreamingText(
      state,
      eventId,
      text,
      handleForAmpMessage(handles, "agent", event.message.id, event.uuid),
    );
  }
  for (const block of toolBlocks) {
    applyToolDerivedState(state, eventId, upsertToolCall(state, eventId, block, handleForToolUse(handles, block.id)));
  }
}

function appendStreamingText(
  state: SessionState,
  eventId: number,
  text: string,
  handle?: string,
): void {
  state.deltaChars += text.length;
  const last = state.items[state.items.length - 1];
  if (last?.type === "text" && !last.uuid) {
    last.text += text;
    assignHandle(last, handle);
    last.sourceEventIds.push(eventId);
    return;
  }

  state.items.push({
    type: "text",
    id: `text:${eventId}`,
    text,
    ...(handle ? { handle } : {}),
    sourceEventIds: [eventId],
  });
}

function reconcileCompleteText(
  state: SessionState,
  eventId: number,
  uuid: string,
  messageId: string | undefined,
  text: string,
  handle?: string,
): void {
  const existing = state.items.find((item) =>
    item.type === "text" && (item.uuid === uuid || item.messageId === messageId),
  ) as TextItem | undefined;
  if (existing) {
    existing.text = text;
    existing.uuid = uuid;
    assignMessageId(existing, messageId);
    assignHandle(existing, handle);
    existing.sourceEventIds.push(eventId);
    return;
  }

  const last = state.items[state.items.length - 1];
  if (last?.type === "text" && !last.uuid) {
    last.id = messageId ? `text:${messageId}` : `text:${uuid}`;
    last.text = text;
    last.uuid = uuid;
    assignMessageId(last, messageId);
    assignHandle(last, handle);
    last.sourceEventIds.push(eventId);
    return;
  }

  state.items.push({
    type: "text",
    id: messageId ? `text:${messageId}` : `text:${uuid}`,
    text,
    uuid,
    ...optionalProp("messageId", messageId),
    ...(handle ? { handle } : {}),
    sourceEventIds: [eventId],
  });
}

function upsertToolCall(
  state: SessionState,
  eventId: number,
  block: AnthropicToolUseBlock,
  handle?: string,
): ToolCallItem {
  const existing = state.items.find((item) =>
    item.type === "tool_call" && item.id === block.id,
  ) as ToolCallItem | undefined;

  if (existing) {
    existing.name = block.name;
    existing.input = block.input;
    assignHandle(existing, handle);
    existing.sourceEventIds.push(eventId);
    return existing;
  }

  const created: ToolCallItem = {
    type: "tool_call",
    id: block.id,
    name: block.name,
    input: block.input,
    ...(handle ? { handle } : {}),
    sourceEventIds: [eventId],
  };
  state.items.push(created);
  return created;
}

function applyToolDerivedState(state: SessionState, eventId: number, item: ToolCallItem): void {
  const name = item.name.toLowerCase();
  if (name === "todowrite") {
    state.todos = parseTodoEntries(item.input.todos);
  } else if (name === "exitplanmode") {
    state.plan = {
      text: typeof item.input.plan === "string" ? item.input.plan : "",
      sourceEventIds: [eventId],
    };
  }
}

function parseTodoEntries(value: unknown): TodoEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry): TodoEntry[] => {
    if (!isJsonObject(entry) || typeof entry.content !== "string") {
      return [];
    }
    const status = parseTodoStatus(entry.status);
    return [
      {
        content: entry.content,
        status,
        ...(typeof entry.activeForm === "string" ? { activeForm: entry.activeForm } : {}),
      },
    ];
  });
}

function parseTodoStatus(value: unknown): TodoEntry["status"] {
  return value === "in_progress" || value === "completed" || value === "pending" ? value : "pending";
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

/** Fold a codex `thread/tokenUsage/updated` snapshot. Output tokens (incl.
 * reasoning) grow smoothly during generation — that's the liveness signal.
 * ONLY the output fields count: totals include the request input/context
 * (easily 100k+), and one input-inflated snapshot would pin the max-merged
 * counter forever. A snapshot without output fields contributes nothing —
 * the chars÷4 estimate covers that stream. Snapshots are cumulative per
 * thread, so take the max rather than adding. */
function reduceThreadTokenUsage(state: SessionState, raw: { tokenUsage?: unknown }): void {
  if (!isJsonObject(raw.tokenUsage)) return;
  const total = raw.tokenUsage.total;
  if (!isJsonObject(total)) return;
  const num = (value: unknown): number => (typeof value === "number" ? value : 0);
  const output =
    num(total.outputTokens ?? total.output_tokens) +
    num(total.reasoningOutputTokens ?? total.reasoning_output_tokens);
  if (output > 0) {
    state.tokensUsed = Math.max(state.tokensUsed ?? 0, output);
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
  state.deltaChars += event.delta.length;
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

function reduceReasoningTextDelta(
  state: SessionState,
  eventId: number,
  event: CodexReasoningTextDeltaEvent,
): void {
  if (!event.delta) {
    return;
  }
  state.deltaChars += event.delta.length;
  appendReasoningText(state, eventId, codexItemId(event), event.delta);
}

function reduceReasoningSummaryTextDelta(
  state: SessionState,
  eventId: number,
  event: CodexReasoningSummaryTextDeltaEvent,
): void {
  if (!event.delta) {
    return;
  }
  state.deltaChars += event.delta.length;
  appendReasoningSummary(state, eventId, codexItemId(event), event.delta);
}

function reduceCodexItemCompleted(
  state: SessionState,
  eventId: number,
  event: CodexItemCompletedEvent,
  handles: RecordHandleHint[],
): void {
  if (event.item.type === "agentMessage") {
    const text = typeof event.item.text === "string" ? event.item.text : codexContentText(event.item);
    if (text) {
      reconcileCodexCompleteText(
        state,
        eventId,
        event.item.id,
        text,
        handleForCodexItem(handles, event.item.id, "message", "agent"),
      );
    }
    return;
  }

  if (event.item.type === "userMessage") {
    const raw = typeof event.item.text === "string" ? event.item.text : codexContentText(event.item);
    const text = stripInjectedContext(raw);
    if (text) {
      upsertUserMessage(
        state,
        eventId,
        event.item.id,
        text,
        handleForCodexItem(handles, event.item.id, "message", "user"),
      );
    }
    return;
  }

  if (event.item.type === "reasoning") {
    const text = typeof event.item.text === "string" ? event.item.text : codexContentText(event.item);
    upsertReasoningItem(
      state,
      eventId,
      event.item.id,
      text,
      stringValue(event.item.summary),
      handleForCodexItem(handles, event.item.id, "reasoning", "agent"),
      true,
    );
    return;
  }

  if (event.item.type === "plan") {
    setPlanFromText(state, eventId, typeof event.item.text === "string" ? event.item.text : codexContentText(event.item));
    return;
  }

  if (event.item.type === "commandExecution") {
    upsertCodexCommandExecution(
      state,
      eventId,
      event.item,
      handleForCodexItem(handles, event.item.id, "command", "agent"),
    );
    completeCodexCommandExecution(state, eventId, event.item);
    return;
  }

  if (event.item.type === "fileChange") {
    captureCodexFileChange(state, eventId, event.item);
  }
}

function appendReasoningText(
  state: SessionState,
  eventId: number,
  itemId: string | undefined,
  delta: string,
): void {
  const item = upsertReasoningItem(state, eventId, itemId, "");
  item.text += delta;
  pushSourceEventId(item, eventId);
}

function appendReasoningSummary(
  state: SessionState,
  eventId: number,
  itemId: string | undefined,
  delta: string,
): void {
  const item = upsertReasoningItem(state, eventId, itemId, "");
  item.summary = `${item.summary ?? ""}${delta}`;
  pushSourceEventId(item, eventId);
}

function upsertReasoningItem(
  state: SessionState,
  eventId: number,
  itemId: string | undefined,
  text: string,
  summary?: string,
  handle?: string,
  replaceText = false,
): ReasoningItem {
  const id = itemId ? `reasoning:${itemId}` : `reasoning:${eventId}`;
  const existing = state.items.find((candidate) =>
    candidate.type === "reasoning" && candidate.id === id,
  ) as ReasoningItem | undefined;

  if (existing) {
    if (replaceText) {
      existing.text = text;
    }
    if (summary !== undefined) {
      existing.summary = summary;
    }
    if (itemId) {
      existing.messageId = itemId;
    }
    assignHandle(existing, handle);
    pushSourceEventId(existing, eventId);
    return existing;
  }

  const created: ReasoningItem = {
    type: "reasoning",
    id,
    text,
    ...(summary !== undefined ? { summary } : {}),
    ...(itemId ? { messageId: itemId } : {}),
    ...(handle ? { handle } : {}),
    sourceEventIds: [eventId],
  };
  state.items.push(created);
  return created;
}

function setPlanFromText(state: SessionState, eventId: number, text: string): void {
  state.plan = { text, sourceEventIds: [eventId] };
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
    ...optionalProp("messageId", itemId),
    sourceEventIds: [eventId],
  });
}

function reconcileCodexCompleteText(
  state: SessionState,
  eventId: number,
  itemId: string | undefined,
  text: string,
  handle?: string,
): void {
  const existing = itemId
    ? (state.items.find((item) => item.type === "text" && item.messageId === itemId) as TextItem | undefined)
    : undefined;
  if (existing) {
    existing.text = text;
    assignHandle(existing, handle);
    existing.sourceEventIds.push(eventId);
    return;
  }

  const lastCodexText = [...state.items]
    .reverse()
    .find((item) => item.type === "text" && isOpenCodexTextItem(item)) as TextItem | undefined;
  if (lastCodexText) {
    lastCodexText.id = itemId ? `text:codex:${itemId}` : lastCodexText.id;
    assignMessageId(lastCodexText, itemId);
    lastCodexText.text = text;
    assignHandle(lastCodexText, handle);
    lastCodexText.sourceEventIds.push(eventId);
    return;
  }

  state.items.push({
    type: "text",
    id: itemId ? `text:codex:${itemId}` : `text:codex:${eventId}`,
    text,
    ...optionalProp("messageId", itemId),
    ...(handle ? { handle } : {}),
    sourceEventIds: [eventId],
  });
}

function upsertCodexCommandExecution(
  state: SessionState,
  eventId: number,
  item: CodexItem,
  handle?: string,
): ToolCallItem {
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
    assignHandle(existing, handle);
    existing.sourceEventIds.push(eventId);
    return existing;
  }

  const created: ToolCallItem = {
    type: "tool_call",
    id,
    name: "command",
    input,
    ...(handle ? { handle } : {}),
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
  handle?: string,
): UserMessageItem {
  const id = itemId ?? `user:${eventId}`;
  const existing = state.items.find((candidate) =>
    candidate.type === "user_message" && candidate.id === id,
  ) as UserMessageItem | undefined;

  if (existing) {
    existing.text = text;
    assignHandle(existing, handle);
    pushSourceEventId(existing, eventId);
    return existing;
  }

  const created: UserMessageItem = {
    type: "user_message",
    id,
    text,
    ...(handle ? { handle } : {}),
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
  let end = raw.length;
  for (const marker of ["\n# Session Context", "\n\n---\nReferenced entries:"]) {
    const index = raw.indexOf(marker);
    if (index !== -1 && index < end) end = index;
  }
  return raw.slice(0, end).trim();
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
