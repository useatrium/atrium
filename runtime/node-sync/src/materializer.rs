use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use crate::runtime::{AtriumChannel, AtriumClient, ContextDeltaRequest, ContextDocResponse};
use crate::state::{ContextDocState, DaemonState};

const MODE_APPEND: &str = "append";
static BYTES_FETCHED: AtomicU64 = AtomicU64::new(0);
static BYTES_WRITTEN: AtomicU64 = AtomicU64::new(0);
static METRIC_WINDOW: OnceLock<Mutex<Instant>> = OnceLock::new();
static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ContextIoBytes {
    pub fetched: u64,
    pub written: u64,
}

/// Drain the process-wide context I/O counters. The daemon uses the same
/// counters for its per-node minute metric; this is public for regression tests.
pub fn take_context_io_bytes() -> ContextIoBytes {
    ContextIoBytes {
        fetched: BYTES_FETCHED.swap(0, Ordering::Relaxed),
        written: BYTES_WRITTEN.swap(0, Ordering::Relaxed),
    }
}

fn record_fetched(bytes: usize) {
    BYTES_FETCHED.fetch_add(bytes as u64, Ordering::Relaxed);
}

fn record_written(bytes: usize) {
    BYTES_WRITTEN.fetch_add(bytes as u64, Ordering::Relaxed);
}

fn maybe_report_context_io() {
    let now = Instant::now();
    let window = METRIC_WINDOW.get_or_init(|| Mutex::new(now));
    let mut started = window
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if now.duration_since(*started) < Duration::from_secs(60) {
        return;
    }
    let elapsed = now.duration_since(*started).as_secs().max(1);
    *started = now;
    let io = take_context_io_bytes();
    println!(
        "event=node_sync_context_io window_secs={elapsed} bytes_fetched={} bytes_written={}",
        io.fetched, io.written
    );
}

const ROOT_README: &str = r#"# Atrium Context Mount

This read-only mount is the local context map for the Atrium channel and its sessions. It refreshes within a few seconds of server-side changes.

