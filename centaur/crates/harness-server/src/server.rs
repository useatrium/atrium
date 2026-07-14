use std::collections::{BTreeMap, HashMap};
use std::env;
use std::fs::OpenOptions;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::thread;
use std::time::{Duration, Instant};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64_STANDARD;
use codex_app_server_protocol::{
    ApprovalsReviewer, AskForApproval, ClientResponse, InitializeResponse, JSONRPCError,
    JSONRPCErrorError, JSONRPCMessage, JSONRPCRequest, JSONRPCResponse, RequestId, SandboxPolicy,
    ServerNotification, ThreadResumeParams, ThreadResumeResponse, ThreadStartParams,
    ThreadStartResponse, TurnInterruptParams, TurnInterruptResponse, TurnStartParams,
    TurnStartResponse, TurnStatus, TurnSteerParams, TurnSteerResponse, UserInput,
};
use serde::Deserialize;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::amp::AmpHarness;
use crate::claude::ClaudeCodeHarness;
use crate::codex::CodexHarnessServer;
use crate::otel::{self, HarnessUsageSpan, TraceContext};
use crate::traits::{
    AppServerNormalizer, AppServerRuntime, HarnessChild, HarnessKind, HarnessServer,
    NormalizedContent, NormalizedEvent, NormalizedTokenUsage, ThreadState,
};
use crate::turn::{BridgeConfig, CodexTurnNormalizer};
use crate::util::{absolute_path, default_codex_home, write_value};
use crate::wire::{is_known_untyped_server_notification, notification_to_wire_value};
use crate::{HarnessServerError, Result};

const LOCAL_ATTACHMENT_WAIT_ENV: &str = "CENTAUR_LOCAL_ATTACHMENT_WAIT_MS";
const DEFAULT_LOCAL_ATTACHMENT_WAIT_MS: u64 = 30_000;
const LOCAL_ATTACHMENT_POLL_MS: u64 = 100;
const ATRIUM_CONTEXT_READY_TIMEOUT_ENV: &str = "ATRIUM_CONTEXT_READY_TIMEOUT_MS";
const DEFAULT_ATRIUM_CONTEXT_READY_TIMEOUT_MS: u64 = 10_000;
const ATRIUM_CONTEXT_READY_POLL_MS: u64 = 250;
const ATRIUM_CONTEXT_TIMEOUT_NOTE: &str = "NOTE: the Atrium context mount (~/context) did not become ready before this turn (materializer may be down). Do not wait for or retry ~/context reads; answer from the repo, tools, and the conversation instead.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ContextReadiness {
    Ready,
    TimedOut,
    Skipped,
}

pub fn server_for(kind: HarnessKind) -> Box<dyn AppServerRuntime> {
    match kind {
        HarnessKind::Codex => Box::new(CodexHarnessServer::codex()),
        HarnessKind::ClaudeCode => Box::new(AppServerNormalizer::new(ClaudeCodeHarness)),
        HarnessKind::Amp => Box::new(AppServerNormalizer::new(AmpHarness)),
    }
}

pub fn run_harness_server(kind: HarnessKind) -> Result<()> {
    server_for(kind).run_stdio()
}

pub fn run_blocks_server(kind: HarnessKind) -> Result<()> {
    match kind {
        HarnessKind::Codex => crate::codex::run_codex_blocks_server(CodexHarnessServer::codex()),
        HarnessKind::ClaudeCode => run_blocks_app_server(&ClaudeCodeHarness),
        HarnessKind::Amp => run_blocks_app_server(&AmpHarness),
    }
}

pub fn run_validate_jsonrpc() -> Result<()> {
    let stdin = io::stdin();
    for raw in stdin.lock().lines() {
        let line = raw?;
        if line.trim().is_empty() {
            continue;
        }
        let message: JSONRPCMessage = serde_json::from_str(&line)?;
        if let JSONRPCMessage::Notification(notification) = message {
            let method = notification.method.clone();
            if !is_known_untyped_server_notification(&method) {
                let _typed = codex_app_server_protocol::ServerNotification::try_from(notification)
                    .map_err(|error| HarnessServerError::InvalidServerNotification {
                        message: error.to_string(),
                    })?;
            }
        }
    }
    Ok(())
}

pub(crate) fn run_blocks_app_server<H: HarnessServer>(harness: &H) -> Result<()> {
    let mut stdout = io::stdout().lock();
    let mut state = initial_blocks_thread_state(harness)?;
    let mut blocks_state = BlocksState::default();
    let (_request_tx, request_rx) = mpsc::channel();
    let input_rx = spawn_blocks_stdin_reader();

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
                // Provider selection only applies to the codex harness; the
                // emulated (claude/amp) app-server has no equivalent knob (its
                // provider is fixed at thread start from session params).
                provider: _,
                reasoning,
                trace_context,
            }) => {
                if let Some(model) = model {
                    state.model = model;
                }
                // Per-turn reasoning effort for claude: the CLI fixes effort at
                // process start, but the child is restartable — `--resume`
                // carries the transcript, so applying a new effort is a respawn
                // with a new `--effort`. A steer that landed mid-turn stashed
                // its effort in pending_reasoning; it applies now. Amp has no
                // effort knob; codex takes it via `turn/start.effort`.
                let reasoning = reasoning.or_else(|| blocks_state.pending_reasoning.take());
                if harness.kind() == HarnessKind::ClaudeCode
                    && let Some(reasoning) = reasoning
                    && state.reasoning_effort.as_deref() != Some(reasoning.as_str())
                {
                    state.reasoning_effort = Some(reasoning);
                    // Dropping the idle child kills it (HarnessChild::drop);
                    // the next ensure_harness_process respawns with the flag.
                    state.process = None;
                }
                if let Err(error) = run_blocks_turn(
                    harness,
                    &mut state,
                    BlocksTurnRequest {
                        input,
                        context,
                        client_user_message_id,
                        trace_context: &trace_context,
                        stdout: &mut stdout,
                        request_rx: &request_rx,
                        active_blocks: Some(ActiveBlocksInput {
                            input_rx: &input_rx,
                            blocks_state: &mut blocks_state,
                        }),
                    },
                ) {
                    eprintln!("blocks turn failed: {error:#}");
                    write_blocks_error(&mut stdout, &state.id, "turn", error.to_string())?;
                }
            }
            Ok(BlocksCommand::Interrupt) => {
                eprintln!("blocks interrupt ignored: no active stdin reader while a turn runs");
            }
            Ok(BlocksCommand::QuestionAnswer { question_id, .. }) => {
                eprintln!("question_answer ignored: no pending question {question_id}");
            }
            Ok(BlocksCommand::AttachmentChunk) => {}
            Err(error) => {
                eprintln!("invalid blocks input: {error:#}");
                write_blocks_error(&mut stdout, &state.id, "input", error.to_string())?;
            }
        }
    }

    Ok(())
}

fn spawn_blocks_stdin_reader() -> Receiver<io::Result<String>> {
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

pub(crate) fn run_app_server<H: HarnessServer>(harness: &H) -> Result<()> {
    let (request_tx, request_rx) = mpsc::channel();
    std::thread::spawn(move || {
        let stdin = io::stdin();
        for raw in stdin.lock().lines() {
            let Ok(line) = raw else {
                break;
            };
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let message = match serde_json::from_str::<JSONRPCMessage>(trimmed) {
                Ok(message) => message,
                Err(error) => {
                    eprintln!("invalid JSON-RPC message: {error}");
                    continue;
                }
            };
            let JSONRPCMessage::Request(request) = message else {
                continue;
            };
            if request_tx.send(request).is_err() {
                break;
            }
        }
    });

    let mut stdout = io::stdout().lock();
    let mut threads: HashMap<String, ThreadState> = HashMap::new();

    while let Ok(request) = request_rx.recv() {
        if let Err(error) = handle_request(harness, request, &request_rx, &mut threads, &mut stdout)
        {
            eprintln!("request failed: {error:#}");
        }
    }

    Ok(())
}

fn initial_blocks_thread_state<H: HarnessServer>(harness: &H) -> Result<ThreadState> {
    let cwd = env::current_dir()?;
    let params = ThreadStartParams::default();
    let mut state = harness.thread_state(&params, cwd);
    if let Some(thread_id) = non_empty(env::var("CENTAUR_THREAD_KEY").ok().as_deref()) {
        state.id = thread_id.to_owned();
    }
    if let Some(thread_id) = non_empty(env::var("CENTAUR_RESUME_THREAD_ID").ok().as_deref()) {
        state.id = thread_id.to_owned();
        state.harness_session_id = Some(thread_id.to_owned());
    }
    Ok(state)
}

struct BlocksTurnRequest<'a, W: Write> {
    input: Vec<UserInput>,
    context: Vec<String>,
    client_user_message_id: Option<String>,
    trace_context: &'a TraceContext,
    stdout: &'a mut W,
    request_rx: &'a Receiver<JSONRPCRequest>,
    active_blocks: Option<ActiveBlocksInput<'a>>,
}

fn run_blocks_turn<H: HarnessServer, W: Write>(
    harness: &H,
    state: &mut ThreadState,
    request: BlocksTurnRequest<'_, W>,
) -> Result<()> {
    let turn_id = format!("turn-{}", Uuid::new_v4().simple());
    let mut normalizer = normalizer_for(harness, state, &turn_id);
    let harness_input = prepend_context_input(&request.context, request.input.clone());
    run_normalized_turn(
        harness,
        state,
        TurnRunContext {
            input: &request.input,
            harness_input: &harness_input,
            client_user_message_id: request.client_user_message_id,
            trace_context: Some(request.trace_context),
            normalizer: &mut normalizer,
            stdout: request.stdout,
            request_rx: request.request_rx,
            active_blocks: request.active_blocks,
        },
    )
}

#[derive(Debug)]
pub(crate) enum BlocksCommand {
    User {
        input: Vec<UserInput>,
        context: Vec<String>,
        client_user_message_id: Option<String>,
        model: Option<String>,
        provider: Option<String>,
        reasoning: Option<String>,
        trace_context: TraceContext,
    },
    QuestionAnswer {
        question_id: String,
        answers: Value,
    },
    Interrupt,
    AttachmentChunk,
}

