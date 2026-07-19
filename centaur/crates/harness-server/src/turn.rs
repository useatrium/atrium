use std::collections::HashMap;
use std::path::PathBuf;

use codex_app_server_protocol::{
    AgentMessageDeltaNotification, CommandAction, CommandExecutionSource, CommandExecutionStatus,
    DynamicToolCallStatus, ErrorNotification, FileUpdateChange, ItemCompletedNotification,
    ItemStartedNotification, PatchApplyStatus, PatchChangeKind, ServerNotification, SessionSource,
    Thread, ThreadItem, ThreadStartedNotification, ThreadStatus, ThreadTokenUsage,
    ThreadTokenUsageUpdatedNotification, TokenUsageBreakdown, Turn, TurnCompletedNotification,
    TurnError, TurnItemsView, TurnStartedNotification, TurnStatus, UserInput,
};
use codex_protocol::models::MessagePhase;
use codex_utils_absolute_path::AbsolutePathBuf;
use serde_json::Value;

use crate::traits::{
    NormalizedContent, NormalizedEvent, NormalizedTokenUsage, NormalizedToolResult,
};
use crate::util::{now_millis, now_secs, stable_id, suffix_delta};
use crate::{HarnessServerError, Result};

#[derive(Debug, Clone)]
pub struct BridgeConfig {
    pub thread_id: String,
    pub turn_id: String,
    pub cwd: PathBuf,
    pub cli_version: String,
    pub model_provider: String,
}

