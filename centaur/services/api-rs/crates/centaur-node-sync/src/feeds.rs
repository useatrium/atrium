use crate::adopt::RemoteChange;
use crate::runtime::{BundleRef, status_of};

#[derive(Debug, Clone, PartialEq)]
pub struct ArtifactFeed {
    pub changes: Vec<(String, RemoteChange)>,
    pub next_cursor: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AtriumFeed {
    pub session_ids: Vec<String>,
    pub next_cursor: String,
}

pub fn parse_artifact_changes(
    value: &serde_json::Value,
    cursor: &str,
    session_id: &str,
) -> ArtifactFeed {
    let next_cursor = value
        .get("next_cursor")
        .and_then(|c| c.as_str())
        .unwrap_or(cursor)
        .to_string();
    let active_prefix = value.get("activePrefix").and_then(|p| p.as_str());
    let mut changes = Vec::new();
    if let Some(rows) = value.get("rows").and_then(|r| r.as_array()) {
        for row in rows {
            let canonical_path = row
                .get("path")
                .and_then(|p| p.as_str())
                .unwrap_or_default()
                .to_string();
            let seq = row.get("seq").and_then(|s| s.as_u64()).unwrap_or(0);
            let sha = row
                .get("sha")
                .and_then(|s| s.as_str())
                .map(|s| s.to_string());
            let status = status_of(
                row.get("status")
                    .and_then(|s| s.as_str())
                    .unwrap_or("normal"),
            );
            let group_id = row
                .get("group_id")
                .and_then(|g| g.as_str())
                .map(|g| g.to_string());
            for path in local_artifact_paths(&canonical_path, active_prefix, session_id) {
                changes.push((
                    path,
                    RemoteChange {
                        seq,
                        sha: sha.clone(),
                        status,
                        group_id: group_id.clone(),
                    },
                ));
            }
        }
    }
    ArtifactFeed {
        changes,
        next_cursor,
    }
}

pub fn parse_atrium_changes(value: &serde_json::Value, since: &str) -> AtriumFeed {
    let next_cursor = value
        .get("next_cursor")
        .and_then(|c| c.as_str())
        .unwrap_or(since)
        .to_string();
    let mut session_ids = Vec::new();
    if let Some(rows) = value.get("rows").and_then(|r| r.as_array()) {
        for row in rows {
            if let Some(session_id) = row.get("sessionId").and_then(|s| s.as_str()) {
                session_ids.push(session_id.to_string());
            }
        }
    }
    AtriumFeed {
        session_ids,
        next_cursor,
    }
}

pub fn parse_profile_bundles(
    value: &serde_json::Value,
    harness: &str,
) -> Result<Vec<BundleRef>, String> {
    serde_json::from_value::<Vec<BundleRef>>(
        value
            .get("bundles")
            .cloned()
            .unwrap_or_else(|| serde_json::Value::Array(vec![])),
    )
    .map_err(|e| format!("parse profile bundles {harness}: {e}"))
}

pub fn local_artifact_paths(
    path: &str,
    active_prefix: Option<&str>,
    session_id: &str,
) -> Vec<String> {
    if let Some(prefix) = active_prefix.map(|value| value.trim_matches('/'))
        && let Some(rest) = path.strip_prefix(&format!("{prefix}/"))
    {
        if is_denied_workspace_root_mirror(rest) {
            return vec![path.to_string()];
        }
        return vec![rest.to_string(), path.to_string()];
    }
    let scratch_prefix = format!("scratch/{session_id}/");
    if let Some(rest) = path.strip_prefix(&scratch_prefix) {
        return vec![format!("scratch/{rest}")];
    }
    vec![path.to_string()]
}

fn is_denied_workspace_root_mirror(path: &str) -> bool {
    if path.contains('/') {
        return false;
    }
    matches!(
        path,
        "AGENTS.md" | "AGENTS_BASE.md" | "AGENTS_OVERLAY.md" | "CLAUDE.md" | "AGENT.md"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adopt::RemoteStatus;

    #[test]
    fn artifact_changes_project_active_channel_and_own_scratch() {
        let parsed = parse_artifact_changes(
            &serde_json::json!({
                "next_cursor": "9.2",
                "activePrefix": "shared/channels/channel-1",
                "rows": [
                    {"path": "shared/channels/channel-1/report.md", "seq": 7, "sha": "aa"},
                    {"path": "scratch/sess-1/log.txt", "seq": 8, "status": "conflict"}
                ]
            }),
            "1.0",
            "sess-1",
        );

        assert_eq!(parsed.next_cursor, "9.2");
        assert_eq!(parsed.changes.len(), 3);
        assert_eq!(parsed.changes[0].0, "report.md");
        assert_eq!(parsed.changes[1].0, "shared/channels/channel-1/report.md");
        assert_eq!(parsed.changes[2].0, "scratch/log.txt");
        assert_eq!(parsed.changes[2].1.status, RemoteStatus::Conflict);
    }

    #[test]
    fn local_artifact_paths_project_active_channel_and_own_scratch() {
        assert_eq!(
            local_artifact_paths(
                "shared/channels/channel-1/report.md",
                Some("shared/channels/channel-1"),
                "sess-1",
            ),
            vec![
                "report.md".to_string(),
                "shared/channels/channel-1/report.md".to_string()
            ]
        );
        assert_eq!(
            local_artifact_paths(
                "shared/channels/channel-2/report.md",
                Some("shared/channels/channel-1"),
                "sess-1",
            ),
            vec!["shared/channels/channel-2/report.md".to_string()]
        );
        assert_eq!(
            local_artifact_paths("scratch/sess-1/note.md", None, "sess-1"),
            vec!["scratch/note.md".to_string()]
        );
    }

    #[test]
    fn local_artifact_paths_does_not_project_agent_prompt_files_to_root() {
        assert_eq!(
            local_artifact_paths(
                "shared/channels/channel-1/AGENTS_BASE.md",
                Some("shared/channels/channel-1"),
                "sess-1",
            ),
            vec!["shared/channels/channel-1/AGENTS_BASE.md".to_string()]
        );
        assert_eq!(
            local_artifact_paths("uploads/AGENTS_BASE.md", Some("uploads"), "sess-1",),
            vec!["uploads/AGENTS_BASE.md".to_string()]
        );
        assert_eq!(
            local_artifact_paths(
                "shared/channels/channel-1/docs/AGENTS_BASE.md",
                Some("shared/channels/channel-1"),
                "sess-1",
            ),
            vec![
                "docs/AGENTS_BASE.md".to_string(),
                "shared/channels/channel-1/docs/AGENTS_BASE.md".to_string()
            ]
        );
    }
}