#[derive(Debug, Default)]
pub(crate) struct BlocksState {
    uploads: HashMap<String, StagedAttachment>,
    staged: HashMap<String, StagedAttachment>,
    pending_questions: HashMap<String, PendingQuestion>,
    context_readiness_checked: bool,
    /// Reasoning effort from a steer that landed MID-turn (the running child
    /// can't be re-parameterized). Consumed between turns so the change
    /// applies from the next turn instead of being dropped.
    pub(crate) pending_reasoning: Option<String>,
}

#[derive(Debug, Clone)]
pub(crate) struct PendingQuestion {
    pub request_id: Value,
    request_id_key: String,
    _turn_id: String,
}

impl BlocksState {
    pub(crate) fn insert_pending_question(
        &mut self,
        question_id: String,
        request_id: Value,
        turn_id: String,
    ) {
        self.pending_questions.insert(
            question_id,
            PendingQuestion {
                request_id_key: request_id_key(&request_id),
                request_id,
                _turn_id: turn_id,
            },
        );
    }

    pub(crate) fn take_pending_question(&mut self, question_id: &str) -> Option<PendingQuestion> {
        self.pending_questions.remove(question_id)
    }

    pub(crate) fn take_pending_question_by_request_id(
        &mut self,
        request_id: &Value,
    ) -> Option<(String, PendingQuestion)> {
        let request_id_key = request_id_key(request_id);
        let question_id = self
            .pending_questions
            .iter()
            .find_map(|(question_id, pending)| {
                (pending.request_id_key == request_id_key).then(|| question_id.clone())
            })?;
        self.pending_questions
            .remove(&question_id)
            .map(|pending| (question_id, pending))
    }

    pub(crate) fn pending_question_ids(&self) -> Vec<String> {
        self.pending_questions.keys().cloned().collect()
    }
}

#[derive(Debug, Clone)]
struct StagedAttachment {
    path: PathBuf,
    mime_type: Option<String>,
    attachment_type: Option<String>,
}

struct ActiveBlocksInput<'a> {
    input_rx: &'a Receiver<io::Result<String>>,
    blocks_state: &'a mut BlocksState,
}

struct TurnRunContext<'a, W: Write> {
    input: &'a [UserInput],
    harness_input: &'a [UserInput],
    client_user_message_id: Option<String>,
    trace_context: Option<&'a TraceContext>,
    normalizer: &'a mut CodexTurnNormalizer,
    stdout: &'a mut W,
    request_rx: &'a Receiver<JSONRPCRequest>,
    active_blocks: Option<ActiveBlocksInput<'a>>,
}

#[derive(Debug, Deserialize)]
struct BlocksLine {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    message: Option<BlocksMessage>,
    #[serde(default)]
    content: Option<BlocksContent>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    client_user_message_id: Option<String>,
    #[serde(default)]
    model: Option<String>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    reasoning: Option<String>,
    #[serde(default)]
    thread_key: Option<String>,
    #[serde(default)]
    trace_id: Option<String>,
    #[serde(default)]
    traceparent: Option<String>,
    #[serde(default)]
    trace_metadata: Option<Value>,
    #[serde(rename = "attachmentId", default)]
    attachment_id: Option<String>,
    #[serde(default)]
    name: Option<String>,
    #[serde(rename = "mimeType", default)]
    mime_type: Option<String>,
    #[serde(rename = "attachmentType", default)]
    attachment_type: Option<String>,
    #[serde(rename = "final", default)]
    final_chunk: bool,
    #[serde(rename = "dataBase64", default)]
    data_base64: Option<String>,
    #[serde(rename = "question_id", default)]
    question_id: Option<String>,
    #[serde(default)]
    answers: Option<Value>,
}

impl BlocksLine {
    fn trace_context(&self) -> TraceContext {
        TraceContext {
            thread_key: clean_string(self.thread_key.as_deref()),
            trace_id: clean_string(self.trace_id.as_deref()),
            traceparent: clean_string(self.traceparent.as_deref()),
            metadata: self
                .trace_metadata
                .as_ref()
                .and_then(Value::as_object)
                .map(|metadata| {
                    metadata
                        .iter()
                        .map(|(key, value)| (key.clone(), value.clone()))
                        .collect::<BTreeMap<_, _>>()
                })
                .unwrap_or_default(),
        }
    }
}

#[derive(Debug, Deserialize)]
struct BlocksMessage {
    #[serde(default)]
    content: Option<BlocksContent>,
    #[serde(default)]
    id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum BlocksContent {
    Inputs(Vec<BlocksInput>),
    Text(String),
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum BlocksInput {
    UserInput(UserInput),
    Attachment(Box<AttachmentBlock>),
}

#[derive(Debug, Deserialize)]
struct AttachmentBlock {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    name: Option<String>,
    #[serde(rename = "mimeType", default)]
    mime_type: Option<String>,
    #[serde(rename = "attachment_type", default)]
    attachment_type: Option<String>,
    #[serde(rename = "stagedAttachmentId", default)]
    staged_attachment_id: Option<String>,
    #[serde(rename = "dataBase64", default)]
    data_base64: Option<String>,
    #[serde(rename = "localPath", default)]
    local_path: Option<String>,
    #[serde(default)]
    path: Option<String>,
    #[serde(rename = "fetchError", default)]
    fetch_error: Option<String>,
    #[serde(default)]
    url: Option<String>,
    #[serde(default)]
    text: Option<String>,
}

#[cfg(test)]
fn parse_blocks_line(line: &str) -> Result<BlocksCommand> {
    parse_blocks_line_with_state(line, &mut BlocksState::default())
}

pub(crate) fn parse_blocks_line_with_state(
    line: &str,
    state: &mut BlocksState,
) -> Result<BlocksCommand> {
    let parsed: BlocksLine =
        serde_json::from_str(line).map_err(|source| HarnessServerError::InvalidBlocksInput {
            message: source.to_string(),
        })?;

    match parsed.kind.as_str() {
        "user" => {
            let trace_context = parsed.trace_context();
            let content = parsed
                .message
                .as_ref()
                .and_then(|message| message.content.as_ref())
                .or(parsed.content.as_ref());
            let mut parsed_content = match content {
                Some(content) => blocks_content_to_user_input(content, state)?,
                None => parsed
                    .text
                    .map(|text| {
                        ParsedBlocksContent::from_input(vec![UserInput::Text {
                            text,
                            text_elements: Vec::new(),
                        }])
                    })
                    .unwrap_or_default(),
            };
            if !state.context_readiness_checked {
                state.context_readiness_checked = true;
                if wait_for_atrium_context_if_first_turn(true) == ContextReadiness::TimedOut {
                    parsed_content
                        .context
                        .insert(0, ATRIUM_CONTEXT_TIMEOUT_NOTE.to_string());
                }
            }
            if parsed_content.input.is_empty() {
                parsed_content.input.push(UserInput::Text {
                    text: "continue".to_string(),
                    text_elements: Vec::new(),
                });
            }
            Ok(BlocksCommand::User {
                input: parsed_content.input,
                context: parsed_content.context,
                client_user_message_id: parsed
                    .client_user_message_id
                    .or_else(|| parsed.message.and_then(|message| message.id)),
                model: parsed
                    .model
                    .map(|model| model.trim().to_owned())
                    .filter(|model| !model.is_empty()),
                provider: parsed
                    .provider
                    .map(|provider| provider.trim().to_owned())
                    .filter(|provider| !provider.is_empty()),
                reasoning: parsed
                    .reasoning
                    .map(|reasoning| reasoning.trim().to_owned())
                    .filter(|reasoning| !reasoning.is_empty()),
                trace_context,
            })
        }
        "question_answer" => {
            let question_id = non_empty(parsed.question_id.as_deref()).ok_or_else(|| {
                HarnessServerError::InvalidBlocksInput {
                    message: "question_answer missing question_id".to_string(),
                }
            })?;
            Ok(BlocksCommand::QuestionAnswer {
                question_id: question_id.to_string(),
                answers: parsed.answers.unwrap_or_else(|| json!({})),
            })
        }
        "attachment.chunk" => {
            handle_attachment_chunk(parsed, state)?;
            Ok(BlocksCommand::AttachmentChunk)
        }
        "interrupt" => Ok(BlocksCommand::Interrupt),
        kind => Err(HarnessServerError::InvalidBlocksInput {
            message: format!("unsupported blocks input type `{kind}`"),
        }),
    }
}

#[derive(Debug, Default)]
struct ParsedBlocksContent {
    input: Vec<UserInput>,
    context: Vec<String>,
}

impl ParsedBlocksContent {
    fn from_input(input: Vec<UserInput>) -> Self {
        Self {
            input,
            context: Vec::new(),
        }
    }

    fn from_context(context: String) -> Self {
        Self {
            input: Vec::new(),
            context: vec![context],
        }
    }

    fn extend(&mut self, other: Self) {
        self.input.extend(other.input);
        self.context.extend(other.context);
    }
}

fn blocks_content_to_user_input(
    content: &BlocksContent,
    state: &mut BlocksState,
) -> Result<ParsedBlocksContent> {
    match content {
        BlocksContent::Inputs(input) => {
            let mut parsed = ParsedBlocksContent::default();
            for item in input {
                parsed.extend(blocks_input_to_user_input(item, state)?);
            }
            Ok(parsed)
        }
        BlocksContent::Text(text) => Ok(ParsedBlocksContent::from_input(vec![UserInput::Text {
            text: text.clone(),
            text_elements: Vec::new(),
        }])),
    }
}

fn blocks_input_to_user_input(
    input: &BlocksInput,
    state: &mut BlocksState,
) -> Result<ParsedBlocksContent> {
    match input {
        BlocksInput::UserInput(input) => Ok(ParsedBlocksContent::from_input(vec![input.clone()])),
        BlocksInput::Attachment(block) if block.kind == "context" => Ok(
            ParsedBlocksContent::from_context(block.text.clone().unwrap_or_default()),
        ),
        BlocksInput::Attachment(block) if block.kind == "attachment" => {
            attachment_block_to_user_input(block, state).map(ParsedBlocksContent::from_input)
        }
        BlocksInput::Attachment(block) => {
            Ok(ParsedBlocksContent::from_input(vec![UserInput::Text {
                text: format!("[Unsupported attachment block type: {}]", block.kind),
                text_elements: Vec::new(),
            }]))
        }
    }
}

pub(crate) fn prepend_context_input(context: &[String], input: Vec<UserInput>) -> Vec<UserInput> {
    let Some(context) = wrapped_context_text(context) else {
        return input;
    };
    let mut with_context = Vec::with_capacity(input.len() + 1);
    with_context.push(UserInput::Text {
        text: context,
        text_elements: Vec::new(),
    });
    with_context.extend(input);
    with_context
}

fn wrapped_context_text(context: &[String]) -> Option<String> {
    if context.is_empty() {
        return None;
    }
    Some(format!("<context>\n{}\n</context>\n\n", context.join("\n")))
}

fn attachment_block_to_user_input(
    block: &AttachmentBlock,
    state: &mut BlocksState,
) -> Result<Vec<UserInput>> {
    let name = non_empty(block.name.as_deref()).unwrap_or("attachment");
    let mime_type = non_empty(block.mime_type.as_deref());
    let attachment_type = non_empty(block.attachment_type.as_deref());

    if let Some(local_path) =
        non_empty(block.local_path.as_deref()).or(non_empty(block.path.as_deref()))
    {
        let path = PathBuf::from(local_path);
        let exists = wait_for_local_attachment_path(&path, local_attachment_wait_duration())
            .map_err(|source| HarnessServerError::InvalidBlocksInput {
                message: format!(
                    "localPath attachment {name:?} is not readable at {local_path}: {source}"
                ),
            })?;
        if !exists {
            return Err(HarnessServerError::InvalidBlocksInput {
                message: format!("localPath attachment {name:?} is missing at {local_path}"),
            });
        }
        return Ok(local_file_inputs(
            &path,
            mime_type,
            is_image_attachment(attachment_type, mime_type),
        ));
    }

    if let Some(staged_attachment_id) = non_empty(block.staged_attachment_id.as_deref()) {
        if let Some(staged) = state.staged.get(staged_attachment_id)
            && staged.path.exists()
        {
            return Ok(local_file_inputs(
                &staged.path,
                staged.mime_type.as_deref().or(mime_type),
                is_image_attachment(
                    staged.attachment_type.as_deref(),
                    staged.mime_type.as_deref().or(mime_type),
                ),
            ));
        }
        return Ok(vec![UserInput::Text {
            text: format!("[Attachment was not staged successfully: {name}]"),
            text_elements: Vec::new(),
        }]);
    }

    if let Some(data_base64) = non_empty(block.data_base64.as_deref()) {
        let path = write_base64_upload(data_base64, name, mime_type)?;
        return Ok(local_file_inputs(
            &path,
            mime_type,
            is_image_attachment(attachment_type, mime_type),
        ));
    }

    let mut fields = vec![format!("name={name}")];
    if let Some(mime_type) = mime_type {
        fields.push(format!("mime={mime_type}"));
    }
    if let Some(url) = non_empty(block.url.as_deref()) {
        fields.push(format!("url={url}"));
    }
    if let Some(fetch_error) = non_empty(block.fetch_error.as_deref()) {
        fields.push(format!("fetch_error={fetch_error}"));
    }
    Ok(vec![UserInput::Text {
        text: format!("[Slack attachment: {}]", fields.join(" ")),
        text_elements: Vec::new(),
    }])
}

fn local_attachment_wait_duration() -> Duration {
    env::var(LOCAL_ATTACHMENT_WAIT_ENV)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or(Duration::from_millis(DEFAULT_LOCAL_ATTACHMENT_WAIT_MS))
}

fn wait_for_local_attachment_path(path: &Path, timeout: Duration) -> io::Result<bool> {
    let start = Instant::now();
    loop {
        if path.try_exists()? {
            let metadata = std::fs::metadata(path)?;
            if !metadata.is_file() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "path is not a regular file",
                ));
            }
            std::fs::File::open(path)?;
            return Ok(true);
        }
        if start.elapsed() >= timeout {
            return Ok(false);
        }
        let remaining = timeout.saturating_sub(start.elapsed());
        thread::sleep(remaining.min(Duration::from_millis(LOCAL_ATTACHMENT_POLL_MS)));
    }
}

