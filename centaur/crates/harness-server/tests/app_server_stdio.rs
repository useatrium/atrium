use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, ExitStatus, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use codex_app_server_protocol::{JSONRPCMessage, ServerNotification};
use harness_server::is_known_untyped_server_notification;
use serde_json::{Value, json};
use uuid::Uuid;

const LONG_PROMPT: &str = "Write exactly 24 lines. Each line must be 'LONG_STREAM_DELTA_LINE_N: abcdefghijklmnopqrstuvwxyz 0123456789' where N is 01 through 24. Do not use markdown, bullets, tools, or extra text.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Harness {
    ClaudeCode,
    Amp,
    Codex,
}

impl Harness {
    fn name(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Amp => "amp",
            Self::Codex => "codex",
        }
    }

    fn args(self) -> &'static [&'static str] {
        match self {
            Self::ClaudeCode => &["claude-code", "--mode", "jsonrpc"],
            Self::Amp => &["amp", "--mode", "jsonrpc"],
            Self::Codex => &["codex", "--mode", "jsonrpc"],
        }
    }

    fn blocks_args(self) -> &'static [&'static str] {
        match self {
            Self::ClaudeCode => &["claude-code"],
            Self::Amp => &["amp"],
            Self::Codex => &["codex"],
        }
    }

    fn command_override_env(self) -> Option<&'static str> {
        match self {
            Self::ClaudeCode => Some("CENTAUR_CLAUDE_APP_BRIDGE_COMMAND"),
            Self::Amp => Some("CENTAUR_AMP_APP_BRIDGE_COMMAND"),
            Self::Codex => None,
        }
    }

    fn thread_start_params(self) -> Value {
        match self {
            Self::ClaudeCode => {
                let model = std::env::var("CENTAUR_REAL_CLAUDE_MODEL")
                    .or_else(|_| std::env::var("CLAUDE_MODEL"))
                    .unwrap_or_else(|_| "sonnet".to_string());
                json!({ "model": model })
            }
            Self::Amp => {
                let model = std::env::var("AMP_MODE").unwrap_or_else(|_| "deep".to_string());
                json!({ "model": model })
            }
            Self::Codex => {
                let mut params = json!({
                    "approvalPolicy": "never",
                    "sandbox": "danger-full-access",
                });
                let model = std::env::var("CODEX_SMOKE_MODEL")
                    .or_else(|_| std::env::var("CODEX_MODEL"))
                    .ok();
                if let Some(model) = model {
                    params["model"] = Value::String(model);
                }
                params
            }
        }
    }
}

struct RejectedInterruptRequestIds {
    turn_start: i64,
    wrong_thread_interrupt: i64,
    wrong_turn_interrupt: i64,
    valid_interrupt: i64,
}

#[test]
fn fake_claude_app_server_streams_codex_v2_notifications() {
    let fake_claude = concat!(
        "printf '%s\\n' ",
        "'{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"claude-session\"}' ",
        "'{\"type\":\"assistant\",\"is_partial\":true,\"message\":{\"id\":\"msg_1\",\"content\":[{\"type\":\"text\",\"text\":\"hel\"}]}}' ",
        "'{\"type\":\"assistant\",\"is_partial\":true,\"message\":{\"id\":\"msg_1\",\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}}' ",
        "'{\"type\":\"assistant\",\"is_partial\":false,\"message\":{\"id\":\"msg_1\",\"content\":[{\"type\":\"text\",\"text\":\"hello\"}]}}' ",
        "'{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"hello\"}'"
    );

    let run = run_bridge_turn(BridgeTurnConfig {
        harness: Harness::ClaudeCode,
        command_override: Some(fake_claude.to_string()),
        prompt: "say hello".to_string(),
        timeout: Duration::from_secs(10),
    });

    assert_completed_turn(&run.turn);
    assert_eq!(run.turn.text_from_deltas, "hello");
    assert_codex_v2_turn(&run.turn);
}

#[test]
fn fake_claude_trailing_result_settles_the_turn_and_does_not_poison_the_next() {
    // The native `result` trails the message_delta stop reason in real CLI
    // output. The stop must not complete the turn so eagerly that the result
    // is left buffered, where the next turn would read it as its own instant
    // terminal and complete with no content.
    let fake_claude = concat!(
        "printf '%s\\n' '{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"claude-session\"}'; ",
        "IFS= read -r _; ",
        "printf '%s\\n' ",
        "'{\"type\":\"stream_event\",\"event\":{\"type\":\"message_start\",\"message\":{\"id\":\"msg_1\",\"stop_reason\":null,\"content\":[]}}}' ",
        "'{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}}' ",
        "'{\"type\":\"stream_event\",\"event\":{\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"text_delta\",\"text\":\"first answer\"}}}' ",
        "'{\"type\":\"assistant\",\"message\":{\"id\":\"msg_1\",\"stop_reason\":null,\"content\":[{\"type\":\"text\",\"text\":\"first answer\"}]}}' ",
        "'{\"type\":\"stream_event\",\"event\":{\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"}}}' ",
        "'{\"type\":\"stream_event\",\"event\":{\"type\":\"message_stop\"}}' ",
        "'{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"first answer\"}'; ",
        "IFS= read -r _; ",
        "printf '%s\\n' ",
        "'{\"type\":\"assistant\",\"is_partial\":false,\"message\":{\"id\":\"msg_2\",\"content\":[{\"type\":\"text\",\"text\":\"second answer\"}]}}' ",
        "'{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"second answer\"}'; ",
        "sleep 60"
    );

    let run = run_bridge_two_turns(BridgeTwoTurnConfig {
        harness: Harness::ClaudeCode,
        command_override: Some(fake_claude.to_string()),
        first_prompt: "first".to_string(),
        second_prompt: "second".to_string(),
        timeout: Duration::from_secs(10),
    });

    assert_completed_turn(&run.turns[0]);
    assert_eq!(run.turns[0].text_from_deltas, "first answer");
    assert_completed_turn(&run.turns[1]);
    assert_eq!(run.turns[1].text_from_deltas, "second answer");
}

#[test]
fn blocks_interrupt_mid_turn_aborts_the_turn() {
    let fake_codex = temp_path("fake-codex-interrupt.sh");
    let fake_codex_log = temp_path("fake-codex-interrupt-requests.jsonl");
    let script = fake_codex_interrupt_app_server_script(&fake_codex_log);
    std::fs::write(&fake_codex, script).expect("write fake codex interrupt script");
    let mut permissions = std::fs::metadata(&fake_codex)
        .expect("fake codex metadata")
        .permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&fake_codex, permissions).expect("chmod fake codex script");

    let mut bridge = BridgeProcess::spawn_harness_blocks(
        Harness::Codex,
        None,
        Some((
            "CODEX_BIN",
            fake_codex.to_str().expect("utf-8 fake codex path"),
        )),
    );
    // The fake holds the turn open; the injected interrupt is the only thing
    // that can end it. If the harness-server dropped a mid-turn interrupt, this
    // would hang until the timeout instead of completing as interrupted.
    let turn = bridge.run_blocks_user_turn_interrupting("work forever", Duration::from_secs(10));
    bridge.finish_successfully();

    assert_eq!(
        turn.terminal_status.as_deref(),
        Some("interrupted"),
        "a mid-turn interrupt should abort the turn"
    );
    let log = std::fs::read_to_string(&fake_codex_log).expect("read fake codex log");
    assert!(
        log.contains("turn/interrupt"),
        "harness-server should forward the interrupt to the codex child; log=\n{log}"
    );
}

#[test]
fn codex_blocks_missing_resume_rollout_starts_fresh_thread() {
    let fake_codex = temp_path("fake-codex-missing-rollout.sh");
    let fake_codex_log = temp_path("fake-codex-missing-rollout-requests.jsonl");
    let script = fake_codex_missing_rollout_script(&fake_codex_log);
    std::fs::write(&fake_codex, script).expect("write fake codex script");
    let mut permissions = std::fs::metadata(&fake_codex)
        .expect("fake codex metadata")
        .permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&fake_codex, permissions).expect("chmod fake codex script");

    let mut bridge = BridgeProcess::spawn_harness_blocks_envs(
        Harness::Codex,
        None,
        Some((
            "CODEX_BIN",
            fake_codex.to_str().expect("utf-8 fake codex path"),
        )),
        &[("CODEX_CONTINUE_THREAD_ID", "stale-thread")],
    );
    bridge.send(json!({
        "type": "user",
        "thread_key": "slack:C123:123.456",
        "message": {
            "role": "user",
            "content": [{"type": "text", "text": "force child restart"}]
        }
    }));
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let value = bridge.read_json(deadline);
        if value.get("method").and_then(Value::as_str) == Some("error") {
            break;
        }
    }

    // The first turn error makes harness-server discard the Codex child. Its
    // next child must resume the fresh thread returned by the fallback, not
    // retry the stale environment value.
    let turn = bridge.run_blocks_user_turn("recover", Duration::from_secs(10));
    bridge.finish_successfully();

    assert_completed_turn(&turn);
    let requests = std::fs::read_to_string(&fake_codex_log).expect("read fake codex log");
    let methods: Vec<String> = requests
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|value| {
            value
                .get("method")
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .collect();
    assert_eq!(
        methods,
        vec![
            "initialize",
            "thread/resume",
            "thread/start",
            "turn/start",
            "initialize",
            "thread/resume",
            "turn/start"
        ]
    );
    let requests: Vec<Value> = requests
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    let resume_ids: Vec<&str> = requests
        .iter()
        .filter(|value| value.get("method").and_then(Value::as_str) == Some("thread/resume"))
        .filter_map(|value| value.pointer("/params/threadId").and_then(Value::as_str))
        .collect();
    assert_eq!(resume_ids, vec!["stale-thread", "thread-1"]);

    let _ = std::fs::remove_file(fake_codex);
    let _ = std::fs::remove_file(fake_codex_log);
}

#[test]
fn fake_codex_blocks_mode_uses_openrouter_provider_when_model_is_configured() {
    let fake_codex = temp_path("fake-openrouter-codex.sh");
    let fake_codex_log = temp_path("fake-openrouter-codex-requests.jsonl");
    let script = fake_codex_app_server_script(&fake_codex_log);
    std::fs::write(&fake_codex, script).expect("write fake codex script");
    let mut permissions = std::fs::metadata(&fake_codex)
        .expect("fake codex metadata")
        .permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&fake_codex, permissions).expect("chmod fake codex script");

    let mut bridge = BridgeProcess::spawn_harness_blocks_envs(
        Harness::Codex,
        None,
        Some((
            "CODEX_BIN",
            fake_codex.to_str().expect("utf-8 fake codex path"),
        )),
        &[("OPENROUTER_MODEL", "openrouter/auto")],
    );
    let turn = bridge.run_blocks_user_turn("say openrouter blocks", Duration::from_secs(10));
    bridge.finish_successfully();

    assert_completed_turn(&turn);
    assert_codex_v2_turn(&turn);

    let requests = std::fs::read_to_string(&fake_codex_log).expect("read fake codex request log");
    let requests: Vec<Value> = requests
        .lines()
        .map(|line| serde_json::from_str(line).expect("fake codex request JSON"))
        .collect();
    let thread_start = requests
        .iter()
        .find(|value| value.get("method").and_then(Value::as_str) == Some("thread/start"))
        .unwrap_or_else(|| panic!("blocks mode did not send thread/start; requests={requests:?}"));
    assert_eq!(
        thread_start
            .pointer("/params/modelProvider")
            .and_then(Value::as_str),
        Some("openrouter")
    );
    let turn_start = requests
        .iter()
        .find(|value| value.get("method").and_then(Value::as_str) == Some("turn/start"))
        .unwrap_or_else(|| panic!("blocks mode did not send turn/start; requests={requests:?}"));
    assert_eq!(
        turn_start.pointer("/params/model").and_then(Value::as_str),
        Some("openrouter/auto")
    );

    let _ = std::fs::remove_file(fake_codex);
    let _ = std::fs::remove_file(fake_codex_log);
}

