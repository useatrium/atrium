use std::env;
use std::io::{self, BufRead, Write};
use std::process::{Child, ChildStdin, Command as ProcessCommand, Stdio};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use codex_app_server_protocol::UserInput;
use serde_json::{Value, json};

use crate::otel;
use crate::server::{
    BlocksCommand, BlocksState, parse_blocks_line_with_state, prepend_context_input,
    write_blocks_error,
};
use crate::util::write_value;
use crate::{AppServerRuntime, HarnessServerError, Result};

const ACTIVE_TURN_POLL_INTERVAL: Duration = Duration::from_millis(50);
const DEFAULT_STARTUP_RPC_TIMEOUT: Duration = Duration::from_secs(60);
const CODEX_STARTUP_RPC_TIMEOUT_MS_ENV: &str = "CODEX_STARTUP_RPC_TIMEOUT_MS";

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
    let mut codex: Option<CodexJsonRpcChild> = None;
    let mut stdout = io::stdout().lock();
    let mut request_id = 1_i64;
    let mut thread_id: Option<String> = None;
    // Keep the last real Codex thread as the restart target. Reading the
    // environment on every child restart can resurrect a stale startup value
    // after this process has already fallen back to a fresh thread.
    let mut resume_thread_id = env::var("CODEX_CONTINUE_THREAD_ID")
        .or_else(|_| env::var("AMP_CONTINUE_THREAD_ID"))
        .ok()
        .map(|id| id.trim().to_owned())
        .filter(|id| !id.is_empty());
    // The provider the thread was started/resumed on. codex pins the provider at
    // thread start (the app-server protocol has no per-turn provider), so this
    // lets a later conflicting override be surfaced rather than silently dropped.
    let mut thread_provider: Option<String> = None;
    let mut blocks_state = BlocksState::default();

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
                context,
                client_user_message_id,
                model,
                provider,
                reasoning,
                trace_context,
            }) => {
                let traceparent = trace_context.effective_traceparent();
                if codex.is_none() {
                    let startup = (|| {
                        otel::configure_codex_otel_for_startup(&trace_context)?;
                        let mut child = CodexJsonRpcChild::spawn()?;
                        initialize_codex(
                            &mut child,
                            &mut stdout,
                            &mut request_id,
                            traceparent.as_deref(),
                        )?;
                        Ok::<_, HarnessServerError>(child)
                    })();
                    match startup {
                        Ok(child) => codex = Some(child),
                        Err(error) => {
                            eprintln!("Codex blocks startup failed: {error:#}");
                            write_blocks_error(
                                &mut stdout,
                                thread_id.as_deref().unwrap_or("codex"),
                                "startup",
                                format!("Codex startup failed: {error}"),
                            )?;
                            continue;
                        }
                    }
                }
                let model = model.or_else(|| config.default_model());
                let model_provider =
                    config.model_provider_for(provider.as_deref(), model.as_deref());
                let turn = CodexTurnInput {
                    input,
                    context,
                    client_user_message_id,
                    model,
                    model_provider,
                    requested_provider: provider,
                    reasoning,
                    traceparent,
                };
                let mut turn_ctx = CodexBlocksTurn {
                    codex: codex.as_mut().expect("codex initialized"),
                    stdout: &mut stdout,
                    request_id: &mut request_id,
                    thread_id: &mut thread_id,
                    resume_thread_id: &mut resume_thread_id,
                    thread_provider: &mut thread_provider,
                    input_rx: &input_rx,
                    blocks_state: &mut blocks_state,
                };
                if let Err(error) = run_codex_user_turn(&mut turn_ctx, turn) {
                    let fallback_thread_id =
                        turn_ctx.thread_id.as_deref().unwrap_or("codex").to_string();
                    // A timeout/protocol error before a turn becomes active can
                    // leave the app-server child permanently poisoned. Drop all
                    // child-local thread state so the next steer starts a fresh
                    // child and resumes the durable thread from the environment.
                    drop(turn_ctx);
                    codex = None;
                    thread_id = None;
                    thread_provider = None;
                    eprintln!("Codex blocks turn failed: {error:#}");
                    write_blocks_error(
                        &mut stdout,
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

fn initialize_codex<W: Write>(
    codex: &mut CodexJsonRpcChild,
    stdout: &mut W,
    request_id: &mut i64,
    traceparent: Option<&str>,
) -> Result<()> {
    let initialize_id = next_request_id(request_id);
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
        traceparent,
    )?;
    codex
        .read_response_or_forward(initialize_id, "initialize", startup_rpc_timeout(), stdout)
        .map(|_| ())
}

struct CodexBlocksTurn<'a, W: Write> {
    codex: &'a mut CodexJsonRpcChild,
    stdout: &'a mut W,
    request_id: &'a mut i64,
    thread_id: &'a mut Option<String>,
    resume_thread_id: &'a mut Option<String>,
    thread_provider: &'a mut Option<String>,
    input_rx: &'a Receiver<io::Result<String>>,
    blocks_state: &'a mut BlocksState,
}

struct CodexActiveTurn<'a> {
    thread_id: &'a str,
    turn_id: &'a str,
    input_rx: &'a Receiver<io::Result<String>>,
    blocks_state: &'a mut BlocksState,
    request_id: &'a mut i64,
    traceparent: Option<&'a str>,
}