fn handle_attachment_chunk(parsed: BlocksLine, state: &mut BlocksState) -> Result<()> {
    let attachment_id = non_empty(parsed.attachment_id.as_deref()).ok_or_else(|| {
        HarnessServerError::InvalidBlocksInput {
            message: "attachment chunk missing attachmentId".to_string(),
        }
    })?;
    let name = non_empty(parsed.name.as_deref()).unwrap_or("attachment");
    let mime_type = non_empty(parsed.mime_type.as_deref());

    if !state.uploads.contains_key(attachment_id) {
        let path = unique_upload_path(name, mime_type)?;
        state.uploads.insert(
            attachment_id.to_string(),
            StagedAttachment {
                path,
                mime_type: mime_type.map(ToOwned::to_owned),
                attachment_type: non_empty(parsed.attachment_type.as_deref())
                    .map(ToOwned::to_owned),
            },
        );
    }

    if let Some(data_base64) = non_empty(parsed.data_base64.as_deref()) {
        let bytes = BASE64_STANDARD.decode(data_base64).map_err(|source| {
            HarnessServerError::InvalidBlocksInput {
                message: format!("invalid attachment chunk for {attachment_id}: {source}"),
            }
        })?;
        let upload = state.uploads.get(attachment_id).expect("upload exists");
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&upload.path)?;
        file.write_all(&bytes)?;
    }

    if parsed.final_chunk
        && let Some(upload) = state.uploads.remove(attachment_id)
    {
        state.staged.insert(attachment_id.to_string(), upload);
    }

    Ok(())
}

fn local_file_inputs(path: &Path, mime_type: Option<&str>, is_image: bool) -> Vec<UserInput> {
    let display_path = path.display();
    if is_image || mime_type.is_some_and(|value| value.starts_with("image/")) {
        return vec![
            UserInput::Text {
                text: format!("[Attached image saved to {display_path}]"),
                text_elements: Vec::new(),
            },
            UserInput::LocalImage {
                path: path.to_path_buf(),
                detail: None,
            },
        ];
    }
    vec![UserInput::Text {
        text: format!("[Attached file saved to {display_path}]"),
        text_elements: Vec::new(),
    }]
}

fn write_base64_upload(data_base64: &str, name: &str, mime_type: Option<&str>) -> Result<PathBuf> {
    let bytes = BASE64_STANDARD.decode(data_base64).map_err(|source| {
        HarnessServerError::InvalidBlocksInput {
            message: format!("invalid attachment dataBase64: {source}"),
        }
    })?;
    let path = unique_upload_path(name, mime_type)?;
    std::fs::write(&path, bytes)?;
    Ok(path)
}

fn unique_upload_path(name: &str, mime_type: Option<&str>) -> Result<PathBuf> {
    let uploads_dir = uploads_dir();
    std::fs::create_dir_all(&uploads_dir)?;
    let mut base = sanitize_upload_name(name);
    if Path::new(&base).extension().is_none()
        && let Some(extension) = extension_for_mime_type(mime_type)
    {
        base.push_str(extension);
    }
    let path = uploads_dir.join(&base);
    if !path.exists() {
        return Ok(path);
    }
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("attachment");
    let suffix = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let suffix = if suffix.is_empty() {
        String::new()
    } else {
        format!(".{suffix}")
    };
    Ok(uploads_dir.join(format!("{stem}-{}{suffix}", Uuid::new_v4().simple())))
}

fn uploads_dir() -> PathBuf {
    env::var_os("CENTAUR_UPLOADS_DIR")
        .map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join("uploads")))
        .unwrap_or_else(|| PathBuf::from("/tmp/uploads"))
}

fn sanitize_upload_name(name: &str) -> String {
    let leaf = Path::new(name)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("attachment")
        .trim();
    let clean = leaf
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '_' | '-') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches(['.', '_'])
        .to_string();
    if clean.is_empty() {
        "attachment".to_string()
    } else {
        clean
    }
}

fn extension_for_mime_type(mime_type: Option<&str>) -> Option<&'static str> {
    match mime_type? {
        "image/jpeg" => Some(".jpg"),
        "image/png" => Some(".png"),
        "image/gif" => Some(".gif"),
        "image/webp" => Some(".webp"),
        "video/mp4" => Some(".mp4"),
        "application/pdf" => Some(".pdf"),
        "text/plain" => Some(".txt"),
        _ => None,
    }
}

fn is_image_attachment(attachment_type: Option<&str>, mime_type: Option<&str>) -> bool {
    attachment_type == Some("image") || mime_type.is_some_and(|value| value.starts_with("image/"))
}