impl BridgeConfig {
    pub fn new(thread_id: impl Into<String>, turn_id: impl Into<String>) -> Self {
        Self {
            thread_id: thread_id.into(),
            turn_id: turn_id.into(),
            cwd: std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/")),
            cli_version: "claude-code".to_string(),
            model_provider: "anthropic".to_string(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct CodexTurnNormalizer {
    thread_id: String,
    turn_id: String,
    cwd: PathBuf,
    cli_version: String,
    model_provider: String,
    thread_started: bool,
    turn_started: bool,
    completed: bool,
    turn_started_at: i64,
    last_error: Option<String>,
    text_by_item_id: HashMap<String, String>,
    reasoning_by_item_id: HashMap<String, String>,
    tool_calls_by_raw_id: HashMap<String, ToolCallState>,
    started_items: HashMap<String, ThreadItem>,
    completed_items: Vec<ThreadItem>,
    user_message_count: usize,
    /// One isolated projector per Task-tool subagent, keyed by
    /// `parent_tool_use_id`. Each projects the subagent's own item stream (with
    /// ids already namespaced `sub~<parent>~…` upstream) without polluting the
    /// parent turn's `completed_items`, and its lifecycle/token notifications are
    /// never forwarded — so a subagent can't settle or bill the parent turn.
    subagents: HashMap<String, CodexTurnNormalizer>,
}

#[derive(Debug, Clone)]
struct ToolCallState {
    item_id: String,
    tool: String,
    arguments: Value,
    projection: ToolProjection,
}

#[derive(Debug, Clone)]
enum ToolProjection {
    CommandExecution { command: String },
    FileChange { changes: Vec<FileUpdateChange> },
    DynamicToolCall,
}

impl CodexTurnNormalizer {
    pub fn new(config: BridgeConfig) -> Self {
        Self {
            thread_id: config.thread_id,
            turn_id: config.turn_id,
            cwd: config.cwd,
            cli_version: config.cli_version,
            model_provider: config.model_provider,
            thread_started: false,
            turn_started: false,
            completed: false,
            turn_started_at: now_secs(),
            last_error: None,
            text_by_item_id: HashMap::new(),
            reasoning_by_item_id: HashMap::new(),
            tool_calls_by_raw_id: HashMap::new(),
            started_items: HashMap::new(),
            completed_items: Vec::new(),
            user_message_count: 0,
            subagents: HashMap::new(),
        }
    }

    pub fn thread_id(&self) -> &str {
        &self.thread_id
    }

    pub fn turn_id(&self) -> &str {
        &self.turn_id
    }

    pub fn thread_snapshot(&self) -> Result<Thread> {
        self.thread()
    }

    pub fn turn_snapshot(&self, status: TurnStatus) -> Turn {
        Turn {
            id: self.turn_id.clone(),
            items: if status == TurnStatus::InProgress {
                Vec::new()
            } else {
                self.completed_items.clone()
            },
            items_view: TurnItemsView::Full,
            status,
            error: None,
            started_at: Some(self.turn_started_at),
            completed_at: None,
            duration_ms: None,
        }
    }

    pub fn start_notifications(
        &mut self,
        include_thread_started: bool,
    ) -> Result<Vec<ServerNotification>> {
        let mut out = Vec::new();
        if !include_thread_started {
            self.thread_started = true;
        }
        self.ensure_started(&mut out)?;
        Ok(out)
    }

    pub fn process_event(&mut self, event: &NormalizedEvent) -> Result<Vec<ServerNotification>> {
        let mut out = Vec::new();

        if let NormalizedEvent::Ignored = event {
            return Ok(out);
        }

        if let Some(session_id) = event.session_id()
            && !self.thread_started
        {
            self.thread_id = session_id.to_string();
        }

        self.ensure_started(&mut out)?;

        match event {
            NormalizedEvent::SessionStarted { .. } => {}
            NormalizedEvent::AgentMessageStarted {
                item_id,
                stop_reason,
            } => {
                let phase = phase_from_stop_reason(stop_reason.as_deref());
                self.start_agent_message_item(item_id, phase, &mut out);
            }
            NormalizedEvent::AssistantMessage {
                partial,
                stop_reason,
                content,
            } => {
                let phase = phase_from_stop_reason(stop_reason.as_deref());
                for item in content {
                    match item {
                        NormalizedContent::AgentText { item_id, text } => {
                            self.emit_agent_text(item_id, text, *partial, phase.clone(), &mut out);
                        }
                        NormalizedContent::ReasoningText { item_id, text } => {
                            self.emit_reasoning_text(item_id, text, *partial, &mut out);
                        }
                        NormalizedContent::ToolUse {
                            raw_id,
                            tool,
                            arguments,
                        } => {
                            if !partial {
                                self.emit_tool_use(raw_id, tool, arguments.clone(), &mut out)?;
                            }
                        }
                    }
                }
            }
            NormalizedEvent::AgentTextDelta { item_id, delta } => {
                self.emit_agent_text_delta(item_id, delta, &mut out);
            }
            NormalizedEvent::ReasoningTextDelta { item_id, delta } => {
                self.emit_reasoning_text_delta(item_id, delta, &mut out);
            }
            NormalizedEvent::ToolResults(results) => {
                for result in results {
                    self.emit_tool_result(result, &mut out)?;
                }
            }
            NormalizedEvent::TokenUsage { usage } => {
                out.push(self.token_usage_notification(usage));
            }
            NormalizedEvent::Subagent { parent_id, event } => {
                self.process_subagent_event(parent_id, event, &mut out)?;
            }
            NormalizedEvent::Result { error } => {
                if let Some(error) = error {
                    self.last_error = Some(error.clone());
                }
            }
            NormalizedEvent::Error { message } => {
                self.last_error = Some(message.clone());
                out.push(self.error_notification(message.clone()));
            }
            NormalizedEvent::Ignored => {}
        }

        Ok(out)
    }

    /// Projects one subagent (Task-tool sidechain) event through an isolated
    /// per-subagent projector, reusing the full item pipeline (reasoning,
    /// commandExecution, fileChange, dynamicToolCall, agentMessage). The
    /// subagent's item ids are already namespaced `sub~<parent>~…` upstream, so
    /// no rewriting is needed here — the client attributes them by id prefix.
    ///
    /// A subagent's terminal, token-usage, and session events are dropped: they
    /// must never settle or bill the parent turn. The per-subagent projector is
    /// pre-marked started so it never emits its own `thread/started` /
    /// `turn/started`; only item and delta notifications are forwarded.
    fn process_subagent_event(
        &mut self,
        parent_id: &str,
        event: &NormalizedEvent,
        out: &mut Vec<ServerNotification>,
    ) -> Result<()> {
        if matches!(
            event,
            NormalizedEvent::Result { .. }
                | NormalizedEvent::Error { .. }
                | NormalizedEvent::TokenUsage { .. }
                | NormalizedEvent::SessionStarted { .. }
                | NormalizedEvent::Subagent { .. }
        ) {
            return Ok(());
        }
        let subagent = self
            .subagents
            .entry(parent_id.to_string())
            .or_insert_with(|| {
                let mut projector = CodexTurnNormalizer::new(BridgeConfig {
                    thread_id: self.thread_id.clone(),
                    turn_id: self.turn_id.clone(),
                    cwd: self.cwd.clone(),
                    cli_version: self.cli_version.clone(),
                    model_provider: self.model_provider.clone(),
                });
                projector.thread_started = true;
                projector.turn_started = true;
                projector
            });
        for notification in subagent.process_event(event)? {
            if is_subagent_forwardable(&notification) {
                out.push(notification);
            }
        }
        Ok(())
    }

    pub fn emit_user_message(
        &mut self,
        client_id: Option<String>,
        content: Vec<UserInput>,
    ) -> Result<Vec<ServerNotification>> {
        let mut out = Vec::new();
        if content.is_empty() {
            return Ok(out);
        }
        self.ensure_started(&mut out)?;
        self.user_message_count += 1;
        let item = ThreadItem::UserMessage {
            id: format!("{}-user-{}", self.turn_id, self.user_message_count),
            client_id,
            content,
        };
        self.completed_items.push(item.clone());
        out.push(self.item_started(item.clone()));
        out.push(self.item_completed(item));
        Ok(out)
    }

    pub fn finish_turn(&mut self, failed: Option<String>) -> Result<Option<ServerNotification>> {
        if self.completed {
            return Ok(None);
        }
        let error = failed.or_else(|| self.last_error.clone());
        let status = if error.is_some() {
            TurnStatus::Failed
        } else {
            TurnStatus::Completed
        };
        self.finish_turn_with_status(status, error)
    }

    pub fn finish_turn_interrupted(&mut self) -> Result<Option<ServerNotification>> {
        self.finish_turn_with_status(TurnStatus::Interrupted, None)
    }

    fn finish_turn_with_status(
        &mut self,
        status: TurnStatus,
        error: Option<String>,
    ) -> Result<Option<ServerNotification>> {
        if self.completed {
            return Ok(None);
        }
        self.completed = true;
        let completed_at = now_secs();
        Ok(Some(ServerNotification::TurnCompleted(
            TurnCompletedNotification {
                thread_id: self.thread_id.clone(),
                turn: Turn {
                    id: self.turn_id.clone(),
                    items: self.completed_items.clone(),
                    items_view: TurnItemsView::Full,
                    status,
                    error: error.map(|message| TurnError {
                        message,
                        codex_error_info: None,
                        additional_details: None,
                    }),
                    started_at: Some(self.turn_started_at),
                    completed_at: Some(completed_at),
                    duration_ms: Some((completed_at - self.turn_started_at).max(0) * 1000),
                },
            },
        )))
    }

    fn ensure_started(&mut self, out: &mut Vec<ServerNotification>) -> Result<()> {
        if !self.thread_started {
            self.thread_started = true;
            out.push(ServerNotification::ThreadStarted(
                ThreadStartedNotification {
                    thread: self.thread()?,
                },
            ));
        }
        if !self.turn_started {
            self.turn_started = true;
            out.push(ServerNotification::TurnStarted(TurnStartedNotification {
                thread_id: self.thread_id.clone(),
                turn: Turn {
                    id: self.turn_id.clone(),
                    items: Vec::new(),
                    items_view: TurnItemsView::Full,
                    status: TurnStatus::InProgress,
                    error: None,
                    started_at: Some(self.turn_started_at),
                    completed_at: None,
                    duration_ms: None,
                },
            }));
        }
        Ok(())
    }

    fn thread(&self) -> Result<Thread> {
        let cwd = AbsolutePathBuf::from_absolute_path(&self.cwd).map_err(|_| {
            HarnessServerError::CwdMustBeAbsolute {
                path: self.cwd.clone(),
            }
        })?;
        let now = now_secs();
        Ok(Thread {
            id: self.thread_id.clone(),
            session_id: self.thread_id.clone(),
            forked_from_id: None,
            preview: String::new(),
            ephemeral: false,
            model_provider: self.model_provider.clone(),
            created_at: self.turn_started_at,
            updated_at: now,
            status: ThreadStatus::Idle,
            path: None,
            cwd,
            cli_version: self.cli_version.clone(),
            source: SessionSource::AppServer,
            thread_source: None,
            agent_nickname: None,
            agent_role: None,
            git_info: None,
            name: None,
            turns: Vec::new(),
        })
    }

    fn start_agent_message_item(
        &mut self,
        item_id: &str,
        phase: Option<MessagePhase>,
        out: &mut Vec<ServerNotification>,
    ) {
        if self.started_items.contains_key(item_id) {
            return;
        }
        let item = ThreadItem::AgentMessage {
            id: item_id.to_string(),
            text: String::new(),
            phase,
            memory_citation: None,
        };
        self.started_items.insert(item_id.to_string(), item.clone());
        out.push(self.item_started(item));
    }

    fn emit_agent_text(
        &mut self,
        item_id: &str,
        text: &str,
        partial: bool,
        phase: Option<MessagePhase>,
        out: &mut Vec<ServerNotification>,
    ) {
        self.start_agent_message_item(item_id, phase.clone(), out);

        let previous = self
            .text_by_item_id
            .get(item_id)
            .cloned()
            .unwrap_or_default();
        let delta = suffix_delta(&previous, text);
        if !delta.is_empty() {
            out.push(ServerNotification::AgentMessageDelta(
                AgentMessageDeltaNotification {
                    thread_id: self.thread_id.clone(),
                    turn_id: self.turn_id.clone(),
                    item_id: item_id.to_string(),
                    delta,
                },
            ));
            self.text_by_item_id
                .insert(item_id.to_string(), text.to_string());
        }

        if !partial {
            let final_text = text.to_string();
            self.text_by_item_id.remove(item_id);
            let item = ThreadItem::AgentMessage {
                id: item_id.to_string(),
                text: final_text,
                phase,
                memory_citation: None,
            };
            self.completed_items.push(item.clone());
            out.push(self.item_completed(item));
        }
    }

    fn emit_agent_text_delta(
        &mut self,
        item_id: &str,
        delta: &str,
        out: &mut Vec<ServerNotification>,
    ) {
        if delta.is_empty() {
            return;
        }
        self.start_agent_message_item(item_id, None, out);
        out.push(ServerNotification::AgentMessageDelta(
            AgentMessageDeltaNotification {
                thread_id: self.thread_id.clone(),
                turn_id: self.turn_id.clone(),
                item_id: item_id.to_string(),
                delta: delta.to_string(),
            },
        ));
        self.text_by_item_id
            .entry(item_id.to_string())
            .and_modify(|text| text.push_str(delta))
            .or_insert_with(|| delta.to_string());
    }

    fn emit_reasoning_text(
        &mut self,
        item_id: &str,
        text: &str,
        partial: bool,
        out: &mut Vec<ServerNotification>,
    ) {
        let previous = self
            .reasoning_by_item_id
            .get(item_id)
            .cloned()
            .unwrap_or_default();
        let final_text = if text.is_empty() && !previous.is_empty() {
            previous.clone()
        } else {
            text.to_string()
        };

        if final_text.is_empty() && !self.started_items.contains_key(item_id) {
            return;
        }

        if !self.started_items.contains_key(item_id) {
            let item = ThreadItem::Reasoning {
                id: item_id.to_string(),
                summary: Vec::new(),
                content: Vec::new(),
            };
            self.started_items.insert(item_id.to_string(), item.clone());
            out.push(self.item_started(item));
        }

        let delta = suffix_delta(&previous, &final_text);
        if !delta.is_empty() {
            out.push(ServerNotification::ReasoningTextDelta(
                codex_app_server_protocol::ReasoningTextDeltaNotification {
                    thread_id: self.thread_id.clone(),
                    turn_id: self.turn_id.clone(),
                    item_id: item_id.to_string(),
                    delta,
                    content_index: 0,
                },
            ));
            self.reasoning_by_item_id
                .insert(item_id.to_string(), final_text.clone());
        }

        if !partial {
            self.reasoning_by_item_id.remove(item_id);
            let item = ThreadItem::Reasoning {
                id: item_id.to_string(),
                summary: Vec::new(),
                content: vec![final_text],
            };
            self.completed_items.push(item.clone());
            out.push(self.item_completed(item));
        }
    }

    fn emit_reasoning_text_delta(
        &mut self,
        item_id: &str,
        delta: &str,
        out: &mut Vec<ServerNotification>,
    ) {
        if delta.is_empty() {
            return;
        }
        if !self.started_items.contains_key(item_id) {
            let item = ThreadItem::Reasoning {
                id: item_id.to_string(),
                summary: Vec::new(),
                content: Vec::new(),
            };
            self.started_items.insert(item_id.to_string(), item.clone());
            out.push(self.item_started(item));
        }
        out.push(ServerNotification::ReasoningTextDelta(
            codex_app_server_protocol::ReasoningTextDeltaNotification {
                thread_id: self.thread_id.clone(),
                turn_id: self.turn_id.clone(),
                item_id: item_id.to_string(),
                delta: delta.to_string(),
                content_index: 0,
            },
        ));
        self.reasoning_by_item_id
            .entry(item_id.to_string())
            .and_modify(|text| text.push_str(delta))
            .or_insert_with(|| delta.to_string());
    }

    fn emit_tool_use(
        &mut self,
        raw_id: &str,
        tool: &str,
        arguments: Value,
        out: &mut Vec<ServerNotification>,
    ) -> Result<()> {
        let item_id = stable_id(raw_id, "tool-call");
        let projection = tool_projection(tool, &arguments);
        self.tool_calls_by_raw_id.insert(
            raw_id.to_string(),
            ToolCallState {
                item_id: item_id.clone(),
                tool: tool.to_string(),
                arguments: arguments.clone(),
                projection: projection.clone(),
            },
        );
        if self.started_items.contains_key(&item_id) {
            return Ok(());
        }
        let item = match projection {
            ToolProjection::CommandExecution { command } => self.command_execution_item(
                item_id.clone(),
                command,
                CommandExecutionStatus::InProgress,
                None,
                None,
            )?,
            ToolProjection::FileChange { changes } => ThreadItem::FileChange {
                id: item_id.clone(),
                changes,
                status: PatchApplyStatus::InProgress,
            },
            ToolProjection::DynamicToolCall => ThreadItem::DynamicToolCall {
                id: item_id.clone(),
                namespace: None,
                tool: tool.to_string(),
                arguments,
                status: DynamicToolCallStatus::InProgress,
                content_items: None,
                success: None,
                duration_ms: None,
            },
        };
        self.started_items.insert(item_id, item.clone());
        out.push(self.item_started(item));
        Ok(())
    }

    fn emit_tool_result(
        &mut self,
        result: &NormalizedToolResult,
        out: &mut Vec<ServerNotification>,
    ) -> Result<()> {
        let fallback_item_id = stable_id(&result.tool_use_id, "tool-call");
        let state = self
            .tool_calls_by_raw_id
            .remove(&result.tool_use_id)
            .unwrap_or_else(|| ToolCallState {
                item_id: fallback_item_id,
                tool: result.tool_use_id.clone(),
                arguments: Value::Null,
                projection: ToolProjection::DynamicToolCall,
            });
        if !self.started_items.contains_key(&state.item_id) {
            let started = match &state.projection {
                ToolProjection::CommandExecution { command } => self.command_execution_item(
                    state.item_id.clone(),
                    command.clone(),
                    CommandExecutionStatus::InProgress,
                    None,
                    None,
                )?,
                ToolProjection::FileChange { changes } => ThreadItem::FileChange {
                    id: state.item_id.clone(),
                    changes: changes.clone(),
                    status: PatchApplyStatus::InProgress,
                },
                ToolProjection::DynamicToolCall => ThreadItem::DynamicToolCall {
                    id: state.item_id.clone(),
                    namespace: None,
                    tool: state.tool.clone(),
                    arguments: state.arguments.clone(),
                    status: DynamicToolCallStatus::InProgress,
                    content_items: None,
                    success: None,
                    duration_ms: None,
                },
            };
            self.started_items
                .insert(state.item_id.clone(), started.clone());
            out.push(self.item_started(started));
        }

        let item = match state.projection {
            ToolProjection::CommandExecution { command } => {
                let (aggregated_output, exit_code) = command_result_output_and_exit_code(result);
                let failed = result.is_error || exit_code.is_some_and(|code| code != 0);
                self.command_execution_item(
                    state.item_id,
                    command,
                    if failed {
                        CommandExecutionStatus::Failed
                    } else {
                        CommandExecutionStatus::Completed
                    },
                    Some(aggregated_output),
                    exit_code,
                )?
            }
            ToolProjection::FileChange { changes } => ThreadItem::FileChange {
                id: state.item_id,
                changes,
                status: if result.is_error {
                    PatchApplyStatus::Failed
                } else {
                    PatchApplyStatus::Completed
                },
            },
            ToolProjection::DynamicToolCall => ThreadItem::DynamicToolCall {
                id: state.item_id,
                namespace: None,
                tool: state.tool,
                arguments: state.arguments,
                status: if result.is_error {
                    DynamicToolCallStatus::Failed
                } else {
                    DynamicToolCallStatus::Completed
                },
                content_items: Some(vec![
                    codex_app_server_protocol::DynamicToolCallOutputContentItem::InputText {
                        text: result.content.clone(),
                    },
                ]),
                success: Some(!result.is_error),
                duration_ms: None,
            },
        };
        self.completed_items.push(item.clone());
        out.push(self.item_completed(item));
        Ok(())
    }

    fn command_execution_item(
        &self,
        item_id: String,
        command: String,
        status: CommandExecutionStatus,
        aggregated_output: Option<String>,
        exit_code: Option<i32>,
    ) -> Result<ThreadItem> {
        let cwd = AbsolutePathBuf::from_absolute_path(&self.cwd).map_err(|_| {
            HarnessServerError::CwdMustBeAbsolute {
                path: self.cwd.clone(),
            }
        })?;
        Ok(ThreadItem::CommandExecution {
            id: item_id,
            command: command.clone(),
            cwd,
            process_id: None,
            source: CommandExecutionSource::Agent,
            status,
            command_actions: vec![CommandAction::Unknown { command }],
            aggregated_output,
            exit_code,
            duration_ms: None,
        })
    }

    fn item_started(&self, item: ThreadItem) -> ServerNotification {
        ServerNotification::ItemStarted(ItemStartedNotification {
            item,
            thread_id: self.thread_id.clone(),
            turn_id: self.turn_id.clone(),
            started_at_ms: now_millis(),
        })
    }

    fn item_completed(&self, item: ThreadItem) -> ServerNotification {
        ServerNotification::ItemCompleted(ItemCompletedNotification {
            item,
            thread_id: self.thread_id.clone(),
            turn_id: self.turn_id.clone(),
            completed_at_ms: now_millis(),
        })
    }

    /// Projects a normalized token-usage sample onto the codex-native
    /// `thread/tokenUsage/updated` snapshot. The Atrium reducer max-merges
    /// snapshots and reads `tokenUsage.total.outputTokens` /
    /// `reasoningOutputTokens`, so cumulative counts stay correct even though
    /// Claude reports per-message usage. `total` and `last` carry the same
    /// breakdown; the reducer only consults `total`.
    fn token_usage_notification(&self, usage: &NormalizedTokenUsage) -> ServerNotification {
        let breakdown = token_usage_breakdown(usage);
        ServerNotification::ThreadTokenUsageUpdated(ThreadTokenUsageUpdatedNotification {
            thread_id: self.thread_id.clone(),
            turn_id: self.turn_id.clone(),
            token_usage: ThreadTokenUsage {
                total: breakdown.clone(),
                last: breakdown,
                model_context_window: None,
            },
        })
    }

    fn error_notification(&self, message: String) -> ServerNotification {
        ServerNotification::Error(ErrorNotification {
            error: TurnError {
                message,
                codex_error_info: None,
                additional_details: None,
            },
            will_retry: false,
            thread_id: self.thread_id.clone(),
            turn_id: self.turn_id.clone(),
        })
    }
}

/// Classifies an assistant message by its stop reason: `tool_use` means more
/// work follows in the same turn (commentary), while `end_turn`/`stop_sequence`
/// terminate the turn (final answer). Unknown reasons stay unphased so
/// downstream keeps its compatibility behavior.
/// Only item lifecycle and streaming-delta notifications from a subagent's
/// projector reach the wire. Its thread/turn lifecycle and token-usage
/// notifications are the parent turn's concern and are suppressed.
fn is_subagent_forwardable(notification: &ServerNotification) -> bool {
    matches!(
        notification,
        ServerNotification::ItemStarted(_)
            | ServerNotification::ItemCompleted(_)
            | ServerNotification::AgentMessageDelta(_)
            | ServerNotification::ReasoningTextDelta(_)
    )
}

fn phase_from_stop_reason(stop_reason: Option<&str>) -> Option<MessagePhase> {
    match stop_reason {
        Some("tool_use") => Some(MessagePhase::Commentary),
        Some("end_turn" | "stop_sequence") => Some(MessagePhase::FinalAnswer),
        _ => None,
    }
}

fn tool_projection(tool: &str, arguments: &Value) -> ToolProjection {
    if matches!(tool, "Bash" | "shell_command")
        && let Some(command) = arguments.get("command").and_then(Value::as_str)
    {
        return ToolProjection::CommandExecution {
            command: command.to_string(),
        };
    }
    if let Some(changes) = file_change_projection(tool, arguments) {
        return ToolProjection::FileChange { changes };
    }
    ToolProjection::DynamicToolCall
}

/// Projects Claude's file-mutating tools (`Edit`/`MultiEdit`/`Write`) onto the
/// codex-native `fileChange` shape with a real unified diff derived from the
/// tool input. `Read`/`WebSearch`/`Task`/`TodoWrite`/`NotebookEdit`/... stay
/// `dynamicToolCall` (handled elsewhere). `NotebookEdit` is intentionally left
/// generic: its cell-scoped `new_source` doesn't map cleanly onto a whole-file
/// diff.
fn file_change_projection(tool: &str, arguments: &Value) -> Option<Vec<FileUpdateChange>> {
    let change = match tool {
        "Edit" => single_edit_change(arguments)?,
        "MultiEdit" => multi_edit_change(arguments)?,
        "Write" => write_change(arguments)?,
        _ => return None,
    };
    Some(vec![change])
}

fn single_edit_change(arguments: &Value) -> Option<FileUpdateChange> {
    let path = arguments.get("file_path").and_then(Value::as_str)?;
    let old = arguments
        .get("old_string")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let new = arguments
        .get("new_string")
        .and_then(Value::as_str)
        .unwrap_or_default();
    Some(FileUpdateChange {
        path: path.to_string(),
        kind: PatchChangeKind::Update { move_path: None },
        diff: unified_diff(old, new),
    })
}

fn multi_edit_change(arguments: &Value) -> Option<FileUpdateChange> {
    let path = arguments.get("file_path").and_then(Value::as_str)?;
    let edits = arguments.get("edits").and_then(Value::as_array)?;
    let mut diff = String::new();
    for edit in edits {
        let old = edit
            .get("old_string")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let new = edit
            .get("new_string")
            .and_then(Value::as_str)
            .unwrap_or_default();
        diff.push_str(&unified_diff(old, new));
    }
    Some(FileUpdateChange {
        path: path.to_string(),
        kind: PatchChangeKind::Update { move_path: None },
        diff,
    })
}

fn write_change(arguments: &Value) -> Option<FileUpdateChange> {
    let path = arguments.get("file_path").and_then(Value::as_str)?;
    let content = arguments.get("content").and_then(Value::as_str)?;
    // Codex-native `Add` carries the full new content in `diff` (see
    // `format_file_change_diff`), and the write's prior contents aren't in the
    // tool input — so surface the new file body as an add.
    Some(FileUpdateChange {
        path: path.to_string(),
        kind: PatchChangeKind::Add,
        diff: content.to_string(),
    })
}

/// Line-based unified diff (3 lines of context) matching the codex-native
/// `FileChange::Update` shape.
fn unified_diff(old: &str, new: &str) -> String {
    similar::TextDiff::from_lines(old, new)
        .unified_diff()
        .to_string()
}

/// Maps Claude's normalized token counts onto the codex-native breakdown.
/// `cached_input_tokens` comes from Claude's cache-read count; the
/// cache-creation count has no codex slot and is dropped.
fn token_usage_breakdown(usage: &NormalizedTokenUsage) -> TokenUsageBreakdown {
    TokenUsageBreakdown {
        total_tokens: usage.total_tokens.unwrap_or(0),
        input_tokens: usage.input_tokens.unwrap_or(0),
        cached_input_tokens: usage.cache_read_input_tokens.unwrap_or(0),
        output_tokens: usage.output_tokens.unwrap_or(0),
        reasoning_output_tokens: usage.reasoning_output_tokens.unwrap_or(0),
    }
}

fn command_result_output_and_exit_code(result: &NormalizedToolResult) -> (String, Option<i32>) {
    if !result.is_error {
        return (result.content.clone(), Some(result.exit_code.unwrap_or(0)));
    }
    let (output, parsed_exit_code) = strip_exit_code_prefix(&result.content);
    (output, result.exit_code.or(parsed_exit_code))
}

fn strip_exit_code_prefix(content: &str) -> (String, Option<i32>) {
    let Some(rest) = content.strip_prefix("Exit code ") else {
        return (content.to_string(), None);
    };
    let Some((code_text, output)) = rest.split_once('\n') else {
        return match rest.trim().parse::<i32>() {
            Ok(code) => (String::new(), Some(code)),
            Err(_) => (content.to_string(), None),
        };
    };
    match code_text.trim().parse::<i32>() {
        Ok(code) => (output.to_string(), Some(code)),
        Err(_) => (content.to_string(), None),
    }
}

#[cfg(test)]
mod tests {
    use codex_app_server_protocol::ServerNotification;
    use serde_json::{Value, json};

    use crate::anthropic::AnthropicStreamEvent;
    use crate::wire::notification_to_jsonrpc;

    use super::*;

    fn normalizer() -> CodexTurnNormalizer {
        CodexTurnNormalizer::new(BridgeConfig::new("T-local", "turn-1"))
    }

    fn process_anthropic(
        normalizer: &mut CodexTurnNormalizer,
        event: Value,
    ) -> Vec<ServerNotification> {
        let event: AnthropicStreamEvent = serde_json::from_value(event).unwrap();
        normalizer.process_event(&event.into()).unwrap()
    }

    #[test]
    fn user_message_emits_started_and_completed_items() {
        let mut normalizer = normalizer();
        normalizer.start_notifications(false).unwrap();

        let events = normalizer
            .emit_user_message(
                Some("client-user-1".to_string()),
                vec![UserInput::Text {
                    text: "steer now".to_string(),
                    text_elements: Vec::new(),
                }],
            )
            .unwrap();

        let methods: Vec<String> = events
            .iter()
            .map(|notification| notification_to_jsonrpc(notification).unwrap().method)
            .collect();
        assert_eq!(methods, vec!["item/started", "item/completed"]);

        let started = notification_to_jsonrpc(&events[0]).unwrap().params.unwrap();
        assert_eq!(started["item"]["type"], "userMessage");
        assert_eq!(started["item"]["clientId"], "client-user-1");
        assert_eq!(started["item"]["content"][0]["text"], "steer now");

        let completed = notification_to_jsonrpc(&events[1]).unwrap().params.unwrap();
        assert_eq!(completed["item"], started["item"]);

        let turn = normalizer.finish_turn(None).unwrap().unwrap();
        let completed_turn = notification_to_jsonrpc(&turn).unwrap().params.unwrap();
        assert_eq!(completed_turn["turn"]["items"][0], started["item"]);
    }

    #[test]
    fn partial_text_streams_codex_agent_message_deltas() {
        let mut normalizer = normalizer();

        let events = process_anthropic(
            &mut normalizer,
            json!({
                "type": "assistant",
                "is_partial": true,
                "message": {
                    "id": "msg_1",
                    "content": [{"type": "text", "text": "hel"}]
                }
            }),
        );
        let methods: Vec<String> = events
            .iter()
            .map(|notification| notification_to_jsonrpc(notification).unwrap().method)
            .collect();

        assert_eq!(
            methods,
            vec![
                "thread/started",
                "turn/started",
                "item/started",
                "item/agentMessage/delta",
            ]
        );
        let delta = notification_to_jsonrpc(&events[3]).unwrap().params.unwrap();
        assert_eq!(delta["delta"], "hel");
        assert_eq!(delta["itemId"], "msg_1");

        let events = process_anthropic(
            &mut normalizer,
            json!({
                "type": "assistant",
                "is_partial": true,
                "message": {
                    "id": "msg_1",
                    "content": [{"type": "text", "text": "hello"}]
                }
            }),
        );
        assert_eq!(events.len(), 1);
        let rpc = notification_to_jsonrpc(&events[0]).unwrap();
        assert_eq!(rpc.method, "item/agentMessage/delta");
        assert_eq!(rpc.params.unwrap()["delta"], "lo");
    }

    #[test]
    fn final_text_emits_typed_item_completed() {
        let mut normalizer = normalizer();
        process_anthropic(
            &mut normalizer,
            json!({
                "type": "system",
                "subtype": "init",
                "session_id": "claude-session-1"
            }),
        );
        let events = process_anthropic(
            &mut normalizer,
            json!({
                "type": "assistant",
                "is_partial": false,
                "message": {
                    "id": "msg_1",
                    "content": [{"type": "text", "text": "final answer"}]
                }
            }),
        );
        let item_completed = events
            .iter()
            .find(|event| matches!(event, ServerNotification::ItemCompleted(_)))
            .expect("final text should complete an item");

        let rpc = notification_to_jsonrpc(item_completed).unwrap();
        assert_eq!(rpc.method, "item/completed");
        let params = rpc.params.unwrap();
        assert_eq!(params["threadId"], "claude-session-1");
        assert_eq!(params["item"]["type"], "agentMessage");
        assert_eq!(params["item"]["text"], "final answer");
    }

    #[test]
    fn stop_reason_projects_agent_message_phase() {
        let mut normalizer = normalizer();
        let events = process_anthropic(
            &mut normalizer,
            json!({
                "type": "assistant",
                "is_partial": false,
                "message": {
                    "id": "msg_1",
                    "stop_reason": "tool_use",
                    "content": [{"type": "text", "text": "Let me check."}]
                }
            }),
        );
        let started = notification_to_jsonrpc(&events[2]).unwrap().params.unwrap();
        assert_eq!(started["item"]["type"], "agentMessage");
        assert_eq!(started["item"]["phase"], "commentary");
        let completed = notification_to_jsonrpc(&events[4]).unwrap().params.unwrap();
        assert_eq!(completed["item"]["phase"], "commentary");

        let events = process_anthropic(
            &mut normalizer,
            json!({
                "type": "assistant",
                "is_partial": false,
                "message": {
                    "id": "msg_2",
                    "stop_reason": "end_turn",
                    "content": [{"type": "text", "text": "DONE"}]
                }
            }),
        );
        let completed = events
            .iter()
            .find_map(|event| {
                let rpc = notification_to_jsonrpc(event).unwrap();
                (rpc.method == "item/completed").then(|| rpc.params.unwrap())
            })
            .expect("final text should complete an item");
        assert_eq!(completed["item"]["phase"], "final_answer");
        assert_eq!(completed["item"]["text"], "DONE");
    }

    #[test]
    fn finish_turn_uses_codex_turn_completed_shape() {
        let mut normalizer = normalizer();
        process_anthropic(
            &mut normalizer,
            json!({
                "type": "assistant",
                "is_partial": false,
                "message": {
                    "id": "msg_1",
                    "content": [{"type": "text", "text": "done"}]
                }
            }),
        );
        let done = normalizer.finish_turn(None).unwrap().unwrap();
        let rpc = notification_to_jsonrpc(&done).unwrap();
        assert_eq!(rpc.method, "turn/completed");
        let params = rpc.params.unwrap();
        assert_eq!(params["turn"]["status"], "completed");
        assert_eq!(params["turn"]["items"][0]["type"], "agentMessage");
        assert_eq!(params["turn"]["items"][0]["text"], "done");
    }

    #[test]
    fn non_bash_tool_use_and_result_share_one_dynamic_tool_item() {
        let mut normalizer = normalizer();
        let events = process_anthropic(
            &mut normalizer,
            json!({
                "type": "assistant",
                "message": {
                    "id": "msg_1",
                    "content": [{
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "Read",
                        "input": {"file_path": "README.md"}
                    }]
                }
            }),
        );

        let methods: Vec<String> = events
            .iter()
            .map(|notification| notification_to_jsonrpc(notification).unwrap().method)
            .collect();
        assert_eq!(
            methods,
            vec!["thread/started", "turn/started", "item/started"]
        );
        let started = notification_to_jsonrpc(&events[2]).unwrap().params.unwrap();
        assert_eq!(started["item"]["type"], "dynamicToolCall");
        assert_eq!(started["item"]["id"], "toolu_1");
        assert_eq!(started["item"]["tool"], "Read");
        assert_eq!(started["item"]["status"], "inProgress");

        let events = process_anthropic(
            &mut normalizer,
            json!({
                "type": "user",
                "message": {
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": "toolu_1",
                        "content": "ok",
                        "is_error": false
                    }]
                }
            }),
        );

        assert_eq!(events.len(), 1);
        let completed = notification_to_jsonrpc(&events[0]).unwrap();
        assert_eq!(completed.method, "item/completed");
        let params = completed.params.unwrap();
        assert_eq!(params["item"]["type"], "dynamicToolCall");
        assert_eq!(params["item"]["id"], "toolu_1");
        assert_eq!(params["item"]["tool"], "Read");
        assert_eq!(params["item"]["status"], "completed");
        assert_eq!(params["item"]["success"], true);
        assert_eq!(params["item"]["arguments"]["file_path"], "README.md");
        assert_eq!(params["item"]["contentItems"][0]["type"], "inputText");
        assert_eq!(params["item"]["contentItems"][0]["text"], "ok");
    }

    #[test]
    fn bash_tool_use_projects_to_command_execution_item() {
        let mut normalizer = normalizer();
        let events = process_anthropic(
            &mut normalizer,
            json!({
                "type": "assistant",
                "message": {
                    "id": "msg_1",
                    "content": [{
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "Bash",
                        "input": {"command": "printf ok"}
                    }]
                }
            }),
        );

        let started = notification_to_jsonrpc(&events[2]).unwrap().params.unwrap();
        assert_eq!(started["item"]["type"], "commandExecution");
        assert_eq!(started["item"]["id"], "toolu_1");
        assert_eq!(started["item"]["command"], "printf ok");
        assert_eq!(started["item"]["source"], "agent");
        assert_eq!(started["item"]["status"], "inProgress");
        assert_eq!(started["item"]["commandActions"][0]["type"], "unknown");
        assert_eq!(started["item"]["commandActions"][0]["command"], "printf ok");

        let events = process_anthropic(
            &mut normalizer,
            json!({
                "type": "user",
                "message": {
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": "toolu_1",
                        "content": "ok",
                        "is_error": false
                    }]
                }
            }),
        );

        assert_eq!(events.len(), 1);
        let completed = notification_to_jsonrpc(&events[0]).unwrap();
        assert_eq!(completed.method, "item/completed");
        let params = completed.params.unwrap();
        assert_eq!(params["item"]["type"], "commandExecution");
        assert_eq!(params["item"]["id"], "toolu_1");
        assert_eq!(params["item"]["command"], "printf ok");
        assert_eq!(params["item"]["status"], "completed");
        assert_eq!(params["item"]["aggregatedOutput"], "ok");
        assert_eq!(params["item"]["exitCode"], 0);
    }

