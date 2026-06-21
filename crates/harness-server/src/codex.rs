use std::env;
use std::io::{self, BufRead, Write};
use std::process::{Child, ChildStdin, Command as ProcessCommand, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::Duration;

use codex_app_server_protocol::UserInput;
use serde_json::{Value, json};

use crate::server::{BlocksCommand, BlocksState, parse_blocks_line_with_state, write_blocks_error};
use crate::util::write_value;
use crate::{AppServerRuntime, HarnessServerError, Result};

const ACTIVE_TURN_POLL_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, Copy)]
pub struct CodexHarnessServer {
    fallback_model_provider: &'static str,
}

impl CodexHarnessServer {
    pub fn codex() -> Self {
        Self {
            fallback_model_provider: "openai",
        }
    }

    fn default_model(&self) -> Option<String> {
        env::var("CODEX_MODEL")
            .ok()
            .or_else(|| env::var("OPENROUTER_MODEL").ok())
            .map(|model| model.trim().to_owned())
            .filter(|model| !model.is_empty())
    }

    fn model_provider_for(&self, provider_override: Option<&str>, model: Option<&str>) -> String {
        provider_override
            .map(str::trim)
            .filter(|provider| !provider.is_empty())
            .map(str::to_owned)
            .or_else(|| {
                env::var("CODEX_MODEL_PROVIDER")
                    .ok()
                    .map(|provider| provider.trim().to_owned())
                    .filter(|provider| !provider.is_empty())
            })
            .or_else(|| {
                model
                    .map(str::trim)
                    .filter(|model| !model.is_empty())
                    .filter(|model| model.contains('/'))
                    .map(|_| "openrouter".to_string())
            })
            .or_else(|| {
                env::var("OPENROUTER_MODEL")
                    .ok()
                    .map(|model| model.trim().to_owned())
                    .filter(|model| !model.is_empty())
                    .map(|_| "openrouter".to_string())
            })
            .unwrap_or_else(|| self.fallback_model_provider.to_string())
    }
}