#[test]
fn fake_codex_blocks_mode_uses_openrouter_provider_for_explicit_model_slug() {
    let fake_codex = temp_path("fake-openrouter-flag-codex.sh");
    let fake_codex_log = temp_path("fake-openrouter-flag-codex-requests.jsonl");
    let script = fake_codex_app_server_script(&fake_codex_log);
    std::fs::write(&fake_codex, script).expect("write fake codex script");
    let mut permissions = std::fs::metadata(&fake_codex)
        .expect("fake codex metadata")
        .permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&fake_codex, permissions).expect("chmod fake codex script");

    let mut bridge = BridgeProcess::spawn_harness_blocks(
        Harness::Codex,
        None,
        Some((
            "CODEX_BIN",
            fake_codex.to_str().expect("utf-8 fake codex path"),
        )),
    );
    let turn = bridge.run_blocks_user_turn_with_model(
        "say explicit openrouter blocks",
        Some("anthropic/claude-fable-5"),
        Duration::from_secs(10),
    );
    bridge.finish_successfully();

    assert_completed_turn(&turn);
    assert_codex_v2_turn(&turn);

    let requests = std::fs::read_to_string(&fake_codex_log).expect("read fake codex request log");
    let requests: Vec<Value> = requests
        .lines()
        .map(|line| serde_json::from_str(line).expect("fake codex request JSON"))
        .collect();
    let thread_start = requests
        .iter()
        .find(|value| value.get("method").and_then(Value::as_str) == Some("thread/start"))
        .unwrap_or_else(|| panic!("blocks mode did not send thread/start; requests={requests:?}"));
    assert_eq!(
        thread_start
            .pointer("/params/modelProvider")
            .and_then(Value::as_str),
        Some("openrouter")
    );
    let turn_start = requests
        .iter()
        .find(|value| value.get("method").and_then(Value::as_str) == Some("turn/start"))
        .unwrap_or_else(|| panic!("blocks mode did not send turn/start; requests={requests:?}"));
    assert_eq!(
        turn_start.pointer("/params/model").and_then(Value::as_str),
        Some("anthropic/claude-fable-5")
    );

    let _ = std::fs::remove_file(fake_codex);
    let _ = std::fs::remove_file(fake_codex_log);
}

#[test]
fn fake_codex_blocks_mode_uses_bedrock_provider_when_selected() {
    let fake_codex = temp_path("fake-bedrock-codex.sh");
    let fake_codex_log = temp_path("fake-bedrock-codex-requests.jsonl");
    let script = fake_codex_app_server_script(&fake_codex_log);
    std::fs::write(&fake_codex, script).expect("write fake codex script");
    let mut permissions = std::fs::metadata(&fake_codex)
        .expect("fake codex metadata")
        .permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&fake_codex, permissions).expect("chmod fake codex script");

    let mut bridge = BridgeProcess::spawn_harness_blocks(
        Harness::Codex,
        None,
        Some((
            "CODEX_BIN",
            fake_codex.to_str().expect("utf-8 fake codex path"),
        )),
    );
    // The `--bedrock` Slack flag rides the blocks `provider` field; it must pin
    // codex's `amazon-bedrock` provider even though the Bedrock model id carries
    // no `/` slug (which would otherwise route nowhere special).
    let user_line = json!({
        "type": "user",
        "thread_key": "slack:C123:123.456",
        "provider": "amazon-bedrock",
        "model": "anthropic.claude-sonnet-4-5",
        "message": {
            "role": "user",
            "content": [{"type": "text", "text": "say bedrock blocks"}],
        },
    });
    let turn = bridge.run_blocks_user_line(user_line, Duration::from_secs(10));
    bridge.finish_successfully();

    assert_completed_turn(&turn);
    assert_codex_v2_turn(&turn);

    let requests = std::fs::read_to_string(&fake_codex_log).expect("read fake codex request log");
    let requests: Vec<Value> = requests
        .lines()
        .map(|line| serde_json::from_str(line).expect("fake codex request JSON"))
        .collect();
    let thread_start = requests
        .iter()
        .find(|value| value.get("method").and_then(Value::as_str) == Some("thread/start"))
        .unwrap_or_else(|| panic!("blocks mode did not send thread/start; requests={requests:?}"));
    assert_eq!(
        thread_start
            .pointer("/params/modelProvider")
            .and_then(Value::as_str),
        Some("amazon-bedrock")
    );
    let turn_start = requests
        .iter()
        .find(|value| value.get("method").and_then(Value::as_str) == Some("turn/start"))
        .unwrap_or_else(|| panic!("blocks mode did not send turn/start; requests={requests:?}"));
    assert_eq!(
        turn_start.pointer("/params/model").and_then(Value::as_str),
        Some("anthropic.claude-sonnet-4-5")
    );

    let _ = std::fs::remove_file(fake_codex);
    let _ = std::fs::remove_file(fake_codex_log);
}

#[test]
fn fake_amp_app_server_streams_codex_v2_notifications() {
    let fake_amp = concat!(
        "printf '%s\\n' ",
        "'{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"T-amp-session\"}' ",
        "'{\"type\":\"assistant\",\"is_partial\":true,\"message\":{\"id\":\"msg_1\",\"content\":[{\"type\":\"text\",\"text\":\"am\"}]}}' ",
        "'{\"type\":\"assistant\",\"is_partial\":true,\"message\":{\"id\":\"msg_1\",\"content\":[{\"type\":\"text\",\"text\":\"amp\"}]}}' ",
        "'{\"type\":\"assistant\",\"is_partial\":false,\"message\":{\"id\":\"msg_1\",\"content\":[{\"type\":\"text\",\"text\":\"amp\"}]}}' ",
        "'{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"amp\"}'"
    );

    let run = run_bridge_turn(BridgeTurnConfig {
        harness: Harness::Amp,
        command_override: Some(fake_amp.to_string()),
        prompt: "say amp".to_string(),
        timeout: Duration::from_secs(10),
    });

    assert_completed_turn(&run.turn);
    assert_eq!(run.turn.text_from_deltas, "amp");
    assert_codex_v2_turn(&run.turn);
}

#[test]
fn fake_claude_blocks_mode_accepts_user_blocks_by_default() {
    let fake_claude = concat!(
        "printf '%s\\n' ",
        "'{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"claude-session\"}' ",
        "'{\"type\":\"assistant\",\"is_partial\":true,\"message\":{\"id\":\"msg_1\",\"content\":[{\"type\":\"text\",\"text\":\"blo\"}]}}' ",
        "'{\"type\":\"assistant\",\"is_partial\":true,\"message\":{\"id\":\"msg_1\",\"content\":[{\"type\":\"text\",\"text\":\"blocks\"}]}}' ",
        "'{\"type\":\"assistant\",\"is_partial\":false,\"message\":{\"id\":\"msg_1\",\"content\":[{\"type\":\"text\",\"text\":\"blocks\"}]}}' ",
        "'{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"blocks\"}'"
    );

    let run = run_blocks_turn(BridgeTurnConfig {
        harness: Harness::ClaudeCode,
        command_override: Some(fake_claude.to_string()),
        prompt: "say blocks".to_string(),
        timeout: Duration::from_secs(10),
    });

    assert_completed_turn(&run.turn);
    assert_eq!(run.turn.text_from_deltas, "blocks");
    assert_codex_v2_turn(&run.turn);
    assert!(
        run.stdout_lines
            .iter()
            .all(|line| response_id(&serde_json::from_str(line).expect("JSON stdout")).is_none()),
        "blocks mode should emit notifications only, not JSON-RPC responses"
    );
}

#[test]
fn fake_amp_blocks_mode_accepts_user_blocks_by_default() {
    let fake_amp = concat!(
        "printf '%s\\n' ",
        "'{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"T-amp-session\"}' ",
        "'{\"type\":\"assistant\",\"is_partial\":true,\"message\":{\"id\":\"msg_1\",\"content\":[{\"type\":\"text\",\"text\":\"bl\"}]}}' ",
        "'{\"type\":\"assistant\",\"is_partial\":true,\"message\":{\"id\":\"msg_1\",\"content\":[{\"type\":\"text\",\"text\":\"block amp\"}]}}' ",
        "'{\"type\":\"assistant\",\"is_partial\":false,\"message\":{\"id\":\"msg_1\",\"content\":[{\"type\":\"text\",\"text\":\"block amp\"}]}}' ",
        "'{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"block amp\"}'"
    );

    let run = run_blocks_turn(BridgeTurnConfig {
        harness: Harness::Amp,
        command_override: Some(fake_amp.to_string()),
        prompt: "say block amp".to_string(),
        timeout: Duration::from_secs(10),
    });

    assert_completed_turn(&run.turn);
    assert_eq!(run.turn.text_from_deltas, "block amp");
    assert_codex_v2_turn(&run.turn);
}

#[test]
fn fake_codex_blocks_mode_spawns_app_server_and_translates_user_blocks() {
    let fake_codex = temp_path("fake-codex.sh");
    let fake_codex_log = temp_path("fake-codex-requests.jsonl");
    let script = fake_codex_app_server_script(&fake_codex_log);
    std::fs::write(&fake_codex, script).expect("write fake codex script");
    let mut permissions = std::fs::metadata(&fake_codex)
        .expect("fake codex metadata")
        .permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&fake_codex, permissions).expect("chmod fake codex script");

    let mut bridge = BridgeProcess::spawn_harness_blocks(
        Harness::Codex,
        None,
        Some((
            "CODEX_BIN",
            fake_codex.to_str().expect("utf-8 fake codex path"),
        )),
    );
    let turn = bridge.run_blocks_user_turn("say codex blocks", Duration::from_secs(10));
    let stdout_lines = bridge.finish_successfully();

    assert_completed_turn(&turn);
    assert_eq!(turn.text_from_deltas, "codex blocks");
    assert_codex_v2_turn(&turn);
    assert!(
        stdout_lines
            .iter()
            .all(|line| response_id(&serde_json::from_str(line).expect("JSON stdout")).is_none()),
        "blocks mode should emit notifications only, not JSON-RPC responses"
    );

    let requests = std::fs::read_to_string(&fake_codex_log).expect("read fake codex request log");
    let requests: Vec<Value> = requests
        .lines()
        .map(|line| serde_json::from_str(line).expect("fake codex request JSON"))
        .collect();
    assert!(
        requests
            .iter()
            .any(|value| value.get("method").and_then(Value::as_str) == Some("thread/start")),
        "blocks mode should start a Codex app-server thread; requests={requests:?}"
    );
    let turn_start = requests
        .iter()
        .find(|value| value.get("method").and_then(Value::as_str) == Some("turn/start"))
        .unwrap_or_else(|| panic!("blocks mode did not send turn/start; requests={requests:?}"));
    assert_eq!(
        turn_start
            .pointer("/params/threadId")
            .and_then(Value::as_str),
        Some("thread-1")
    );
    assert_eq!(
        turn_start
            .pointer("/params/input/0/text")
            .and_then(Value::as_str),
        Some("say codex blocks")
    );

    let _ = std::fs::remove_file(fake_codex);
    let _ = std::fs::remove_file(fake_codex_log);
}

#[test]
fn fake_codex_blocks_mode_relays_request_user_input_answers() {
    let fake_codex = temp_path("fake-codex-hitl.sh");
    let fake_codex_log = temp_path("fake-codex-hitl-requests.jsonl");
    let script = fake_codex_hitl_app_server_script(&fake_codex_log);
    std::fs::write(&fake_codex, script).expect("write fake codex script");
    let mut permissions = std::fs::metadata(&fake_codex)
        .expect("fake codex metadata")
        .permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&fake_codex, permissions).expect("chmod fake codex script");

    let mut bridge = BridgeProcess::spawn_harness_blocks(
        Harness::Codex,
        None,
        Some((
            "CODEX_BIN",
            fake_codex.to_str().expect("utf-8 fake codex path"),
        )),
    );
    bridge.send(json!({
        "type": "user",
        "thread_key": "slack:C123:123.456",
        "message": {
            "role": "user",
            "content": [{"type": "text", "text": "ask me"}],
        },
    }));

    let deadline = Instant::now() + Duration::from_secs(10);
    let mut saw_question = false;
    let mut saw_answered = false;
    let mut saw_completed = false;
    while !saw_completed {
        let value = bridge.read_any_json(deadline);
        match value.get("type").and_then(Value::as_str) {
            Some("question_requested") => {
                saw_question = true;
                assert_eq!(
                    value.get("question_id").and_then(Value::as_str),
                    Some("q-1")
                );
                assert_eq!(value.get("turn_id").and_then(Value::as_str), Some("turn-1"));
                bridge.send(json!({
                    "type": "question_answer",
                    "question_id": "q-1",
                    "answers": {
                        "choice": {"answers": ["A"]},
                    },
                }));
            }
            Some("question_resolved") => {
                saw_answered = true;
                assert_eq!(
                    value.get("question_id").and_then(Value::as_str),
                    Some("q-1")
                );
                assert_eq!(
                    value.get("reason").and_then(Value::as_str),
                    Some("answered")
                );
            }
            _ => {
                if value.get("method").and_then(Value::as_str) == Some("turn/completed") {
                    saw_completed = true;
                }
            }
        }
    }
    bridge.finish_successfully();

    assert!(saw_question, "blocks mode should emit question_requested");
    assert!(
        saw_answered,
        "blocks mode should emit question_resolved(answered)"
    );
    let requests = std::fs::read_to_string(&fake_codex_log).expect("read fake codex request log");
    let values: Vec<Value> = requests
        .lines()
        .map(|line| serde_json::from_str(line).expect("fake codex JSON"))
        .collect();
    assert!(
        values.iter().any(|value| {
            value.get("id").and_then(Value::as_str) == Some("ask-1")
                && value
                    .pointer("/result/answers/choice/answers/0")
                    .and_then(Value::as_str)
                    == Some("A")
        }),
        "Codex did not receive the question answer response; log={values:?}"
    );

    let _ = std::fs::remove_file(fake_codex);
    let _ = std::fs::remove_file(fake_codex_log);
}