fn non_empty(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn request_id_key(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Number(value) => value.to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

fn clean_string(value: Option<&str>) -> Option<String> {
    non_empty(value).map(ToOwned::to_owned)
}

fn handle_request<H: HarnessServer, W: Write>(
    harness: &H,
    request: JSONRPCRequest,
    request_rx: &Receiver<JSONRPCRequest>,
    threads: &mut HashMap<String, ThreadState>,
    stdout: &mut W,
) -> Result<()> {
    match request.method.as_str() {
        "initialize" => {
            let response = InitializeResponse {
                user_agent: "harness-server".to_string(),
                codex_home: absolute_path(
                    env::var_os("CODEX_HOME")
                        .map(PathBuf::from)
                        .unwrap_or_else(default_codex_home),
                )?,
                platform_family: env::consts::FAMILY.to_string(),
                platform_os: env::consts::OS.to_string(),
            };
            write_client_response(
                stdout,
                ClientResponse::Initialize {
                    request_id: request.id,
                    response,
                },
            )
        }
        "thread/start" => {
            let params: ThreadStartParams = request_params(request.params)?;
            let cwd = params
                .cwd
                .as_deref()
                .map(PathBuf::from)
                .unwrap_or(env::current_dir()?);
            let cwd = if cwd.is_absolute() {
                cwd
            } else {
                env::current_dir()?.join(cwd)
            };
            let state = harness.thread_state(&params, cwd.clone());
            let thread_id = state.id.clone();
            let normalizer = normalizer_for(harness, &state, "turn-placeholder");
            let response = ThreadStartResponse {
                thread: normalizer.thread_snapshot()?,
                model: state.model.clone(),
                model_provider: state.model_provider.clone(),
                service_tier: state.service_tier.clone(),
                cwd: absolute_path(cwd)?,
                runtime_workspace_roots: Vec::new(),
                instruction_sources: Vec::new(),
                approval_policy: AskForApproval::Never,
                approvals_reviewer: ApprovalsReviewer::User,
                sandbox: SandboxPolicy::DangerFullAccess,
                active_permission_profile: None,
                reasoning_effort: None,
            };
            threads.insert(thread_id, state);
            write_client_response(
                stdout,
                ClientResponse::ThreadStart {
                    request_id: request.id,
                    response,
                },
            )
        }
        "thread/resume" => {
            let params: ThreadResumeParams = request_params(request.params)?;
            let thread_id = params.thread_id.clone();
            if !threads.contains_key(&thread_id) {
                threads.insert(thread_id.clone(), resumed_thread_state(harness, &params)?);
            }
            let state = threads
                .get_mut(&thread_id)
                .expect("thread state inserted or existed");
            apply_resume_overrides(state, &params)?;
            let normalizer = normalizer_for(harness, state, "turn-placeholder");
            let mut thread = normalizer.thread_snapshot()?;
            if !params.exclude_turns {
                thread.turns = state.completed_turns.clone();
            }
            let response = ThreadResumeResponse {
                thread,
                model: state.model.clone(),
                model_provider: state.model_provider.clone(),
                service_tier: state.service_tier.clone(),
                cwd: absolute_path(state.cwd.clone())?,
                runtime_workspace_roots: Vec::new(),
                instruction_sources: Vec::new(),
                approval_policy: AskForApproval::Never,
                approvals_reviewer: ApprovalsReviewer::User,
                sandbox: SandboxPolicy::DangerFullAccess,
                active_permission_profile: None,
                reasoning_effort: None,
                initial_turns_page: None,
            };
            write_client_response(
                stdout,
                ClientResponse::ThreadResume {
                    request_id: request.id,
                    response,
                },
            )
        }
        "turn/start" => {
            let params: TurnStartParams = request_params(request.params)?;
            let state = threads.get_mut(&params.thread_id).ok_or_else(|| {
                HarnessServerError::UnknownThread {
                    thread_id: params.thread_id.clone(),
                }
            })?;
            let turn_id = format!("turn-{}", Uuid::new_v4().simple());
            let mut normalizer = normalizer_for(harness, state, &turn_id);
            let response = TurnStartResponse {
                turn: normalizer.turn_snapshot(TurnStatus::InProgress),
            };
            write_client_response(
                stdout,
                ClientResponse::TurnStart {
                    request_id: request.id,
                    response,
                },
            )?;
            run_normalized_turn(
                harness,
                state,
                TurnRunContext {
                    input: &params.input,
                    harness_input: &params.input,
                    client_user_message_id: params.client_user_message_id.clone(),
                    trace_context: None,
                    normalizer: &mut normalizer,
                    stdout,
                    request_rx,
                    active_blocks: None,
                },
            )
        }
        "turn/interrupt" => {
            let _params: TurnInterruptParams = request_params(request.params)?;
            write_client_response(
                stdout,
                ClientResponse::TurnInterrupt {
                    request_id: request.id,
                    response: TurnInterruptResponse {},
                },
            )
        }
        "turn/steer" => write_error(
            stdout,
            request.id,
            -32600,
            "no active turn to steer".to_string(),
        ),
        _ => write_error(
            stdout,
            request.id,
            -32601,
            format!("method not found: {}", request.method),
        ),
    }
}

fn normalizer_for<H: HarnessServer>(
    harness: &H,
    state: &ThreadState,
    turn_id: &str,
) -> CodexTurnNormalizer {
    let mut config = BridgeConfig::new(state.id.clone(), turn_id.to_string());
    config.cwd = state.cwd.clone();
    config.cli_version = harness.cli_version().to_string();
    config.model_provider = state.model_provider.clone();
    CodexTurnNormalizer::new(config)
}

fn resumed_thread_state<H: HarnessServer>(
    harness: &H,
    params: &ThreadResumeParams,
) -> Result<ThreadState> {
    let cwd = params
        .cwd
        .as_deref()
        .map(PathBuf::from)
        .unwrap_or(env::current_dir()?);
    let cwd = if cwd.is_absolute() {
        cwd
    } else {
        env::current_dir()?.join(cwd)
    };
    Ok(ThreadState {
        id: params.thread_id.clone(),
        cwd,
        model: params
            .model
            .clone()
            .unwrap_or_else(|| harness.default_model()),
        model_provider: params
            .model_provider
            .clone()
            .unwrap_or_else(|| harness.default_model_provider().to_string()),
        service_tier: params.service_tier.clone().flatten(),
        reasoning_effort: None,
        harness_session_id: Some(params.thread_id.clone()),
        completed_turns: Vec::new(),
        process: None,
        thread_started_sent: false,
    })
}

fn apply_resume_overrides(state: &mut ThreadState, params: &ThreadResumeParams) -> Result<()> {
    if let Some(model) = &params.model {
        state.model = model.clone();
    }
    if let Some(model_provider) = &params.model_provider {
        state.model_provider = model_provider.clone();
    }
    if let Some(service_tier) = &params.service_tier {
        state.service_tier.clone_from(service_tier);
    }
    if let Some(cwd) = &params.cwd {
        let cwd = PathBuf::from(cwd);
        state.cwd = if cwd.is_absolute() {
            cwd
        } else {
            env::current_dir()?.join(cwd)
        };
    }
    Ok(())
}

fn handle_active_turn_request<H: HarnessServer, W: Write>(
    harness: &H,
    process: &mut HarnessChild,
    normalizer: &mut CodexTurnNormalizer,
    request: JSONRPCRequest,
    stdout: &mut W,
) -> Result<bool> {
    match request.method.as_str() {
        "turn/steer" => {
            let params: TurnSteerParams = request_params(request.params)?;
            if params.thread_id != normalizer.thread_id() {
                write_error(
                    stdout,
                    request.id,
                    -32600,
                    format!("unknown threadId {}", params.thread_id),
                )?;
                return Ok(false);
            }
            if params.expected_turn_id != normalizer.turn_id() {
                write_error(
                    stdout,
                    request.id,
                    -32600,
                    format!(
                        "expected active turn id `{}` but found `{}`",
                        params.expected_turn_id,
                        normalizer.turn_id()
                    ),
                )?;
                return Ok(false);
            }
            process
                .stdin
                .write_all(&harness.stdin_for_steer(&params.input)?)?;
            process.stdin.flush()?;
            write_client_response(
                stdout,
                ClientResponse::TurnSteer {
                    request_id: request.id,
                    response: TurnSteerResponse {
                        turn_id: normalizer.turn_id().to_string(),
                    },
                },
            )?;
            for notification in normalizer
                .emit_user_message(params.client_user_message_id.clone(), params.input.clone())?
            {
                write_value(stdout, &notification_to_wire_value(&notification)?)?;
            }
            Ok(false)
        }
        "turn/interrupt" => {
            let params: TurnInterruptParams = request_params(request.params)?;
            if params.thread_id != normalizer.thread_id() {
                write_error(
                    stdout,
                    request.id,
                    -32600,
                    format!("unknown threadId {}", params.thread_id),
                )?;
                return Ok(false);
            }
            if params.turn_id != normalizer.turn_id() {
                write_error(
                    stdout,
                    request.id,
                    -32600,
                    format!(
                        "expected active turn id `{}` but found `{}`",
                        params.turn_id,
                        normalizer.turn_id()
                    ),
                )?;
                return Ok(false);
            }
            process.kill_and_wait()?;
            write_client_response(
                stdout,
                ClientResponse::TurnInterrupt {
                    request_id: request.id,
                    response: TurnInterruptResponse {},
                },
            )?;
            Ok(true)
        }
        _ => {
            write_error(
                stdout,
                request.id,
                -32600,
                format!("cannot handle {} while a turn is active", request.method),
            )?;
            Ok(false)
        }
    }
}

fn run_normalized_turn<H: HarnessServer, W: Write>(
    harness: &H,
    state: &mut ThreadState,
    mut ctx: TurnRunContext<'_, W>,
) -> Result<()> {
    let context_readiness = if input_contains_context_timeout_note(ctx.harness_input) {
        ContextReadiness::TimedOut
    } else {
        wait_for_atrium_context_if_first_turn(!state.thread_started_sent)
    };
    let harness_input =
        prepend_context_readiness_note(context_readiness, ctx.harness_input.to_vec());
    for notification in ctx
        .normalizer
        .start_notifications(!state.thread_started_sent)?
    {
        if matches!(notification, ServerNotification::ThreadStarted(_)) {
            state.thread_started_sent = true;
        }
        write_value(ctx.stdout, &notification_to_wire_value(&notification)?)?;
    }
    for notification in ctx
        .normalizer
        .emit_user_message(ctx.client_user_message_id.take(), ctx.input.to_vec())?
    {
        write_value(ctx.stdout, &notification_to_wire_value(&notification)?)?;
    }

    match run_harness_turn(harness, state, &mut ctx, &harness_input) {
        Ok(Some(turn)) => state.completed_turns.push(turn),
        Ok(None) => {}
        Err(HarnessServerError::TurnInterrupted { .. }) => {
            state.process = None;
            finish_turn_interrupted(state, ctx.normalizer, ctx.stdout)?;
        }
        Err(error) => finish_turn_with_error(state, ctx.normalizer, ctx.stdout, error)?,
    }
    Ok(())
}

fn wait_for_atrium_context_if_first_turn(first_turn: bool) -> ContextReadiness {
    if !first_turn {
        return ContextReadiness::Skipped;
    }
    let timeout = env::var(ATRIUM_CONTEXT_READY_TIMEOUT_ENV)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .map(Duration::from_millis)
        .unwrap_or(Duration::from_millis(
            DEFAULT_ATRIUM_CONTEXT_READY_TIMEOUT_MS,
        ));
    if timeout.is_zero() {
        return ContextReadiness::Skipped;
    }
    let Some(home) = env::var_os("HOME") else {
        return ContextReadiness::Skipped;
    };
    wait_for_atrium_context_path(first_turn, &PathBuf::from(home).join("context"), timeout)
}

fn wait_for_atrium_context_path(
    first_turn: bool,
    context_dir: &Path,
    timeout: Duration,
) -> ContextReadiness {
    if !first_turn || timeout.is_zero() {
        return ContextReadiness::Skipped;
    }
    if !context_dir.is_dir() {
        return ContextReadiness::Skipped;
    }
    let marker = context_dir.join(".atrium-context-ready");
    let start = Instant::now();
    while !marker.is_file() && start.elapsed() < timeout {
        let remaining = timeout.saturating_sub(start.elapsed());
        thread::sleep(remaining.min(Duration::from_millis(ATRIUM_CONTEXT_READY_POLL_MS)));
    }
    if !marker.is_file() {
        eprintln!(
            "warning: Atrium context readiness marker {} was missing after {}ms; proceeding with first turn",
            marker.display(),
            timeout.as_millis()
        );
        return ContextReadiness::TimedOut;
    }
    ContextReadiness::Ready
}

fn prepend_context_readiness_note(
    readiness: ContextReadiness,
    input: Vec<UserInput>,
) -> Vec<UserInput> {
    if readiness != ContextReadiness::TimedOut || input_contains_context_timeout_note(&input) {
        return input;
    }
    let mut with_note = Vec::with_capacity(input.len() + 1);
    with_note.push(UserInput::Text {
        text: ATRIUM_CONTEXT_TIMEOUT_NOTE.to_string(),
        text_elements: Vec::new(),
    });
    with_note.extend(input);
    with_note
}

fn input_contains_context_timeout_note(input: &[UserInput]) -> bool {
    input.iter().any(|item| {
        matches!(
            item,
            UserInput::Text { text, .. } if text.contains(ATRIUM_CONTEXT_TIMEOUT_NOTE)
        )
    })
}

fn finish_turn_interrupted<W: Write>(
    state: &mut ThreadState,
    normalizer: &mut CodexTurnNormalizer,
    stdout: &mut W,
) -> Result<()> {
    if let Some(notification) = normalizer.finish_turn_interrupted()? {
        if let ServerNotification::TurnCompleted(completed) = &notification {
            state.completed_turns.push(completed.turn.clone());
        }
        write_value(stdout, &notification_to_wire_value(&notification)?)?;
    }
    Ok(())
}

fn finish_turn_with_error<W: Write>(
    state: &mut ThreadState,
    normalizer: &mut CodexTurnNormalizer,
    stdout: &mut W,
    error: HarnessServerError,
) -> Result<()> {
    let message = error.to_string();
    let normalized = NormalizedEvent::Error {
        message: message.clone(),
    };
    for notification in normalizer.process_event(&normalized)? {
        write_value(stdout, &notification_to_wire_value(&notification)?)?;
    }
    if let Some(notification) = normalizer.finish_turn(Some(message))? {
        if let ServerNotification::TurnCompleted(completed) = &notification {
            state.completed_turns.push(completed.turn.clone());
        }
        write_value(stdout, &notification_to_wire_value(&notification)?)?;
    }
    Ok(())
}

fn run_harness_turn<H: HarnessServer, W: Write>(
    harness: &H,
    state: &mut ThreadState,
    ctx: &mut TurnRunContext<'_, W>,
    harness_input: &[UserInput],
) -> Result<Option<codex_app_server_protocol::Turn>> {
    let usage_span_start = otel::unix_time_nanos();
    let usage_span_model = state.model.clone();
    let usage_span_model_provider = state.model_provider.clone();
    let usage_span_turn_id = ctx.normalizer.turn_id().to_string();
    let usage_span_input = usage_span_input_value(harness_input);
    let mut usage_span_output = UsageSpanOutput::default();
    ensure_harness_process(harness, state)?;
    {
        let process = state
            .process
            .as_mut()
            .ok_or(HarnessServerError::HarnessStdinUnavailable)?;
        // Buffered stdout predates this turn's input. A previous turn that
        // completed via the assistant-stop fallback can leave the CLI's late
        // native result behind; draining it here keeps it from terminating the
        // next turn instantly.
        while process.stdout.try_recv().is_ok() {}
        process
            .stdin
            .write_all(&harness.stdin_for_turn(harness_input)?)?;
        process.stdin.flush()?;
    }

    let settle_window = harness.terminal_assistant_stop_settle();
    let mut settle_deadline: Option<Instant> = None;
    let mut last_session_id = state.harness_session_id.clone();
    let mut event_normalizer = H::EventNormalizer::default();
    let mut completed_turn = None;
    let mut latest_usage = None;
    loop {
        while let Ok(request) = ctx.request_rx.try_recv() {
            let interrupted = {
                let process = state
                    .process
                    .as_mut()
                    .ok_or(HarnessServerError::HarnessStdinUnavailable)?;
                handle_active_turn_request(harness, process, ctx.normalizer, request, ctx.stdout)?
            };
            if interrupted {
                state.process = None;
                return Err(HarnessServerError::TurnInterrupted {
                    kind: harness.kind(),
                });
            }
            // Steering gives the active turn new input and therefore a new
            // response window; any pending assistant-stop fallback no longer
            // applies until the next terminal stop appears.
            settle_deadline = None;
        }
        if let Some(active_blocks) = ctx.active_blocks.as_mut() {
            let drained_input = {
                let process = state
                    .process
                    .as_mut()
                    .ok_or(HarnessServerError::HarnessStdinUnavailable)?;
                drain_active_blocks_input(
                    harness,
                    process,
                    ctx.normalizer,
                    ctx.stdout,
                    &state.id,
                    active_blocks,
                )?
            };
            if drained_input {
                settle_deadline = None;
            }
        }

        let mut terminal = false;
        match state
            .process
            .as_mut()
            .ok_or(HarnessServerError::HarnessStdoutUnavailable)?
            .stdout
            .recv_timeout(Duration::from_millis(50))
        {
            Ok(line) => {
                let line = line?;
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if let Some(active_blocks) = ctx.active_blocks.as_mut()
                    && handle_harness_control_output(
                        trimmed,
                        ctx.stdout,
                        active_blocks.blocks_state,
                    )?
                {
                    continue;
                }
                let event = harness.parse_stdout_line(trimmed)?;
                let normalized_events = harness.normalize_events(&mut event_normalizer, event)?;
                let mut terminal_stop = false;
                for normalized in normalized_events {
                    if let Some(usage) = normalized.token_usage() {
                        latest_usage = Some(usage.clone());
                    }
                    append_usage_span_output(&normalized, &mut usage_span_output);
                    if let Some(session_id) = normalized.session_id() {
                        last_session_id = Some(session_id.to_string());
                        state.harness_session_id = Some(session_id.to_string());
                    }
                    for notification in ctx.normalizer.process_event(&normalized)? {
                        write_value(ctx.stdout, &notification_to_wire_value(&notification)?)?;
                    }
                    terminal |= normalized.is_terminal();
                    terminal_stop |=
                        settle_window.is_some() && normalized.is_terminal_assistant_stop();
                }
                if !terminal {
                    match settle_window {
                        Some(window) if terminal_stop && window.is_zero() => terminal = true,
                        Some(window) if terminal_stop || settle_deadline.is_some() => {
                            settle_deadline = Some(Instant::now() + window);
                        }
                        _ => {}
                    }
                }
            }
            Err(RecvTimeoutError::Timeout) => match settle_deadline {
                Some(deadline) if Instant::now() >= deadline => terminal = true,
                _ => continue,
            },
            Err(RecvTimeoutError::Disconnected) => {
                let status = state
                    .process
                    .as_mut()
                    .ok_or(HarnessServerError::HarnessStdoutUnavailable)?
                    .child
                    .wait()?;
                // A clean exit while waiting out the settle window means the
                // native result is not coming; the terminal stop already seen
                // is enough to complete the turn.
                if settle_deadline.is_some() && status.success() {
                    state.process = None;
                    terminal = true;
                } else {
                    return Err(HarnessServerError::HarnessExited {
                        kind: harness.kind(),
                        status,
                        stderr: String::new(),
                    });
                }
            }
        }
        if terminal {
            export_harness_usage_if_available(HarnessUsageExport {
                trace_context: ctx.trace_context,
                harness: harness.kind(),
                model: &usage_span_model,
                model_provider: &usage_span_model_provider,
                turn_id: &usage_span_turn_id,
                input: usage_span_input.as_deref(),
                output: usage_span_output.value().as_deref(),
                start_unix_nano: usage_span_start,
                usage: latest_usage.as_ref(),
            });
            if let Some(notification) = ctx.normalizer.finish_turn(None)? {
                if let ServerNotification::TurnCompleted(completed) = &notification {
                    completed_turn = Some(completed.turn.clone());
                }
                write_value(ctx.stdout, &notification_to_wire_value(&notification)?)?;
            }
            break;
        }
    }

    if let Some(session_id) = last_session_id {
        state.harness_session_id = Some(session_id);
    }
    if let Some(notification) = ctx.normalizer.finish_turn(None)? {
        if let ServerNotification::TurnCompleted(completed) = &notification {
            completed_turn = Some(completed.turn.clone());
        }
        write_value(ctx.stdout, &notification_to_wire_value(&notification)?)?;
    }
    Ok(completed_turn)
}

fn drain_active_blocks_input<H: HarnessServer, W: Write>(
    harness: &H,
    process: &mut HarnessChild,
    normalizer: &mut CodexTurnNormalizer,
    stdout: &mut W,
    thread_id: &str,
    active_blocks: &mut ActiveBlocksInput<'_>,
) -> Result<bool> {
    let mut sent_to_child = false;
    while let Ok(raw) = active_blocks.input_rx.try_recv() {
        let line = raw?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        match parse_blocks_line_with_state(trimmed, active_blocks.blocks_state) {
            Ok(BlocksCommand::User {
                input,
                context,
                client_user_message_id,
                model,
                provider,
                reasoning,
                trace_context: _,
            }) => {
                if model.is_some() || provider.is_some() {
                    eprintln!("blocks active steering ignored model/provider overrides");
                }
                // The running child can't be re-parameterized, but the effort
                // change shouldn't vanish either: stash it so the between-turns
                // loop applies it from the NEXT turn.
                if let Some(reasoning) = reasoning {
                    active_blocks.blocks_state.pending_reasoning = Some(reasoning);
                }
                let harness_input = prepend_context_input(&context, input.clone());
                process
                    .stdin
                    .write_all(&harness.stdin_for_steer(&harness_input)?)?;
                process.stdin.flush()?;
                sent_to_child = true;
                for notification in normalizer.emit_user_message(client_user_message_id, input)? {
                    write_value(stdout, &notification_to_wire_value(&notification)?)?;
                }
            }
            Ok(BlocksCommand::QuestionAnswer {
                question_id,
                answers,
            }) => {
                if active_blocks
                    .blocks_state
                    .take_pending_question(&question_id)
                    .is_none()
                {
                    eprintln!("question_answer dropped: no pending question {question_id}");
                    continue;
                }
                write_child_value(
                    process,
                    &json!({
                        "type": "question_answer",
                        "question_id": question_id,
                        "answers": if answers.is_object() { answers } else { json!({}) },
                    }),
                )?;
                sent_to_child = true;
                write_question_resolved(stdout, &question_id, "answered")?;
            }
            Ok(BlocksCommand::Interrupt) => {
                write_child_value(process, &json!({"type": "interrupt"}))?;
                sent_to_child = true;
                emit_questions_resolved(stdout, active_blocks.blocks_state, "cancelled")?;
            }
            Ok(BlocksCommand::AttachmentChunk) => {}
            Err(error) => {
                eprintln!("invalid blocks input during active turn: {error:#}");
                write_blocks_error(stdout, thread_id, normalizer.turn_id(), error.to_string())?;
            }
        }
    }
    Ok(sent_to_child)
}

fn handle_harness_control_output<W: Write>(
    line: &str,
    stdout: &mut W,
    blocks_state: &mut BlocksState,
) -> Result<bool> {
    let Ok(value) = serde_json::from_str::<Value>(line) else {
        return Ok(false);
    };
    match value.get("type").and_then(Value::as_str) {
        Some("question_requested") => {
            let question_id = value
                .get("question_id")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    HarnessServerError::Protocol(
                        "question_requested missing question_id".to_string(),
                    )
                })?;
            let turn_id = value
                .get("turn_id")
                .and_then(Value::as_str)
                .unwrap_or("turn");
            blocks_state.insert_pending_question(
                question_id.to_string(),
                Value::Null,
                turn_id.to_string(),
            );
            write_value(stdout, &value)?;
            Ok(true)
        }
        Some("question_resolved") => {
            let question_id = value
                .get("question_id")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    HarnessServerError::Protocol(
                        "question_resolved missing question_id".to_string(),
                    )
                })?;
            if blocks_state.take_pending_question(question_id).is_some() {
                write_value(stdout, &value)?;
            }
            Ok(true)
        }
        _ => Ok(false),
    }
}

