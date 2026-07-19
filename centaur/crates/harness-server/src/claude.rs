use std::collections::HashMap;
use std::env;
use std::path::PathBuf;
use std::process::Command as ProcessCommand;
use std::time::Duration;

use codex_app_server_protocol::UserInput;
use serde_json::json;

use crate::{
    HarnessKind, HarnessServer, NormalizedContent, NormalizedEvent, Result, ThreadState,
    anthropic::{AnthropicEventNormalizer, AnthropicStreamEvent},
    command_from_override, subagent_item_id, user_input_to_anthropic_content,
};

/// Defers agent text until the owning message's fate is known, so agentMessage
/// items can be emitted with an authoritative stop reason. Claude's per-block
/// `assistant` events leave `stop_reason` null, and downstream renderers treat
/// unphased messages as the final answer, so completing each text block as it
/// arrives makes every interim message render as an extra reply. Text is held
/// until a `message_delta` stop reason, a `tool_use` in the same message, a tool
/// result, a newer message, or the terminal `result` settles whether the text was
/// commentary (`tool_use`) or the final answer (`end_turn`). Flushing replays the
/// original delta chunks after an `AgentMessageStarted` carrying the stop reason,
/// so the item starts with the right phase and native chunking is preserved.
#[derive(Debug, Default)]
pub struct ClaudeEventNormalizer {
    inner: AnthropicEventNormalizer,
    pending: Vec<PendingAgentMessage>,
    /// One isolated normalizer per Task-tool subagent, keyed by
    /// `parent_tool_use_id`. Keeping sidechains out of `inner`/`pending` is what
    /// stops their message ids clobbering the main chain's deferred-text state
    /// and their `end_turn` from settling the parent turn.
    sidechains: HashMap<String, ClaudeEventNormalizer>,
}

#[derive(Debug)]
struct PendingAgentMessage {
    item_id: String,
    chunks: Vec<String>,
    canonical: Option<String>,
}

impl PendingAgentMessage {
    fn text(&self) -> String {
        self.canonical
            .clone()
            .unwrap_or_else(|| self.chunks.concat())
    }
}

impl ClaudeEventNormalizer {
    /// Entry point for a raw stream line. Main-chain events go through
    /// `normalize`; subagent sidechain events are routed to an isolated
    /// per-`parent_tool_use_id` normalizer and wrapped as
    /// `NormalizedEvent::Subagent` with their item ids namespaced.
    pub fn normalize_line(&mut self, event: AnthropicStreamEvent) -> Vec<NormalizedEvent> {
        let Some(parent_id) = event.parent_tool_use_id().map(str::to_string) else {
            return self.normalize(event);
        };
        let sidechain = self.sidechains.entry(parent_id.clone()).or_default();
        sidechain
            .normalize(event)
            .into_iter()
            .map(|inner| NormalizedEvent::Subagent {
                parent_id: parent_id.clone(),
                event: Box::new(namespace_event_ids(&parent_id, inner)),
            })
            .collect()
    }

    pub fn normalize(&mut self, event: AnthropicStreamEvent) -> Vec<NormalizedEvent> {
        let token_usage = event.token_usage();
        let message_stop_reason = event.message_stop_reason().map(str::to_string);
        let normalized = self.inner.normalize(event);
        let mut out = Vec::new();
        if let Some(usage) = token_usage {
            out.push(NormalizedEvent::TokenUsage { usage });
        }
        if let Some(stop_reason) = message_stop_reason {
            self.flush_pending(Some(stop_reason), &mut out);
        }

        match normalized {
            NormalizedEvent::AgentTextDelta { item_id, delta } => {
                self.flush_other_messages(&item_id, &mut out);
                self.pending_for(item_id).chunks.push(delta);
            }
            NormalizedEvent::AssistantMessage {
                partial: false,
                stop_reason,
                content,
            } => self.defer_assistant_message(stop_reason, content, &mut out),
            NormalizedEvent::ToolResults(results) => {
                self.flush_pending(Some("tool_use".to_string()), &mut out);
                out.push(NormalizedEvent::ToolResults(results));
            }
            event @ NormalizedEvent::Result { .. } => {
                self.flush_pending(Some("end_turn".to_string()), &mut out);
                out.push(event);
            }
            event @ NormalizedEvent::Error { .. } => {
                self.flush_pending(None, &mut out);
                out.push(event);
            }
            NormalizedEvent::TokenUsage { .. } => {}
            NormalizedEvent::Ignored => {}
            event => out.push(event),
        }
        out
    }