#[test]
fn fake_codex_blocks_mode_forwards_traceparent_to_app_server_requests() {
    let fake_codex = temp_path("fake-codex-trace.sh");
    let fake_codex_log = temp_path("fake-codex-trace-requests.jsonl");
    let script = fake_codex_app_server_script(&fake_codex_log);
    std::fs::write(&fake_codex, script).expect("write fake codex script");
    let mut permissions = std::fs::metadata(&fake_codex)
        .expect("fake codex metadata")
        .permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&fake_codex, permissions).expect("chmod fake codex script");

    let traceparent = "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01";
    let mut bridge = BridgeProcess::spawn_harness_blocks(
        Harness::Codex,
        None,
        Some((
            "CODEX_BIN",
            fake_codex.to_str().expect("utf-8 fake codex path"),
        )),
    );
    let turn = bridge.run_blocks_user_line(
        json!({
            "type": "user",
            "thread_key": "slack:C123:123.456",
            "traceparent": traceparent,
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": "say codex blocks"}],
            },
        }),
        Duration::from_secs(10),
    );
    bridge.finish_successfully();

    assert_completed_turn(&turn);
    let requests = std::fs::read_to_string(&fake_codex_log).expect("read fake codex request log");
    let requests: Vec<Value> = requests
        .lines()
        .map(|line| serde_json::from_str(line).expect("fake codex request JSON"))
        .collect();
    for method in ["initialize", "thread/start", "turn/start"] {
        let request = requests
            .iter()
            .find(|value| value.get("method").and_then(Value::as_str) == Some(method))
            .unwrap_or_else(|| panic!("missing {method}; requests={requests:?}"));
        assert_eq!(
            request
                .pointer("/trace/traceparent")
                .and_then(Value::as_str),
            Some(traceparent),
            "{method} request should carry traceparent"
        );
    }

    let _ = std::fs::remove_file(fake_codex);
    let _ = std::fs::remove_file(fake_codex_log);
}

#[test]
fn fake_claude_blocks_mode_relays_sdk_question_answers() {
    let fake_claude = temp_path("fake-claude-hitl.sh");
    let fake_claude_log = temp_path("fake-claude-hitl-stdin.jsonl");
    let script = fake_claude_hitl_bridge_script(&fake_claude_log);
    std::fs::write(&fake_claude, script).expect("write fake claude script");
    let mut permissions = std::fs::metadata(&fake_claude)
        .expect("fake claude metadata")
        .permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&fake_claude, permissions).expect("chmod fake claude script");

    let mut bridge = BridgeProcess::spawn_harness_blocks(
        Harness::ClaudeCode,
        Some(shell_quote(&fake_claude)),
        None,
    );
    bridge.send(json!({
        "type": "user",
        "thread_key": "slack:C123:123.456",
        "message": {
            "role": "user",
            "content": [{"type": "text", "text": "ask me"}],
        },
    }));

    let deadline = Instant::now() + Duration::from_secs(10);
    let mut saw_question = false;
    let mut saw_answered = false;
    let mut saw_completed = false;
    while !saw_completed {
        let value = bridge.read_any_json(deadline);
        match value.get("type").and_then(Value::as_str) {
            Some("question_requested") => {
                saw_question = true;
                assert_eq!(
                    value.get("question_id").and_then(Value::as_str),
                    Some("toolu_ask")
                );
                assert_eq!(
                    value
                        .pointer("/questions/0/multiSelect")
                        .and_then(Value::as_bool),
                    Some(true)
                );
                assert_eq!(
                    value
                        .pointer("/questions/0/options/0/previewFormat")
                        .and_then(Value::as_str),
                    Some("markdown")
                );
                bridge.send(json!({
                    "type": "question_answer",
                    "question_id": "toolu_ask",
                    "answers": {
                        "question-1": {"answers": ["Summary", "Timeline"]},
                    },
                }));
            }
            Some("question_resolved") => {
                saw_answered = true;
                assert_eq!(
                    value.get("question_id").and_then(Value::as_str),
                    Some("toolu_ask")
                );
                assert_eq!(
                    value.get("reason").and_then(Value::as_str),
                    Some("answered")
                );
            }
            _ => {
                if value.get("method").and_then(Value::as_str) == Some("turn/completed") {
                    saw_completed = true;
                }
            }
        }
    }
    bridge.finish_successfully();

    assert!(saw_question, "Claude bridge should emit question_requested");
    assert!(
        saw_answered,
        "Claude bridge should emit question_resolved(answered)"
    );
    let stdin_log = std::fs::read_to_string(&fake_claude_log).expect("read fake claude stdin log");
    let values: Vec<Value> = stdin_log
        .lines()
        .map(|line| serde_json::from_str(line).expect("fake claude stdin JSON"))
        .collect();
    assert!(
        values.iter().any(|value| {
            value.get("type").and_then(Value::as_str) == Some("question_answer")
                && value
                    .pointer("/answers/question-1/answers/0")
                    .and_then(Value::as_str)
                    == Some("Summary")
                && value
                    .pointer("/answers/question-1/answers/1")
                    .and_then(Value::as_str)
                    == Some("Timeline")
        }),
        "Claude bridge did not receive the question answer; log={values:?}"
    );

    let _ = std::fs::remove_file(fake_claude);
    let _ = std::fs::remove_file(fake_claude_log);
}

#[test]
fn claude_sdk_bridge_maps_ask_user_question_with_fake_sdk() {
    let fake_sdk = temp_path("fake-claude-agent-sdk").with_extension("mjs");
    std::fs::write(&fake_sdk, fake_claude_agent_sdk_module_script())
        .expect("write fake SDK module");

    let bridge_script = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("services/sandbox/claude-sdk-bridge.mjs");
    let session_id = Uuid::new_v4().to_string();
    let mut command = Command::new("node");
    command
        .arg(bridge_script)
        .env("CLAUDE_AGENT_SDK_MODULE", &fake_sdk)
        .env("CLAUDE_ASK_USER_PREVIEW_FORMAT", "html")
        .env("CENTAUR_CLAUDE_MODEL", "fake-model")
        .env("CENTAUR_CLAUDE_SESSION_ID", &session_id)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut bridge = BridgeProcess::spawn_command(command);

    bridge.send(json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{"type": "text", "text": "ask me"}],
        },
    }));

    let deadline = Instant::now() + Duration::from_secs(10);
    let mut saw_question = false;
    let mut saw_answer_text = false;
    let mut saw_result = false;
    while !saw_result {
        let value = bridge.read_any_json(deadline);
        match value.get("type").and_then(Value::as_str) {
            Some("question_requested") => {
                saw_question = true;
                assert_eq!(
                    value.get("question_id").and_then(Value::as_str),
                    Some("toolu_sdk")
                );
                assert_eq!(
                    value
                        .pointer("/questions/0/multiSelect")
                        .and_then(Value::as_bool),
                    Some(true)
                );
                assert_eq!(
                    value
                        .pointer("/questions/0/options/0/previewFormat")
                        .and_then(Value::as_str),
                    Some("html")
                );
                bridge.send(json!({
                    "type": "question_answer",
                    "question_id": "toolu_sdk",
                    "answers": {
                        "question-1": {"answers": ["Summary", "Timeline"]},
                    },
                }));
            }
            Some("assistant") => {
                let text = value
                    .pointer("/message/content/0/text")
                    .and_then(Value::as_str);
                if text == Some("Summary, Timeline") {
                    saw_answer_text = true;
                }
            }
            Some("result") => {
                saw_result = true;
            }
            _ => {}
        }
    }
    bridge.finish_successfully();

    assert!(saw_question, "bridge should emit question_requested");
    assert!(
        saw_answer_text,
        "bridge should pass selected labels back to the SDK"
    );
    let _ = std::fs::remove_file(fake_sdk);
}

#[test]
fn claude_blocks_mode_uses_sdk_bridge_for_hitl_questions() {
    let fake_sdk = temp_path("fake-claude-agent-sdk-harness").with_extension("mjs");
    std::fs::write(&fake_sdk, fake_claude_agent_sdk_module_script())
        .expect("write fake SDK module");
    let bridge_script = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../..")
        .join("services/sandbox/claude-sdk-bridge.mjs");

    let mut bridge = BridgeProcess::spawn_harness_blocks_envs(
        Harness::ClaudeCode,
        Some(format!("node {}", shell_quote(&bridge_script))),
        None,
        &[
            (
                "CLAUDE_AGENT_SDK_MODULE",
                fake_sdk.to_str().expect("utf-8 fake SDK path"),
            ),
            ("CLAUDE_ASK_USER_PREVIEW_FORMAT", "html"),
            ("CLAUDE_MODEL", "fake-model"),
        ],
    );
    bridge.send(json!({
        "type": "user",
        "thread_key": "slack:C123:123.456",
        "message": {
            "role": "user",
            "content": [{"type": "text", "text": "ask me"}],
        },
    }));

    let deadline = Instant::now() + Duration::from_secs(10);
    let mut saw_question = false;
    let mut saw_answered = false;
    let mut saw_agent_text = false;
    let mut saw_completed = false;
    while !saw_completed {
        let value = bridge.read_any_json(deadline);
        match value.get("type").and_then(Value::as_str) {
            Some("question_requested") => {
                saw_question = true;
                assert_eq!(
                    value.get("question_id").and_then(Value::as_str),
                    Some("toolu_sdk")
                );
                assert_eq!(
                    value
                        .pointer("/questions/0/options/0/previewFormat")
                        .and_then(Value::as_str),
                    Some("html")
                );
                bridge.send(json!({
                    "type": "question_answer",
                    "question_id": "toolu_sdk",
                    "answers": {
                        "question-1": {"answers": ["Summary", "Timeline"]},
                    },
                }));
            }
            Some("question_resolved") => {
                saw_answered = true;
                assert_eq!(
                    value.get("reason").and_then(Value::as_str),
                    Some("answered")
                );
            }
            _ => {
                if value.get("method").and_then(Value::as_str) == Some("item/completed")
                    && value.pointer("/params/item/type").and_then(Value::as_str)
                        == Some("agentMessage")
                    && value.pointer("/params/item/text").and_then(Value::as_str)
                        == Some("Summary, Timeline")
                {
                    saw_agent_text = true;
                }
                if value.get("method").and_then(Value::as_str) == Some("turn/completed") {
                    saw_completed = true;
                }
            }
        }
    }
    bridge.finish_successfully();

    assert!(saw_question, "SDK bridge should emit question_requested");
    assert!(
        saw_answered,
        "harness should resolve the question as answered"
    );
    assert!(
        saw_agent_text,
        "Claude answer should include the labels selected through the GUI path"
    );
    let _ = std::fs::remove_file(fake_sdk);
}