impl AppServerRuntime for CodexHarnessServer {
    fn run_stdio(&self) -> Result<()> {
        let bin = codex_bin();
        let mut child = ProcessCommand::new(&bin)
            .args(["app-server", "--listen", "stdio://"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|source| HarnessServerError::SpawnCodex {
                bin: bin.clone(),
                source,
            })?;

        let mut child_stdin = child
            .stdin
            .take()
            .ok_or(HarnessServerError::CodexStdinUnavailable)?;
        let _stdin_thread = thread::spawn(move || {
            let mut stdin = io::stdin().lock();
            io::copy(&mut stdin, &mut child_stdin)
        });

        let mut child_stderr = child
            .stderr
            .take()
            .ok_or(HarnessServerError::CodexStderrUnavailable)?;
        let stderr_thread = thread::spawn(move || {
            let mut stderr = io::stderr().lock();
            io::copy(&mut child_stderr, &mut stderr)
        });

        let mut child_stdout = child
            .stdout
            .take()
            .ok_or(HarnessServerError::CodexStdoutUnavailable)?;
        {
            let mut stdout = io::stdout().lock();
            io::copy(&mut child_stdout, &mut stdout)?;
            stdout.flush()?;
        }

        let status = child.wait()?;
        let _ = stderr_thread.join();
        if !status.success() {
            return Err(HarnessServerError::CodexExited { status });
        }
        Ok(())
    }
}

pub(crate) fn run_codex_blocks_server(config: CodexHarnessServer) -> Result<()> {
    let mut codex = CodexJsonRpcChild::spawn()?;
    let mut stdout = io::stdout().lock();
    let mut request_id = 1_i64;
    let mut thread_id: Option<String> = None;
    // The provider the thread was started/resumed on. codex pins the provider at
    // thread start (the app-server protocol has no per-turn provider), so this
    // lets a later conflicting override be surfaced rather than silently dropped.
    let mut thread_provider: Option<String> = None;
    let mut blocks_state = BlocksState::default();

    let initialize_id = next_request_id(&mut request_id);
    codex.send_request(
        initialize_id,
        "initialize",
        json!({
            "clientInfo": {
                "name": "centaur-harness-server",
                "title": null,
                "version": env!("CARGO_PKG_VERSION"),
            },
            "capabilities": null,
        }),
    )?;
    codex.read_response_or_forward(initialize_id, &mut stdout)?;

    let input_rx = spawn_stdin_reader();
    while let Ok(raw) = input_rx.recv() {
        let line = raw?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }

        match parse_blocks_line_with_state(trimmed, &mut blocks_state) {
            Ok(BlocksCommand::User {
                input,
                client_user_message_id,
                model,
                provider,
                reasoning,
            }) => {
                let model = model.or_else(|| config.default_model());
                let turn = CodexTurnInput {
                    input,
                    client_user_message_id,
                    model_provider: config
                        .model_provider_for(provider.as_deref(), model.as_deref()),
                    requested_provider: provider,
                    model,
                    reasoning,
                };
                let mut turn_ctx = CodexBlocksTurn {
                    codex: &mut codex,
                    stdout: &mut stdout,
                    request_id: &mut request_id,
                    thread_id: &mut thread_id,
                    thread_provider: &mut thread_provider,
                    input_rx: &input_rx,
                    blocks_state: &mut blocks_state,
                };
                if let Err(error) = run_codex_user_turn(&mut turn_ctx, turn) {
                    let fallback_thread_id =
                        turn_ctx.thread_id.as_deref().unwrap_or("codex").to_string();
                    eprintln!("Codex blocks turn failed: {error:#}");
                    write_blocks_error(
                        turn_ctx.stdout,
                        &fallback_thread_id,
                        "turn",
                        error.to_string(),
                    )?;
                }
            }
            Ok(BlocksCommand::Interrupt) => {
                eprintln!(
                    "Codex blocks interrupt ignored: no active stdin reader while a turn runs"
                );
            }
            Ok(BlocksCommand::QuestionAnswer { question_id, .. }) => {
                eprintln!("question_answer ignored: no pending question {question_id}");
            }
            Ok(BlocksCommand::AttachmentChunk) => {}
            Err(error) => {
                eprintln!("invalid Codex blocks input: {error:#}");
                write_blocks_error(
                    &mut stdout,
                    thread_id.as_deref().unwrap_or("codex"),
                    "input",
                    error.to_string(),
                )?;
            }
        }
    }

    Ok(())
}

fn spawn_stdin_reader() -> Receiver<io::Result<String>> {
    let (input_tx, input_rx) = mpsc::channel();
    thread::spawn(move || {
        let stdin = io::stdin();
        for raw in stdin.lock().lines() {
            let should_stop = raw.is_err();
            if input_tx.send(raw).is_err() || should_stop {
                break;
            }
        }
    });
    input_rx
}

struct CodexBlocksTurn<'a, W: Write> {
    codex: &'a mut CodexJsonRpcChild,
    stdout: &'a mut W,
    request_id: &'a mut i64,
    thread_id: &'a mut Option<String>,
    thread_provider: &'a mut Option<String>,
    input_rx: &'a Receiver<io::Result<String>>,
    blocks_state: &'a mut BlocksState,
}

struct CodexTurnInput {
    input: Vec<UserInput>,
    client_user_message_id: Option<String>,
    model: Option<String>,
    model_provider: String,
    requested_provider: Option<String>,
    reasoning: Option<String>,
}