    fn defer_assistant_message(
        &mut self,
        stop_reason: Option<String>,
        content: Vec<NormalizedContent>,
        out: &mut Vec<NormalizedEvent>,
    ) {
        let mut passthrough = Vec::new();
        let mut has_tool_use = false;
        for part in content {
            match part {
                NormalizedContent::AgentText { item_id, text } => {
                    self.flush_other_messages(&item_id, out);
                    self.pending_for(item_id).canonical = Some(text);
                }
                part @ NormalizedContent::ToolUse { .. } => {
                    has_tool_use = true;
                    passthrough.push(part);
                }
                part @ NormalizedContent::ReasoningText { .. } => passthrough.push(part),
            }
        }
        if has_tool_use {
            self.flush_pending(Some("tool_use".to_string()), out);
        }
        if let Some(stop_reason) = stop_reason {
            self.flush_pending(Some(stop_reason), out);
        }
        if !passthrough.is_empty() {
            out.push(NormalizedEvent::AssistantMessage {
                partial: false,
                stop_reason: None,
                content: passthrough,
            });
        }
    }

    fn pending_for(&mut self, item_id: String) -> &mut PendingAgentMessage {
        if let Some(index) = self
            .pending
            .iter()
            .position(|message| message.item_id == item_id)
        {
            return &mut self.pending[index];
        }
        self.pending.push(PendingAgentMessage {
            item_id,
            chunks: Vec::new(),
            canonical: None,
        });
        self.pending.last_mut().expect("just pushed")
    }

    /// Text from an older message still pending when a newer message produces
    /// text means the older message ended mid-turn: commentary.
    fn flush_other_messages(&mut self, current_item_id: &str, out: &mut Vec<NormalizedEvent>) {
        if self
            .pending
            .iter()
            .all(|message| message.item_id == current_item_id)
        {
            return;
        }
        let (current, others) = std::mem::take(&mut self.pending)
            .into_iter()
            .partition(|message| message.item_id == current_item_id);
        self.pending = current;
        flush_messages(others, Some("tool_use".to_string()), out);
    }

    fn flush_pending(&mut self, stop_reason: Option<String>, out: &mut Vec<NormalizedEvent>) {
        flush_messages(std::mem::take(&mut self.pending), stop_reason, out);
    }
}

/// Rewrites every item id carried by a subagent's normalized event so it is
/// namespaced under the parent tool-use id. Variants without ids pass through.
fn namespace_event_ids(parent_id: &str, event: NormalizedEvent) -> NormalizedEvent {
    match event {
        NormalizedEvent::AgentMessageStarted {
            item_id,
            stop_reason,
        } => NormalizedEvent::AgentMessageStarted {
            item_id: subagent_item_id(parent_id, &item_id),
            stop_reason,
        },
        NormalizedEvent::AgentTextDelta { item_id, delta } => NormalizedEvent::AgentTextDelta {
            item_id: subagent_item_id(parent_id, &item_id),
            delta,
        },
        NormalizedEvent::ReasoningTextDelta { item_id, delta } => {
            NormalizedEvent::ReasoningTextDelta {
                item_id: subagent_item_id(parent_id, &item_id),
                delta,
            }
        }
        NormalizedEvent::AssistantMessage {
            partial,
            stop_reason,
            content,
        } => NormalizedEvent::AssistantMessage {
            partial,
            stop_reason,
            content: content
                .into_iter()
                .map(|part| namespace_content_ids(parent_id, part))
                .collect(),
        },
        NormalizedEvent::ToolResults(results) => NormalizedEvent::ToolResults(
            results
                .into_iter()
                .map(|mut result| {
                    result.tool_use_id = subagent_item_id(parent_id, &result.tool_use_id);
                    result
                })
                .collect(),
        ),
        other => other,
    }
}