fn write_child_value(process: &mut HarnessChild, value: &Value) -> Result<()> {
    serde_json::to_writer(&mut process.stdin, value)?;
    process.stdin.write_all(b"\n")?;
    process.stdin.flush()?;
    Ok(())
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

struct HarnessUsageExport<'a> {
    trace_context: Option<&'a TraceContext>,
    harness: HarnessKind,
    model: &'a str,
    model_provider: &'a str,
    turn_id: &'a str,
    input: Option<&'a str>,
    output: Option<&'a str>,
    start_unix_nano: u64,
    usage: Option<&'a NormalizedTokenUsage>,
}

fn export_harness_usage_if_available(export: HarnessUsageExport<'_>) {
    let (Some(trace_context), Some(usage)) = (export.trace_context, export.usage) else {
        return;
    };
    let span = HarnessUsageSpan {
        harness: export.harness,
        model: export.model,
        model_provider: export.model_provider,
        turn_id: export.turn_id,
        input: export.input,
        output: export.output,
        start_unix_nano: export.start_unix_nano,
        end_unix_nano: otel::unix_time_nanos(),
    };
    if let Err(error) = otel::export_harness_usage_span(trace_context, span, usage) {
        eprintln!("harness usage OTLP export failed: {error:#}");
    }
}

fn usage_span_input_value(input: &[UserInput]) -> Option<String> {
    let mut parts = Vec::new();
    for item in input {
        match item {
            UserInput::Text { text, .. } => parts.push(text.clone()),
            UserInput::Image { url, .. } => parts.push(format!("[image: {url}]")),
            UserInput::LocalImage { path, .. } => {
                parts.push(format!("[local image: {}]", path.display()));
            }
            UserInput::Skill { name, path } => {
                parts.push(format!("[skill: {name} at {}]", path.display()));
            }
            UserInput::Mention { name, path } => {
                parts.push(format!("[mention: {name} at {path}]"));
            }
        }
    }
    let joined = parts.join("\n");
    non_empty(Some(&joined)).map(str::to_owned)
}