fn run_codex_user_turn<W: Write>(
    ctx: &mut CodexBlocksTurn<'_, W>,
    turn: CodexTurnInput,
) -> Result<()> {
    if ctx.thread_id.is_none() {
        *ctx.thread_id = Some(start_or_resume_thread(
            ctx.codex,
            ctx.stdout,
            ctx.request_id,
            &turn.model_provider,
        )?);
        *ctx.thread_provider = Some(turn.model_provider.clone());
    } else if let (Some(requested), Some(pinned)) = (
        turn.requested_provider.as_deref(),
        ctx.thread_provider.as_deref(),
    ) && requested != pinned
    {
        // codex pins the provider at thread start, so an explicit mid-thread
        // override (e.g. a later `--bedrock`) cannot take effect. Surface it
        // rather than silently staying on the pinned provider; switching
        // providers requires a new thread (a harness flag like `--bedrock`
        // already restarts across harnesses, but a codex->codex provider switch
        // does not).
        eprintln!(
            "Codex provider `{requested}` ignored: this thread is pinned to `{pinned}` \
             (provider is fixed at thread start; start a new thread to switch providers)"
        );
    }
    let current_thread_id = ctx
        .thread_id
        .as_ref()
        .expect("thread id was initialized")
        .clone();

    let mut params = json!({
        "threadId": current_thread_id,
        "input": turn.input,
    });
    if let Some(client_user_message_id) = turn.client_user_message_id {
        params["clientUserMessageId"] = Value::String(client_user_message_id);
    }
    if let Some(model) = turn.model {
        params["model"] = Value::String(model);
    }
    // Per-turn reasoning effort (codex `turn/start.effort`), parsed from the
    // `-rsn` message flag. Values match codex's ReasoningEffort enum
    // (none|minimal|low|medium|high|xhigh); validation happens upstream.
    if let Some(reasoning) = turn.reasoning {
        params["effort"] = Value::String(reasoning);
    }

    let turn_request_id = next_request_id(ctx.request_id);
    ctx.codex
        .send_request(turn_request_id, "turn/start", params)?;
    let result = ctx
        .codex
        .read_response_or_forward(turn_request_id, ctx.stdout)?;
    let turn_id = result
        .pointer("/turn/id")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            HarnessServerError::Protocol("turn/start response missing turn.id".to_string())
        })?
        .to_string();
    ctx.codex.read_until_turn_terminal(
        ctx.stdout,
        ctx.thread_id.as_deref().unwrap_or_default(),
        &turn_id,
        ctx.input_rx,
        ctx.blocks_state,
        ctx.request_id,
    )
}

fn start_or_resume_thread<W: Write>(
    codex: &mut CodexJsonRpcChild,
    stdout: &mut W,
    request_id: &mut i64,
    model_provider: &str,
) -> Result<String> {
    let cwd = env::current_dir()?.display().to_string();
    let resume = env::var("CODEX_CONTINUE_THREAD_ID")
        .or_else(|_| env::var("AMP_CONTINUE_THREAD_ID"))
        .unwrap_or_default();
    let (method, params) = if resume.trim().is_empty() {
        (
            "thread/start",
            json!({
                "cwd": cwd,
                "approvalPolicy": "never",
                "approvalsReviewer": "user",
                "sandbox": "danger-full-access",
                "modelProvider": model_provider,
            }),
        )
    } else {
        (
            "thread/resume",
            json!({
                "threadId": resume.trim(),
                "cwd": cwd,
                "approvalPolicy": "never",
                "approvalsReviewer": "user",
                "sandbox": "danger-full-access",
                "modelProvider": model_provider,
                "excludeTurns": false,
            }),
        )
    };

    let id = next_request_id(request_id);
    codex.send_request(id, method, params)?;
    let result = codex.read_response_or_forward(id, stdout)?;
    result
        .pointer("/thread/id")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| HarnessServerError::Protocol(format!("{method} response missing thread.id")))
}

struct CodexJsonRpcChild {
    child: Child,
    stdin: ChildStdin,
    stdout: Receiver<io::Result<String>>,
}