If a listed path is missing, it is still materializing — wait a few seconds and retry. `.atrium-context-ready` appears here once the initial seed (this guide, the channel index, and the active channel's docs) is complete; you can otherwise ignore it.

## Tree

- `README.md`: this guide.
- `sessions/index.md`: entry point for materialized sessions.
- `sessions/<id>/transcript.md`: lean user-visible transcript.
- `sessions/<id>/summary.md`: compact status and key-action summary.
- `sessions/<id>/meta.json`: session metadata, channel, driver, and participants.
- `sessions/<id>/tools.md`: commands and tool calls.
- `sessions/<id>/artifacts.md`: artifacts captured by the session.
- `sessions/<id>/changes.md`: files changed by the session.
- `channels/index.md`: entry point for channel context.
- `channels/<id>/channel.md`: channel metadata, roster, and current state.
- `channels/<id>/chat.md`: channel chat transcript.
- `channel`: symlink to the active channel directory.

## Recipes

- Follow an `/e/<handle>` link: `rg -n "<handle>" ~/context/channels/*/chat.md`, then read about 30 lines around the hit.
- Find a topic: `rg -i "<topic>" ~/context/channels/*/chat.md ~/context/sessions/*/summary.md`.
- See who is here: `cat ~/context/channel/channel.md`.
"#;

pub const CONTEXT_READY_MARKER: &str = ".atrium-context-ready";

pub const ATRIUM_DOCS: &[(&str, &str)] = &[
    ("transcript", "transcript.md"),
    ("full", "full.md"),
    ("summary", "summary.md"),
    ("meta", "meta.json"),
    ("tools", "tools.md"),
    ("artifacts", "artifacts.md"),
    ("changes-doc", "changes.md"),
    ("events", "events.jsonl"),
];
pub const ATRIUM_CHANNEL_DOCS: &[(&str, &str)] = &[("channel", "channel.md"), ("chat", "chat.md")];

/// Poll one page of the Atrium change-feed and materialize each changed session's
/// docs under `{atrium_root}/sessions/<id>/`. Writes are atomic per file.
pub fn materialize_once<C: AtriumClient + ?Sized>(
    client: &C,
    atrium_root: &Path,
    since: &str,
    state: &mut DaemonState,
) -> Result<String, String> {
    let (session_ids, next_cursor) = client.atrium_changes(since)?;
    materialize_changed_sessions(client, atrium_root, since, session_ids, next_cursor, state)
}

pub fn materialize_changed_sessions<C: AtriumClient + ?Sized>(
    client: &C,
    atrium_root: &Path,
    since: &str,
    session_ids: Vec<String>,
    next_cursor: String,
    state: &mut DaemonState,
) -> Result<String, String> {
    if let Err(error) = write_mount_readme(atrium_root) {
        eprintln!("atrium materializer write README.md: {error}");
    }
    if session_ids.is_empty() {
        if let Err(error) = write_sessions_index(atrium_root) {
            eprintln!("atrium materializer write sessions/index.md: {error}");
        }
        maybe_report_context_io();
        return Ok(since.to_string());
    }

    for session_id in session_ids {
        let session_dir = atrium_root.join("sessions").join(&session_id);
        let mut cold_start_bytes = 0u64;
        for (doc, filename) in ATRIUM_DOCS {
            let dst = session_dir.join(filename);
            let proven = state
                .atrium_docs
                .get(&session_id)
                .and_then(|docs| docs.get(*doc))
                .filter(|_| dst.is_file())
                .cloned();
            let request = proven.as_ref().map(delta_request);
            match fetch_and_apply_session_doc(
                client,
                atrium_root,
                &session_id,
                doc,
                &dst,
                request.as_ref(),
                &mut cold_start_bytes,
            ) {
                Ok(next) => update_doc_state(&mut state.atrium_docs, &session_id, doc, next),
                Err(error) => {
                    // A 403 on full/events is the EXPECTED full-view gate response
                    // when the viewer lacks raw access — the agent simply gets
                    // lean-only context. Don't log it as an error (it would spam
                    // every tick whenever the gate is off, which is the default).
                    if !error.contains("status code 403") {
                        eprintln!("atrium materializer fetch {session_id}/{doc}: {error}");
                    }
                }
            }
        }
        if cold_start_bytes > 0 {
            println!(
                "event=node_sync_context_cold_start session={} bytes_fetched={cold_start_bytes}",
                session_id
            );
        }
    }
    if let Err(error) = write_sessions_index(atrium_root) {
        eprintln!("atrium materializer write sessions/index.md: {error}");
    }

    maybe_report_context_io();
    Ok(next_cursor)
}

fn delta_request(state: &ContextDocState) -> ContextDeltaRequest {
    ContextDeltaRequest {
        epoch: state.epoch.clone(),
        watermark: state.last_seq,
    }
}

fn update_doc_state(
    states: &mut std::collections::HashMap<
        String,
        std::collections::HashMap<String, ContextDocState>,
    >,
    id: &str,
    doc: &str,
    next: Option<ContextDocState>,
) {
    if let Some(next) = next {
        states
            .entry(id.to_string())
            .or_default()
            .insert(doc.to_string(), next);
    } else if let Some(docs) = states.get_mut(id) {
        docs.remove(doc);
        if docs.is_empty() {
            states.remove(id);
        }
    }
}

fn response_state(response: &ContextDocResponse) -> Option<ContextDocState> {
    Some(ContextDocState {
        epoch: response.epoch.clone()?,
        last_seq: response.next_watermark?,
    })
}

fn apply_doc_response(
    atrium_root: &Path,
    dst: &Path,
    response: &ContextDocResponse,
    request: Option<&ContextDeltaRequest>,
) -> Result<Option<ContextDocState>, String> {
    let can_append = response.mode.as_deref() == Some(MODE_APPEND)
        && request.is_some_and(|request| response.epoch.as_deref() == Some(&request.epoch))
        && dst.is_file();
    if can_append {
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(dst)
            .map_err(|e| format!("open append {}: {e}", dst.display()))?;
        file.write_all(&response.body)
            .map_err(|e| format!("append {}: {e}", dst.display()))?;
        record_written(response.body.len());
    } else {
        write_atomic(atrium_root, dst, &response.body)?;
        record_written(response.body.len());
    }
    Ok(response_state(response))
}

fn fetch_and_apply_session_doc<C: AtriumClient + ?Sized>(
    client: &C,
    atrium_root: &Path,
    session_id: &str,
    doc: &str,
    dst: &Path,
    request: Option<&ContextDeltaRequest>,
    cold_start_bytes: &mut u64,
) -> Result<Option<ContextDocState>, String> {
    let mut response = client.atrium_doc_delta(session_id, doc, request)?;
    record_fetched(response.body.len());
    if request.is_none() {
        *cold_start_bytes = cold_start_bytes.saturating_add(response.body.len() as u64);
    }
    let append_is_unproven = response.mode.as_deref() == Some(MODE_APPEND)
        && !request.is_some_and(|request| {
            response.epoch.as_deref() == Some(&request.epoch) && dst.is_file()
        });
    if append_is_unproven {
        response = client.atrium_doc_delta(session_id, doc, None)?;
        record_fetched(response.body.len());
        *cold_start_bytes = cold_start_bytes.saturating_add(response.body.len() as u64);
        if response.mode.as_deref() == Some(MODE_APPEND) {
            return Err("server returned append to a full-document request".to_string());
        }
    }
    apply_doc_response(atrium_root, dst, &response, request)
}

pub fn write_mount_readme(atrium_root: &Path) -> Result<(), String> {
    write_atomic(
        atrium_root,
        &atrium_root.join("README.md"),
        ROOT_README.as_bytes(),
    )
}

fn write_sessions_index(atrium_root: &Path) -> Result<(), String> {
    let sessions_dir = atrium_root.join("sessions");
    let mut rows = read_session_index_rows(&sessions_dir)?;
    rows.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.dir_name.cmp(&b.dir_name))
    });

    let mut lines = vec!["# Sessions".to_string(), String::new()];
    if rows.is_empty() {
        lines.push("No sessions have been materialized yet.".to_string());
    } else {
        lines.push("| Title | Status | Channel | Driver | Updated | Dir |".to_string());
        lines.push("|---|---|---|---|---|---|".to_string());
        for row in rows {
            lines.push(format!(
                "| {} | {} | {} | {} | {} | `{}` |",
                markdown_cell(&row.title),
                markdown_cell(&row.status),
                markdown_cell(&row.channel_name),
                markdown_cell(&row.driver_name),
                markdown_cell(&row.updated_at),
                row.dir_name
            ));
        }
    }
    lines.push(String::new());
    write_atomic(
        atrium_root,
        &sessions_dir.join("index.md"),
        lines.join("\n").as_bytes(),
    )
}