#[test]
fn fake_codex_blocks_mode_forwards_reasoning_as_turn_start_effort() {
    let fake_codex = temp_path("fake-codex-effort.sh");
    let fake_codex_log = temp_path("fake-codex-effort-requests.jsonl");
    let script = fake_codex_app_server_script(&fake_codex_log);
    std::fs::write(&fake_codex, script).expect("write fake codex script");
    let mut permissions = std::fs::metadata(&fake_codex)
        .expect("fake codex metadata")
        .permissions();
    permissions.set_mode(0o755);
    std::fs::set_permissions(&fake_codex, permissions).expect("chmod fake codex script");

    let mut bridge = BridgeProcess::spawn_harness_blocks(
        Harness::Codex,
        None,
        Some((
            "CODEX_BIN",
            fake_codex.to_str().expect("utf-8 fake codex path"),
        )),
    );
    let turn = bridge.run_blocks_user_line(
        json!({
            "type": "user",
            "thread_key": "slack:C123:123.456",
            "reasoning": "high",
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": "say codex blocks"}],
            },
        }),
        Duration::from_secs(10),
    );
    bridge.finish_successfully();
    assert_completed_turn(&turn);

    let requests = std::fs::read_to_string(&fake_codex_log).expect("read fake codex request log");
    let turn_start = requests
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).expect("fake codex request JSON"))
        .find(|value| value.get("method").and_then(Value::as_str) == Some("turn/start"))
        .expect("blocks mode did not send turn/start");
    assert_eq!(
        turn_start.pointer("/params/effort").and_then(Value::as_str),
        Some("high"),
        "reasoning should be forwarded as turn/start effort; turn_start={turn_start}"
    );

    let _ = std::fs::remove_file(fake_codex);
    let _ = std::fs::remove_file(fake_codex_log);
}

#[test]
fn fake_amp_final_only_assistant_message_is_chunked_into_codex_deltas() {
    let expected = expected_long_text();
    let system = json!({
        "type": "system",
        "subtype": "init",
        "session_id": "T-amp-session",
    })
    .to_string();
    let assistant = json!({
        "type": "assistant",
        "message": {
            "id": "msg_1",
            "content": [{"type": "text", "text": expected}],
        },
    })
    .to_string();
    let result = json!({
        "type": "result",
        "subtype": "success",
        "result": expected,
    })
    .to_string();
    let fake_amp = format!(
        "printf '%s\\n' {} {} {}",
        shell_quote_str(&system),
        shell_quote_str(&assistant),
        shell_quote_str(&result)
    );

    let run = run_bridge_turn(BridgeTurnConfig {
        harness: Harness::Amp,
        command_override: Some(fake_amp),
        prompt: "write long text".to_string(),
        timeout: Duration::from_secs(10),
    });

    assert_completed_turn(&run.turn);
    assert_eq!(run.turn.text_from_deltas, expected);
    assert!(
        run.turn.agent_delta_count > 1,
        "Amp final-only assistant text should be expanded into multiple Codex deltas"
    );
    assert_codex_v2_turn(&run.turn);
}

#[test]
fn fake_harness_process_is_started_once_across_two_turns() {
    let start_log = temp_path("harness-starts.log");
    let command = format!(
        "printf 'start\\n' >> {}; \
         printf '%s\\n' '{{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"fake-session\"}}'; \
         while IFS= read -r _; do \
           printf '%s\\n' '{{\"type\":\"assistant\",\"is_partial\":false,\"message\":{{\"id\":\"msg_1\",\"content\":[{{\"type\":\"text\",\"text\":\"turn\"}}]}}}}'; \
           printf '%s\\n' '{{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"turn\"}}'; \
         done",
        shell_quote(start_log.as_path())
    );

    let run = run_bridge_two_turns(BridgeTwoTurnConfig {
        harness: Harness::ClaudeCode,
        command_override: Some(command),
        first_prompt: "first".to_string(),
        second_prompt: "second".to_string(),
        timeout: Duration::from_secs(10),
    });

    assert_completed_turn(&run.turns[0]);
    assert_completed_turn(&run.turns[1]);
    assert_eq!(run.turns[0].text_from_deltas, "turn");
    assert_eq!(run.turns[1].text_from_deltas, "turn");

    let starts = std::fs::read_to_string(&start_log).expect("read start log");
    assert_eq!(
        starts.lines().count(),
        1,
        "underlying harness process should be spawned once per thread"
    );
    let _ = std::fs::remove_file(start_log);
}

#[test]
fn turn_interrupt_kills_harness_process_and_finishes_turn() {
    let start_log = temp_path("harness-interrupt-starts.log");
    let marker = temp_path("harness-interrupt-marker");
    let command = format!(
        "printf 'start\\n' >> {start_log}; \
         printf '%s\\n' '{{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"fake-session\"}}'; \
         while IFS= read -r _; do \
           if [ -f {marker} ]; then \
             printf '%s\\n' '{{\"type\":\"assistant\",\"is_partial\":false,\"message\":{{\"id\":\"msg_1\",\"content\":[{{\"type\":\"text\",\"text\":\"fresh turn\"}}]}}}}'; \
             printf '%s\\n' '{{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"fresh turn\"}}'; \
           else \
             sleep 60; \
           fi; \
         done",
        start_log = shell_quote(start_log.as_path()),
        marker = shell_quote(marker.as_path())
    );
    let mut bridge = BridgeProcess::spawn_harness(Harness::ClaudeCode, Some(command), None);
    let thread_id =
        bridge.initialize_and_start_thread(Harness::ClaudeCode, Duration::from_secs(10));

    let interrupted = bridge.run_interrupted_turn(
        &thread_id,
        3,
        4,
        "hang until stopped",
        Duration::from_secs(10),
    );
    assert_eq!(interrupted.terminal_status.as_deref(), Some("interrupted"));

    std::fs::write(&marker, b"fresh turn ready").expect("write fresh-turn marker");
    let fresh = bridge.run_turn(
        &thread_id,
        5,
        "run after interrupt",
        None,
        Duration::from_secs(10),
    );
    assert_completed_turn(&fresh);
    assert_eq!(fresh.text_from_deltas, "fresh turn");
    let _ = bridge.child.kill();
    let _ = bridge.child.wait();
    let _ = std::fs::remove_file(start_log);
    let _ = std::fs::remove_file(marker);
}

#[test]
fn turn_interrupt_rejects_wrong_thread_and_turn_without_killing_process() {
    let start_log = temp_path("harness-rejected-interrupt-starts.log");
    let command = format!(
        "printf 'start\\n' >> {start_log}; \
         printf '%s\\n' '{{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"fake-session\"}}'; \
         while IFS= read -r _; do sleep 60; done",
        start_log = shell_quote(start_log.as_path()),
    );
    let mut bridge = BridgeProcess::spawn_harness(Harness::ClaudeCode, Some(command), None);
    let thread_id =
        bridge.initialize_and_start_thread(Harness::ClaudeCode, Duration::from_secs(10));

    let interrupted = bridge.run_turn_with_rejected_interrupts(
        &thread_id,
        RejectedInterruptRequestIds {
            turn_start: 3,
            wrong_thread_interrupt: 4,
            wrong_turn_interrupt: 5,
            valid_interrupt: 6,
        },
        "hang until stopped",
        Duration::from_secs(10),
    );
    assert_eq!(interrupted.terminal_status.as_deref(), Some("interrupted"));

    let starts = std::fs::read_to_string(&start_log).expect("read start log");
    assert_eq!(
        starts.lines().count(),
        1,
        "rejected interrupts must not kill and restart the harness before the valid interrupt"
    );
    let _ = bridge.child.kill();
    let _ = bridge.child.wait();
    let _ = std::fs::remove_file(start_log);
}

#[test]
#[ignore = "runs real Claude Code and Codex/Amp-style networked binaries"]
fn real_claude_code_long_streaming_is_anchored_to_native_cli() {
    require_command("claude", &["--version"]);
    let expected = expected_long_text();
    let native = run_native_anthropic(Harness::ClaudeCode, LONG_PROMPT, Duration::from_secs(240));
    eprintln!(
        "native claude summary: stream_text_delta_count={} assistant_events={} final_bytes={}",
        native.stream_text_delta_count,
        native.assistant_event_count,
        native.final_text().len()
    );
    assert_eq!(native.final_text().trim(), expected);
    assert!(
        native.stream_text_delta_count > 1,
        "native Claude Code did not stream multiple text deltas; raw stdout={:?}",
        native.stdout_lines
    );

    let wrapped = run_bridge_turn(BridgeTurnConfig {
        harness: Harness::ClaudeCode,
        command_override: None,
        prompt: LONG_PROMPT.to_string(),
        timeout: Duration::from_secs(240),
    });
    assert_completed_turn(&wrapped.turn);
    assert_eq!(wrapped.turn.text_from_deltas.trim(), expected);
    assert!(
        wrapped.turn.agent_delta_count > 1,
        "wrapper collapsed native Claude Code streaming into one delta; stdout={:?}",
        wrapped.stdout_lines
    );
    assert_delta_reconstruction(&wrapped.turn);
}

#[test]
#[ignore = "runs real Amp and may make network/auth calls"]
fn real_amp_long_streaming_is_anchored_to_native_cli() {
    require_command("amp", &["--version"]);
    let expected = expected_long_text();
    let native = run_native_anthropic(Harness::Amp, LONG_PROMPT, Duration::from_secs(240));
    eprintln!(
        "native amp summary: stream_text_delta_count={} assistant_events={} final_bytes={}",
        native.stream_text_delta_count,
        native.assistant_event_count,
        native.final_text().len()
    );
    assert_eq!(native.final_text().trim(), expected);

    let wrapped = run_bridge_turn(BridgeTurnConfig {
        harness: Harness::Amp,
        command_override: None,
        prompt: LONG_PROMPT.to_string(),
        timeout: Duration::from_secs(240),
    });
    assert_completed_turn(&wrapped.turn);
    assert_eq!(wrapped.turn.text_from_deltas.trim(), expected);
    assert_delta_reconstruction(&wrapped.turn);

    assert!(
        wrapped.turn.agent_delta_count > 1,
        "Amp wrapper should expose Codex text deltas even when native Amp emits final assistant text; native_stream_text_delta_count={}",
        native.stream_text_delta_count
    );
}

#[test]
#[ignore = "runs real Codex app-server and may make network/auth calls"]
fn real_codex_long_streaming_uses_native_app_server_chunks() {
    let expected = expected_long_text();
    let direct = run_direct_codex_app_server_turn(LONG_PROMPT, Duration::from_secs(240));
    assert_completed_turn(&direct.turn);
    assert_eq!(direct.turn.text_from_deltas.trim(), expected);
    assert!(
        direct.turn.agent_delta_count > 10,
        "native Codex app-server did not stream the long reply in many chunks"
    );
    assert_delta_reconstruction(&direct.turn);

    let wrapped = run_bridge_turn(BridgeTurnConfig {
        harness: Harness::Codex,
        command_override: None,
        prompt: LONG_PROMPT.to_string(),
        timeout: Duration::from_secs(240),
    });
    assert_completed_turn(&wrapped.turn);
    assert_eq!(wrapped.turn.text_from_deltas.trim(), expected);
    assert!(
        wrapped.turn.agent_delta_count > 10,
        "Codex wrapper should preserve upstream app-server chunking"
    );
    assert_delta_reconstruction(&wrapped.turn);
}

#[test]
#[ignore = "runs real harness binaries and may make network/auth calls"]
fn real_harnesses_basic_steer_and_resume() {
    for harness in [Harness::ClaudeCode, Harness::Amp, Harness::Codex] {
        let marker = format!("REAL_STEER_{}", Uuid::new_v4().simple());
        let run = run_bridge_steered_turn(BridgeSteerConfig {
            harness,
            command_override: None,
            start_prompt:
                "Before answering, run a shell command that sleeps for 8 seconds. If a steering update arrives while you are waiting, follow it. Otherwise reply exactly INITIAL."
                    .to_string(),
            steer_prompt: format!("Steering update: reply exactly {marker} and nothing else."),
            timeout: Duration::from_secs(240),
        });
        assert_completed_turn(&run.turn);
        assert_eq!(run.steer_response, Some(run.turn.turn_id.clone()));
        assert!(
            run.turn.text_from_deltas.contains(&marker),
            "{} did not apply steering; text={:?}",
            harness.name(),
            run.turn.text_from_deltas
        );
        assert_delta_reconstruction(&run.turn);

        let marker = format!("REAL_CTX_{}", Uuid::new_v4().simple());
        let turns = run_bridge_two_turns(BridgeTwoTurnConfig {
            harness,
            command_override: None,
            first_prompt: format!(
                "Remember this exact marker for the next turn: {marker}. Do not use tools. Reply exactly TURN1_OK."
            ),
            second_prompt: format!(
                "Without using tools, what exact marker did I ask you to remember in the previous turn? Reply exactly TURN2_MARKER_{marker}."
            ),
            timeout: Duration::from_secs(300),
        });
        assert_completed_turn(&turns.turns[0]);
        assert_completed_turn(&turns.turns[1]);
        assert!(
            turns.turns[1].text_from_deltas.contains(&marker),
            "{} did not preserve context across resume; turn2={:?}",
            harness.name(),
            turns.turns[1].text_from_deltas
        );
        assert_delta_reconstruction(&turns.turns[0]);
        assert_delta_reconstruction(&turns.turns[1]);
    }
}

