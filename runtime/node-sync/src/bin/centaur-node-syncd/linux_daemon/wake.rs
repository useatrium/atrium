//! Linux daemon wake sources and event-driven tick pacing.
//!
//! Bridges SSE and filesystem watch messages into the orchestration loop.

use centaur_node_sync::daemon::loop_state::DirtySessions;
use centaur_node_sync::pacing::{TickPacer, TickPacerAction};
use centaur_node_sync::sse::{ChangedEvent, DirtySet, SseOutput, SseParser};
use centaur_node_sync::watch::WatchMessage;
use std::collections::{HashSet, VecDeque};
use std::io::Read;
use std::sync::mpsc;
use std::time::{Duration, Instant};

#[derive(Debug)]
pub(super) enum StreamMessage {
    Healthy,
    Unhealthy,
    Changed(ChangedEvent),
}

#[derive(Debug)]
pub(super) enum WakeMessage {
    Stream(StreamMessage),
    LocalDirty {
        session: String,
        path: Option<std::path::PathBuf>,
    },
}

pub(super) fn start_change_stream(base_url: &str, api_key: &str, tx: mpsc::Sender<WakeMessage>) {
    let base_url = base_url.trim_end_matches('/').to_string();
    let api_key = api_key.to_string();
    std::thread::spawn(move || stream_reader_loop(base_url, api_key, tx));
}

pub(super) fn start_watch_bridge(rx: mpsc::Receiver<WatchMessage>, tx: mpsc::Sender<WakeMessage>) {
    std::thread::spawn(move || {
        while let Ok(message) = rx.recv() {
            match message {
                WatchMessage::Dirty { session, path } => {
                    if tx.send(WakeMessage::LocalDirty { session, path }).is_err() {
                        return;
                    }
                }
            }
        }
    });
}

fn stream_reader_loop(base_url: String, api_key: String, tx: mpsc::Sender<WakeMessage>) {
    let url = format!("{base_url}/api/internal/changes/stream");
    let agent = ureq::AgentBuilder::new()
        .timeout_read(Duration::from_secs(46))
        .build();
    let mut backoff = Duration::from_secs(1);
    loop {
        let response = agent.get(&url).set("x-api-key", &api_key).call();
        match response {
            Ok(response) => {
                let _ = tx.send(WakeMessage::Stream(StreamMessage::Healthy));
                backoff = Duration::from_secs(1);
                let mut parser = SseParser::default();
                let mut reader = response.into_reader();
                let mut buf = [0u8; 4096];
                loop {
                    match reader.read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => {
                            for output in parser.push(&buf[..n]) {
                                forward_sse_output(&tx, output);
                            }
                        }
                        Err(error) => {
                            eprintln!("node-sync changes stream read: {error}");
                            break;
                        }
                    }
                }
                for output in parser.finish() {
                    forward_sse_output(&tx, output);
                }
                let _ = tx.send(WakeMessage::Stream(StreamMessage::Unhealthy));
            }
            Err(error) => {
                eprintln!("node-sync changes stream connect: {error}");
                let _ = tx.send(WakeMessage::Stream(StreamMessage::Unhealthy));
            }
        }
        std::thread::sleep(backoff);
        backoff = (backoff * 2).min(Duration::from_secs(15));
    }
}

fn forward_sse_output(tx: &mpsc::Sender<WakeMessage>, output: SseOutput) {
    match output {
        SseOutput::Hello { .. } => {
            let _ = tx.send(WakeMessage::Stream(StreamMessage::Healthy));
        }
        SseOutput::Changed(event) => {
            let _ = tx.send(WakeMessage::Stream(StreamMessage::Changed(event)));
        }
        SseOutput::Malformed { event, error } => {
            eprintln!("node-sync changes stream malformed {event}: {error}");
        }
    }
}

