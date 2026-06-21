export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject {
  [key: string]: unknown;
}

export type ExecutionStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "failed_permanent"
  | "cancelled"
  | (string & {});

export interface ExecutionState {
  type: "execution.state";
  status: ExecutionStatus;
  thread_key: string;
  execution_id: string;
  result_text?: string;
  agent_thread_id?: string;
  terminal_reason?: string;
  [key: string]: unknown;
}

export interface AnthropicTextBlock {
  type: "text";
  text: string;
  [key: string]: unknown;
}

export interface AnthropicToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: JsonObject;
  [key: string]: unknown;
}

export type AnthropicMessageBlock =
  | AnthropicTextBlock
  | AnthropicToolUseBlock
  | ({ type: string } & JsonObject);

export interface AnthropicMessage {
  id?: string;
  role?: "assistant" | string;
  type?: "message" | string;
  model?: string;
  usage?: JsonObject;
  content: AnthropicMessageBlock[];
  stop_reason?: string | null;
  stop_sequence?: string | null;
  context_management?: JsonValue;
  [key: string]: unknown;
}

export interface AmpSystemEvent {
  type: "system";
  subtype: string;
  session_id?: string;
  [key: string]: unknown;
}

export interface AmpAssistantEvent {
  type: "assistant";
  message: AnthropicMessage;
  uuid?: string;
  request_id?: string;
  session_id?: string;
  parent_tool_use_id?: string | null;
  [key: string]: unknown;
}

export interface AmpToolResultContent {
  content: string;
  is_error: boolean;
  tool_use_id?: string;
  [key: string]: unknown;
}

export interface AmpToolEvent {
  type: "tool";
  content: AmpToolResultContent[];
  [key: string]: unknown;
}

export interface AmpResultEvent {
  type: "result";
  text: string;
  [key: string]: unknown;
}

export interface AmpTurnDoneEvent {
  type: "turn.done";
  result: string;
  turn_id: number;
  agent_thread_id?: string;
  [key: string]: unknown;
}

export interface CodexTextContent {
  type: "text";
  text: string;
  text_elements?: unknown[];
  [key: string]: unknown;
}

export interface CodexItem {
  id?: string;
  type: "userMessage" | "agentMessage" | "commandExecution" | "fileChange" | "reasoning" | "plan" | (string & {});
  content?: CodexTextContent[];
  text?: string;
  command?: string;
  input?: JsonObject;
  output?: string;
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  exitCode?: number;
  status?: string;
  [key: string]: unknown;
}

export interface CodexItemStartedEvent {
  type: "item.started";
  item: CodexItem;
  [key: string]: unknown;
}

export interface CodexItemCompletedEvent {
  type: "item.completed";
  item: CodexItem;
  [key: string]: unknown;
}

export interface CodexAgentMessageDeltaEvent {
  type: "item.agentMessage.delta";
  delta: string;
  item_id?: string;
  itemId?: string;
  id?: string;
  item?: CodexItem;
  [key: string]: unknown;
}

export interface CodexCommandExecutionOutputDeltaEvent {
  type: "item.commandExecution.outputDelta";
  delta?: string;
  output?: string;
  item_id?: string;
  itemId?: string;
  id?: string;
  item?: CodexItem;
  [key: string]: unknown;
}

export type AmpRawEvent =
  | AmpSystemEvent
  | AmpAssistantEvent
  | AmpToolEvent
  | AmpResultEvent
  | AmpTurnDoneEvent
  | CodexItemStartedEvent
  | CodexItemCompletedEvent
  | CodexAgentMessageDeltaEvent
  | CodexCommandExecutionOutputDeltaEvent;

interface ObservationBase {
  engine: string;
  harness: string;
  thread_key: string;
  execution_id: string;
  persona_id?: string | null;
  prompt_ref?: string;
  prompt_sha?: string;
  assignment_generation?: number;
  [key: string]: JsonValue | undefined;
}

export interface AssistantTextObserved extends ObservationBase {
  type: "obs.assistant_text";
  text_chars: number;
  text_block_count: number;
}