#[derive(Debug)]
struct BridgeTurnConfig {
    harness: Harness,
    command_override: Option<String>,
    prompt: String,
    timeout: Duration,
}

#[derive(Debug)]
struct BridgeTwoTurnConfig {
    harness: Harness,
    command_override: Option<String>,
    first_prompt: String,
    second_prompt: String,
    timeout: Duration,
}

#[derive(Debug)]
struct BridgeSteerConfig {
    harness: Harness,
    command_override: Option<String>,
    start_prompt: String,
    steer_prompt: String,
    timeout: Duration,
}

#[derive(Debug)]
struct BridgeRun {
    stdout_lines: Vec<String>,
    turn: TurnCapture,
}

#[derive(Debug)]
struct BridgeTwoTurnRun {
    turns: Vec<TurnCapture>,
}

#[derive(Debug)]
struct BridgeSteerRun {
    turn: TurnCapture,
    steer_response: Option<String>,
}

#[derive(Debug, Default, Clone)]
struct TurnCapture {
    turn_id: String,
    methods: Vec<String>,
    text_from_deltas: String,
    agent_delta_count: usize,
    reasoning_delta_count: usize,
    completed_agent_items: HashMap<String, String>,
    delta_text_by_item: HashMap<String, String>,
    terminal_status: Option<String>,
    terminal_error: Option<String>,
}

fn run_bridge_turn(config: BridgeTurnConfig) -> BridgeRun {
    let mut bridge = BridgeProcess::spawn_harness(config.harness, config.command_override, None);
    let thread_id = bridge.initialize_and_start_thread(config.harness, config.timeout);
    let turn = bridge.run_turn(&thread_id, 3, &config.prompt, None, config.timeout);
    let stdout_lines = bridge.finish_successfully();
    BridgeRun { stdout_lines, turn }
}

fn run_blocks_turn(config: BridgeTurnConfig) -> BridgeRun {
    let mut bridge =
        BridgeProcess::spawn_harness_blocks(config.harness, config.command_override, None);
    let turn = bridge.run_blocks_user_turn(&config.prompt, config.timeout);
    let stdout_lines = bridge.finish_successfully();
    BridgeRun { stdout_lines, turn }
}

fn run_bridge_two_turns(config: BridgeTwoTurnConfig) -> BridgeTwoTurnRun {
    let mut bridge = BridgeProcess::spawn_harness(config.harness, config.command_override, None);
    let thread_id = bridge.initialize_and_start_thread(config.harness, config.timeout);
    let first = bridge.run_turn(&thread_id, 3, &config.first_prompt, None, config.timeout);
    bridge.resume_thread(&thread_id, 4, config.timeout);
    let second = bridge.run_turn(&thread_id, 5, &config.second_prompt, None, config.timeout);
    bridge.finish_successfully();
    BridgeTwoTurnRun {
        turns: vec![first, second],
    }
}

fn run_bridge_steered_turn(config: BridgeSteerConfig) -> BridgeSteerRun {
    let mut bridge = BridgeProcess::spawn_harness(config.harness, config.command_override, None);
    let thread_id = bridge.initialize_and_start_thread(config.harness, config.timeout);
    let mut steer_response = None;
    let turn = bridge.run_turn(
        &thread_id,
        3,
        &config.start_prompt,
        Some(SteerPlan {
            request_id: 4,
            prompt: config.steer_prompt,
            response_turn_id: &mut steer_response,
        }),
        config.timeout,
    );
    bridge.finish_successfully();
    BridgeSteerRun {
        turn,
        steer_response,
    }
}

fn run_direct_codex_app_server_turn(prompt: &str, timeout: Duration) -> BridgeRun {
    let bin = codex_bin();
    let mut command = Command::new(bin);
    command
        .args(["app-server", "--listen", "stdio://"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut bridge = BridgeProcess::spawn_command(command);
    let thread_id = bridge.initialize_and_start_thread(Harness::Codex, timeout);
    let turn = bridge.run_turn(&thread_id, 3, prompt, None, timeout);
    let stdout_lines = bridge.finish_successfully();
    BridgeRun { stdout_lines, turn }
}

struct SteerPlan<'a> {
    request_id: i64,
    prompt: String,
    response_turn_id: &'a mut Option<String>,
}

struct BridgeProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    line_rx: Receiver<std::io::Result<String>>,
    stdout_reader: JoinHandle<()>,
    stderr_reader: JoinHandle<String>,
    stdout_lines: Vec<String>,
}

impl BridgeProcess {
    fn spawn_harness(
        harness: Harness,
        command_override: Option<String>,
        extra_env: Option<(&str, &str)>,
    ) -> Self {
        Self::spawn_harness_with_args(harness, harness.args(), command_override, extra_env, &[])
    }

    fn spawn_harness_blocks(
        harness: Harness,
        command_override: Option<String>,
        extra_env: Option<(&str, &str)>,
    ) -> Self {
        Self::spawn_harness_with_args(
            harness,
            harness.blocks_args(),
            command_override,
            extra_env,
            &[],
        )
    }

    fn spawn_harness_blocks_envs(
        harness: Harness,
        command_override: Option<String>,
        extra_env: Option<(&str, &str)>,
        extra_envs: &[(&str, &str)],
    ) -> Self {
        Self::spawn_harness_with_args(
            harness,
            harness.blocks_args(),
            command_override,
            extra_env,
            extra_envs,
        )
    }