struct CodexTurnInput {
    input: Vec<UserInput>,
    context: Vec<String>,
    client_user_message_id: Option<String>,
    model: Option<String>,
    model_provider: String,
    requested_provider: Option<String>,
    reasoning: Option<String>,
    traceparent: Option<String>,
}

fn run_codex_user_turn<W: Write>(
    ctx: &mut CodexBlocksTurn<'_, W>,
    turn: CodexTurnInput,
) -> Result<()> {
    if ctx.thread_id.is_none() {
        let started_thread_id = start_or_resume_thread(
            ctx.codex,
            ctx.stdout,
            ctx.request_id,
            ctx.resume_thread_id.as_deref(),
            &turn.model_provider,
            turn.traceparent.as_deref(),
        )?;
        *ctx.resume_thread_id = Some(started_thread_id.clone());
        *ctx.thread_id = Some(started_thread_id);
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

    let input = prepend_context_input(&turn.context, turn.input);
    let mut params = json!({
        "threadId": current_thread_id,
        "input": input,
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

    let max_retries = engine_retry_max();
    let mut retries = 0u32;
    loop {
        let turn_request_id = next_request_id(ctx.request_id);
        ctx.codex.send_request(
            turn_request_id,
            "turn/start",
            params.clone(),
            turn.traceparent.as_deref(),
        )?;
        let result = ctx.codex.read_response_or_forward(
            turn_request_id,
            "turn/start",
            startup_rpc_timeout(),
            ctx.stdout,
        )?;
        let turn_id = result
            .pointer("/turn/id")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                HarnessServerError::Protocol("turn/start response missing turn.id".to_string())
            })?
            .to_string();
        match ctx.codex.read_until_turn_terminal(
            ctx.stdout,
            CodexActiveTurn {
                thread_id: ctx.thread_id.as_deref().unwrap_or_default(),
                turn_id: &turn_id,
                input_rx: ctx.input_rx,
                blocks_state: ctx.blocks_state,
                request_id: ctx.request_id,
                traceparent: turn.traceparent.as_deref(),
            },
        )? {
            TurnTermination::Done => return Ok(()),
            TurnTermination::RetriableEngineError { withheld } => {
                if retries >= max_retries {
                    for value in &withheld {
                        write_value(ctx.stdout, value)?;
                    }
                    return Ok(());
                }
                retries += 1;
                eprintln!(
                    "codex turn hit a transient engine-registration error; \
                     retrying ({retries}/{max_retries})"
                );
                thread::sleep(retry_backoff(retries));
            }
        }
    }
}

fn start_or_resume_thread<W: Write>(
    codex: &mut CodexJsonRpcChild,
    stdout: &mut W,
    request_id: &mut i64,
    resume_thread_id: Option<&str>,
    model_provider: &str,
    traceparent: Option<&str>,
) -> Result<String> {
    let cwd = env::current_dir()?.display().to_string();
    let resume = resume_thread_id.unwrap_or_default().trim();
    let (mut method, params) = if resume.is_empty() {
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
    codex.send_request(id, method, params, traceparent)?;
    let result = match codex.read_response_or_forward(id, method, startup_rpc_timeout(), stdout) {
        Ok(result) => result,
        Err(error)
            if method == "thread/resume"
                && matches!(
                    &error,
                    HarnessServerError::Protocol(message)
                        if message.contains("no rollout found for thread id")
                ) =>
        {
            eprintln!("Codex rollout {resume} is unavailable; starting a fresh thread instead");
            method = "thread/start";
            let id = next_request_id(request_id);
            codex.send_request(
                id,
                method,
                json!({
                    "cwd": cwd,
                    "approvalPolicy": "never",
                    "approvalsReviewer": "user",
                    "sandbox": "danger-full-access",
                    "modelProvider": model_provider,
                }),
                traceparent,
            )?;
            codex.read_response_or_forward(id, method, startup_rpc_timeout(), stdout)?
        }
        Err(error) => return Err(error),
    };
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
            // Do not hold the process stderr lock for the entire Codex child
            // lifetime. The main harness thread also emits diagnostics while
            // the child is live (including resume fallback); a lifetime lock
            // makes those writes deadlock before the next RPC is sent.
            let mut parent_stderr = io::stderr();
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

    fn send_request(
        &mut self,
        id: i64,
        method: &str,
        params: Value,
        traceparent: Option<&str>,
    ) -> Result<()> {
        let mut payload = json!({
            "id": id,
            "method": method,
            "params": params,
        });
        if let Some(traceparent) = traceparent {
            payload["trace"] = json!({ "traceparent": traceparent });
        }
        self.write_value(&payload)
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
        operation: &str,
        timeout: Duration,
        stdout: &mut W,
    ) -> Result<Value> {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(startup_rpc_timeout_error(operation, timeout));
            }
            let Some(value) = self.read_value_timeout(remaining)? else {
                return Err(startup_rpc_timeout_error(operation, timeout));
            };
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
        mut turn: CodexActiveTurn<'_>,
    ) -> Result<TurnTermination> {
        let mut guard = TurnGuard::default();
        loop {
            self.drain_active_turn_input(stdout, &mut turn)?;

            let Some(value) = self.read_value_timeout(ACTIVE_TURN_POLL_INTERVAL)? else {
                continue;
            };
            if is_server_request(&value) {
                handle_server_request(self, stdout, turn.blocks_state, turn.turn_id, &value)?;
                continue;
            }
            if response_id(&value).is_some() {
                if let Some(error) = value.get("error") {
                    eprintln!("Codex app-server active-turn request failed: {error}");
                }
                continue;
            }
            if notification_method(&value).is_none() {
                continue;
            }
            if maybe_handle_server_request_resolved(stdout, turn.blocks_state, &value)? {
                continue;
            }
            let terminal = is_terminal_notification(&value, turn.thread_id, turn.turn_id);
            match guard.observe(value, terminal) {
                GuardStep::Retry(withheld) => {
                    return Ok(TurnTermination::RetriableEngineError { withheld });
                }
                GuardStep::Forward(values) => {
                    for value in &values {
                        write_value(stdout, value)?;
                    }
                }
                GuardStep::ForwardThenDone(values) => {
                    for value in &values {
                        write_value(stdout, value)?;
                    }
                    emit_questions_resolved(stdout, turn.blocks_state, "empty")?;
                    return Ok(TurnTermination::Done);
                }
            }
        }
    }

    fn drain_active_turn_input<W: Write>(
        &mut self,
        stdout: &mut W,
        turn: &mut CodexActiveTurn<'_>,
    ) -> Result<()> {
        while let Ok(raw) = turn.input_rx.try_recv() {
            let line = raw?;
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            match parse_blocks_line_with_state(trimmed, turn.blocks_state) {
                Ok(BlocksCommand::User {
                    input,
                    context,
                    client_user_message_id: _,
                    model,
                    provider,
                    reasoning,
                    trace_context: _,
                }) => {
                    if model.is_some() || provider.is_some() || reasoning.is_some() {
                        eprintln!(
                            "Codex blocks active steering ignored model/provider/reasoning overrides"
                        );
                    }
                    self.send_request(
                        next_request_id(turn.request_id),
                        "turn/steer",
                        json!({
                            "threadId": turn.thread_id,
                            "expectedTurnId": turn.turn_id,
                            "input": prepend_context_input(&context, input),
                        }),
                        turn.traceparent,
                    )?;
                }
                Ok(BlocksCommand::QuestionAnswer {
                    question_id,
                    answers,
                }) => {
                    answer_pending_question(
                        self,
                        stdout,
                        turn.blocks_state,
                        &question_id,
                        answers,
                    )?;
                }
                Ok(BlocksCommand::Interrupt) => {
                    self.send_request(
                        next_request_id(turn.request_id),
                        "turn/interrupt",
                        json!({
                            "threadId": turn.thread_id,
                            "turnId": turn.turn_id,
                        }),
                        turn.traceparent,
                    )?;
                    emit_questions_resolved(stdout, turn.blocks_state, "cancelled")?;
                }
                Ok(BlocksCommand::AttachmentChunk) => {}
                Err(error) => {
                    eprintln!("invalid Codex blocks input during active turn: {error:#}");
                    write_blocks_error(stdout, turn.thread_id, turn.turn_id, error.to_string())?;
                }
            }
        }
        Ok(())
    }

    fn read_value_timeout(&mut self, timeout: Duration) -> Result<Option<Value>> {
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(None);
            }
            let line = match self.stdout.recv_timeout(remaining) {
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

fn startup_rpc_timeout() -> Duration {
    env::var(CODEX_STARTUP_RPC_TIMEOUT_MS_ENV)
        .ok()
        .and_then(|raw| raw.trim().parse::<u64>().ok())
        .filter(|millis| *millis > 0)
        .map(Duration::from_millis)
        .unwrap_or(DEFAULT_STARTUP_RPC_TIMEOUT)
}

fn startup_rpc_timeout_error(operation: &str, timeout: Duration) -> HarnessServerError {
    HarnessServerError::Protocol(format!(
        "Codex app-server {operation} response timed out after {}ms",
        timeout.as_millis()
    ))
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
        .map(|items| {
            items
                .iter()
                .enumerate()
                .map(|(index, question)| adapt_codex_question(question, index))
                .collect::<Vec<Value>>()
        })
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

/// Translate a codex `requestUserInput` question into the Atrium question
/// prompt shape the surface consumers validate (`{id, header, question,
/// options?, multiSelect?, isOther?, isSecret?}`).
///
/// The `id` is preserved EXACTLY so the JSON-RPC answer response round-trips
/// keyed by it (`{"answers": {<id>: {"answers": [...]}}}`). Questions already in
/// Atrium shape (string `header` AND `question`) pass through with only option
/// normalization. Legacy/codex-native questions carry a `label` (+ optional
/// `kind`/`choices`); those map: `question` from the label/prompt/text, a short
/// derived `header`, and `kind` decides options vs. free-text vs. multi-select.
/// Unknown kinds and text kinds become a free-text prompt (no options), which
/// the surface renders as a plain input.
fn adapt_codex_question(question: &Value, index: usize) -> Value {
    let Some(obj) = question.as_object() else {
        // Non-object entries can't be answered structurally; synthesize a
        // free-text prompt so the human still sees something meaningful.
        return json!({
            "id": format!("question-{}", index + 1),
            "header": format!("Question {}", index + 1),
            "question": question.as_str().map(str::trim).unwrap_or_default(),
        });
    };

    let header_field = string_field(question, &["header"]);
    let question_field = string_field(question, &["question"]);

    // Already Atrium-shaped: both header and question present as strings. The
    // real codex v2 `ToolRequestUserInputQuestion` lands here (it already
    // carries id/header/question/options/isOther/isSecret).
    if let (Some(header), Some(prompt)) = (header_field, question_field) {
        let mut out = serde_json::Map::new();
        out.insert("id".into(), adapted_id(obj, index));
        out.insert("header".into(), json!(header));
        out.insert("question".into(), json!(prompt));
        if let Some(options) = normalize_options(obj.get("options")) {
            out.insert("options".into(), Value::Array(options));
        }
        if let Some(multi) = bool_field(obj, &["multiSelect", "multi_select"]) {
            out.insert("multiSelect".into(), json!(multi));
        }
        if let Some(other) = bool_field(obj, &["isOther", "is_other"]) {
            out.insert("isOther".into(), json!(other));
        }
        if let Some(secret) = bool_field(obj, &["isSecret", "is_secret"]) {
            out.insert("isSecret".into(), json!(secret));
        }
        return Value::Object(out);
    }

    // Legacy/codex-native question: derive from label/prompt/text.
    let prompt = string_field(question, &["question", "label", "prompt", "text", "title"])
        .unwrap_or("")
        .to_owned();
    let header = header_field
        .map(str::to_owned)
        .unwrap_or_else(|| derive_header(&prompt, index));
    let kind = string_field(question, &["kind", "type"]).unwrap_or("");
    let multi = is_multi_select_kind(kind)
        || bool_field(obj, &["multiSelect", "multi_select"]).unwrap_or(false);

    let mut out = serde_json::Map::new();
    out.insert("id".into(), adapted_id(obj, index));
    out.insert("header".into(), json!(header));
    out.insert("question".into(), json!(prompt));

    // Options come from an Atrium-style `options` array or a codex `choices`
    // string list. Absent/empty options (a text or unknown kind) → the surface
    // renders a plain text input.
    let options =
        normalize_options(obj.get("options")).or_else(|| choices_to_options(obj.get("choices")));
    if let Some(options) = options {
        out.insert("options".into(), Value::Array(options));
        if multi {
            out.insert("multiSelect".into(), json!(true));
        }
    }
    if let Some(other) = bool_field(obj, &["isOther", "is_other"]) {
        out.insert("isOther".into(), json!(other));
    }
    if let Some(secret) = bool_field(obj, &["isSecret", "is_secret"]) {
        out.insert("isSecret".into(), json!(secret));
    }
    Value::Object(out)
}

/// Preserve the original question `id` verbatim (answers round-trip keyed by
/// it); fall back to a positional id only when absent/empty.
fn adapted_id(obj: &serde_json::Map<String, Value>, index: usize) -> Value {
    match obj.get("id").and_then(Value::as_str) {
        Some(id) if !id.is_empty() => json!(id),
        _ => json!(format!("question-{}", index + 1)),
    }
}

/// A short header derived from the question prompt (truncated ~24 chars), or a
/// positional fallback when the prompt is empty.
fn derive_header(prompt: &str, index: usize) -> String {
    const MAX: usize = 24;
    let trimmed = prompt.trim();
    if trimmed.is_empty() {
        return format!("Question {}", index + 1);
    }
    let mut header: String = trimmed.chars().take(MAX).collect();
    if trimmed.chars().count() > MAX {
        header.push('…');
    }
    header
}

/// A codex kind names a multi-select question when it carries a `multi` marker
/// (`multi_select`, `multiChoice`, `multiple_choice`, …). Plain `choice` is
/// single-select; text/unknown kinds have no options at all.
fn is_multi_select_kind(kind: &str) -> bool {
    kind.to_ascii_lowercase().contains("multi")
}

fn bool_field(obj: &serde_json::Map<String, Value>, fields: &[&str]) -> Option<bool> {
    fields
        .iter()
        .find_map(|field| obj.get(*field).and_then(Value::as_bool))
}

/// Normalize an Atrium/codex `options` array to `[{label, description,
/// preview?, previewFormat?}]`, dropping entries without a usable label.
/// Returns `None` when the input is absent, not an array, or yields no options.
fn normalize_options(value: Option<&Value>) -> Option<Vec<Value>> {
    let arr = value?.as_array()?;
    let options: Vec<Value> = arr.iter().filter_map(normalize_option).collect();
    (!options.is_empty()).then_some(options)
}

fn normalize_option(option: &Value) -> Option<Value> {
    let label = string_field(option, &["label", "value", "text"])?;
    let mut out = serde_json::Map::new();
    out.insert("label".into(), json!(label));
    out.insert(
        "description".into(),
        json!(string_field(option, &["description", "detail"]).unwrap_or("")),
    );
    if let Some(preview) = string_field(option, &["preview"]) {
        out.insert("preview".into(), json!(preview));
    }
    if let Some(format) = string_field(option, &["previewFormat", "preview_format"]) {
        out.insert("previewFormat".into(), json!(format));
    }
    Some(Value::Object(out))
}

/// Map a codex `choices` list of strings to Atrium options. Returns `None` when
/// absent, not an array, or empty after dropping blank entries.
fn choices_to_options(value: Option<&Value>) -> Option<Vec<Value>> {
    let arr = value?.as_array()?;
    let options: Vec<Value> = arr
        .iter()
        .filter_map(|choice| {
            let label = choice.as_str().map(str::trim).filter(|s| !s.is_empty())?;
            Some(json!({"label": label, "description": ""}))
        })
        .collect();
    (!options.is_empty()).then_some(options)
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

/// Outcome of driving a single codex turn attempt.
enum TurnTermination {
    /// The turn reached a terminal state; everything needed has been forwarded.
    Done,
    /// The turn failed with a transient engine-registration error before
    /// streaming output. The caller can retry or forward the withheld failure.
    RetriableEngineError { withheld: Vec<Value> },
}

#[derive(Default)]
struct TurnGuard {
    pending_system_error: Option<Value>,
    streamed: bool,
}

enum GuardStep {
    Forward(Vec<Value>),
    ForwardThenDone(Vec<Value>),
    Retry(Vec<Value>),
}

impl TurnGuard {
    fn observe(&mut self, value: Value, terminal: bool) -> GuardStep {
        let method = notification_method(&value).unwrap_or_default().to_owned();
        if terminal && method == "error" && !self.streamed && is_retriable_engine_error(&value) {
            let mut withheld = Vec::new();
            if let Some(status) = self.pending_system_error.take() {
                withheld.push(status);
            }
            withheld.push(value);
            return GuardStep::Retry(withheld);
        }

        let mut out = Vec::new();
        if let Some(status) = self.pending_system_error.take() {
            out.push(status);
        }

        if !self.streamed && is_system_error_status(&value) {
            self.pending_system_error = Some(value);
            return GuardStep::Forward(out);
        }

        if streams_turn_output(&method) {
            self.streamed = true;
        }
        out.push(value);
        if terminal {
            GuardStep::ForwardThenDone(out)
        } else {
            GuardStep::Forward(out)
        }
    }
}

fn engine_retry_max() -> u32 {
    parse_engine_retry_max(env::var("CODEX_ENGINE_RETRY_MAX").ok().as_deref())
}

fn parse_engine_retry_max(raw: Option<&str>) -> u32 {
    const DEFAULT: u32 = 2;
    raw.and_then(|raw| raw.trim().parse::<u32>().ok())
        .unwrap_or(DEFAULT)
}

fn retry_backoff(retry: u32) -> Duration {
    let shift = retry.saturating_sub(1).min(4);
    Duration::from_millis((500u64 << shift).min(5_000))
}

fn is_retriable_engine_error(value: &Value) -> bool {
    let Some(message) = value
        .pointer("/params/error/message")
        .and_then(Value::as_str)
    else {
        return false;
    };
    message.contains("Engine not found")
        || (message.contains("Job registration failed") && message.contains("404"))
}

fn is_system_error_status(value: &Value) -> bool {
    notification_method(value) == Some("thread/status/changed")
        && value.pointer("/params/status/type").and_then(Value::as_str) == Some("systemError")
}

fn streams_turn_output(method: &str) -> bool {
    method.starts_with("item/") || method == "thread/tokenUsage/updated"
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

    #[test]
    fn resume_rpc_hang_times_out_despite_remote_control_notification() {
        let mut child = ProcessCommand::new("sh")
            .args([
                "-c",
                "printf '%s\\n' '{\"method\":\"codex/event/remote_control_status_changed\",\"params\":{\"enabled\":false}}'; sleep 10",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn hanging fake app-server");
        let stdin = child.stdin.take().expect("fake app-server stdin");
        let stdout = child.stdout.take().expect("fake app-server stdout");
        let (stdout_tx, stdout_rx) = mpsc::channel();
        thread::spawn(move || {
            for raw in io::BufReader::new(stdout).lines() {
                let should_stop = raw.is_err();
                if stdout_tx.send(raw).is_err() || should_stop {
                    break;
                }
            }
        });
        let mut codex = CodexJsonRpcChild {
            child,
            stdin,
            stdout: stdout_rx,
        };
        let mut forwarded = Vec::new();

        let error = codex
            .read_response_or_forward(
                7,
                "thread/resume",
                Duration::from_millis(50),
                &mut forwarded,
            )
            .expect_err("missing resume response must time out");

        assert!(
            error
                .to_string()
                .contains("thread/resume response timed out after 50ms")
        );
        assert!(
            String::from_utf8(forwarded)
                .expect("forwarded notification is utf-8")
                .contains("remote_control_status_changed"),
            "notification should be forwarded without resetting the RPC deadline"
        );
    }

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

    #[test]
    fn adapts_codex_choice_question_to_atrium_options() {
        let adapted = adapt_codex_question(
            &json!({"id": "choice", "label": "Pick one", "kind": "choice", "choices": ["A", "B"]}),
            0,
        );
        // id preserved EXACTLY so the answer response round-trips keyed by it.
        assert_eq!(adapted["id"], "choice");
        assert_eq!(adapted["question"], "Pick one");
        assert_eq!(adapted["header"], "Pick one");
        assert_eq!(
            adapted["options"],
            json!([
                {"label": "A", "description": ""},
                {"label": "B", "description": ""},
            ])
        );
        // Single-select choice must NOT be flagged multiSelect.
        assert!(adapted.get("multiSelect").is_none());
    }

    #[test]
    fn adapts_codex_text_kind_to_free_text_prompt() {
        let adapted = adapt_codex_question(
            &json!({"id": "name", "label": "What is your name?", "kind": "text"}),
            0,
        );
        assert_eq!(adapted["id"], "name");
        assert_eq!(adapted["question"], "What is your name?");
        // No options → the surface renders a plain text input.
        assert!(adapted.get("options").is_none());
        assert!(adapted.get("multiSelect").is_none());
    }

    #[test]
    fn adapts_unknown_kind_as_free_text() {
        let adapted = adapt_codex_question(
            &json!({"id": "freeform", "label": "Anything", "kind": "wildcard-kind"}),
            2,
        );
        assert_eq!(adapted["id"], "freeform");
        assert_eq!(adapted["question"], "Anything");
        assert!(adapted.get("options").is_none());
    }

    #[test]
    fn adapts_multi_select_kind_with_choices() {
        let adapted = adapt_codex_question(
            &json!({
                "id": "sections",
                "label": "Which sections?",
                "kind": "multi_choice",
                "choices": ["Summary", "Timeline"],
            }),
            0,
        );
        assert_eq!(adapted["multiSelect"], true);
        assert_eq!(
            adapted["options"],
            json!([
                {"label": "Summary", "description": ""},
                {"label": "Timeline", "description": ""},
            ])
        );
    }

    #[test]
    fn already_atrium_shaped_question_passes_through() {
        let original = json!({
            "id": "question-1",
            "header": "Sections",
            "question": "Which sections should be visible?",
            "multiSelect": true,
            "isOther": true,
            "options": [
                {"label": "Summary", "description": "Show a brief overview.",
                 "preview": "SUMMARY", "previewFormat": "markdown"},
            ],
        });
        let adapted = adapt_codex_question(&original, 0);
        assert_eq!(adapted["id"], "question-1");
        assert_eq!(adapted["header"], "Sections");
        assert_eq!(adapted["question"], "Which sections should be visible?");
        assert_eq!(adapted["multiSelect"], true);
        assert_eq!(adapted["isOther"], true);
        assert_eq!(adapted["options"][0]["label"], "Summary");
        assert_eq!(adapted["options"][0]["preview"], "SUMMARY");
        assert_eq!(adapted["options"][0]["previewFormat"], "markdown");
    }

    #[test]
    fn missing_id_falls_back_to_positional_but_preserves_present_id() {
        let no_id = adapt_codex_question(&json!({"label": "Pick", "kind": "text"}), 3);
        assert_eq!(no_id["id"], "question-4");

        let with_id = adapt_codex_question(&json!({"id": "keep-me", "label": "Pick"}), 0);
        assert_eq!(with_id["id"], "keep-me");
    }

    #[test]
    fn derives_short_header_from_long_prompt() {
        let adapted = adapt_codex_question(
            &json!({
                "id": "q",
                "label": "This is a very long question prompt that should be truncated",
            }),
            0,
        );
        let header = adapted["header"].as_str().unwrap();
        assert!(header.chars().count() <= 25, "header too long: {header:?}");
        assert!(header.ends_with('…'), "expected ellipsis: {header:?}");
    }

    #[test]
    fn context_is_separate_first_codex_input_item() {
        let input = prepend_context_input(
            &["[atrium context]\nfrom: Alice Basin (human - driver)".to_string()],
            vec![UserInput::Text {
                text: "hello".to_string(),
                text_elements: Vec::new(),
            }],
        );
        let value = serde_json::to_value(input).unwrap();

        assert_eq!(value[0]["type"], "text");
        assert_eq!(
            value[0]["text"],
            "<context>\n[atrium context]\nfrom: Alice Basin (human - driver)\n</context>\n\n"
        );
        assert_eq!(value[1]["type"], "text");
        assert_eq!(value[1]["text"], "hello");
    }
}