#[derive(Debug, PartialEq, Eq)]
struct SessionIndexRow {
    dir_name: String,
    title: String,
    status: String,
    channel_name: String,
    driver_name: String,
    updated_at: String,
}

fn read_session_index_rows(sessions_dir: &Path) -> Result<Vec<SessionIndexRow>, String> {
    let entries = match std::fs::read_dir(sessions_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("read_dir {}: {error}", sessions_dir.display())),
    };
    let mut rows = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if !file_type.is_dir() {
            continue;
        }
        let dir_name = entry.file_name().to_string_lossy().into_owned();
        let meta_path = entry.path().join("meta.json");
        let bytes = match std::fs::read(&meta_path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("read {}: {error}", meta_path.display())),
        };
        let Ok(meta) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
            continue;
        };
        rows.push(SessionIndexRow {
            dir_name,
            title: json_string(&meta, "title").unwrap_or_else(|| "Untitled".to_string()),
            status: json_string(&meta, "status").unwrap_or_else(|| "unknown".to_string()),
            channel_name: json_string(&meta, "channelName")
                .unwrap_or_else(|| "unknown".to_string()),
            driver_name: match (
                json_string(&meta, "driverName"),
                json_string(&meta, "driverHandle"),
            ) {
                (Some(name), Some(handle)) => format!("{name} (@{handle})"),
                (Some(name), None) => name,
                (None, _) => json_string(&meta, "driver").unwrap_or_else(|| "unknown".to_string()),
            },
            updated_at: json_string(&meta, "updatedAt")
                .or_else(|| json_string(&meta, "completedAt"))
                .or_else(|| json_string(&meta, "createdAt"))
                .unwrap_or_else(|| "unknown".to_string()),
        });
    }
    Ok(rows)
}

fn json_string(value: &serde_json::Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(|field| field.as_str())
        .filter(|field| !field.is_empty())
        .map(ToOwned::to_owned)
}

fn markdown_cell(value: &str) -> String {
    value.replace('|', "\\|").replace('\n', " ")
}

pub fn materialize_channel_docs<C: AtriumClient + ?Sized>(
    client: &C,
    atrium_root: &Path,
    only_channel_ids: Option<&[String]>,
    state: &mut DaemonState,
) -> Result<(), String> {
    let channels = client.atrium_channels()?;
    let channels_dir = atrium_root.join("channels");
    write_atomic(
        atrium_root,
        &channels_dir.join("index.md"),
        render_channels_index(&channels).as_bytes(),
    )?;
    let active = channels.iter().find(|channel| channel.active);
    let marker_missing = !atrium_root.join(CONTEXT_READY_MARKER).is_file();
    let active_selected = active.is_some_and(|channel| match only_channel_ids {
        Some(ids) => ids.iter().any(|id| id == &channel.id),
        None => true,
    });
    if let Some(active) = active.filter(|channel| {
        marker_missing || (active_selected && channel_needs_refresh(atrium_root, state, channel))
    }) {
        materialize_one_channel(client, atrium_root, active, true, state)?;
        update_active_channel_symlink(atrium_root, Some(active))?;
        write_mount_readme(atrium_root)?;
        write_atomic(
            atrium_root,
            &atrium_root.join(CONTEXT_READY_MARKER),
            b"ready\n",
        )?;
    } else if active.is_none() {
        update_active_channel_symlink(atrium_root, None)?;
    }
    if only_channel_ids.is_none() {
        prune_stale_channel_dirs(&channels_dir, &channels)?;
    }

    let selected = |channel: &AtriumChannel| -> bool {
        match only_channel_ids {
            Some(ids) => ids.iter().any(|id| id == &channel.id),
            None => true,
        }
    };
    for channel in &channels {
        if channel.active
            || !selected(channel)
            || !channel_needs_refresh(atrium_root, state, channel)
        {
            continue;
        }
        materialize_one_channel(client, atrium_root, channel, false, state)?;
    }
    maybe_report_context_io();
    Ok(())
}

fn channel_needs_refresh(atrium_root: &Path, state: &DaemonState, channel: &AtriumChannel) -> bool {
    state.atrium_channel_watermarks.get(&channel.id) != Some(&channel.last_event_id)
        || ATRIUM_CHANNEL_DOCS.iter().any(|(_, filename)| {
            !atrium_root
                .join("channels")
                .join(&channel.id)
                .join(filename)
                .is_file()
        })
}