    fn spawn_harness_with_args(
        harness: Harness,
        args: &'static [&'static str],
        command_override: Option<String>,
        extra_env: Option<(&str, &str)>,
        extra_envs: &[(&str, &str)],
    ) -> Self {
        let bin = env!("CARGO_BIN_EXE_harness-server");
        let mut command = Command::new(bin);
        command
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        for env_key in [
            "CENTAUR_CLAUDE_APP_BRIDGE_COMMAND",
            "CENTAUR_AMP_APP_BRIDGE_COMMAND",
            "CODEX_CONTINUE_THREAD_ID",
            "CODEX_MODEL",
            "CODEX_MODEL_PROVIDER",
            "OPENROUTER_MODEL",
        ] {
            command.env_remove(env_key);
        }
        if let Some(env_key) = harness.command_override_env()
            && let Some(raw) = command_override
        {
            command.env(env_key, raw);
        }
        if let Some((key, value)) = extra_env {
            command.env(key, value);
        }
        for (key, value) in extra_envs {
            command.env(key, value);
        }

        Self::spawn_command(command)
    }

    fn spawn_command(mut command: Command) -> Self {
        let mut child = command.spawn().expect("spawn app server process");
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let stderr = child.stderr.take().expect("stderr");
        let (line_tx, line_rx) = mpsc::channel();
        let stdout_reader = thread::spawn(move || {
            for raw in BufReader::new(stdout).lines() {
                let should_stop = raw.is_err();
                if line_tx.send(raw).is_err() || should_stop {
                    break;
                }
            }
        });
        let stderr_reader = thread::spawn(move || {
            let mut buf = String::new();
            let _ = BufReader::new(stderr).read_to_string(&mut buf);
            buf
        });

        Self {
            child,
            stdin: Some(stdin),
            line_rx,
            stdout_reader,
            stderr_reader,
            stdout_lines: Vec::new(),
        }
    }

    fn initialize_and_start_thread(&mut self, harness: Harness, timeout: Duration) -> String {
        self.send(json!({
            "id": 1,
            "method": "initialize",
            "params": {
                "clientInfo": {"name": "cargo-test", "title": null, "version": "0"},
                "capabilities": null,
            },
        }));
        self.send(json!({
            "id": 2,
            "method": "thread/start",
            "params": harness.thread_start_params(),
        }));

        let deadline = Instant::now() + timeout;
        loop {
            let value = self.read_json(deadline);
            if response_id(&value) == Some(2) {
                return value
                    .pointer("/result/thread/id")
                    .and_then(Value::as_str)
                    .unwrap_or_else(|| panic!("thread/start did not return thread id: {value}"))
                    .to_string();
            }
        }
    }

    fn resume_thread(&mut self, thread_id: &str, request_id: i64, timeout: Duration) {
        self.send(json!({
            "id": request_id,
            "method": "thread/resume",
            "params": {
                "threadId": thread_id,
                "excludeTurns": false,
            },
        }));

        let deadline = Instant::now() + timeout;
        loop {
            let value = self.read_json(deadline);
            if response_id(&value) == Some(request_id) {
                let resumed = value
                    .pointer("/result/thread/id")
                    .and_then(Value::as_str)
                    .unwrap_or_else(|| panic!("thread/resume did not return thread id: {value}"));
                assert_eq!(resumed, thread_id, "thread/resume returned wrong thread");
                return;
            }
        }
    }

    fn run_turn(
        &mut self,
        thread_id: &str,
        request_id: i64,
        prompt: &str,
        mut steer: Option<SteerPlan<'_>>,
        timeout: Duration,
    ) -> TurnCapture {
        self.send(json!({
            "id": request_id,
            "method": "turn/start",
            "params": {
                "threadId": thread_id,
                "input": [{"type": "text", "text": prompt, "text_elements": []}],
            },
        }));

        let deadline = Instant::now() + timeout;
        let mut capture = TurnCapture::default();
        let mut steer_sent = false;
        let mut turn_started = false;

        loop {
            let value = self.read_json(deadline);
            if let Some(id) = response_id(&value) {
                if id == request_id {
                    capture.turn_id = value
                        .pointer("/result/turn/id")
                        .and_then(Value::as_str)
                        .unwrap_or_else(|| panic!("turn/start did not return turn id: {value}"))
                        .to_string();
                } else if let Some(plan) = steer.as_mut()
                    && id == plan.request_id
                {
                    *plan.response_turn_id = value
                        .pointer("/result/turnId")
                        .and_then(Value::as_str)
                        .map(str::to_string);
                }
                continue;
            }

            if let Some(method) = value.get("method").and_then(Value::as_str) {
                assert_notification_thread_id(&value, thread_id);
                capture.consume_notification(method, &value);
                if method == "turn/started"
                    && capture.turn_id.is_empty()
                    && let Some(turn_id) = value.pointer("/params/turn/id").and_then(Value::as_str)
                {
                    capture.turn_id = turn_id.to_string();
                }
                if method == "turn/started" {
                    turn_started = true;
                }
                if let Some(plan) = steer.as_ref()
                    && !steer_sent
                    && turn_started
                    && !capture.turn_id.is_empty()
                {
                    self.send(json!({
                        "id": plan.request_id,
                        "method": "turn/steer",
                        "params": {
                            "threadId": thread_id,
                            "expectedTurnId": capture.turn_id,
                            "input": [{"type": "text", "text": plan.prompt, "text_elements": []}],
                        },
                    }));
                    steer_sent = true;
                }
                if method == "turn/completed" {
                    break;
                }
            }
        }

        capture
    }

    fn run_interrupted_turn(
        &mut self,
        thread_id: &str,
        request_id: i64,
        interrupt_request_id: i64,
        prompt: &str,
        timeout: Duration,
    ) -> TurnCapture {
        self.send(json!({
            "id": request_id,
            "method": "turn/start",
            "params": {
                "threadId": thread_id,
                "input": [{"type": "text", "text": prompt, "text_elements": []}],
            },
        }));

        let deadline = Instant::now() + timeout;
        let mut capture = TurnCapture::default();
        let mut interrupt_sent = false;
        let mut interrupt_acknowledged = false;

        loop {
            let value = self.read_json(deadline);
            if let Some(id) = response_id(&value) {
                if id == request_id {
                    capture.turn_id = value
                        .pointer("/result/turn/id")
                        .and_then(Value::as_str)
                        .unwrap_or_else(|| panic!("turn/start did not return turn id: {value}"))
                        .to_string();
                } else if id == interrupt_request_id {
                    interrupt_acknowledged = true;
                }
                continue;
            }

            if let Some(method) = value.get("method").and_then(Value::as_str) {
                assert_notification_thread_id(&value, thread_id);
                capture.consume_notification(method, &value);
                if method == "turn/started"
                    && capture.turn_id.is_empty()
                    && let Some(turn_id) = value.pointer("/params/turn/id").and_then(Value::as_str)
                {
                    capture.turn_id = turn_id.to_string();
                }
                if method == "turn/started" && !interrupt_sent {
                    self.send(json!({
                        "id": interrupt_request_id,
                        "method": "turn/interrupt",
                        "params": {
                            "threadId": thread_id,
                            "turnId": capture.turn_id,
                        },
                    }));
                    interrupt_sent = true;
                }
                if method == "turn/completed" {
                    assert!(
                        interrupt_acknowledged,
                        "turn completed before interrupt response"
                    );
                    break;
                }
            }
        }

        capture
    }

    fn run_turn_with_rejected_interrupts(
        &mut self,
        thread_id: &str,
        request_ids: RejectedInterruptRequestIds,
        prompt: &str,
        timeout: Duration,
    ) -> TurnCapture {
        self.send(json!({
            "id": request_ids.turn_start,
            "method": "turn/start",
            "params": {
                "threadId": thread_id,
                "input": [{"type": "text", "text": prompt, "text_elements": []}],
            },
        }));

        let deadline = Instant::now() + timeout;
        let mut capture = TurnCapture::default();
        let mut wrong_thread_interrupt_sent = false;
        let mut wrong_thread_interrupt_rejected = false;
        let mut wrong_turn_interrupt_sent = false;
        let mut wrong_turn_interrupt_rejected = false;
        let mut valid_interrupt_sent = false;
        let mut valid_interrupt_acknowledged = false;

        loop {
            let value = self.read_json_allowing_error(deadline);
            if let Some(id) = response_id(&value) {
                if id == request_ids.turn_start {
                    capture.turn_id = value
                        .pointer("/result/turn/id")
                        .and_then(Value::as_str)
                        .unwrap_or_else(|| panic!("turn/start did not return turn id: {value}"))
                        .to_string();
                } else if id == request_ids.wrong_thread_interrupt {
                    assert!(
                        value.get("error").is_some(),
                        "wrong-thread interrupt should be rejected: {value}"
                    );
                    wrong_thread_interrupt_rejected = true;
                    self.send(json!({
                        "id": request_ids.wrong_turn_interrupt,
                        "method": "turn/interrupt",
                        "params": {
                            "threadId": thread_id,
                            "turnId": "wrong-turn",
                        },
                    }));
                    wrong_turn_interrupt_sent = true;
                } else if id == request_ids.wrong_turn_interrupt {
                    assert!(
                        value.get("error").is_some(),
                        "wrong-turn interrupt should be rejected: {value}"
                    );
                    wrong_turn_interrupt_rejected = true;
                    self.send(json!({
                        "id": request_ids.valid_interrupt,
                        "method": "turn/interrupt",
                        "params": {
                            "threadId": thread_id,
                            "turnId": capture.turn_id,
                        },
                    }));
                    valid_interrupt_sent = true;
                } else if id == request_ids.valid_interrupt {
                    assert!(
                        value.get("error").is_none(),
                        "valid interrupt should be acknowledged: {value}"
                    );
                    valid_interrupt_acknowledged = true;
                }
                continue;
            }

            if let Some(method) = value.get("method").and_then(Value::as_str) {
                assert_notification_thread_id(&value, thread_id);
                capture.consume_notification(method, &value);
                if method == "turn/started"
                    && capture.turn_id.is_empty()
                    && let Some(turn_id) = value.pointer("/params/turn/id").and_then(Value::as_str)
                {
                    capture.turn_id = turn_id.to_string();
                }
                if method == "turn/started"
                    && !wrong_thread_interrupt_sent
                    && !capture.turn_id.is_empty()
                {
                    self.send(json!({
                        "id": request_ids.wrong_thread_interrupt,
                        "method": "turn/interrupt",
                        "params": {
                            "threadId": "wrong-thread",
                            "turnId": capture.turn_id,
                        },
                    }));
                    wrong_thread_interrupt_sent = true;
                }
                if method == "turn/completed" {
                    assert!(
                        wrong_thread_interrupt_rejected,
                        "turn completed before wrong-thread interrupt rejection"
                    );
                    assert!(
                        wrong_turn_interrupt_sent && wrong_turn_interrupt_rejected,
                        "turn completed before wrong-turn interrupt rejection"
                    );
                    assert!(valid_interrupt_sent, "valid interrupt was never sent");
                    assert!(
                        valid_interrupt_acknowledged,
                        "turn completed before valid interrupt response"
                    );
                    break;
                }
            }
        }

        capture
    }

    fn run_blocks_user_turn(&mut self, prompt: &str, timeout: Duration) -> TurnCapture {
        self.run_blocks_user_turn_with_model(prompt, None, timeout)
    }

    fn run_blocks_user_turn_with_model(
        &mut self,
        prompt: &str,
        model: Option<&str>,
        timeout: Duration,
    ) -> TurnCapture {
        let mut input = json!({
            "type": "user",
            "thread_key": "slack:C123:123.456",
            "trace_metadata": {
                "source": "slackbotv2",
                "action": "execute"
            },
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": prompt}],
            },
        });
        if let Some(model) = model {
            input["model"] = Value::String(model.to_string());
        }
        self.run_blocks_user_line(input, timeout)
    }

    /// Start a blocks-mode turn, then inject an `{"type":"interrupt"}` frame once
    /// the turn is running (right after `turn/started`), and capture the terminal
    /// turn. Proves the harness-server reads a mid-turn interrupt off stdin and
    /// forwards it to the harness so the turn aborts (rather than being ignored).
    fn run_blocks_user_turn_interrupting(
        &mut self,
        prompt: &str,
        timeout: Duration,
    ) -> TurnCapture {
        let input = json!({
            "type": "user",
            "thread_key": "slack:C123:123.456",
            "trace_metadata": {"source": "slackbotv2", "action": "execute"},
            "message": {"role": "user", "content": [{"type": "text", "text": prompt}]},
        });
        self.send(input);

        let deadline = Instant::now() + timeout;
        let mut capture = TurnCapture::default();
        let mut interrupt_sent = false;

        loop {
            let value = self.read_json(deadline);
            assert!(
                response_id(&value).is_none(),
                "blocks mode emitted JSON-RPC response: {value}"
            );
            if let Some(method) = value.get("method").and_then(Value::as_str) {
                capture.consume_notification(method, &value);
                if method == "turn/started" {
                    if capture.turn_id.is_empty()
                        && let Some(turn_id) =
                            value.pointer("/params/turn/id").and_then(Value::as_str)
                    {
                        capture.turn_id = turn_id.to_string();
                    }
                    if !interrupt_sent {
                        self.send(json!({"type": "interrupt"}));
                        interrupt_sent = true;
                    }
                }
                if method == "turn/completed" {
                    break;
                }
            }
        }

        capture
    }

    fn run_blocks_user_line(&mut self, user_line: Value, timeout: Duration) -> TurnCapture {
        self.send(user_line);

        let deadline = Instant::now() + timeout;
        let mut capture = TurnCapture::default();

        loop {
            let value = self.read_json(deadline);
            assert!(
                response_id(&value).is_none(),
                "blocks mode emitted JSON-RPC response: {value}"
            );
            if let Some(method) = value.get("method").and_then(Value::as_str) {
                capture.consume_notification(method, &value);
                if method == "turn/started"
                    && capture.turn_id.is_empty()
                    && let Some(turn_id) = value.pointer("/params/turn/id").and_then(Value::as_str)
                {
                    capture.turn_id = turn_id.to_string();
                }
                if method == "turn/completed" {
                    break;
                }
            }
        }

        capture
    }

    fn send(&mut self, value: Value) {
        eprintln!("stdin JSON: {value}");
        let stdin = self.stdin.as_mut().expect("stdin still open");
        serde_json::to_writer(&mut *stdin, &value).expect("write JSON");
        stdin.write_all(b"\n").expect("write newline");
        stdin.flush().expect("flush");
    }

    fn read_json(&mut self, deadline: Instant) -> Value {
        self.read_value(deadline, true)
    }

    fn read_json_allowing_error(&mut self, deadline: Instant) -> Value {
        self.read_value(deadline, false)
    }

    fn read_any_json(&mut self, deadline: Instant) -> Value {
        self.read_value(deadline, false)
    }

    fn read_value(&mut self, deadline: Instant, validate_jsonrpc: bool) -> Value {
        loop {
            let now = Instant::now();
            assert!(now < deadline, "timed out waiting for app-server stdout");
            let wait_for = deadline
                .saturating_duration_since(now)
                .min(Duration::from_secs(1));
            match self.line_rx.recv_timeout(wait_for) {
                Ok(Ok(line)) => {
                    eprintln!("stdout JSON: {line}");
                    self.stdout_lines.push(line.clone());
                    let value: Value =
                        serde_json::from_str(line.trim()).expect("valid JSON stdout line");
                    if validate_jsonrpc {
                        validate_jsonrpc_value(&value);
                    }
                    return value;
                }
                Ok(Err(error)) => panic!("read app-server stdout: {error}"),
                Err(RecvTimeoutError::Timeout) => continue,
                Err(RecvTimeoutError::Disconnected) => {
                    panic!("app-server stdout disconnected before expected response")
                }
            }
        }
    }

    fn finish_successfully(mut self) -> Vec<String> {
        let _ = self.stdin.take();
        let status = self.child.wait().expect("wait app-server process");
        self.stdout_reader.join().expect("join stdout reader");
        let stderr = self.stderr_reader.join().expect("join stderr reader");
        assert!(
            status.success(),
            "app-server exited with {status}; stderr={stderr}; stdout={:?}",
            self.stdout_lines
        );
        if !stderr.trim().is_empty() {
            eprintln!("stderr:\n{stderr}");
        }
        self.stdout_lines
    }
}

impl TurnCapture {
    fn consume_notification(&mut self, method: &str, value: &Value) {
        self.methods.push(method.to_string());
        match method {
            "item/agentMessage/delta" => {
                let params = value.get("params").expect("delta params");
                let item_id = params
                    .get("itemId")
                    .and_then(Value::as_str)
                    .expect("delta itemId");
                let delta = params
                    .get("delta")
                    .and_then(Value::as_str)
                    .expect("delta text");
                self.agent_delta_count += 1;
                self.text_from_deltas.push_str(delta);
                self.delta_text_by_item
                    .entry(item_id.to_string())
                    .and_modify(|text| text.push_str(delta))
                    .or_insert_with(|| delta.to_string());
            }
            method if method.starts_with("item/reasoning/") => {
                self.reasoning_delta_count += 1;
            }
            "item/completed" => {
                let item = value
                    .get("params")
                    .and_then(|params| params.get("item"))
                    .expect("completed item");
                if item.get("type").and_then(Value::as_str) == Some("agentMessage") {
                    let item_id = item
                        .get("id")
                        .and_then(Value::as_str)
                        .expect("agent item id");
                    let text = item
                        .get("text")
                        .and_then(Value::as_str)
                        .expect("agent item text");
                    self.completed_agent_items
                        .insert(item_id.to_string(), text.to_string());
                }
            }
            "turn/completed" => {
                self.terminal_status = value
                    .pointer("/params/turn/status")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                self.terminal_error = value
                    .pointer("/params/turn/error/message")
                    .and_then(Value::as_str)
                    .map(str::to_string);
            }
            _ => {}
        }
    }
}

#[derive(Debug)]
struct NativeRun {
    stdout_lines: Vec<String>,
    stderr: String,
    stream_text_delta_count: usize,
    text_from_stream_deltas: String,
    final_assistant_text: String,
    assistant_event_count: usize,
}