export interface AssistantToolUseObserved extends ObservationBase {
  type: "obs.assistant_tool_use";
  tool_name: string;
  tool_use_id: string;
  input_keys: string[];
  input_size_bytes: number;
}

export interface ToolResultObserved extends ObservationBase {
  type: "obs.tool_result";
  tool_use_id: string;
  is_error: boolean;
  content_size_bytes: number;
}

export interface UsageObserved extends ObservationBase {
  type: "obs.usage";
  model: string;
  cost_usd: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  authoritative?: boolean;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ExecutionSummaryObserved extends ObservationBase {
  type: "obs.execution_summary";
  models: string[];
  status: ExecutionStatus;
  cost_usd?: number;
  duration_s?: number;
  terminal_reason?: string;
}

export interface ExecutionStartedObserved extends ObservationBase {
  type: "obs.execution_started";
  user_id: string;
  runtime_id?: string;
  queue_delay_s?: number;
  delivery_platform?: string;
  execution_sequence?: number;
}

export interface SystemObserved extends ObservationBase {
  type: "obs.system";
  subtype: string;
  session_id?: string;
}

export interface ResultObserved extends ObservationBase {
  type: "obs.result";
  text_chars: number;
}

export interface QuestionOption {
  label: string;
  description: string;
  preview?: string;
  previewFormat?: "markdown" | "html";
}

export interface QuestionPrompt {
  id: string;
  header: string;
  question: string;
  multiSelect?: boolean;
  isOther?: boolean;
  isSecret?: boolean;
  options?: QuestionOption[];
}

export interface QuestionRequested {
  type: "question_requested";
  question_id: string;
  turn_id: string;
  questions: QuestionPrompt[];
}

export interface QuestionResolved {
  type: "question_resolved";
  question_id: string;
  reason: "answered" | "cancelled" | "empty";
}

/** A file the sandbox capture sidecar surfaced as a work-product artifact. The
 * bytes (if any) live in Centaur staging keyed by `ref`; atrium offloads them to
 * its own object store and serves them. `ref: null` = manifest-only (the file was
 * too large or filtered as junk — metadata captured, bytes not staged). */
export interface ArtifactCaptured {
  type: "artifact.captured";
  artifact_id: string;
  /** Execution that captured this artifact. Optional for backward compat with
   * events emitted before Centaur added it. */
  execution_id?: string;
  path: string;
  kind: "created" | "modified" | "deleted";
  mime: string;
  size_bytes: number;
  sha256: string;
  ref: string | null;
}

export type ProjectionEvent =
  | AssistantTextObserved
  | AssistantToolUseObserved
  | ToolResultObserved
  | UsageObserved
  | ExecutionSummaryObserved
  | ExecutionStartedObserved
  | SystemObserved
  | ResultObserved;

export type CentaurEventFrame =
  | { event: "execution_state"; event_id: number; data: ExecutionState }
  | { event: "execution_started"; event_id: number; data: ExecutionStartedObserved }
  | { event: "amp_raw_event"; event_id: number; data: AmpRawEvent }
  | { event: "system_event_observed"; event_id: number; data: SystemObserved }
  | { event: "assistant_text_observed"; event_id: number; data: AssistantTextObserved }
  | { event: "assistant_tool_use_observed"; event_id: number; data: AssistantToolUseObserved }
  | { event: "tool_result_observed"; event_id: number; data: ToolResultObserved }
  | { event: "usage_observed"; event_id: number; data: UsageObserved }
  | { event: "result_observed"; event_id: number; data: ResultObserved }
  | { event: "execution_summary"; event_id: number; data: ExecutionSummaryObserved }
  | { event: "question_requested"; event_id: number; data: QuestionRequested }
  | { event: "question_resolved"; event_id: number; data: QuestionResolved }
  | { event: "artifact.captured"; event_id: number; data: ArtifactCaptured };

export function isTerminalExecutionStatus(status: ExecutionStatus): boolean {
  return status === "completed" || status === "failed" || status === "failed_permanent" || status === "cancelled";
}
