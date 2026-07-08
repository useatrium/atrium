use std::path::{Path, PathBuf};

use crate::runtime::{AtriumChannel, AtriumClient};

const ROOT_README: &str = r#"# Atrium Context Mount

This read-only mount is the local context map for the Atrium channel and its sessions. It refreshes within a few seconds of server-side changes.

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
) -> Result<String, String> {
    let (session_ids, next_cursor) = client.atrium_changes(since)?;
    materialize_changed_sessions(client, atrium_root, since, session_ids, next_cursor)
}

pub fn materialize_changed_sessions<C: AtriumClient + ?Sized>(
    client: &C,
    atrium_root: &Path,
    since: &str,
    session_ids: Vec<String>,
    next_cursor: String,
) -> Result<String, String> {
    if let Err(error) = write_mount_readme(atrium_root) {
        eprintln!("atrium materializer write README.md: {error}");
    }
    if session_ids.is_empty() {
        if let Err(error) = write_sessions_index(atrium_root) {
            eprintln!("atrium materializer write sessions/index.md: {error}");
        }
        return Ok(since.to_string());
    }

    for session_id in session_ids {
        let session_dir = atrium_root.join("sessions").join(&session_id);
        for (doc, filename) in ATRIUM_DOCS {
            match client.atrium_doc(&session_id, doc) {
                Ok(bytes) => {
                    let dst = session_dir.join(filename);
                    if let Err(error) = write_atomic(&dst, &bytes) {
                        eprintln!(
                            "atrium materializer write {}/{}: {error}",
                            session_id, filename
                        );
                    }
                }
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
    }
    if let Err(error) = write_sessions_index(atrium_root) {
        eprintln!("atrium materializer write sessions/index.md: {error}");
    }

    Ok(next_cursor)
}

fn write_mount_readme(atrium_root: &Path) -> Result<(), String> {
    write_atomic(&atrium_root.join("README.md"), ROOT_README.as_bytes())
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
    write_atomic(&sessions_dir.join("index.md"), lines.join("\n").as_bytes())
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
) -> Result<(), String> {
    let channels = client.atrium_channels()?;
    let channels_dir = atrium_root.join("channels");
    write_atomic(
        &channels_dir.join("index.md"),
        render_channels_index(&channels).as_bytes(),
    )?;
    update_active_channel_symlink(atrium_root, channels.iter().find(|channel| channel.active))?;
    if only_channel_ids.is_none() {
        prune_stale_channel_dirs(&channels_dir, &channels)?;
    }

    let selected = |channel: &AtriumChannel| -> bool {
        match only_channel_ids {
            Some(ids) => ids.iter().any(|id| id == &channel.id),
            None => true,
        }
    };
    for channel in channels.iter().filter(|channel| selected(channel)) {
        let channel_dir = channels_dir.join(&channel.id);
        for (doc, filename) in ATRIUM_CHANNEL_DOCS {
            match client.atrium_channel_doc(&channel.id, doc) {
                Ok(bytes) => {
                    let dst = channel_dir.join(filename);
                    if let Err(error) = write_atomic(&dst, &bytes) {
                        eprintln!(
                            "atrium channel materializer write {}/{}: {error}",
                            channel.id, filename
                        );
                    }
                }
                Err(error) => {
                    if !error.contains("status code 403") && !error.contains("status code 404") {
                        eprintln!(
                            "atrium channel materializer fetch {}/{}: {error}",
                            channel.id, doc
                        );
                    }
                }
            }
        }
    }
    Ok(())
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
    let tmp = atrium_root.join(".channel.tmp");
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

fn write_atomic(dst: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("create {}: {e}", parent.display()))?;
    }
    let tmp = tmp_path(dst);
    std::fs::write(&tmp, bytes).map_err(|e| format!("write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, dst)
        .map_err(|e| format!("rename {} -> {}: {e}", tmp.display(), dst.display()))
}

fn tmp_path(dst: &Path) -> PathBuf {
    let mut tmp = dst.as_os_str().to_os_string();
    tmp.push(".tmp");
    PathBuf::from(tmp)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[derive(Default)]
    struct FakeClient {
        sessions: Vec<String>,
        next_cursor: String,
        fail_docs: HashSet<(String, String)>,
        channels: Vec<AtriumChannel>,
        fail_channel_docs: HashSet<(String, String)>,
    }

    impl FakeClient {
        fn with_sessions(sessions: &[&str], next_cursor: &str) -> Self {
            Self {
                sessions: sessions.iter().map(|s| (*s).to_string()).collect(),
                next_cursor: next_cursor.to_string(),
                fail_docs: HashSet::new(),
                channels: Vec::new(),
                fail_channel_docs: HashSet::new(),
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
            Ok(self.channels.clone())
        }

        fn atrium_channel_doc(&self, channel_id: &str, doc: &str) -> Result<Vec<u8>, String> {
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

        let cursor = materialize_once(&client, temp.path(), "1.2").unwrap();

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
        let index = std::fs::read_to_string(temp.path().join("sessions").join("index.md")).unwrap();
        assert!(index.contains("| Session s1 | running | general | Codex |"));
        assert!(index.contains("`s1`"));
    }

    #[test]
    fn empty_changes_page_keeps_cursor_and_writes_mount_entrypoints() {
        let temp = tempfile::tempdir().unwrap();
        let client = FakeClient::with_sessions(&[], "7.8");

        let cursor = materialize_once(&client, temp.path(), "1.2").unwrap();

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

        let cursor = materialize_once(&client, temp.path(), "1.2").unwrap();

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

        materialize_channel_docs(&client, temp.path(), None).unwrap();

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
    fn materializes_only_dirty_channel_docs_but_refreshes_index() {
        let temp = tempfile::tempdir().unwrap();
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

        materialize_channel_docs(&client, temp.path(), Some(&dirty)).unwrap();

        assert!(temp.path().join("channels").join("index.md").exists());
        assert!(!temp.path().join("channels").join("chan-1").exists());
        assert_eq!(
            std::fs::read(temp.path().join("channels").join("chan-2").join("chat.md")).unwrap(),
            b"chan-2/chat".to_vec()
        );
    }
}