impl NativeRun {
    fn final_text(&self) -> &str {
        if self.text_from_stream_deltas.is_empty() {
            &self.final_assistant_text
        } else {
            &self.text_from_stream_deltas
        }
    }
}

fn run_native_anthropic(harness: Harness, prompt: &str, timeout: Duration) -> NativeRun {
    let mut command = match harness {
        Harness::ClaudeCode => {
            let bin = std::env::var("CLAUDE_BIN").unwrap_or_else(|_| "claude".to_string());
            let mut command = Command::new(bin);
            let model =
                std::env::var("CENTAUR_REAL_CLAUDE_MODEL").unwrap_or_else(|_| "sonnet".to_string());
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
                "--model",
                &model,
                "--session-id",
                &Uuid::new_v4().to_string(),
            ]);
            command
        }
        Harness::Amp => {
            let bin = std::env::var("AMP_BIN").unwrap_or_else(|_| "amp".to_string());
            let mut command = Command::new(bin);
            let mode = std::env::var("AMP_MODE").unwrap_or_else(|_| "deep".to_string());
            command.args([
                "--no-ide",
                "--no-notifications",
                "--no-color",
                "--dangerously-allow-all",
                "--execute",
                "--stream-json",
                "--stream-json-input",
                "--stream-json-thinking",
                "--mode",
                &mode,
            ]);
            command
        }
        Harness::Codex => panic!("native anthropic runner does not support Codex"),
    };
    command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut process = RawProcess::spawn(command);
    process.send(json!({
        "type": "user",
        "message": {
            "role": "user",
            "content": [{"type": "text", "text": prompt}],
        },
    }));
    let output = process.collect_until_exit(timeout);
    assert!(
        output.status.success(),
        "native {} failed with {}; stderr={}; stdout={:?}",
        harness.name(),
        output.status,
        output.stderr,
        output.stdout_lines
    );

    let mut run = NativeRun {
        stdout_lines: output.stdout_lines,
        stderr: output.stderr,
        stream_text_delta_count: 0,
        text_from_stream_deltas: String::new(),
        final_assistant_text: String::new(),
        assistant_event_count: 0,
    };
    for line in &run.stdout_lines {
        eprintln!("native {} stdout JSON: {line}", harness.name());
        let value: Value = serde_json::from_str(line).expect("native JSON stdout");
        match value.get("type").and_then(Value::as_str) {
            Some("stream_event") => {
                let event = value.get("event").unwrap_or(&Value::Null);
                if event.get("type").and_then(Value::as_str) == Some("content_block_delta") {
                    let delta = event.get("delta").unwrap_or(&Value::Null);
                    if delta.get("type").and_then(Value::as_str) == Some("text_delta")
                        && let Some(text) = delta.get("text").and_then(Value::as_str)
                    {
                        run.stream_text_delta_count += 1;
                        run.text_from_stream_deltas.push_str(text);
                    }
                }
            }
            Some("assistant") => {
                run.assistant_event_count += 1;
                if value
                    .get("is_partial")
                    .and_then(Value::as_bool)
                    .is_some_and(|partial| !partial)
                    || value.get("is_partial").is_none()
                {
                    run.final_assistant_text = assistant_text_from_message(&value["message"]);
                }
            }
            _ => {}
        }
    }
    if !run.stderr.trim().is_empty() {
        eprintln!("native {} stderr:\n{}", harness.name(), run.stderr);
    }
    run
}

struct RawProcess {
    child: Child,
    stdin: Option<ChildStdin>,
    line_rx: Receiver<std::io::Result<String>>,
    stdout_reader: JoinHandle<()>,
    stderr_reader: JoinHandle<String>,
}

struct RawOutput {
    status: ExitStatus,
    stdout_lines: Vec<String>,
    stderr: String,
}

impl RawProcess {
    fn spawn(mut command: Command) -> Self {
        let mut child = command.spawn().expect("spawn native process");
        let stdin = child.stdin.take().expect("native stdin");
        let stdout = child.stdout.take().expect("native stdout");
        let stderr = child.stderr.take().expect("native stderr");
        let (line_tx, line_rx) = mpsc::channel();
        let stdout_reader = thread::spawn(move || {
            for raw in BufReader::new(stdout).lines() {
                let should_stop = raw.is_err();
                if line_tx.send(raw).is_err() || should_stop {
                    break;
                }
            }
        });
        let stderr_reader = thread::spawn(move || {
            let mut buf = String::new();
            let _ = BufReader::new(stderr).read_to_string(&mut buf);
            buf
        });
        Self {
            child,
            stdin: Some(stdin),
            line_rx,
            stdout_reader,
            stderr_reader,
        }
    }

    fn send(&mut self, value: Value) {
        let stdin = self.stdin.as_mut().expect("native stdin still open");
        serde_json::to_writer(&mut *stdin, &value).expect("write native stdin JSON");
        stdin.write_all(b"\n").expect("write native stdin newline");
        stdin.flush().expect("flush native stdin");
    }

    fn collect_until_exit(mut self, timeout: Duration) -> RawOutput {
        let _ = self.stdin.take();
        let deadline = Instant::now() + timeout;
        let mut stdout_lines = Vec::new();
        let status = loop {
            while let Ok(line) = self.line_rx.try_recv() {
                stdout_lines.push(line.expect("native stdout line"));
            }
            if let Some(status) = self.child.try_wait().expect("poll native process") {
                break status;
            }
            if Instant::now() >= deadline {
                let _ = self.child.kill();
                let status = self.child.wait().expect("wait killed native process");
                panic!(
                    "native process timed out after {timeout:?}; status={status}; stdout={stdout_lines:?}"
                );
            }
            match self.line_rx.recv_timeout(Duration::from_millis(100)) {
                Ok(line) => stdout_lines.push(line.expect("native stdout line")),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {}
            }
        };
        self.stdout_reader
            .join()
            .expect("join native stdout reader");
        while let Ok(line) = self.line_rx.try_recv() {
            stdout_lines.push(line.expect("native stdout line"));
        }
        let stderr = self
            .stderr_reader
            .join()
            .expect("join native stderr reader");
        RawOutput {
            status,
            stdout_lines,
            stderr,
        }
    }
}

fn validate_jsonrpc_value(value: &Value) {
    let message: JSONRPCMessage =
        serde_json::from_value(value.clone()).expect("valid JSON-RPC message");
    match message {
        JSONRPCMessage::Notification(notification) => {
            let method = notification.method.clone();
            if !is_known_untyped_server_notification(&method) {
                ServerNotification::try_from(notification).unwrap_or_else(|error| {
                    panic!(
                        "notification is not a typed Codex App Server V2 notification: {error}; value={value}"
                    )
                });
            }
        }
        JSONRPCMessage::Response(_) => {}
        JSONRPCMessage::Error(error) => panic!("app-server returned JSON-RPC error: {error:?}"),
        JSONRPCMessage::Request(request) => {
            panic!("app-server emitted unexpected request: {request:?}")
        }
    }
}

fn response_id(value: &Value) -> Option<i64> {
    value.get("id").and_then(Value::as_i64)
}

fn assert_notification_thread_id(value: &Value, expected_thread_id: &str) {
    if let Some(actual) = value.pointer("/params/threadId").and_then(Value::as_str) {
        assert_eq!(actual, expected_thread_id, "notification threadId mismatch");
    }
    if value.get("method").and_then(Value::as_str) == Some("thread/started")
        && let Some(actual) = value.pointer("/params/thread/id").and_then(Value::as_str)
    {
        assert_eq!(
            actual, expected_thread_id,
            "thread/started thread.id mismatch"
        );
    }
}

fn assert_codex_v2_turn(turn: &TurnCapture) {
    assert!(
        turn.methods
            .contains(&"item/agentMessage/delta".to_string()),
        "missing text delta; got {:?}",
        turn.methods
    );
    assert!(
        turn.methods.contains(&"item/completed".to_string()),
        "missing item/completed; got {:?}",
        turn.methods
    );
    assert!(
        turn.methods.contains(&"turn/completed".to_string()),
        "missing turn/completed; got {:?}",
        turn.methods
    );
    assert_delta_reconstruction(turn);
}

fn assert_completed_turn(turn: &TurnCapture) {
    assert_eq!(
        turn.terminal_status.as_deref(),
        Some("completed"),
        "terminal error: {:?}; methods={:?}",
        turn.terminal_error,
        turn.methods
    );
}

fn assert_delta_reconstruction(turn: &TurnCapture) {
    assert!(
        !turn.delta_text_by_item.is_empty(),
        "turn emitted no agent text deltas; methods={:?}",
        turn.methods
    );
    for (item_id, delta_text) in &turn.delta_text_by_item {
        let completed = turn
            .completed_agent_items
            .get(item_id)
            .unwrap_or_else(|| panic!("agent item {item_id} emitted deltas but never completed"));
        assert_eq!(
            completed, delta_text,
            "agent item {item_id} completed text does not equal concatenated deltas"
        );
    }
}