fn materialize_one_channel<C: AtriumClient + ?Sized>(
    client: &C,
    atrium_root: &Path,
    channel: &AtriumChannel,
    required: bool,
    state: &mut DaemonState,
) -> Result<(), String> {
    let channel_dir = atrium_root.join("channels").join(&channel.id);
    let mut all_succeeded = true;
    for (doc, filename) in ATRIUM_CHANNEL_DOCS {
        let dst = channel_dir.join(filename);
        let proven = state
            .atrium_channel_docs
            .get(&channel.id)
            .and_then(|docs| docs.get(*doc))
            .filter(|_| dst.is_file())
            .cloned();
        let request = proven.as_ref().map(delta_request);
        let result = fetch_and_apply_channel_doc(
            client,
            atrium_root,
            &channel.id,
            doc,
            &dst,
            request.as_ref(),
        );
        if let Ok(next) = &result {
            update_doc_state(
                &mut state.atrium_channel_docs,
                &channel.id,
                doc,
                next.clone(),
            );
        }
        if let Err(error) = result {
            all_succeeded = false;
            if required {
                return Err(format!("active channel {}/{}: {error}", channel.id, doc));
            }
            if !error.contains("status code 403") && !error.contains("status code 404") {
                eprintln!(
                    "atrium channel materializer fetch/write {}/{}: {error}",
                    channel.id, doc
                );
            }
        }
    }
    if all_succeeded {
        state
            .atrium_channel_watermarks
            .insert(channel.id.clone(), channel.last_event_id);
    }
    Ok(())
}

fn fetch_and_apply_channel_doc<C: AtriumClient + ?Sized>(
    client: &C,
    atrium_root: &Path,
    channel_id: &str,
    doc: &str,
    dst: &Path,
    request: Option<&ContextDeltaRequest>,
) -> Result<Option<ContextDocState>, String> {
    let mut response = client.atrium_channel_doc_delta(channel_id, doc, request)?;
    record_fetched(response.body.len());
    let append_is_unproven = response.mode.as_deref() == Some(MODE_APPEND)
        && !request.is_some_and(|request| {
            response.epoch.as_deref() == Some(&request.epoch) && dst.is_file()
        });
    if append_is_unproven {
        response = client.atrium_channel_doc_delta(channel_id, doc, None)?;
        record_fetched(response.body.len());
        if response.mode.as_deref() == Some(MODE_APPEND) {
            return Err("server returned append to a full-document request".to_string());
        }
    }
    apply_doc_response(atrium_root, dst, &response, request)
}

fn prune_stale_channel_dirs(channels_dir: &Path, channels: &[AtriumChannel]) -> Result<(), String> {
    let entries = std::fs::read_dir(channels_dir)
        .map_err(|e| format!("read {}: {e}", channels_dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("read {} entry: {e}", channels_dir.display()))?;
        let file_type = entry
            .file_type()
            .map_err(|e| format!("stat {}: {e}", entry.path().display()))?;
        if !file_type.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if channels.iter().any(|channel| channel.id == name) {
            continue;
        }
        std::fs::remove_dir_all(entry.path())
            .map_err(|e| format!("remove stale channel {}: {e}", entry.path().display()))?;
    }
    Ok(())
}

fn render_channels_index(channels: &[AtriumChannel]) -> String {
    let mut lines = vec![
        "# Channels".to_string(),
        "".to_string(),
        "| name | id | kind | last activity | active |".to_string(),
        "|---|---|---|---:|---|".to_string(),
    ];
    for channel in channels {
        lines.push(format!(
            "| [{}]({}/channel.md) | `{}` | {} | {} | {} |",
            channel.name.replace('|', "\\|"),
            channel.id,
            channel.id,
            channel.kind,
            channel.last_event_id,
            if channel.active { "yes" } else { "" }
        ));
    }
    lines.push("".to_string());
    lines.join("\n")
}

fn update_active_channel_symlink(
    atrium_root: &Path,
    active: Option<&AtriumChannel>,
) -> Result<(), String> {
    let link = atrium_root.join("channel");
    let Some(active) = active else {
        remove_existing_path(&link)?;
        return Ok(());
    };
    if let Some(parent) = link.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let tmp = staging_path(atrium_root, &link)?;
    if let Some(parent) = tmp.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let _ = std::fs::remove_file(&tmp);
    std::os::unix::fs::symlink(Path::new("channels").join(&active.id), &tmp)
        .map_err(|e| format!("symlink {}: {e}", tmp.display()))?;
    remove_existing_path(&link)?;
    std::fs::rename(&tmp, &link)
        .map_err(|e| format!("rename {} -> {}: {e}", tmp.display(), link.display()))
}

fn remove_existing_path(path: &Path) -> Result<(), String> {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return Ok(());
    };
    if meta.file_type().is_dir() && !meta.file_type().is_symlink() {
        std::fs::remove_dir_all(path).map_err(|e| format!("remove {}: {e}", path.display()))
    } else {
        std::fs::remove_file(path).map_err(|e| format!("remove {}: {e}", path.display()))
    }
}

fn write_atomic(atrium_root: &Path, dst: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let tmp = staging_path(atrium_root, dst)?;
    if let Some(parent) = tmp.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    std::fs::write(&tmp, bytes).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, dst)
        .map_err(|e| format!("rename {} -> {}: {e}", tmp.display(), dst.display()))
}