#[derive(Debug, Default)]
struct UsageSpanOutput {
    item_order: Vec<String>,
    text_by_item_id: HashMap<String, String>,
    fallback: Option<String>,
}

impl UsageSpanOutput {
    fn append_delta(&mut self, item_id: &str, delta: &str) {
        if delta.is_empty() {
            return;
        }
        self.remember_item(item_id);
        self.text_by_item_id
            .entry(item_id.to_string())
            .or_default()
            .push_str(delta);
    }

    fn set_item_text(&mut self, item_id: &str, text: &str) {
        if text.is_empty() {
            return;
        }
        self.remember_item(item_id);
        self.text_by_item_id
            .insert(item_id.to_string(), text.to_string());
    }

    fn set_fallback_if_empty(&mut self, value: &str) {
        if self.value().is_none() {
            self.fallback = clean_string(Some(value));
        }
    }

    fn value(&self) -> Option<String> {
        let mut text = String::new();
        for item_id in &self.item_order {
            if let Some(item_text) = self.text_by_item_id.get(item_id) {
                text.push_str(item_text);
            }
        }
        clean_string(Some(&text)).or_else(|| self.fallback.clone())
    }

    fn remember_item(&mut self, item_id: &str) {
        if self.text_by_item_id.contains_key(item_id) {
            return;
        }
        self.item_order.push(item_id.to_string());
        self.text_by_item_id
            .insert(item_id.to_string(), String::new());
    }
}

fn append_usage_span_output(event: &NormalizedEvent, output: &mut UsageSpanOutput) {
    match event {
        NormalizedEvent::AssistantMessage { content, .. } => {
            for item in content {
                if let NormalizedContent::AgentText { item_id, text } = item {
                    output.set_item_text(item_id, text);
                }
            }
        }
        NormalizedEvent::AgentTextDelta { item_id, delta } => output.append_delta(item_id, delta),
        NormalizedEvent::Error { message } => output.set_fallback_if_empty(message),
        _ => {}
    }
}

fn ensure_harness_process<H: HarnessServer>(harness: &H, state: &mut ThreadState) -> Result<()> {
    if state.process.is_some() {
        return Ok(());
    }

    let mut command = harness.command_for_turn(state);
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .current_dir(&state.cwd)
        .spawn()
        .map_err(|source| HarnessServerError::SpawnHarness {
            cwd: state.cwd.clone(),
            source,
        })?;

    let stdin = child
        .stdin
        .take()
        .ok_or(HarnessServerError::HarnessStdinUnavailable)?;
    let stdout = child
        .stdout
        .take()
        .ok_or(HarnessServerError::HarnessStdoutUnavailable)?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or(HarnessServerError::HarnessStderrUnavailable)?;
    std::thread::spawn(move || {
        let mut parent_stderr = io::stderr().lock();
        let _ = io::copy(&mut stderr, &mut parent_stderr);
    });
    let (stdout_tx, stdout_rx) = mpsc::channel();
    std::thread::spawn(move || {
        let reader = io::BufReader::new(stdout);
        for raw in reader.lines() {
            let should_stop = raw.is_err();
            if stdout_tx.send(raw).is_err() || should_stop {
                break;
            }
        }
    });

    state.process = Some(HarnessChild {
        child,
        stdin,
        stdout: stdout_rx,
    });
    Ok(())
}

fn request_params<T: serde::de::DeserializeOwned>(params: Option<Value>) -> Result<T> {
    serde_json::from_value(params.unwrap_or_else(|| json!({})))
        .map_err(|source| HarnessServerError::InvalidParams { source })
}

fn write_client_response<W: Write>(stdout: &mut W, response: ClientResponse) -> Result<()> {
    let (id, result) = response.into_jsonrpc_parts()?;
    write_value(
        stdout,
        &serde_json::to_value(JSONRPCMessage::Response(JSONRPCResponse { id, result }))?,
    )
}

fn write_error<W: Write>(stdout: &mut W, id: RequestId, code: i64, message: String) -> Result<()> {
    write_value(
        stdout,
        &serde_json::to_value(JSONRPCMessage::Error(JSONRPCError {
            id,
            error: JSONRPCErrorError {
                code,
                message,
                data: None,
            },
        }))?,
    )
}