fn assistant_text_from_message(message: &Value) -> String {
    message
        .get("content")
        .and_then(Value::as_array)
        .map(|blocks| {
            blocks
                .iter()
                .filter(|block| block.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|block| block.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
}

fn expected_long_text() -> String {
    (1..=24)
        .map(|line| {
            format!("LONG_STREAM_DELTA_LINE_{line:02}: abcdefghijklmnopqrstuvwxyz 0123456789")
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn require_command(bin: &str, args: &[&str]) {
    let output = Command::new(bin)
        .args(args)
        .output()
        .unwrap_or_else(|error| panic!("{bin} must be installed and on PATH: {error}"));
    assert!(
        output.status.success(),
        "{bin} version check failed: status={}; stderr={}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );
}

fn codex_bin() -> String {
    if let Ok(bin) = std::env::var("CODEX_BIN") {
        return bin;
    }
    for bin in ["codex", "/Applications/Codex.app/Contents/Resources/codex"] {
        let Ok(output) = Command::new(bin).args(["app-server", "--help"]).output() else {
            continue;
        };
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        if output.status.success() && (stdout.contains("--listen") || stderr.contains("--listen")) {
            return bin.to_string();
        }
    }
    "codex".to_string()
}

fn fake_codex_app_server_script(log_path: &Path) -> String {
    let mut script = String::new();
    script.push_str("#!/bin/sh\n");
    script.push_str("log=");
    script.push_str(&shell_quote(log_path));
    script.push_str(
        r#"
touch "$log"
if [ "${1:-}" = "app-server" ] && [ "${2:-}" = "--help" ]; then
  printf '%s\n' '--listen stdio://'
  exit 0
fi
if [ "${1:-}" != "app-server" ]; then
  printf '%s\n' 'expected app-server command' >&2
  exit 64
fi

request_id() {
  printf '%s' "$1" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p'
}

while IFS= read -r line; do
  printf '%s\n' "$line" >> "$log"
  case "$line" in
    *'"method":"initialize"'*)
      id=$(request_id "$line")
      printf '{"id":%s,"result":{"userAgent":"fake-codex"}}\n' "$id"
      ;;
    *'"method":"thread/start"'*)
      id=$(request_id "$line")
      printf '{"id":%s,"result":{"thread":{"id":"thread-1"}}}\n' "$id"
      ;;
    *'"method":"thread/resume"'*)
      id=$(request_id "$line")
      printf '{"id":%s,"result":{"thread":{"id":"thread-1"}}}\n' "$id"
      ;;
    *'"method":"turn/start"'*)
      id=$(request_id "$line")
      printf '{"id":%s,"result":{"turn":{"id":"turn-1"}}}\n' "$id"
      printf '%s\n' '{"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1","items":[],"itemsView":"full","status":"inProgress","error":null,"startedAt":1,"completedAt":null,"durationMs":null}}}'
      printf '%s\n' '{"method":"item/agentMessage/delta","params":{"threadId":"thread-1","turnId":"turn-1","itemId":"answer-1","delta":"codex blocks"}}'
      printf '%s\n' '{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","item":{"type":"agentMessage","id":"answer-1","text":"codex blocks","phase":null,"memoryCitation":null},"completedAtMs":2}}'
      printf '%s\n' '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","items":[{"type":"agentMessage","id":"answer-1","text":"codex blocks","phase":null,"memoryCitation":null}],"itemsView":"full","status":"completed","error":null,"startedAt":1,"completedAt":2,"durationMs":1}}}'
      ;;
    *)
      printf '%s\n' "unexpected request: $line" >&2
      exit 65
      ;;
  esac
done
"#,
    );
    script
}

fn fake_codex_missing_rollout_script(log_path: &Path) -> String {
    let log_path = serde_json::to_string(&log_path.to_string_lossy()).expect("serialize log path");
    format!(
        r#"#!/usr/bin/env python3
import json
import pathlib
import sys

log_path = pathlib.Path({log_path})
log_path.touch()

def emit(response):
    encoded = json.dumps(response, separators=(",", ":"))
    print(encoded, flush=True)

for raw in sys.stdin:
    raw = raw.strip()
    if not raw:
        continue
    with log_path.open("a") as log:
        log.write(raw + "\n")
    request = json.loads(raw)
    request_id = request.get("id")
    method = request.get("method")
    if method == "initialize":
        response = {{"id": request_id, "result": {{"userAgent": "fake-codex"}}}}
    elif method == "thread/resume":
        thread_id = request["params"]["threadId"]
        if thread_id == "stale-thread":
            response = {{
                "id": request_id,
                "error": {{"code": -32600, "message": "no rollout found for thread id stale-thread"}},
            }}
        else:
            response = {{"id": request_id, "result": {{"thread": {{"id": thread_id}}}}}}
    elif method == "thread/start":
        response = {{"id": request_id, "result": {{"thread": {{"id": "thread-1"}}}}}}
    elif method == "turn/start":
        turn_count = log_path.read_text().count('"method":"turn/start"')
        if turn_count == 1:
            response = {{
                "id": request_id,
                "error": {{"code": -32000, "message": "forced first turn failure"}},
            }}
            emit(response)
            continue
        response = {{"id": request_id, "result": {{"turn": {{"id": "turn-1"}}}}}}
        emit(response)
        notifications = [
            {{"method":"turn/started","params":{{"threadId":"thread-1","turn":{{"id":"turn-1","items":[],"itemsView":"full","status":"inProgress","error":None,"startedAt":1,"completedAt":None,"durationMs":None}}}}}},
            {{"method":"item/agentMessage/delta","params":{{"threadId":"thread-1","turnId":"turn-1","itemId":"answer-1","delta":"codex blocks"}}}},
            {{"method":"item/completed","params":{{"threadId":"thread-1","turnId":"turn-1","item":{{"type":"agentMessage","id":"answer-1","text":"codex blocks","phase":None,"memoryCitation":None}},"completedAtMs":2}}}},
            {{"method":"turn/completed","params":{{"threadId":"thread-1","turn":{{"id":"turn-1","items":[{{"type":"agentMessage","id":"answer-1","text":"codex blocks","phase":None,"memoryCitation":None}}],"itemsView":"full","status":"completed","error":None,"startedAt":1,"completedAt":2,"durationMs":1}}}}}},
        ]
        for notification in notifications:
            emit(notification)
        continue
    else:
        raise SystemExit(f"unexpected method: {{method}}")
    emit(response)
"#
    )
}

/// A fake codex app-server that STARTS a turn and holds it open (no
/// `turn/completed`), then — when it receives a `turn/interrupt` request
/// (forwarded by the harness-server from a blocks `{"type":"interrupt"}`) —
/// completes the turn with status `interrupted`. Lets a test prove interrupt
/// delivery aborts a running turn without any cluster.
fn fake_codex_interrupt_app_server_script(log_path: &Path) -> String {
    let mut script = String::new();
    script.push_str("#!/bin/sh\n");
    script.push_str("log=");
    script.push_str(&shell_quote(log_path));
    script.push_str(
        r#"
touch "$log"
if [ "${1:-}" = "app-server" ] && [ "${2:-}" = "--help" ]; then
  printf '%s\n' '--listen stdio://'
  exit 0
fi
if [ "${1:-}" != "app-server" ]; then
  printf '%s\n' 'expected app-server command' >&2
  exit 64
fi

request_id() {
  printf '%s' "$1" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p'
}

while IFS= read -r line; do
  printf '%s\n' "$line" >> "$log"
  case "$line" in
    *'"method":"initialize"'*)
      id=$(request_id "$line")
      printf '{"id":%s,"result":{"userAgent":"fake-codex"}}\n' "$id"
      ;;
    *'"method":"thread/start"'*)
      id=$(request_id "$line")
      printf '{"id":%s,"result":{"thread":{"id":"thread-1"}}}\n' "$id"
      ;;
    *'"method":"turn/start"'*)
      id=$(request_id "$line")
      printf '{"id":%s,"result":{"turn":{"id":"turn-1"}}}\n' "$id"
      printf '%s\n' '{"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1","items":[],"itemsView":"full","status":"inProgress","error":null,"startedAt":1,"completedAt":null,"durationMs":null}}}'
      printf '%s\n' '{"method":"item/agentMessage/delta","params":{"threadId":"thread-1","turnId":"turn-1","itemId":"answer-1","delta":"working"}}'
      # hold the turn open — wait for turn/interrupt below
      ;;
    *'"method":"turn/interrupt"'*)
      id=$(request_id "$line")
      if [ -n "$id" ]; then printf '{"id":%s,"result":{}}\n' "$id"; fi
      printf '%s\n' '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","items":[{"type":"agentMessage","id":"answer-1","text":"working","phase":null,"memoryCitation":null}],"itemsView":"full","status":"interrupted","error":null,"startedAt":1,"completedAt":2,"durationMs":1}}}'
      ;;
    *)
      printf '%s\n' "unexpected request: $line" >&2
      exit 65
      ;;
  esac
done
"#,
    );
    script
}

fn fake_codex_hitl_app_server_script(log_path: &Path) -> String {
    let mut script = String::new();
    script.push_str("#!/bin/sh\n");
    script.push_str("log=");
    script.push_str(&shell_quote(log_path));
    script.push_str(
        r#"
touch "$log"
if [ "${1:-}" = "app-server" ] && [ "${2:-}" = "--help" ]; then
  printf '%s\n' '--listen stdio://'
  exit 0
fi
if [ "${1:-}" != "app-server" ]; then
  printf '%s\n' 'expected app-server command' >&2
  exit 64
fi

request_id() {
  printf '%s' "$1" | sed -n 's/.*"id":\([0-9][0-9]*\).*/\1/p'
}

while IFS= read -r line; do
  printf '%s\n' "$line" >> "$log"
  case "$line" in
    *'"method":"initialize"'*)
      id=$(request_id "$line")
      printf '{"id":%s,"result":{"userAgent":"fake-codex"}}\n' "$id"
      ;;
    *'"method":"thread/start"'*)
      id=$(request_id "$line")
      printf '{"id":%s,"result":{"thread":{"id":"thread-1"}}}\n' "$id"
      ;;
    *'"method":"turn/start"'*)
      id=$(request_id "$line")
      printf '{"id":%s,"result":{"turn":{"id":"turn-1"}}}\n' "$id"
      printf '%s\n' '{"method":"turn/started","params":{"threadId":"thread-1","turn":{"id":"turn-1","items":[],"itemsView":"full","status":"inProgress","error":null,"startedAt":1,"completedAt":null,"durationMs":null}}}'
      printf '%s\n' '{"id":"ask-1","method":"item/tool/requestUserInput","params":{"threadId":"thread-1","turnId":"turn-1","itemId":"q-1","questions":[{"id":"choice","label":"Pick one","kind":"choice","choices":["A","B"]}]}}'
      if ! IFS= read -r answer_line; then
        printf '%s\n' 'expected requestUserInput response' >&2
        exit 66
      fi
      printf '%s\n' "$answer_line" >> "$log"
      printf '%s\n' '{"method":"item/agentMessage/delta","params":{"threadId":"thread-1","turnId":"turn-1","itemId":"answer-1","delta":"answered"}}'
      printf '%s\n' '{"method":"item/completed","params":{"threadId":"thread-1","turnId":"turn-1","item":{"type":"agentMessage","id":"answer-1","text":"answered","phase":null,"memoryCitation":null},"completedAtMs":2}}'
      printf '%s\n' '{"method":"turn/completed","params":{"threadId":"thread-1","turn":{"id":"turn-1","items":[{"type":"agentMessage","id":"answer-1","text":"answered","phase":null,"memoryCitation":null}],"itemsView":"full","status":"completed","error":null,"startedAt":1,"completedAt":2,"durationMs":1}}}'
      ;;
    *)
      printf '%s\n' "unexpected request: $line" >&2
      exit 65
      ;;
  esac
done
"#,
    );
    script
}

fn fake_claude_hitl_bridge_script(log_path: &Path) -> String {
    let mut script = String::new();
    script.push_str("#!/bin/sh\n");
    script.push_str("log=");
    script.push_str(&shell_quote(log_path));
    script.push_str(
        r#"
touch "$log"
if ! IFS= read -r user_line; then
  printf '%s\n' 'expected user input' >&2
  exit 66
fi
printf '%s\n' "$user_line" >> "$log"
printf '%s\n' '{"type":"system","subtype":"init","session_id":"claude-session"}'
printf '%s\n' '{"type":"question_requested","question_id":"toolu_ask","turn_id":"turn-1","questions":[{"id":"question-1","header":"Sections","question":"Which sections should be visible?","multiSelect":true,"options":[{"label":"Summary","description":"Show a brief overview.","preview":"ASCII SUMMARY","previewFormat":"markdown"},{"label":"Timeline","description":"Show recent activity.","preview":"<div>Timeline</div>","previewFormat":"html"}]}]}'
if ! IFS= read -r answer_line; then
  printf '%s\n' 'expected question_answer input' >&2
  exit 67
fi
printf '%s\n' "$answer_line" >> "$log"
printf '%s\n' '{"type":"assistant","is_partial":true,"message":{"id":"msg_1","content":[{"type":"text","text":"answered"}]}}'
printf '%s\n' '{"type":"assistant","is_partial":false,"message":{"id":"msg_1","content":[{"type":"text","text":"answered"}]}}'
printf '%s\n' '{"type":"result","subtype":"success","result":"answered"}'
"#,
    );
    script
}

fn fake_claude_agent_sdk_module_script() -> &'static str {
    r#"
export function query({ prompt, options }) {
  return {
    async *[Symbol.asyncIterator]() {
      let sawUser = false;
      for await (const message of prompt) {
        if (message.type === "user" && message.message?.role === "user") {
          sawUser = true;
        }
      }
      if (!sawUser) {
        throw new Error("prompt did not include a user message");
      }
      if (options.model !== "fake-model") {
        throw new Error(`expected fake-model, got ${options.model}`);
      }
      if (!options.sessionId) {
        throw new Error("expected sessionId on first query");
      }
      if (options.permissionMode !== "bypassPermissions" || !options.allowDangerouslySkipPermissions) {
        throw new Error("expected bypass permission options");
      }
      if (options.toolConfig?.askUserQuestion?.previewFormat !== "html") {
        throw new Error("expected HTML preview format");
      }

      yield { type: "system", subtype: "init", session_id: "sdk-session" };
      const permission = await options.canUseTool(
        "AskUserQuestion",
        {
          questions: [
            {
              question: "Which sections should be visible?",
              header: "Sections",
              multiSelect: true,
              options: [
                { label: "Summary", description: "Show a brief overview.", preview: "<div>Summary</div>" },
                { label: "Timeline", description: "Show recent activity.", preview: "<div>Timeline</div>" }
              ]
            }
          ]
        },
        { toolUseID: "toolu_sdk", signal: new AbortController().signal }
      );

      yield {
        type: "assistant",
        session_id: "sdk-session",
        message: {
          id: "msg_sdk",
          stop_reason: "end_turn",
          content: [
            { type: "text", text: permission.updatedInput.answers["Which sections should be visible?"] }
          ]
        }
      };
      yield {
        type: "result",
        subtype: "success",
        result: "done",
        is_error: false,
        session_id: "sdk-session"
      };
    }
  };
}
"#
}

fn temp_path(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "harness-server-{name}-{}-{}",
        std::process::id(),
        Uuid::new_v4().simple()
    ))
}

fn shell_quote(path: &Path) -> String {
    let raw = path.to_string_lossy();
    shell_quote_str(&raw)
}

fn shell_quote_str(raw: &str) -> String {
    format!("'{}'", raw.replace('\'', "'\\''"))
}