fn staging_path(atrium_root: &Path, dst: &Path) -> Result<PathBuf, String> {
    let parent = atrium_root
        .parent()
        .ok_or_else(|| format!("context root has no parent: {}", atrium_root.display()))?;
    let root_name = atrium_root
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("context");
    let relative = dst.strip_prefix(atrium_root).map_err(|_| {
        format!(
            "atomic destination {} is outside context root {}",
            dst.display(),
            atrium_root.display()
        )
    })?;
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let mut tmp = parent
        .join(format!(".{root_name}.node-sync-staging"))
        .join(relative);
    let mut name = tmp
        .file_name()
        .ok_or_else(|| format!("atomic destination has no filename: {}", dst.display()))?
        .to_os_string();
    name.push(format!(".{}.{}.tmp", std::process::id(), sequence));
    tmp.set_file_name(name);
    Ok(tmp)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicU64, Ordering};

    #[derive(Default)]
    struct FakeClient {
        sessions: Vec<String>,
        next_cursor: String,
        fail_docs: HashSet<(String, String)>,
        channels: Vec<AtriumChannel>,
        fail_channel_docs: HashSet<(String, String)>,
        calls: Mutex<Vec<String>>,
    }

    impl FakeClient {
        fn with_sessions(sessions: &[&str], next_cursor: &str) -> Self {
            Self {
                sessions: sessions.iter().map(|s| (*s).to_string()).collect(),
                next_cursor: next_cursor.to_string(),
                fail_docs: HashSet::new(),
                channels: Vec::new(),
                fail_channel_docs: HashSet::new(),
                calls: Mutex::new(Vec::new()),
            }
        }

        fn failing(mut self, session_id: &str, doc: &str) -> Self {
            self.fail_docs
                .insert((session_id.to_string(), doc.to_string()));
            self
        }

        fn with_channels(mut self, channels: Vec<AtriumChannel>) -> Self {
            self.channels = channels;
            self
        }

        fn failing_channel(mut self, channel_id: &str, doc: &str) -> Self {
            self.fail_channel_docs
                .insert((channel_id.to_string(), doc.to_string()));
            self
        }
    }

    impl AtriumClient for FakeClient {
        fn post_capture(
            &mut self,
            _path: &str,
            _base_seq: u64,
            _bytes: &[u8],
        ) -> Result<u64, String> {
            unreachable!("materializer tests do not capture artifacts")
        }

        fn post_delete(&mut self, _path: &str, _base_seq: u64) -> Result<u64, String> {
            unreachable!("materializer tests do not delete artifacts")
        }

        fn fetch_bytes(&mut self, _path: &str, _seq: u64) -> Result<Vec<u8>, String> {
            unreachable!("materializer tests do not fetch artifact bytes")
        }

        fn atrium_changes(&self, _since: &str) -> Result<(Vec<String>, String), String> {
            Ok((self.sessions.clone(), self.next_cursor.clone()))
        }

        fn atrium_doc(&self, target_id: &str, doc: &str) -> Result<Vec<u8>, String> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("session:{target_id}:{doc}"));
            if self
                .fail_docs
                .contains(&(target_id.to_string(), doc.to_string()))
            {
                return Err(format!("boom {target_id}/{doc}"));
            }
            if doc == "meta" {
                return Ok(serde_json::json!({
                    "title": format!("Session {target_id}"),
                    "status": "running",
                    "channelName": "general",
                    "driverName": "Codex",
                    "updatedAt": format!("2026-01-01T00:00:0{}.000Z", target_id.len())
                })
                .to_string()
                .into_bytes());
            }
            Ok(format!("{target_id}/{doc}").into_bytes())
        }

        fn atrium_channels(&self) -> Result<Vec<AtriumChannel>, String> {
            self.calls
                .lock()
                .unwrap()
                .push("channels:index".to_string());
            Ok(self.channels.clone())
        }

        fn atrium_channel_doc(&self, channel_id: &str, doc: &str) -> Result<Vec<u8>, String> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("channel:{channel_id}:{doc}"));
            if self
                .fail_channel_docs
                .contains(&(channel_id.to_string(), doc.to_string()))
            {
                return Err(format!("boom {channel_id}/{doc}"));
            }
            Ok(format!("{channel_id}/{doc}").into_bytes())
        }
    }

    fn expected_doc_bytes(session_id: &str, doc: &str) -> Vec<u8> {
        if doc == "meta" {
            return serde_json::json!({
                "title": format!("Session {session_id}"),
                "status": "running",
                "channelName": "general",
                "driverName": "Codex",
                "updatedAt": format!("2026-01-01T00:00:0{}.000Z", session_id.len())
            })
            .to_string()
            .into_bytes();
        }
        format!("{session_id}/{doc}").into_bytes()
    }

    #[test]
    fn materializes_changed_sessions_docs() {
        let temp = tempfile::tempdir().unwrap();
        let client = FakeClient::with_sessions(&["s1", "s2"], "7.8");
        let mut state = DaemonState::default();

        let cursor = materialize_once(&client, temp.path(), "1.2", &mut state).unwrap();

        assert_eq!(cursor, "7.8");
        for session_id in ["s1", "s2"] {
            for (doc, filename) in ATRIUM_DOCS {
                let path = temp.path().join("sessions").join(session_id).join(filename);
                assert_eq!(
                    std::fs::read(path).unwrap(),
                    expected_doc_bytes(session_id, doc)
                );
            }
        }
        let readme = std::fs::read_to_string(temp.path().join("README.md")).unwrap();
        assert!(readme.contains("Atrium Context Mount"));
        assert!(readme.contains("still materializing"));
        assert!(readme.contains(".atrium-context-ready"));
        let index = std::fs::read_to_string(temp.path().join("sessions").join("index.md")).unwrap();
        assert!(index.contains("| Session s1 | running | general | Codex |"));
        assert!(index.contains("`s1`"));
    }

    #[test]
    fn empty_changes_page_keeps_cursor_and_writes_mount_entrypoints() {
        let temp = tempfile::tempdir().unwrap();
        let client = FakeClient::with_sessions(&[], "7.8");
        let mut state = DaemonState::default();

        let cursor = materialize_once(&client, temp.path(), "1.2", &mut state).unwrap();

        assert_eq!(cursor, "1.2");
        assert!(temp.path().join("README.md").exists());
        let index = std::fs::read_to_string(temp.path().join("sessions").join("index.md")).unwrap();
        assert!(index.contains("No sessions have been materialized yet."));
    }

    #[test]
    fn doc_fetch_error_does_not_block_other_sessions() {
        let temp = tempfile::tempdir().unwrap();
        let client =
            FakeClient::with_sessions(&["bad", "good"], "7.8").failing("bad", "transcript");
        let mut state = DaemonState::default();

        let cursor = materialize_once(&client, temp.path(), "1.2", &mut state).unwrap();

        assert_eq!(cursor, "7.8");
        assert!(
            !temp
                .path()
                .join("sessions")
                .join("bad")
                .join("transcript.md")
                .exists()
        );
        assert_eq!(
            std::fs::read(temp.path().join("sessions").join("bad").join("summary.md")).unwrap(),
            b"bad/summary".to_vec()
        );
        for (doc, filename) in ATRIUM_DOCS {
            let path = temp.path().join("sessions").join("good").join(filename);
            assert_eq!(
                std::fs::read(path).unwrap(),
                expected_doc_bytes("good", doc)
            );
        }
    }

    #[test]
    fn materializes_channel_docs_index_and_active_symlink() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(temp.path().join("channels").join("stale")).unwrap();
        let client = FakeClient::default().with_channels(vec![
            AtriumChannel {
                id: "chan-1".to_string(),
                name: "general".to_string(),
                kind: "public".to_string(),
                active: true,
                last_event_id: 9,
            },
            AtriumChannel {
                id: "chan-2".to_string(),
                name: "private".to_string(),
                kind: "private".to_string(),
                active: false,
                last_event_id: 7,
            },
        ]);

        let mut state = DaemonState::default();
        materialize_channel_docs(&client, temp.path(), None, &mut state).unwrap();

        let index = std::fs::read_to_string(temp.path().join("channels").join("index.md")).unwrap();
        assert!(index.contains("| [general](chan-1/channel.md) | `chan-1` | public | 9 | yes |"));
        assert!(index.contains("| [private](chan-2/channel.md) | `chan-2` | private | 7 |  |"));
        assert!(!temp.path().join("channels").join("stale").exists());
        for channel_id in ["chan-1", "chan-2"] {
            for (doc, filename) in ATRIUM_CHANNEL_DOCS {
                assert_eq!(
                    std::fs::read(temp.path().join("channels").join(channel_id).join(filename))
                        .unwrap(),
                    format!("{channel_id}/{doc}").into_bytes()
                );
            }
        }
        assert_eq!(
            std::fs::read_link(temp.path().join("channel")).unwrap(),
            PathBuf::from("channels").join("chan-1")
        );
    }

    #[test]
    fn seeds_readme_without_fetching_remote_content() {
        let temp = tempfile::tempdir().unwrap();
        let client = FakeClient::default();

        write_mount_readme(temp.path()).unwrap();

        assert!(temp.path().join("README.md").is_file());
        assert!(client.calls.lock().unwrap().is_empty());
    }

    #[test]
    fn active_channel_is_materialized_before_other_channels_and_marker() {
        let temp = tempfile::tempdir().unwrap();
        let client = FakeClient::default().with_channels(vec![
            AtriumChannel {
                id: "other".to_string(),
                name: "Other".to_string(),
                kind: "public".to_string(),
                last_event_id: 1,
                active: false,
            },
            AtriumChannel {
                id: "active".to_string(),
                name: "Active".to_string(),
                kind: "public".to_string(),
                last_event_id: 2,
                active: true,
            },
        ]);

        let mut state = DaemonState::default();
        materialize_channel_docs(&client, temp.path(), None, &mut state).unwrap();

        let calls = client.calls.lock().unwrap();
        let active_chat = calls
            .iter()
            .position(|call| call == "channel:active:chat")
            .unwrap();
        let other_channel = calls
            .iter()
            .position(|call| call == "channel:other:channel")
            .unwrap();
        assert!(active_chat < other_channel);
        assert!(temp.path().join(CONTEXT_READY_MARKER).is_file());
        assert!(
            !temp
                .path()
                .join(format!("{CONTEXT_READY_MARKER}.tmp"))
                .exists()
        );
    }

    #[test]
    fn readiness_marker_requires_all_active_channel_docs() {
        let temp = tempfile::tempdir().unwrap();
        let client = FakeClient::default()
            .with_channels(vec![AtriumChannel {
                id: "active".to_string(),
                name: "Active".to_string(),
                kind: "public".to_string(),
                last_event_id: 2,
                active: true,
            }])
            .failing_channel("active", "chat");

        let mut state = DaemonState::default();
        assert!(materialize_channel_docs(&client, temp.path(), None, &mut state).is_err());
        assert!(!temp.path().join(CONTEXT_READY_MARKER).exists());
        assert!(!temp.path().join("channel").exists());
    }

    #[test]
    fn materializes_only_dirty_channel_docs_but_refreshes_index() {
        let temp = tempfile::tempdir().unwrap();
        write_atomic(
            temp.path(),
            &temp.path().join(CONTEXT_READY_MARKER),
            b"ready\n",
        )
        .unwrap();
        let client = FakeClient::default()
            .with_channels(vec![
                AtriumChannel {
                    id: "chan-1".to_string(),
                    name: "general".to_string(),
                    kind: "public".to_string(),
                    active: true,
                    last_event_id: 9,
                },
                AtriumChannel {
                    id: "chan-2".to_string(),
                    name: "private".to_string(),
                    kind: "private".to_string(),
                    active: false,
                    last_event_id: 10,
                },
            ])
            .failing_channel("chan-1", "chat");
        let dirty = vec!["chan-2".to_string()];

        let mut state = DaemonState::default();
        materialize_channel_docs(&client, temp.path(), Some(&dirty), &mut state).unwrap();

        assert!(temp.path().join("channels").join("index.md").exists());
        assert!(!temp.path().join("channels").join("chan-1").exists());
        assert_eq!(
            std::fs::read(temp.path().join("channels").join("chan-2").join("chat.md")).unwrap(),
            b"chan-2/chat".to_vec()
        );
    }

    #[test]
    fn unchanged_channel_watermark_skips_reconcile_doc_fetches() {
        let temp = tempfile::tempdir().unwrap();
        let client = FakeClient::default().with_channels(vec![AtriumChannel {
            id: "chan-1".to_string(),
            name: "general".to_string(),
            kind: "public".to_string(),
            active: true,
            last_event_id: 9,
        }]);
        let mut state = DaemonState::default();

        materialize_channel_docs(&client, temp.path(), None, &mut state).unwrap();
        let first_calls = client.calls.lock().unwrap().len();
        materialize_channel_docs(&client, temp.path(), None, &mut state).unwrap();
        let calls = client.calls.lock().unwrap();

        assert_eq!(
            calls[first_calls..],
            ["channels:index"],
            "the cheap reconcile still refreshes the listing but not channel docs"
        );
        assert_eq!(state.atrium_channel_watermarks.get("chan-1"), Some(&9));
    }

    struct EpochMismatchClient {
        requests: Mutex<Vec<Option<ContextDeltaRequest>>>,
    }

    impl AtriumClient for EpochMismatchClient {
        fn post_capture(&mut self, _: &str, _: u64, _: &[u8]) -> Result<u64, String> {
            unreachable!()
        }
        fn post_delete(&mut self, _: &str, _: u64) -> Result<u64, String> {
            unreachable!()
        }
        fn fetch_bytes(&mut self, _: &str, _: u64) -> Result<Vec<u8>, String> {
            unreachable!()
        }
        fn atrium_changes(&self, since: &str) -> Result<(Vec<String>, String), String> {
            Ok((vec![], since.to_string()))
        }
        fn atrium_doc(&self, _: &str, _: &str) -> Result<Vec<u8>, String> {
            unreachable!()
        }
        fn atrium_doc_delta(
            &self,
            _: &str,
            _: &str,
            request: Option<&ContextDeltaRequest>,
        ) -> Result<ContextDocResponse, String> {
            self.requests.lock().unwrap().push(request.cloned());
            Ok(if request.is_some() {
                ContextDocResponse {
                    body: b"delta".to_vec(),
                    epoch: Some("new-epoch".to_string()),
                    mode: Some(MODE_APPEND.to_string()),
                    next_watermark: Some(8),
                }
            } else {
                ContextDocResponse {
                    body: b"complete replacement".to_vec(),
                    epoch: Some("new-epoch".to_string()),
                    mode: Some("full".to_string()),
                    next_watermark: Some(8),
                }
            })
        }
    }

    #[test]
    fn epoch_mismatch_never_appends_and_refetches_full() {
        let temp = tempfile::tempdir().unwrap();
        let dst = temp.path().join("sessions/s1/transcript.md");
        std::fs::create_dir_all(dst.parent().unwrap()).unwrap();
        std::fs::write(&dst, b"old bytes").unwrap();
        let client = EpochMismatchClient {
            requests: Mutex::new(Vec::new()),
        };
        let request = ContextDeltaRequest {
            epoch: "old-epoch".to_string(),
            watermark: 7,
        };
        let mut cold = 0;

        let state = fetch_and_apply_session_doc(
            &client,
            temp.path(),
            "s1",
            "transcript",
            &dst,
            Some(&request),
            &mut cold,
        )
        .unwrap();

        assert_eq!(std::fs::read(&dst).unwrap(), b"complete replacement");
        assert_eq!(
            client.requests.lock().unwrap().as_slice(),
            &[Some(request), None]
        );
        assert_eq!(state.unwrap().epoch, "new-epoch");
    }

    #[test]
    fn existing_bytes_without_state_request_and_receive_a_full_document() {
        let temp = tempfile::tempdir().unwrap();
        let dst = temp.path().join("sessions/s1/transcript.md");
        std::fs::create_dir_all(dst.parent().unwrap()).unwrap();
        std::fs::write(&dst, b"unproven old bytes").unwrap();
        let client = EpochMismatchClient {
            requests: Mutex::new(Vec::new()),
        };
        let mut cold = 0;

        fetch_and_apply_session_doc(
            &client,
            temp.path(),
            "s1",
            "transcript",
            &dst,
            None,
            &mut cold,
        )
        .unwrap();

        assert_eq!(client.requests.lock().unwrap().as_slice(), &[None]);
        assert_eq!(std::fs::read(&dst).unwrap(), b"complete replacement");
        assert_eq!(cold, b"complete replacement".len() as u64);
    }

    struct GrowingClient {
        records: AtomicU64,
        fetched: AtomicU64,
    }

    impl GrowingClient {
        const RECORD_BYTES: usize = 32;

        fn render_records(from: u64, through: u64) -> Vec<u8> {
            if from > through {
                return Vec::new();
            }
            let count = (through - from + 1) as usize;
            vec![b'x'; count * Self::RECORD_BYTES]
        }

        fn fetched(&self) -> u64 {
            self.fetched.load(Ordering::Relaxed)
        }
    }

    impl AtriumClient for GrowingClient {
        fn post_capture(&mut self, _: &str, _: u64, _: &[u8]) -> Result<u64, String> {
            unreachable!()
        }
        fn post_delete(&mut self, _: &str, _: u64) -> Result<u64, String> {
            unreachable!()
        }
        fn fetch_bytes(&mut self, _: &str, _: u64) -> Result<Vec<u8>, String> {
            unreachable!()
        }
        fn atrium_changes(&self, since: &str) -> Result<(Vec<String>, String), String> {
            Ok((vec!["growing".to_string()], since.to_string()))
        }
        fn atrium_doc(&self, _: &str, _: &str) -> Result<Vec<u8>, String> {
            unreachable!()
        }
        fn atrium_doc_delta(
            &self,
            _: &str,
            doc: &str,
            request: Option<&ContextDeltaRequest>,
        ) -> Result<ContextDocResponse, String> {
            let through = self.records.load(Ordering::Relaxed);
            let aggregate = matches!(doc, "summary" | "meta");
            let (body, mode) = if aggregate {
                (b"{}".to_vec(), "full")
            } else if let Some(request) = request {
                (
                    Self::render_records(request.watermark.saturating_add(1), through),
                    MODE_APPEND,
                )
            } else {
                (Self::render_records(1, through), "full")
            };
            self.fetched.fetch_add(body.len() as u64, Ordering::Relaxed);
            Ok(ContextDocResponse {
                body,
                epoch: Some("opaque-render-v1".to_string()),
                mode: Some(mode.to_string()),
                next_watermark: Some(through),
            })
        }
    }

    #[test]
    fn bytes_fetched_per_change_stays_flat_as_session_grows() {
        let temp = tempfile::tempdir().unwrap();
        let client = GrowingClient {
            records: AtomicU64::new(1_000),
            fetched: AtomicU64::new(0),
        };
        let mut state = DaemonState::default();

        materialize_once(&client, temp.path(), "0.0", &mut state).unwrap();
        let mut first_change = 0;
        let mut last_change = 0;
        for records in 1_001..=5_000 {
            client.records.store(records, Ordering::Relaxed);
            let before = client.fetched();
            materialize_once(&client, temp.path(), "0.0", &mut state).unwrap();
            let change_bytes = client.fetched() - before;
            if records == 1_001 {
                first_change = change_bytes;
            }
            last_change = change_bytes;
            assert_eq!(change_bytes, first_change);
        }

        let old_first = 6 * 1_001 * GrowingClient::RECORD_BYTES as u64 + 4;
        let old_last = 6 * 5_000 * GrowingClient::RECORD_BYTES as u64 + 4;
        println!(
            "bytes/change old_full: {old_first}->{old_last}; delta: {first_change}->{last_change}"
        );
        assert_eq!(first_change, 6 * GrowingClient::RECORD_BYTES as u64 + 4);
        assert_eq!(last_change, first_change);
    }

    #[test]
    fn atomic_staging_is_outside_the_agent_mount() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("viewer-context");
        let dst = root.join("sessions/s1/transcript.md");
        let staged = staging_path(&root, &dst).unwrap();

        assert!(!staged.starts_with(&root));
        assert!(staged.starts_with(temp.path().join(".viewer-context.node-sync-staging")));
    }
}