pub(crate) fn write_blocks_error<W: Write>(
    stdout: &mut W,
    thread_id: &str,
    turn_id: &str,
    message: String,
) -> Result<()> {
    write_value(
        stdout,
        &json!({
            "method": "error",
            "params": {
                "error": {
                    "message": message,
                    "codexErrorInfo": null,
                    "additionalDetails": null
                },
                "willRetry": false,
                "threadId": thread_id,
                "turnId": turn_id
            }
        }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static LOCAL_ATTACHMENT_ENV_LOCK: Mutex<()> = Mutex::new(());

    fn temp_upload_dir() -> PathBuf {
        let path = env::temp_dir().join(format!("harness-server-test-{}", Uuid::new_v4().simple()));
        std::fs::create_dir_all(&path).expect("create temp upload dir");
        unsafe {
            env::set_var("CENTAUR_UPLOADS_DIR", &path);
        }
        path
    }

    fn temp_context_dir(create: bool) -> PathBuf {
        let root =
            env::temp_dir().join(format!("harness-context-test-{}", Uuid::new_v4().simple()));
        std::fs::create_dir_all(&root).expect("create context test root");
        let context = root.join("context");
        if create {
            std::fs::create_dir(&context).expect("create context mount");
        }
        context
    }

    #[test]
    fn blocks_thread_state_uses_centaur_thread_key_and_resume_target() {
        let previous_thread_key = env::var_os("CENTAUR_THREAD_KEY");
        let previous_resume_thread_id = env::var_os("CENTAUR_RESUME_THREAD_ID");
        unsafe {
            env::set_var("CENTAUR_THREAD_KEY", "slack:C123:1780000000.000000");
            env::remove_var("CENTAUR_RESUME_THREAD_ID");
        }

        let state = initial_blocks_thread_state(&ClaudeCodeHarness).expect("initial state");

        assert_eq!(state.id, "slack:C123:1780000000.000000");
        assert_eq!(state.harness_session_id, None);

        unsafe {
            env::set_var("CENTAUR_RESUME_THREAD_ID", "claude-session-1");
        }
        let resumed = initial_blocks_thread_state(&ClaudeCodeHarness).expect("resumed state");

        assert_eq!(resumed.id, "claude-session-1");
        assert_eq!(
            resumed.harness_session_id.as_deref(),
            Some("claude-session-1")
        );

        unsafe {
            if let Some(value) = previous_thread_key {
                env::set_var("CENTAUR_THREAD_KEY", value);
            } else {
                env::remove_var("CENTAUR_THREAD_KEY");
            }
            if let Some(value) = previous_resume_thread_id {
                env::set_var("CENTAUR_RESUME_THREAD_ID", value);
            } else {
                env::remove_var("CENTAUR_RESUME_THREAD_ID");
            }
        }
    }

    #[test]
    fn parses_blocks_user_line_with_model_override() {
        let line = r#"{"type":"user","thread_key":"web:t1","model":"claude-sonnet-4-6","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#;
        let BlocksCommand::User { model, input, .. } = parse_blocks_line(line).expect("parses")
        else {
            panic!("expected user command");
        };
        assert_eq!(model.as_deref(), Some("claude-sonnet-4-6"));
        assert_eq!(input.len(), 1);
    }

    #[test]
    fn parses_blocks_user_line_with_trace_context() {
        let line = r#"{"type":"user","thread_key":"web:t1","trace_id":"01234567-89ab-cdef-0123-456789abcdef","traceparent":"00-0123456789abcdef0123456789abcdef-0123456789abcdef-01","trace_metadata":{"execution_id":"exe_123"},"text":"hi"}"#;
        let BlocksCommand::User { trace_context, .. } = parse_blocks_line(line).expect("parses")
        else {
            panic!("expected user command");
        };

        assert_eq!(trace_context.thread_key.as_deref(), Some("web:t1"));
        assert_eq!(
            trace_context.trace_id.as_deref(),
            Some("01234567-89ab-cdef-0123-456789abcdef")
        );
        assert_eq!(
            trace_context.traceparent.as_deref(),
            Some("00-0123456789abcdef0123456789abcdef-0123456789abcdef-01")
        );
        assert_eq!(
            trace_context
                .metadata
                .get("execution_id")
                .and_then(Value::as_str),
            Some("exe_123")
        );
    }

    #[test]
    fn ignores_blank_model_on_blocks_user_line() {
        let line = r#"{"type":"user","model":"  ","text":"hi"}"#;
        let BlocksCommand::User { model, .. } = parse_blocks_line(line).expect("parses") else {
            panic!("expected user command");
        };
        assert_eq!(model, None);
    }

    #[test]
    fn parses_blocks_user_line_with_provider_override() {
        let line = r#"{"type":"user","thread_key":"web:t1","provider":"amazon-bedrock","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#;
        let BlocksCommand::User { provider, .. } = parse_blocks_line(line).expect("parses") else {
            panic!("expected user command");
        };
        assert_eq!(provider.as_deref(), Some("amazon-bedrock"));
    }

    #[test]
    fn ignores_blank_provider_on_blocks_user_line() {
        let line = r#"{"type":"user","provider":"  ","text":"hi"}"#;
        let BlocksCommand::User { provider, .. } = parse_blocks_line(line).expect("parses") else {
            panic!("expected user command");
        };
        assert_eq!(provider, None);
    }

    #[test]
    fn parses_blocks_user_line_with_reasoning_override() {
        let line = r#"{"type":"user","thread_key":"web:t1","reasoning":"high","message":{"role":"user","content":[{"type":"text","text":"hi"}]}}"#;
        let BlocksCommand::User { reasoning, .. } = parse_blocks_line(line).expect("parses") else {
            panic!("expected user command");
        };
        assert_eq!(reasoning.as_deref(), Some("high"));
    }

    #[test]
    fn ignores_blank_reasoning_on_blocks_user_line() {
        let line = r#"{"type":"user","reasoning":"  ","text":"hi"}"#;
        let BlocksCommand::User { reasoning, .. } = parse_blocks_line(line).expect("parses") else {
            panic!("expected user command");
        };
        assert_eq!(reasoning, None);
    }

    #[test]
    fn defaults_reasoning_to_none_when_absent() {
        let line = r#"{"type":"user","text":"hi"}"#;
        let BlocksCommand::User { reasoning, .. } = parse_blocks_line(line).expect("parses") else {
            panic!("expected user command");
        };
        assert_eq!(reasoning, None);
    }

    #[test]
    fn context_blocks_are_split_from_user_input_and_unknown_types_still_degrade() {
        let line = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [
                    {
                        "type": "context",
                        "text": "[atrium context]\nfrom: Alice Basin (human - driver)"
                    },
                    {"type": "text", "text": "inspect this"},
                    {
                        "type": "attachment",
                        "attachment_type": "document",
                        "name": "notes.txt",
                        "mimeType": "text/plain",
                        "url": "https://example.test/notes.txt"
                    },
                    {
                        "type": "context",
                        "text": "[atrium context]\nfrom: Bob Basin (human - reviewer)"
                    },
                    {"type": "mystery", "text": "still unsupported"}
                ]
            }
        })
        .to_string();

        let BlocksCommand::User { input, context, .. } =
            parse_blocks_line(&line).expect("user parses")
        else {
            panic!("expected user command");
        };

        assert_eq!(
            context,
            vec![
                "[atrium context]\nfrom: Alice Basin (human - driver)".to_string(),
                "[atrium context]\nfrom: Bob Basin (human - reviewer)".to_string(),
            ]
        );
        assert_eq!(input.len(), 3);
        assert_eq!(text_input(&input[0]), "inspect this");
        assert_eq!(
            text_input(&input[1]),
            "[Slack attachment: name=notes.txt mime=text/plain url=https://example.test/notes.txt]"
        );
        assert_eq!(
            text_input(&input[2]),
            "[Unsupported attachment block type: mystery]"
        );
        assert!(
            input
                .iter()
                .filter_map(user_input_text)
                .all(|text| !text.contains("Unsupported attachment block type: context"))
        );
    }

    #[test]
    fn context_is_prepended_to_claude_amp_stdin_and_kept_out_of_echo() {
        let input = vec![UserInput::Text {
            text: "hello".to_string(),
            text_elements: Vec::new(),
        }];
        let context = vec![
            "[atrium context]\nfrom: Alice Basin (human - driver)".to_string(),
            "[atrium context]\nfrom: Bob Basin (human - reviewer)".to_string(),
        ];
        let wrapped = "<context>\n[atrium context]\nfrom: Alice Basin (human - driver)\n[atrium context]\nfrom: Bob Basin (human - reviewer)\n</context>\n\n";
        let delivered = prepend_context_input(&context, input.clone());

        assert_eq!(delivered.len(), 2);
        assert_eq!(text_input(&delivered[0]), wrapped);
        assert_eq!(text_input(&delivered[1]), "hello");

        for bytes in [
            ClaudeCodeHarness.stdin_for_turn(&delivered).unwrap(),
            AmpHarness.stdin_for_turn(&delivered).unwrap(),
            AmpHarness.stdin_for_steer(&delivered).unwrap(),
        ] {
            let value: Value = serde_json::from_slice(&bytes).unwrap();
            let content = value["message"]["content"].as_array().unwrap();
            assert_eq!(content[0]["text"], wrapped);
            assert_eq!(content[1]["text"], "hello");
        }

        let mut normalizer = CodexTurnNormalizer::new(BridgeConfig::new("thread-1", "turn-1"));
        let emitted = normalizer
            .emit_user_message(Some("client-user-1".to_string()), input)
            .unwrap();
        let completed = emitted
            .iter()
            .find_map(|notification| match notification {
                ServerNotification::ItemCompleted(completed) => Some(completed),
                _ => None,
            })
            .expect("expected item completed notification");
        let codex_app_server_protocol::ThreadItem::UserMessage { content, .. } = &completed.item
        else {
            panic!("expected user message item");
        };

        assert_eq!(content.len(), 1);
        assert_eq!(text_input(&content[0]), "hello");
    }

    #[test]
    fn context_gate_waits_until_marker_arrives() {
        let context = temp_context_dir(true);
        let marker = context.join(".atrium-context-ready");
        let writer = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(30));
            std::fs::write(marker, b"ready\n").unwrap();
        });

        let readiness = wait_for_atrium_context_path(true, &context, Duration::from_secs(1));

        writer.join().unwrap();
        assert!(context.join(".atrium-context-ready").is_file());
        assert_eq!(readiness, ContextReadiness::Ready);
    }

    #[test]
    fn context_gate_skips_absent_mount() {
        let context = temp_context_dir(false);
        let start = Instant::now();
        let readiness = wait_for_atrium_context_path(true, &context, Duration::from_secs(1));
        assert!(start.elapsed() < Duration::from_millis(100));
        assert_eq!(readiness, ContextReadiness::Skipped);
    }

    #[test]
    fn context_gate_timeout_proceeds() {
        let context = temp_context_dir(true);
        let start = Instant::now();
        let readiness = wait_for_atrium_context_path(true, &context, Duration::from_millis(20));
        assert!(start.elapsed() >= Duration::from_millis(20));
        assert_eq!(readiness, ContextReadiness::TimedOut);
    }

    #[test]
    fn context_gate_never_waits_after_first_turn() {
        let context = temp_context_dir(true);
        let start = Instant::now();
        let readiness = wait_for_atrium_context_path(false, &context, Duration::from_secs(1));
        assert!(start.elapsed() < Duration::from_millis(100));
        assert_eq!(readiness, ContextReadiness::Skipped);
    }

    #[test]
    fn context_gate_timeout_note_is_prepended_only_after_timeout() {
        let input = vec![UserInput::Text {
            text: "hello".to_string(),
            text_elements: Vec::new(),
        }];

        let delivered = prepend_context_readiness_note(ContextReadiness::TimedOut, input.clone());
        assert_eq!(delivered.len(), 2);
        assert_eq!(text_input(&delivered[0]), ATRIUM_CONTEXT_TIMEOUT_NOTE);
        assert_eq!(text_input(&delivered[1]), "hello");

        assert_eq!(
            prepend_context_readiness_note(ContextReadiness::Ready, input.clone()),
            input
        );
    }

    #[test]
    fn usage_span_output_replaces_delta_reconstruction_with_canonical_text() {
        let mut output = UsageSpanOutput::default();
        append_usage_span_output(
            &NormalizedEvent::AgentTextDelta {
                item_id: "msg-1".to_string(),
                delta: "hel".to_string(),
            },
            &mut output,
        );
        append_usage_span_output(
            &NormalizedEvent::AgentTextDelta {
                item_id: "msg-1".to_string(),
                delta: "lo".to_string(),
            },
            &mut output,
        );
        append_usage_span_output(
            &NormalizedEvent::AssistantMessage {
                partial: false,
                stop_reason: Some("end_turn".to_string()),
                content: vec![NormalizedContent::AgentText {
                    item_id: "msg-1".to_string(),
                    text: "hello".to_string(),
                }],
            },
            &mut output,
        );

        assert_eq!(output.value().as_deref(), Some("hello"));
    }

    #[test]
    fn parses_attachment_chunk_without_starting_turn() {
        let _upload_dir = temp_upload_dir();
        let mut state = BlocksState::default();
        let line = r#"{"type":"attachment.chunk","attachmentId":"att-1","name":"large-upload.mp4","mimeType":"video/mp4","attachmentType":"video","chunkIndex":0,"final":true,"dataBase64":"aGVsbG8="}"#;

        assert!(matches!(
            parse_blocks_line_with_state(line, &mut state).expect("parses"),
            BlocksCommand::AttachmentChunk
        ));

        let staged = state.staged.get("att-1").expect("staged attachment");
        assert_eq!(staged.mime_type.as_deref(), Some("video/mp4"));
        assert_eq!(
            std::fs::read(&staged.path).expect("read staged bytes"),
            b"hello"
        );
    }

    #[test]
    fn staged_attachment_block_becomes_local_file_text_input() {
        let _upload_dir = temp_upload_dir();
        let mut state = BlocksState::default();
        let chunk = r#"{"type":"attachment.chunk","attachmentId":"att-1","name":"clip.mp4","mimeType":"video/mp4","attachmentType":"video","chunkIndex":0,"final":true,"dataBase64":"aGVsbG8="}"#;
        parse_blocks_line_with_state(chunk, &mut state).expect("chunk parses");

        let user = r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"analyze this"},{"type":"attachment","attachment_type":"video","stagedAttachmentId":"att-1","name":"clip.mp4","mimeType":"video/mp4","size":5}]}}"#;
        let BlocksCommand::User { input, .. } =
            parse_blocks_line_with_state(user, &mut state).expect("user parses")
        else {
            panic!("expected user command");
        };

        assert_eq!(input.len(), 2);
        assert_eq!(
            input[0],
            UserInput::Text {
                text: "analyze this".to_string(),
                text_elements: Vec::new()
            }
        );
        let UserInput::Text { text, .. } = &input[1] else {
            panic!("expected staged attachment to become text");
        };
        assert!(text.starts_with("[Attached file saved to "));
        assert!(text.ends_with("clip.mp4]"));
    }

    #[test]
    fn inline_attachment_block_becomes_local_file_text_input() {
        let _upload_dir = temp_upload_dir();
        let mut state = BlocksState::default();
        let user = r#"{"type":"user","message":{"role":"user","content":[{"type":"attachment","attachment_type":"document","dataBase64":"aGVsbG8=","name":"notes.txt","mimeType":"text/plain","size":5}]}}"#;
        let BlocksCommand::User { input, .. } =
            parse_blocks_line_with_state(user, &mut state).expect("user parses")
        else {
            panic!("expected user command");
        };

        assert_eq!(input.len(), 1);
        let UserInput::Text { text, .. } = &input[0] else {
            panic!("expected inline attachment to become text");
        };
        assert!(text.starts_with("[Attached file saved to "));
        assert!(text.ends_with("notes.txt]"));
    }

    #[test]
    fn local_path_attachment_block_becomes_local_file_text_input() {
        let dir = temp_upload_dir();
        let path = dir.join("committed-artifact.md");
        std::fs::write(&path, b"hello").expect("write local artifact");
        let user = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{
                    "type": "attachment",
                    "attachment_type": "document",
                    "localPath": path,
                    "name": "committed-artifact.md",
                    "mimeType": "text/markdown"
                }]
            }
        })
        .to_string();
        let BlocksCommand::User { input, .. } = parse_blocks_line(&user).expect("user parses")
        else {
            panic!("expected user command");
        };

        assert_eq!(input.len(), 1);
        let UserInput::Text { text, .. } = &input[0] else {
            panic!("expected local path attachment to become text");
        };
        assert_eq!(
            text,
            &format!("[Attached file saved to {}]", path.display())
        );
    }

    #[test]
    fn missing_local_path_attachment_block_errors_instead_of_degrading_to_text() {
        let _env_guard = LOCAL_ATTACHMENT_ENV_LOCK.lock().expect("env lock");
        let path = temp_upload_dir().join("missing-artifact.md");
        let previous_wait = env::var_os(LOCAL_ATTACHMENT_WAIT_ENV);
        unsafe {
            env::set_var(LOCAL_ATTACHMENT_WAIT_ENV, "1");
        }
        let user = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{
                    "type": "attachment",
                    "attachment_type": "document",
                    "localPath": path,
                    "name": "missing-artifact.md",
                    "mimeType": "text/markdown"
                }]
            }
        })
        .to_string();

        let error = parse_blocks_line(&user).expect_err("missing localPath should fail");
        restore_local_attachment_wait(previous_wait);

        assert!(matches!(
            error,
            HarnessServerError::InvalidBlocksInput { .. }
        ));
        assert!(
            error
                .to_string()
                .contains("localPath attachment \"missing-artifact.md\" is missing at "),
            "{error}"
        );
    }

    #[test]
    fn non_file_local_path_attachment_block_errors_instead_of_degrading_to_text() {
        let path = temp_upload_dir();
        let user = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{
                    "type": "attachment",
                    "attachment_type": "document",
                    "localPath": path,
                    "name": "artifact-dir",
                    "mimeType": "text/markdown"
                }]
            }
        })
        .to_string();

        let error = parse_blocks_line(&user).expect_err("directory localPath should fail");

        assert!(matches!(
            error,
            HarnessServerError::InvalidBlocksInput { .. }
        ));
        assert!(
            error
                .to_string()
                .contains("localPath attachment \"artifact-dir\" is not readable at "),
            "{error}"
        );
    }

    #[test]
    fn local_path_attachment_waits_for_delayed_artifact() {
        let _env_guard = LOCAL_ATTACHMENT_ENV_LOCK.lock().expect("env lock");
        let dir = temp_upload_dir();
        let path = dir.join("delayed-artifact.md");
        let previous_wait = env::var_os(LOCAL_ATTACHMENT_WAIT_ENV);
        unsafe {
            env::set_var(LOCAL_ATTACHMENT_WAIT_ENV, "500");
        }
        let writer_path = path.clone();
        let writer = thread::spawn(move || {
            thread::sleep(Duration::from_millis(25));
            std::fs::write(writer_path, b"ready").expect("write delayed artifact");
        });
        let user = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [{
                    "type": "attachment",
                    "attachment_type": "document",
                    "localPath": path,
                    "name": "delayed-artifact.md",
                    "mimeType": "text/markdown"
                }]
            }
        })
        .to_string();
        let BlocksCommand::User { input, .. } = parse_blocks_line(&user).expect("user parses")
        else {
            panic!("expected user command");
        };
        writer.join().expect("writer finished");
        restore_local_attachment_wait(previous_wait);

        assert_eq!(input.len(), 1);
        let UserInput::Text { text, .. } = &input[0] else {
            panic!("expected local path attachment to become text");
        };
        assert_eq!(
            text,
            &format!("[Attached file saved to {}]", path.display())
        );
    }

    fn restore_local_attachment_wait(previous: Option<std::ffi::OsString>) {
        unsafe {
            if let Some(value) = previous {
                env::set_var(LOCAL_ATTACHMENT_WAIT_ENV, value);
            } else {
                env::remove_var(LOCAL_ATTACHMENT_WAIT_ENV);
            }
        }
    }

    fn text_input(input: &UserInput) -> &str {
        user_input_text(input).expect("expected text input")
    }

    fn user_input_text(input: &UserInput) -> Option<&str> {
        match input {
            UserInput::Text { text, .. } => Some(text.as_str()),
            _ => None,
        }
    }
}