pub(super) fn drain_wake_messages(
    rx: &mpsc::Receiver<WakeMessage>,
    pending: &mut VecDeque<WakeMessage>,
    stream_healthy: &mut bool,
    dirty: &mut DirtySet,
    local_dirty: &mut DirtySessions,
    current_atrium_keys: &HashSet<String>,
) {
    while let Some(message) = pending.pop_front() {
        handle_wake_message(
            message,
            stream_healthy,
            dirty,
            local_dirty,
            current_atrium_keys,
        );
    }
    while let Ok(message) = rx.try_recv() {
        handle_wake_message(
            message,
            stream_healthy,
            dirty,
            local_dirty,
            current_atrium_keys,
        );
    }
}

fn handle_wake_message(
    message: WakeMessage,
    stream_healthy: &mut bool,
    dirty: &mut DirtySet,
    local_dirty: &mut DirtySessions,
    current_atrium_keys: &HashSet<String>,
) {
    match message {
        WakeMessage::Stream(StreamMessage::Healthy) => *stream_healthy = true,
        WakeMessage::Stream(StreamMessage::Unhealthy) => *stream_healthy = false,
        WakeMessage::Stream(StreamMessage::Changed(event)) => {
            dirty.mark_changed(&event, current_atrium_keys.iter().map(String::as_str));
        }
        WakeMessage::LocalDirty { session, path } => {
            local_dirty.mark(session, path);
        }
    }
}

pub(super) fn wait_for_next_tick(
    rx: &mpsc::Receiver<WakeMessage>,
    pending: &mut VecDeque<WakeMessage>,
    stream_healthy: &mut bool,
    local_dirty: &mut DirtySessions,
    current_atrium_keys: &HashSet<String>,
    tick_start: Instant,
    interval: Duration,
) -> bool {
    let deadline = tick_start + interval;
    let mut pacer = TickPacer::default();
    loop {
        let decision = pacer.next(Instant::now(), tick_start, deadline);
        let TickPacerAction::WaitMore(timeout) = decision.action else {
            return false;
        };
        match rx.recv_timeout(timeout) {
            Ok(message) => {
                let made_dirty = handle_wait_wake_message(
                    message,
                    pending,
                    stream_healthy,
                    local_dirty,
                    current_atrium_keys,
                );
                let decision =
                    pacer.observe_message(Instant::now(), tick_start, deadline, made_dirty);
                if matches!(decision.action, TickPacerAction::TickNow) {
                    return false;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let decision = pacer.observe_timeout(Instant::now(), tick_start, deadline);
                if matches!(decision.action, TickPacerAction::TickNow) {
                    return false;
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                *stream_healthy = false;
                let decision = pacer.observe_disconnected(Instant::now(), deadline);
                if let TickPacerAction::WaitMore(timeout) = decision.action {
                    std::thread::sleep(timeout);
                }
                return decision.stream_disconnected;
            }
        }
    }
}

fn handle_wait_wake_message(
    message: WakeMessage,
    pending: &mut VecDeque<WakeMessage>,
    stream_healthy: &mut bool,
    local_dirty: &mut DirtySessions,
    current_atrium_keys: &HashSet<String>,
) -> bool {
    match message {
        WakeMessage::Stream(StreamMessage::Healthy) => {
            *stream_healthy = true;
            false
        }
        WakeMessage::Stream(StreamMessage::Unhealthy) => {
            *stream_healthy = false;
            false
        }
        WakeMessage::Stream(StreamMessage::Changed(event)) => {
            let made_dirty = changed_event_targets_current_session(&event, current_atrium_keys);
            pending.push_back(WakeMessage::Stream(StreamMessage::Changed(event)));
            made_dirty
        }
        WakeMessage::LocalDirty { session, path } => local_dirty.mark(session, path),
    }
}

fn changed_event_targets_current_session(
    event: &ChangedEvent,
    current_atrium_keys: &HashSet<String>,
) -> bool {
    if let Some(key) = event.key.as_deref().filter(|key| !key.trim().is_empty()) {
        current_atrium_keys.contains(key)
    } else {
        !current_atrium_keys.is_empty()
    }
}