    #[test]
    fn failed_bash_tool_use_preserves_exit_code() {
        let mut normalizer = normalizer();
        process_anthropic(
            &mut normalizer,
            json!({
                "type": "assistant",
                "message": {
                    "id": "msg_1",
                    "content": [{
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "Bash",
                        "input": {"command": "sh -lc 'exit 7'"}
                    }]
                }
            }),
        );

        let events = process_anthropic(
            &mut normalizer,
            json!({
                "type": "user",
                "message": {
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": "toolu_1",
                        "content": "Exit code 7\nFAIL_STDOUTFAIL_STDERR",
                        "is_error": true
                    }]
                }
            }),
        );

        let completed = notification_to_jsonrpc(&events[0]).unwrap();
        let params = completed.params.unwrap();
        assert_eq!(params["item"]["type"], "commandExecution");
        assert_eq!(params["item"]["status"], "failed");
        assert_eq!(params["item"]["aggregatedOutput"], "FAIL_STDOUTFAIL_STDERR");
        assert_eq!(params["item"]["exitCode"], 7);
    }

    #[test]
    fn bash_tool_result_prefers_runtime_stdout_stderr() {
        let mut normalizer = normalizer();
        process_anthropic(
            &mut normalizer,
            json!({
                "type": "assistant",
                "message": {
                    "id": "msg_1",
                    "content": [{
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "Bash",
                        "input": {"command": "printf 'alpha\\nbeta\\ngamma\\n'"}
                    }]
                }
            }),
        );

        let events = process_anthropic(
            &mut normalizer,
            json!({
                "type": "user",
                "message": {
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": "toolu_1",
                        "content": "alpha\nbeta\ngamma",
                        "is_error": false
                    }]
                },
                "tool_use_result": {
                    "stdout": "alpha\nbeta\ngamma\n",
                    "stderr": "",
                    "exit_code": 0
                }
            }),
        );

        let completed = notification_to_jsonrpc(&events[0]).unwrap();
        let params = completed.params.unwrap();
        assert_eq!(params["item"]["type"], "commandExecution");
        assert_eq!(params["item"]["status"], "completed");
        assert_eq!(params["item"]["aggregatedOutput"], "alpha\nbeta\ngamma\n");
        assert_eq!(params["item"]["exitCode"], 0);
    }

    #[test]
    fn amp_shell_command_projects_to_command_execution_item() {
        let mut normalizer = normalizer();
        process_anthropic(
            &mut normalizer,
            json!({
                "type": "assistant",
                "message": {
                    "id": "msg_1",
                    "content": [{
                        "type": "tool_use",
                        "id": "TU-1",
                        "name": "shell_command",
                        "input": {
                            "command": "printf HARNESS_TOOL_OK",
                            "workdir": "/tmp",
                            "timeout_ms": 30000
                        }
                    }]
                }
            }),
        );

        let events = process_anthropic(
            &mut normalizer,
            json!({
                "type": "user",
                "message": {
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": "TU-1",
                        "content": "{\"output\":\"HARNESS_TOOL_OK\",\"exitCode\":0}",
                        "is_error": false
                    }]
                }
            }),
        );

        let completed = notification_to_jsonrpc(&events[0]).unwrap();
        let params = completed.params.unwrap();
        assert_eq!(params["item"]["type"], "commandExecution");
        assert_eq!(params["item"]["command"], "printf HARNESS_TOOL_OK");
        assert_eq!(params["item"]["status"], "completed");
        assert_eq!(params["item"]["aggregatedOutput"], "HARNESS_TOOL_OK");
        assert_eq!(params["item"]["exitCode"], 0);
    }

    #[test]
    fn amp_shell_command_nonzero_exit_code_is_failed_even_without_is_error() {
        let mut normalizer = normalizer();
        process_anthropic(
            &mut normalizer,
            json!({
                "type": "assistant",
                "message": {
                    "id": "msg_1",
                    "content": [{
                        "type": "tool_use",
                        "id": "TU-1",
                        "name": "shell_command",
                        "input": {"command": "sh -lc 'exit 7'"}
                    }]
                }
            }),
        );

        let events = process_anthropic(
            &mut normalizer,
            json!({
                "type": "user",
                "message": {
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": "TU-1",
                        "content": "{\"output\":\"FAIL_STDOUTFAIL_STDERR\",\"exitCode\":7}",
                        "is_error": false
                    }]
                }
            }),
        );

        let completed = notification_to_jsonrpc(&events[0]).unwrap();
        let params = completed.params.unwrap();
        assert_eq!(params["item"]["type"], "commandExecution");
        assert_eq!(params["item"]["status"], "failed");
        assert_eq!(params["item"]["aggregatedOutput"], "FAIL_STDOUTFAIL_STDERR");
        assert_eq!(params["item"]["exitCode"], 7);
    }

    #[test]
    fn edit_tool_use_projects_to_file_change_diff() {
        let mut normalizer = normalizer();
        let events = process_anthropic(
            &mut normalizer,
            json!({
                "type": "assistant",
                "message": {
                    "id": "msg_1",
                    "content": [{
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "Edit",
                        "input": {
                            "file_path": "/repo/src/main.rs",
                            "old_string": "let x = 1;\n",
                            "new_string": "let x = 2;\n"
                        }
                    }]
                }
            }),
        );

        let started = notification_to_jsonrpc(&events[2]).unwrap().params.unwrap();
        assert_eq!(started["item"]["type"], "fileChange");
        assert_eq!(started["item"]["id"], "toolu_1");
        assert_eq!(started["item"]["status"], "inProgress");
        assert_eq!(started["item"]["changes"][0]["path"], "/repo/src/main.rs");
        assert_eq!(started["item"]["changes"][0]["kind"]["type"], "update");
        let diff = started["item"]["changes"][0]["diff"].as_str().unwrap();
        assert!(diff.contains("-let x = 1;"), "diff was: {diff}");
        assert!(diff.contains("+let x = 2;"), "diff was: {diff}");

        let events = process_anthropic(
            &mut normalizer,
            json!({
                "type": "user",
                "message": {
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": "toolu_1",
                        "content": "The file /repo/src/main.rs has been updated.",
                        "is_error": false
                    }]
                }
            }),
        );

        assert_eq!(events.len(), 1);
        let completed = notification_to_jsonrpc(&events[0]).unwrap();
        assert_eq!(completed.method, "item/completed");
        let params = completed.params.unwrap();
        assert_eq!(params["item"]["type"], "fileChange");
        assert_eq!(params["item"]["id"], "toolu_1");
        assert_eq!(params["item"]["status"], "completed");
        assert_eq!(params["item"]["changes"][0]["path"], "/repo/src/main.rs");
        let diff = params["item"]["changes"][0]["diff"].as_str().unwrap();
        assert!(diff.contains("+let x = 2;"), "diff was: {diff}");
    }

    #[test]
    fn multi_edit_tool_projects_multiple_hunks() {
        let mut normalizer = normalizer();
        let events = process_anthropic(
            &mut normalizer,
            json!({
                "type": "assistant",
                "message": {
                    "id": "msg_1",
                    "content": [{
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "MultiEdit",
                        "input": {
                            "file_path": "/repo/a.txt",
                            "edits": [
                                {"old_string": "alpha\n", "new_string": "ALPHA\n"},
                                {"old_string": "beta\n", "new_string": "BETA\n"}
                            ]
                        }
                    }]
                }
            }),
        );

        let started = notification_to_jsonrpc(&events[2]).unwrap().params.unwrap();
        assert_eq!(started["item"]["type"], "fileChange");
        assert_eq!(started["item"]["changes"][0]["path"], "/repo/a.txt");
        assert_eq!(started["item"]["changes"][0]["kind"]["type"], "update");
        let diff = started["item"]["changes"][0]["diff"].as_str().unwrap();
        assert!(diff.contains("-alpha"), "diff was: {diff}");
        assert!(diff.contains("+ALPHA"), "diff was: {diff}");
        assert!(diff.contains("-beta"), "diff was: {diff}");
        assert!(diff.contains("+BETA"), "diff was: {diff}");
        // Two independent edits produce two hunk headers.
        assert!(
            diff.matches("@@ ").count() >= 2,
            "expected >=2 hunks, diff was: {diff}"
        );
    }

    #[test]
    fn write_tool_projects_add_file_change() {
        let mut normalizer = normalizer();
        let events = process_anthropic(
            &mut normalizer,
            json!({
                "type": "assistant",
                "message": {
                    "id": "msg_1",
                    "content": [{
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "Write",
                        "input": {
                            "file_path": "/repo/new.txt",
                            "content": "line one\nline two\n"
                        }
                    }]
                }
            }),
        );

        let started = notification_to_jsonrpc(&events[2]).unwrap().params.unwrap();
        assert_eq!(started["item"]["type"], "fileChange");
        assert_eq!(started["item"]["changes"][0]["path"], "/repo/new.txt");
        assert_eq!(started["item"]["changes"][0]["kind"]["type"], "add");
        // Codex-native Add carries the full new content in `diff`.
        assert_eq!(
            started["item"]["changes"][0]["diff"],
            "line one\nline two\n"
        );
    }

    #[test]
    fn failed_edit_tool_marks_file_change_failed() {
        let mut normalizer = normalizer();
        process_anthropic(
            &mut normalizer,
            json!({
                "type": "assistant",
                "message": {
                    "id": "msg_1",
                    "content": [{
                        "type": "tool_use",
                        "id": "toolu_1",
                        "name": "Edit",
                        "input": {"file_path": "/repo/x.rs", "old_string": "a\n", "new_string": "b\n"}
                    }]
                }
            }),
        );

        let events = process_anthropic(
            &mut normalizer,
            json!({
                "type": "user",
                "message": {
                    "content": [{
                        "type": "tool_result",
                        "tool_use_id": "toolu_1",
                        "content": "String to replace not found in file.",
                        "is_error": true
                    }]
                }
            }),
        );

        let completed = notification_to_jsonrpc(&events[0]).unwrap();
        let params = completed.params.unwrap();
        assert_eq!(params["item"]["type"], "fileChange");
        assert_eq!(params["item"]["status"], "failed");
    }

    fn subagent(parent_id: &str, event: NormalizedEvent) -> NormalizedEvent {
        NormalizedEvent::Subagent {
            parent_id: parent_id.to_string(),
            event: Box::new(event),
        }
    }

    fn methods(events: &[ServerNotification]) -> Vec<String> {
        events
            .iter()
            .map(|event| notification_to_jsonrpc(event).unwrap().method)
            .collect()
    }

    #[test]
    fn subagent_tool_use_projects_namespaced_item_reusing_the_pipeline() {
        let mut normalizer = normalizer();

        let started = normalizer
            .process_event(&subagent(
                "toolu_task1",
                NormalizedEvent::AssistantMessage {
                    partial: false,
                    stop_reason: None,
                    content: vec![NormalizedContent::ToolUse {
                        raw_id: "sub~toolu_task1~toolu_bash".to_string(),
                        tool: "Bash".to_string(),
                        arguments: json!({"command": "ls"}),
                    }],
                },
            ))
            .unwrap();

        // Parent lifecycle emits once; the subagent's own projector is pre-marked
        // started, so only the item notification is added.
        assert_eq!(
            methods(&started),
            vec!["thread/started", "turn/started", "item/started"]
        );
        let item = notification_to_jsonrpc(&started[2])
            .unwrap()
            .params
            .unwrap();
        assert_eq!(item["item"]["type"], "commandExecution");
        assert_eq!(item["item"]["id"], "sub~toolu_task1~toolu_bash");
        assert_eq!(item["item"]["command"], "ls");

        let completed = normalizer
            .process_event(&subagent(
                "toolu_task1",
                NormalizedEvent::ToolResults(vec![NormalizedToolResult {
                    tool_use_id: "sub~toolu_task1~toolu_bash".to_string(),
                    content: "ok".to_string(),
                    is_error: false,
                    exit_code: Some(0),
                }]),
            ))
            .unwrap();
        assert_eq!(methods(&completed), vec!["item/completed"]);
        let item = notification_to_jsonrpc(&completed[0])
            .unwrap()
            .params
            .unwrap();
        assert_eq!(item["item"]["type"], "commandExecution");
        assert_eq!(item["item"]["id"], "sub~toolu_task1~toolu_bash");
        assert_eq!(item["item"]["status"], "completed");
        assert_eq!(item["item"]["aggregatedOutput"], "ok");
    }

    #[test]
    fn subagent_activity_never_settles_or_pollutes_the_parent_turn() {
        let mut normalizer = normalizer();

        // A full subagent message that ends with `end_turn`.
        normalizer
            .process_event(&subagent(
                "toolu_task1",
                NormalizedEvent::AgentMessageStarted {
                    item_id: "sub~toolu_task1~msg_s".to_string(),
                    stop_reason: Some("end_turn".to_string()),
                },
            ))
            .unwrap();
        normalizer
            .process_event(&subagent(
                "toolu_task1",
                NormalizedEvent::AssistantMessage {
                    partial: false,
                    stop_reason: Some("end_turn".to_string()),
                    content: vec![NormalizedContent::AgentText {
                        item_id: "sub~toolu_task1~msg_s".to_string(),
                        text: "subagent report".to_string(),
                    }],
                },
            ))
            .unwrap();

        // The parent turn is still driven by the parent stream: its own completed
        // items list carries none of the subagent's work.
        let turn = normalizer.finish_turn(None).unwrap().unwrap();
        let params = notification_to_jsonrpc(&turn).unwrap().params.unwrap();
        assert_eq!(params["turn"]["status"], "completed");
        assert!(
            params["turn"]["items"].as_array().unwrap().is_empty(),
            "subagent items must not appear in the parent turn snapshot: {}",
            params["turn"]["items"]
        );
    }

    #[test]
    fn subagent_lifecycle_and_token_notifications_are_suppressed() {
        let mut normalizer = normalizer();
        normalizer.start_notifications(false).unwrap();

        // Token usage from a subagent is dropped — it must not bill the parent.
        let usage = normalizer
            .process_event(&subagent(
                "toolu_task1",
                NormalizedEvent::TokenUsage {
                    usage: NormalizedTokenUsage {
                        output_tokens: Some(5),
                        ..Default::default()
                    },
                },
            ))
            .unwrap();
        assert!(usage.is_empty());

        // A subagent item after the parent has started emits only the item — no
        // second thread/started or turn/started from the subagent's projector.
        let events = normalizer
            .process_event(&subagent(
                "toolu_task1",
                NormalizedEvent::AssistantMessage {
                    partial: false,
                    stop_reason: None,
                    content: vec![NormalizedContent::ToolUse {
                        raw_id: "sub~toolu_task1~toolu_read".to_string(),
                        tool: "Read".to_string(),
                        arguments: json!({"file_path": "x"}),
                    }],
                },
            ))
            .unwrap();
        assert_eq!(methods(&events), vec!["item/started"]);
    }

    #[test]
    fn parallel_subagents_keep_isolated_projection_state() {
        let mut normalizer = normalizer();
        normalizer.start_notifications(false).unwrap();

        // Two subagents each run an identically-named tool; separate projectors
        // keep their tool-call correlation from colliding.
        for parent in ["toolu_a", "toolu_b"] {
            normalizer
                .process_event(&subagent(
                    parent,
                    NormalizedEvent::AssistantMessage {
                        partial: false,
                        stop_reason: None,
                        content: vec![NormalizedContent::ToolUse {
                            raw_id: format!("sub~{parent}~toolu_read"),
                            tool: "Read".to_string(),
                            arguments: json!({"file_path": "x"}),
                        }],
                    },
                ))
                .unwrap();
        }
        let completed_a = normalizer
            .process_event(&subagent(
                "toolu_a",
                NormalizedEvent::ToolResults(vec![NormalizedToolResult {
                    tool_use_id: "sub~toolu_a~toolu_read".to_string(),
                    content: "A output".to_string(),
                    is_error: false,
                    exit_code: None,
                }]),
            ))
            .unwrap();
        let item = notification_to_jsonrpc(&completed_a[0])
            .unwrap()
            .params
            .unwrap();
        assert_eq!(item["item"]["id"], "sub~toolu_a~toolu_read");
        assert_eq!(item["item"]["contentItems"][0]["text"], "A output");
    }

    #[test]
    fn token_usage_event_emits_thread_token_usage_notification() {
        let mut normalizer = normalizer();
        normalizer.start_notifications(false).unwrap();

        let events = normalizer
            .process_event(&NormalizedEvent::TokenUsage {
                usage: NormalizedTokenUsage {
                    model: Some("claude-fable-5".to_string()),
                    input_tokens: Some(120),
                    output_tokens: Some(42),
                    cache_creation_input_tokens: Some(7),
                    cache_read_input_tokens: Some(13),
                    reasoning_output_tokens: Some(8),
                    total_tokens: Some(170),
                },
            })
            .unwrap();

        assert_eq!(events.len(), 1);
        let rpc = notification_to_jsonrpc(&events[0]).unwrap();
        assert_eq!(rpc.method, "thread/tokenUsage/updated");
        let params = rpc.params.unwrap();
        assert_eq!(params["turnId"], "turn-1");
        // The reducer reads `tokenUsage.total.outputTokens` + `reasoningOutputTokens`.
        assert_eq!(params["tokenUsage"]["total"]["outputTokens"], 42);
        assert_eq!(params["tokenUsage"]["total"]["reasoningOutputTokens"], 8);
        assert_eq!(params["tokenUsage"]["total"]["inputTokens"], 120);
        assert_eq!(params["tokenUsage"]["total"]["cachedInputTokens"], 13);
        assert_eq!(params["tokenUsage"]["total"]["totalTokens"], 170);
        assert_eq!(params["tokenUsage"]["last"]["outputTokens"], 42);
    }
}