fn namespace_content_ids(parent_id: &str, content: NormalizedContent) -> NormalizedContent {
    match content {
        NormalizedContent::AgentText { item_id, text } => NormalizedContent::AgentText {
            item_id: subagent_item_id(parent_id, &item_id),
            text,
        },
        NormalizedContent::ReasoningText { item_id, text } => NormalizedContent::ReasoningText {
            item_id: subagent_item_id(parent_id, &item_id),
            text,
        },
        NormalizedContent::ToolUse {
            raw_id,
            tool,
            arguments,
        } => NormalizedContent::ToolUse {
            raw_id: subagent_item_id(parent_id, &raw_id),
            tool,
            arguments,
        },
    }
}

fn flush_messages(
    pending: Vec<PendingAgentMessage>,
    stop_reason: Option<String>,
    out: &mut Vec<NormalizedEvent>,
) {
    for message in pending {
        let text = message.text();
        if text.is_empty() {
            continue;
        }
        out.push(NormalizedEvent::AgentMessageStarted {
            item_id: message.item_id.clone(),
            stop_reason: stop_reason.clone(),
        });
        out.extend(
            message
                .chunks
                .into_iter()
                .map(|delta| NormalizedEvent::AgentTextDelta {
                    item_id: message.item_id.clone(),
                    delta,
                }),
        );
        out.push(NormalizedEvent::AssistantMessage {
            partial: false,
            stop_reason: stop_reason.clone(),
            content: vec![NormalizedContent::AgentText {
                item_id: message.item_id,
                text,
            }],
        });
    }
}

#[derive(Debug, Default)]
pub struct ClaudeCodeHarness;

impl HarnessServer for ClaudeCodeHarness {
    type Event = AnthropicStreamEvent;
    type EventNormalizer = ClaudeEventNormalizer;

    fn kind(&self) -> HarnessKind {
        HarnessKind::ClaudeCode
    }

    fn cli_version(&self) -> &'static str {
        "claude-code"
    }

    /// Empty when no explicit override exists: the model is owned by Claude Code
    /// defaults or by deployment-provided Claude settings. An empty model means
    /// `command_for_turn` omits `--model` so the CLI/SDK chooses its default.
    fn default_model(&self) -> String {
        env::var("CLAUDE_MODEL").unwrap_or_default()
    }

    fn default_model_provider(&self) -> &'static str {
        "anthropic"
    }

    fn command_for_turn(&self, state: &ThreadState) -> ProcessCommand {
        if let Some(mut command) = command_from_override("CENTAUR_CLAUDE_APP_BRIDGE_COMMAND") {
            command.env("CENTAUR_CLAUDE_MODEL", &state.model);
            command.env("CENTAUR_CLAUDE_MODEL_PROVIDER", &state.model_provider);
            command.env("CENTAUR_CLAUDE_SESSION_ID", &state.id);
            if let Some(session_id) = &state.harness_session_id {
                command.env("CENTAUR_CLAUDE_RESUME_SESSION_ID", session_id);
            }
            if let Some(effort) = &state.reasoning_effort {
                command.env("CENTAUR_CLAUDE_EFFORT", effort);
            }
            return command;
        }

        let bin = env::var("CLAUDE_BIN").unwrap_or_else(|_| "claude".to_string());
        let mut command = ProcessCommand::new(bin);
        command.args([
            "--print",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--verbose",
            "--include-partial-messages",
            "--dangerously-skip-permissions",
            "--permission-mode",
            "bypassPermissions",
        ]);
        if !state.model.is_empty() {
            command.args(["--model", &state.model]);
        }
        if let Some(effort) = &state.reasoning_effort {
            command.args(["--effort", effort]);
        }
        if PathBuf::from("AGENTS.md").is_file() {
            command.args(["--append-system-prompt-file", "AGENTS.md"]);
        }
        if let Some(session_id) = &state.harness_session_id {
            command.args(["--resume", session_id]);
        } else {
            command.args(["--session-id", &state.id]);
        }
        command
    }

    fn stdin_for_turn(&self, input: &[UserInput]) -> Result<Vec<u8>> {
        let payload = json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": user_input_to_anthropic_content(input),
            },
        });
        let mut bytes = serde_json::to_vec(&payload)?;
        bytes.push(b'\n');
        Ok(bytes)
    }

    fn parse_stdout_line(&self, line: &str) -> Result<Self::Event> {
        AnthropicStreamEvent::parse_json_line(line)
    }

    fn normalize_events(
        &self,
        normalizer: &mut Self::EventNormalizer,
        event: Self::Event,
    ) -> Result<Vec<NormalizedEvent>> {
        // Subagent sidechains (Task tool) interleave their own messages into
        // the stream, ending with their own `end_turn` while the parent turn
        // keeps running. `normalize_line` routes them to an isolated
        // per-`parent_tool_use_id` normalizer (so their message ids can't clobber
        // the main chain's pending-text state) and wraps them as
        // `NormalizedEvent::Subagent`, which is opaque to the turn-settling
        // checks — so a subagent's `end_turn` never settles the parent turn.
        Ok(normalizer.normalize_line(event))
    }

    /// Claude Code normally ends a turn with a native `result` line, but
    /// streams have been observed to stop at `message_delta.stop_reason`
    /// without one (leaving the execution hung as "thinking" forever). Wait a
    /// short window for the native result before completing on the stop, so
    /// the trailing `result` is consumed by this turn instead of instantly
    /// terminating the next one.
    fn terminal_assistant_stop_settle(&self) -> Option<Duration> {
        Some(Duration::from_secs(2))
    }
}