impl CodexJsonRpcChild {
    fn spawn() -> Result<Self> {
        let bin = codex_bin();
        let mut child = ProcessCommand::new(&bin)
            .args(["app-server", "--listen", "stdio://"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|source| HarnessServerError::SpawnCodex {
                bin: bin.clone(),
                source,
            })?;

        let stdin = child
            .stdin
            .take()
            .ok_or(HarnessServerError::CodexStdinUnavailable)?;
        let stdout = child
            .stdout
            .take()
            .ok_or(HarnessServerError::CodexStdoutUnavailable)?;
        let mut stderr = child
            .stderr
            .take()
            .ok_or(HarnessServerError::CodexStderrUnavailable)?;
        thread::spawn(move || {
            let mut parent_stderr = io::stderr().lock();
            let _ = io::copy(&mut stderr, &mut parent_stderr);
        });

        let (stdout_tx, stdout_rx) = mpsc::channel();
        thread::spawn(move || {
            let reader = io::BufReader::new(stdout);
            for raw in reader.lines() {
                let should_stop = raw.is_err();
                if stdout_tx.send(raw).is_err() || should_stop {
                    break;
                }
            }
        });

        Ok(Self {
            child,
            stdin,
            stdout: stdout_rx,
        })
    }

    fn send_request(&mut self, id: i64, method: &str, params: Value) -> Result<()> {
        self.write_value(&json!({
            "id": id,
            "method": method,
            "params": params,
        }))
    }

    fn send_error_response(&mut self, request: &Value) -> Result<()> {
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        self.write_value(&json!({
            "id": id,
            "error": {
                "code": -32000,
                "message": "Centaur blocks mode cannot service app-server client requests",
                "data": null,
            },
        }))
    }

    fn send_response(&mut self, id: &Value, result: Value) -> Result<()> {
        self.write_value(&json!({
            "id": id,
            "result": result,
        }))
    }

    fn write_value(&mut self, value: &Value) -> Result<()> {
        serde_json::to_writer(&mut self.stdin, value)?;
        self.stdin.write_all(b"\n")?;
        self.stdin.flush()?;
        Ok(())
    }

    fn read_response_or_forward<W: Write>(
        &mut self,
        expected_id: i64,
        stdout: &mut W,
    ) -> Result<Value> {
        loop {
            let value = self.read_value()?;
            if is_server_request(&value) {
                self.send_error_response(&value)?;
                continue;
            }
            if response_id(&value) == Some(expected_id) {
                if let Some(error) = value.get("error") {
                    return Err(HarnessServerError::Protocol(format!(
                        "Codex app-server request {expected_id} failed: {error}"
                    )));
                }
                return Ok(value.get("result").cloned().unwrap_or(Value::Null));
            }
            if notification_method(&value).is_some() {
                write_value(stdout, &value)?;
            }
        }
    }

    fn read_until_turn_terminal<W: Write>(
        &mut self,
        stdout: &mut W,
        thread_id: &str,
        turn_id: &str,
        input_rx: &Receiver<io::Result<String>>,
        blocks_state: &mut BlocksState,
        request_id: &mut i64,
    ) -> Result<()> {
        loop {
            self.drain_active_turn_input(
                stdout,
                thread_id,
                turn_id,
                input_rx,
                blocks_state,
                request_id,
            )?;

            let Some(value) = self.read_value_timeout(ACTIVE_TURN_POLL_INTERVAL)? else {
                continue;
            };
            if is_server_request(&value) {
                handle_server_request(self, stdout, blocks_state, turn_id, &value)?;
                continue;
            }
            if response_id(&value).is_some() {
                if let Some(error) = value.get("error") {
                    eprintln!("Codex app-server active-turn request failed: {error}");
                }
                continue;
            }
            if notification_method(&value).is_some() {
                if maybe_handle_server_request_resolved(stdout, blocks_state, &value)? {
                    continue;
                }
                let terminal = is_terminal_notification(&value, thread_id, turn_id);
                write_value(stdout, &value)?;
                if terminal {
                    emit_questions_resolved(stdout, blocks_state, "empty")?;
                    break;
                }
            }
        }
        Ok(())
    }

    fn drain_active_turn_input<W: Write>(
        &mut self,
        stdout: &mut W,
        thread_id: &str,
        turn_id: &str,
        input_rx: &Receiver<io::Result<String>>,
        blocks_state: &mut BlocksState,
        request_id: &mut i64,
    ) -> Result<()> {
        while let Ok(raw) = input_rx.try_recv() {
            let line = raw?;
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            match parse_blocks_line_with_state(trimmed, blocks_state) {
                Ok(BlocksCommand::User {
                    input,
                    client_user_message_id: _,
                    model,
                    provider,
                    reasoning,
                }) => {
                    if model.is_some() || provider.is_some() || reasoning.is_some() {
                        eprintln!(
                            "Codex blocks active steering ignored model/provider/reasoning overrides"
                        );
                    }
                    self.send_request(
                        next_request_id(request_id),
                        "turn/steer",
                        json!({
                            "threadId": thread_id,
                            "expectedTurnId": turn_id,
                            "input": input,
                        }),
                    )?;
                }
                Ok(BlocksCommand::QuestionAnswer {
                    question_id,
                    answers,
                }) => {
                    answer_pending_question(self, stdout, blocks_state, &question_id, answers)?;
                }
                Ok(BlocksCommand::Interrupt) => {
                    self.send_request(
                        next_request_id(request_id),
                        "turn/interrupt",
                        json!({
                            "threadId": thread_id,
                            "turnId": turn_id,
                        }),
                    )?;
                    emit_questions_resolved(stdout, blocks_state, "cancelled")?;
                }
                Ok(BlocksCommand::AttachmentChunk) => {}
                Err(error) => {
                    eprintln!("invalid Codex blocks input during active turn: {error:#}");
                    write_blocks_error(stdout, thread_id, turn_id, error.to_string())?;
                }
            }
        }
        Ok(())
    }

    fn read_value(&mut self) -> Result<Value> {
        loop {
            let line = match self.stdout.recv() {
                Ok(line) => line?,
                Err(_) => {
                    let status = self.child.wait()?;
                    return Err(HarnessServerError::CodexExited { status });
                }
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            return Ok(serde_json::from_str(trimmed)?);
        }
    }

    fn read_value_timeout(&mut self, timeout: Duration) -> Result<Option<Value>> {
        loop {
            let line = match self.stdout.recv_timeout(timeout) {
                Ok(line) => line?,
                Err(RecvTimeoutError::Timeout) => return Ok(None),
                Err(RecvTimeoutError::Disconnected) => {
                    let status = self.child.wait()?;
                    return Err(HarnessServerError::CodexExited { status });
                }
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            return Ok(Some(serde_json::from_str(trimmed)?));
        }
    }
}

impl Drop for CodexJsonRpcChild {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn is_server_request(value: &Value) -> bool {
    value.get("id").is_some() && value.get("method").is_some()
}

fn response_id(value: &Value) -> Option<i64> {
    value.get("id").and_then(Value::as_i64)
}

fn notification_method(value: &Value) -> Option<&str> {
    if value.get("id").is_some() {
        return None;
    }
    value.get("method").and_then(Value::as_str)
}

fn is_terminal_notification(value: &Value, thread_id: &str, turn_id: &str) -> bool {
    match notification_method(value) {
        Some("turn/completed") | Some("turn/failed") => {
            let notification_thread = value
                .pointer("/params/threadId")
                .and_then(Value::as_str)
                .unwrap_or(thread_id);
            let notification_turn = value
                .pointer("/params/turn/id")
                .or_else(|| value.pointer("/params/turnId"))
                .and_then(Value::as_str)
                .unwrap_or(turn_id);
            notification_thread == thread_id && notification_turn == turn_id
        }
        Some("error") => true,
        _ => false,
    }
}

fn handle_server_request<W: Write>(
    codex: &mut CodexJsonRpcChild,
    stdout: &mut W,
    blocks_state: &mut BlocksState,
    current_turn_id: &str,
    request: &Value,
) -> Result<()> {
    let Some("item/tool/requestUserInput") = request.get("method").and_then(Value::as_str) else {
        return codex.send_error_response(request);
    };

    let request_id = request.get("id").cloned().unwrap_or(Value::Null);
    let params = request.get("params").unwrap_or(&Value::Null);
    let Some(question_id) = string_field(params, &["itemId", "item_id"]) else {
        return codex.send_response(&request_id, json!({"answers": {}}));
    };
    let turn_id = string_field(params, &["turnId", "turn_id"]).unwrap_or(current_turn_id);
    let questions = params
        .get("questions")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    blocks_state.insert_pending_question(question_id.to_owned(), request_id, turn_id.to_owned());
    write_value(
        stdout,
        &json!({
            "type": "question_requested",
            "question_id": question_id,
            "turn_id": turn_id,
            "questions": questions,
        }),
    )
}

fn maybe_handle_server_request_resolved<W: Write>(
    stdout: &mut W,
    blocks_state: &mut BlocksState,
    value: &Value,
) -> Result<bool> {
    let Some("serverRequest/resolved") = notification_method(value) else {
        return Ok(false);
    };
    let Some(request_id) = value.pointer("/params/requestId") else {
        return Ok(true);
    };
    if let Some((question_id, _pending)) =
        blocks_state.take_pending_question_by_request_id(request_id)
    {
        write_question_resolved(stdout, &question_id, "empty")?;
    }
    Ok(true)
}

fn answer_pending_question<W: Write>(
    codex: &mut CodexJsonRpcChild,
    stdout: &mut W,
    blocks_state: &mut BlocksState,
    question_id: &str,
    answers: Value,
) -> Result<()> {
    let Some(pending) = blocks_state.take_pending_question(question_id) else {
        eprintln!("question_answer dropped: no pending question {question_id}");
        return Ok(());
    };
    let response_answers = if answers.is_object() {
        answers
    } else {
        json!({})
    };
    codex.send_response(&pending.request_id, json!({"answers": response_answers}))?;
    write_question_resolved(stdout, question_id, "answered")
}

fn emit_questions_resolved<W: Write>(
    stdout: &mut W,
    blocks_state: &mut BlocksState,
    reason: &str,
) -> Result<()> {
    for question_id in blocks_state.pending_question_ids() {
        if blocks_state.take_pending_question(&question_id).is_some() {
            write_question_resolved(stdout, &question_id, reason)?;
        }
    }
    Ok(())
}

fn write_question_resolved<W: Write>(
    stdout: &mut W,
    question_id: &str,
    reason: &str,
) -> Result<()> {
    write_value(
        stdout,
        &json!({
            "type": "question_resolved",
            "question_id": question_id,
            "reason": reason,
        }),
    )
}

fn string_field<'a>(value: &'a Value, fields: &[&str]) -> Option<&'a str> {
    fields
        .iter()
        .find_map(|field| value.get(*field).and_then(Value::as_str))
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn next_request_id(request_id: &mut i64) -> i64 {
    let id = *request_id;
    *request_id += 1;
    id
}

fn codex_bin() -> String {
    if let Ok(bin) = env::var("CODEX_BIN") {
        return bin;
    }

    let candidates = ["codex", "/Applications/Codex.app/Contents/Resources/codex"];
    candidates
        .iter()
        .find(|bin| codex_supports_stdio_listen(bin))
        .copied()
        .unwrap_or("codex")
        .to_string()
}

fn codex_supports_stdio_listen(bin: &str) -> bool {
    let Ok(output) = ProcessCommand::new(bin)
        .args(["app-server", "--help"])
        .output()
    else {
        return false;
    };
    if !output.status.success() {
        return false;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    stdout.contains("--listen") || stderr.contains("--listen")
}

#[cfg(test)]
mod tests {
    use super::*;

    // A non-empty explicit provider override (the `--bedrock` blocks `provider`
    // field) short-circuits before any env/model heuristic, so these assertions
    // are deterministic regardless of CODEX_MODEL_PROVIDER / OPENROUTER_MODEL.
    #[test]
    fn explicit_provider_override_wins_over_model_heuristic() {
        let codex = CodexHarnessServer::codex();
        assert_eq!(
            codex.model_provider_for(Some("amazon-bedrock"), None),
            "amazon-bedrock"
        );
        assert_eq!(
            codex.model_provider_for(Some("amazon-bedrock"), Some("anthropic/claude-fable-5")),
            "amazon-bedrock"
        );
    }

    #[test]
    fn blank_provider_override_is_ignored() {
        // A blank override falls through to the model `/`-slug heuristic, which
        // selects openrouter — i.e. the override does not pin an empty provider.
        let codex = CodexHarnessServer::codex();
        assert_eq!(
            codex.model_provider_for(Some("   "), Some("vendor/model")),
            "openrouter"
        );
    }
}