#[cfg(test)]
mod tests {
    use codex_app_server_protocol::UserInput;
    use serde_json::{Value, json};

    use crate::{HarnessServer, NormalizedContent, NormalizedEvent};

    use super::{ClaudeCodeHarness, ClaudeEventNormalizer};

    fn normalize(normalizer: &mut ClaudeEventNormalizer, event: Value) -> Vec<NormalizedEvent> {
        normalizer.normalize(serde_json::from_value(event).unwrap())
    }

    fn normalize_line(
        normalizer: &mut ClaudeEventNormalizer,
        event: Value,
    ) -> Vec<NormalizedEvent> {
        normalizer.normalize_line(serde_json::from_value(event).unwrap())
    }

    /// Unwraps a single `Subagent` event, asserting its parent id.
    fn unwrap_subagent<'a>(
        events: &'a [NormalizedEvent],
        parent_id: &str,
    ) -> Vec<&'a NormalizedEvent> {
        events
            .iter()
            .map(|event| match event {
                NormalizedEvent::Subagent {
                    parent_id: got,
                    event,
                } => {
                    assert_eq!(got, parent_id);
                    event.as_ref()
                }
                other => panic!("expected Subagent, got {other:?}"),
            })
            .collect()
    }

    #[test]
    fn sidechain_tool_use_routes_to_isolated_normalizer_and_namespaces_ids() {
        let mut normalizer = ClaudeEventNormalizer::default();
        let events = normalize_line(
            &mut normalizer,
            json!({
                "type": "assistant",
                "parent_tool_use_id": "toolu_task1",
                "message": {"id": "msg_s1", "content": [
                    {"type": "tool_use", "id": "toolu_bash", "name": "Bash", "input": {"command": "ls"}}
                ]}
            }),
        );

        let inner = unwrap_subagent(&events, "toolu_task1");
        assert_eq!(inner.len(), 1);
        assert!(matches!(
            inner[0],
            NormalizedEvent::AssistantMessage { content, .. }
                if matches!(
                    content.as_slice(),
                    [NormalizedContent::ToolUse { raw_id, tool, .. }]
                        if raw_id == "sub~toolu_task1~toolu_bash" && tool == "Bash"
                )
        ));
    }

    #[test]
    fn sidechain_end_turn_events_are_non_terminal() {
        let mut normalizer = ClaudeEventNormalizer::default();
        // Deferred subagent text.
        normalize_line(
            &mut normalizer,
            json!({
                "type": "assistant",
                "parent_tool_use_id": "toolu_task1",
                "message": {"id": "msg_s1", "content": [{"type": "text", "text": "subagent done"}]}
            }),
        );
        // The subagent's own end_turn flushes its message but must not settle the
        // parent turn: every emitted event is Subagent-wrapped, hence opaque to
        // the turn-settling checks.
        let events = normalize_line(
            &mut normalizer,
            json!({
                "type": "stream_event",
                "parent_tool_use_id": "toolu_task1",
                "event": {"type": "message_delta", "delta": {"stop_reason": "end_turn"}}
            }),
        );
        assert!(!events.is_empty());
        for event in &events {
            assert!(matches!(event, NormalizedEvent::Subagent { .. }));
            assert!(!event.is_terminal());
            assert!(!event.is_terminal_assistant_stop());
        }
    }

    #[test]
    fn parallel_sidechains_keep_separate_pending_text() {
        let mut normalizer = ClaudeEventNormalizer::default();
        // Two subagents each defer their own text.
        normalize_line(
            &mut normalizer,
            json!({
                "type": "assistant",
                "parent_tool_use_id": "toolu_a",
                "message": {"id": "msg_a", "content": [{"type": "text", "text": "from A"}]}
            }),
        );
        normalize_line(
            &mut normalizer,
            json!({
                "type": "assistant",
                "parent_tool_use_id": "toolu_b",
                "message": {"id": "msg_b", "content": [{"type": "text", "text": "from B"}]}
            }),
        );

        // A's end_turn flushes only A's text, namespaced under A.
        let events = normalize_line(
            &mut normalizer,
            json!({
                "type": "stream_event",
                "parent_tool_use_id": "toolu_a",
                "event": {"type": "message_delta", "delta": {"stop_reason": "end_turn"}}
            }),
        );
        let inner = unwrap_subagent(&events, "toolu_a");
        let flushed: Vec<&str> = inner
            .iter()
            .filter_map(|event| match event {
                NormalizedEvent::AssistantMessage { content, .. } => {
                    content.iter().find_map(|part| match part {
                        NormalizedContent::AgentText { item_id, text } => {
                            assert_eq!(item_id, "sub~toolu_a~msg_a");
                            Some(text.as_str())
                        }
                        _ => None,
                    })
                }
                _ => None,
            })
            .collect();
        assert_eq!(flushed, vec!["from A"]);
    }

    #[test]
    fn sidechain_does_not_disturb_main_chain_pending_text() {
        let mut normalizer = ClaudeEventNormalizer::default();
        // Main chain defers text.
        assert!(
            normalize(
                &mut normalizer,
                json!({"type": "assistant", "message": {"id": "msg_main", "stop_reason": null, "content": [{"type": "text", "text": "main answer"}]}}),
            )
            .is_empty()
        );
        // A whole subagent turn interleaves; the main pending text is untouched.
        normalize_line(
            &mut normalizer,
            json!({
                "type": "assistant",
                "parent_tool_use_id": "toolu_task1",
                "message": {"id": "msg_s1", "content": [{"type": "text", "text": "subagent noise"}]}
            }),
        );
        normalize_line(
            &mut normalizer,
            json!({
                "type": "stream_event",
                "parent_tool_use_id": "toolu_task1",
                "event": {"type": "message_delta", "delta": {"stop_reason": "end_turn"}}
            }),
        );
        // The native result settles the main chain: its deferred text survives as
        // the final answer.
        let events = normalize_line(
            &mut normalizer,
            json!({"type": "result", "subtype": "success", "result": "main answer"}),
        );
        let final_text = events.iter().find_map(|event| match event {
            NormalizedEvent::AssistantMessage {
                stop_reason,
                content,
                ..
            } => content.iter().find_map(|part| match part {
                NormalizedContent::AgentText { item_id, text } => {
                    assert_eq!(item_id, "msg_main");
                    Some((stop_reason.clone(), text.clone()))
                }
                _ => None,
            }),
            _ => None,
        });
        assert_eq!(
            final_text,
            Some((Some("end_turn".to_string()), "main answer".to_string()))
        );
    }

    #[test]
    fn command_for_turn_applies_reasoning_effort() {
        let harness = ClaudeCodeHarness;
        let mut state = crate::ThreadState {
            id: "thread-1".to_string(),
            cwd: std::path::PathBuf::from("/tmp"),
            model: String::new(),
            model_provider: "anthropic".to_string(),
            service_tier: None,
            reasoning_effort: None,
            harness_session_id: None,
            completed_turns: Vec::new(),
            process: None,
            thread_started_sent: false,
        };

        let args = |state: &crate::ThreadState| -> Vec<String> {
            harness
                .command_for_turn(state)
                .get_args()
                .map(|arg| arg.to_string_lossy().into_owned())
                .collect()
        };

        assert!(!args(&state).contains(&"--effort".to_string()));

        state.reasoning_effort = Some("xhigh".to_string());
        let with_effort = args(&state);
        let flag = with_effort
            .iter()
            .position(|arg| arg == "--effort")
            .expect("--effort present");
        assert_eq!(with_effort.get(flag + 1).map(String::as_str), Some("xhigh"));
    }

    fn agent_texts(events: &[NormalizedEvent]) -> Vec<(Option<String>, String)> {
        events
            .iter()
            .filter_map(|event| match event {
                NormalizedEvent::AssistantMessage {
                    partial: false,
                    stop_reason,
                    content,
                } => {
                    let text = content
                        .iter()
                        .filter_map(|part| match part {
                            NormalizedContent::AgentText { text, .. } => Some(text.as_str()),
                            _ => None,
                        })
                        .collect::<String>();
                    (!text.is_empty()).then(|| (stop_reason.clone(), text))
                }
                _ => None,
            })
            .collect()
    }

    #[test]
    fn defers_streamed_text_until_message_delta_settles_stop_reason() {
        let mut normalizer = ClaudeEventNormalizer::default();

        let events = normalize(
            &mut normalizer,
            json!({"type": "stream_event", "event": {"type": "message_start", "message": {"id": "msg_1", "stop_reason": null, "content": []}}}),
        );
        assert!(events.is_empty());

        let events = normalize(
            &mut normalizer,
            json!({"type": "stream_event", "event": {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}}),
        );
        assert!(events.is_empty());

        // Text deltas are buffered, not forwarded.
        let events = normalize(
            &mut normalizer,
            json!({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "Let me check."}}}),
        );
        assert!(events.is_empty());

        // The per-block assistant event records canonical text but stays deferred.
        let events = normalize(
            &mut normalizer,
            json!({"type": "assistant", "message": {"id": "msg_1", "stop_reason": null, "content": [{"type": "text", "text": "Let me check."}]}}),
        );
        assert!(events.is_empty());

        // The tool_use block settles the message as commentary.
        let events = normalize(
            &mut normalizer,
            json!({"type": "assistant", "message": {"id": "msg_1", "stop_reason": null, "content": [{"type": "tool_use", "id": "toolu_1", "name": "Bash", "input": {"command": "echo hello"}}]}}),
        );
        assert_eq!(
            agent_texts(&events),
            vec![(Some("tool_use".to_string()), "Let me check.".to_string())]
        );
        assert!(matches!(
            events.last(),
            Some(NormalizedEvent::AssistantMessage { content, .. })
                if matches!(content.as_slice(), [NormalizedContent::ToolUse { .. }])
        ));

        // message_delta arrives after the blocks; nothing left to flush.
        let events = normalize(
            &mut normalizer,
            json!({"type": "stream_event", "event": {"type": "message_delta", "delta": {"stop_reason": "tool_use"}}}),
        );
        assert!(events.is_empty());
    }

    #[test]
    fn final_message_flushes_as_end_turn_on_message_delta() {
        let mut normalizer = ClaudeEventNormalizer::default();
        normalize(
            &mut normalizer,
            json!({"type": "stream_event", "event": {"type": "message_start", "message": {"id": "msg_2", "stop_reason": null, "content": []}}}),
        );
        normalize(
            &mut normalizer,
            json!({"type": "stream_event", "event": {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}}),
        );
        normalize(
            &mut normalizer,
            json!({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": "DONE"}}}),
        );
        normalize(
            &mut normalizer,
            json!({"type": "assistant", "message": {"id": "msg_2", "stop_reason": null, "content": [{"type": "text", "text": "DONE"}]}}),
        );

        let events = normalize(
            &mut normalizer,
            json!({"type": "stream_event", "event": {"type": "message_delta", "delta": {"stop_reason": "end_turn"}}}),
        );
        assert_eq!(
            agent_texts(&events),
            vec![(Some("end_turn".to_string()), "DONE".to_string())]
        );
    }

    #[test]
    fn pending_text_flushes_as_final_answer_when_result_arrives_first() {
        let mut normalizer = ClaudeEventNormalizer::default();
        normalize(
            &mut normalizer,
            json!({"type": "assistant", "message": {"id": "msg_1", "stop_reason": null, "content": [{"type": "text", "text": "final answer"}]}}),
        );

        let events = normalize(
            &mut normalizer,
            json!({"type": "result", "subtype": "success", "result": "final answer"}),
        );
        assert_eq!(
            agent_texts(&events),
            vec![(Some("end_turn".to_string()), "final answer".to_string())]
        );
        assert!(matches!(
            events.last(),
            Some(NormalizedEvent::Result { error: None })
        ));
    }

    #[test]
    fn tool_result_flushes_pending_text_as_commentary() {
        let mut normalizer = ClaudeEventNormalizer::default();
        normalize(
            &mut normalizer,
            json!({"type": "assistant", "message": {"id": "msg_1", "stop_reason": null, "content": [{"type": "text", "text": "Let me check."}]}}),
        );

        let events = normalize(
            &mut normalizer,
            json!({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "toolu_1", "content": "ok", "is_error": false}]}}),
        );
        assert_eq!(
            agent_texts(&events),
            vec![(Some("tool_use".to_string()), "Let me check.".to_string())]
        );
        assert!(matches!(
            events.last(),
            Some(NormalizedEvent::ToolResults(results)) if results.len() == 1
        ));
    }

    #[test]
    fn newer_message_text_flushes_older_pending_message_as_commentary() {
        let mut normalizer = ClaudeEventNormalizer::default();
        normalize(
            &mut normalizer,
            json!({"type": "assistant", "message": {"id": "msg_1", "stop_reason": null, "content": [{"type": "text", "text": "first"}]}}),
        );

        let events = normalize(
            &mut normalizer,
            json!({"type": "assistant", "message": {"id": "msg_2", "stop_reason": null, "content": [{"type": "text", "text": "second"}]}}),
        );
        assert_eq!(
            agent_texts(&events),
            vec![(Some("tool_use".to_string()), "first".to_string())]
        );

        let events = normalize(
            &mut normalizer,
            json!({"type": "result", "subtype": "success", "result": "second"}),
        );
        assert_eq!(
            agent_texts(&events),
            vec![(Some("end_turn".to_string()), "second".to_string())]
        );
    }

    #[test]
    fn flush_replays_original_delta_chunks_behind_phased_item_start() {
        let mut normalizer = ClaudeEventNormalizer::default();
        normalize(
            &mut normalizer,
            json!({"type": "stream_event", "event": {"type": "message_start", "message": {"id": "msg_1", "stop_reason": null, "content": []}}}),
        );
        normalize(
            &mut normalizer,
            json!({"type": "stream_event", "event": {"type": "content_block_start", "index": 0, "content_block": {"type": "text", "text": ""}}}),
        );
        for chunk in ["hel", "lo ", "world"] {
            normalize(
                &mut normalizer,
                json!({"type": "stream_event", "event": {"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": chunk}}}),
            );
        }

        let events = normalize(
            &mut normalizer,
            json!({"type": "stream_event", "event": {"type": "message_delta", "delta": {"stop_reason": "end_turn"}}}),
        );
        assert!(matches!(
            &events[0],
            NormalizedEvent::AgentMessageStarted { item_id, stop_reason: Some(reason) }
                if item_id == "msg_1" && reason == "end_turn"
        ));
        let deltas: Vec<&str> = events
            .iter()
            .filter_map(|event| match event {
                NormalizedEvent::AgentTextDelta { delta, .. } => Some(delta.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(deltas, vec!["hel", "lo ", "world"]);
        assert_eq!(
            agent_texts(&events),
            vec![(Some("end_turn".to_string()), "hello world".to_string())]
        );
    }

    #[test]
    fn explicit_assistant_stop_reason_flushes_immediately() {
        let mut normalizer = ClaudeEventNormalizer::default();
        let events = normalize(
            &mut normalizer,
            json!({"type": "assistant", "message": {"id": "msg_1", "stop_reason": "end_turn", "content": [{"type": "text", "text": "hello"}]}}),
        );
        assert_eq!(
            agent_texts(&events),
            vec![(Some("end_turn".to_string()), "hello".to_string())]
        );
    }

    #[test]
    fn steer_stdin_uses_claude_streaming_user_message_shape() {
        let bytes = ClaudeCodeHarness
            .stdin_for_steer(&[UserInput::Text {
                text: "new guidance".to_string(),
                text_elements: Vec::new(),
            }])
            .unwrap();
        let value: Value = serde_json::from_slice(&bytes).unwrap();

        assert_eq!(value["type"], "user");
        assert!(value.get("steer").is_none());
        assert_eq!(value["message"]["role"], "user");
        assert_eq!(value["message"]["content"][0]["text"], "new guidance");
    }
}
