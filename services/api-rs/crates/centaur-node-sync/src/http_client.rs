//! Live HTTP `AtriumClient` (egress-only, x-api-key). Talks to the internal
//! node-ingestion endpoints: capture (POST raw bytes), raw fetch (GET bytes),
//! and the gap-free change-feed (GET JSON). Blocking (ureq) — the daemon loop is
//! synchronous per session.

use crate::adopt::RemoteChange;
use crate::cas::CasHydrateEntry;
use crate::runtime::{AtriumClient, BundleRef, status_of};
use serde::Deserialize;

pub struct HttpAtriumClient {
    base_url: String,
    api_key: String,
    session_id: String,
    agent: ureq::Agent,
}

impl HttpAtriumClient {
    pub fn new(
        base_url: impl Into<String>,
        api_key: impl Into<String>,
        session_id: impl Into<String>,
    ) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            api_key: api_key.into(),
            session_id: session_id.into(),
            agent: ureq::AgentBuilder::new()
                .timeout(std::time::Duration::from_secs(30))
                .build(),
        }
    }

    fn url(&self, suffix: &str) -> String {
        format!(
            "{}/api/internal/sessions/{}{}",
            self.base_url, self.session_id, suffix
        )
    }
}

fn enc(s: &str) -> String {
    // minimal percent-encoding for a path query value
    s.bytes()
        .map(|b| match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'/' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

#[derive(Debug, Deserialize)]
struct HydrationScopeResponse {
    #[serde(default, rename = "sessionId")]
    session_id: Option<String>,
    #[serde(rename = "activePrefix")]
    active_prefix: Option<String>,
    #[serde(default)]
    paths: Vec<HydrationScopePath>,
}

#[derive(Debug, Deserialize)]
struct HydrationScopePath {
    path: String,
    #[serde(rename = "latestSeq")]
    latest_seq: u64,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    sha: Option<String>,
}

fn parse_hydration_scope(
    value: serde_json::Value,
    session_id: &str,
) -> Result<Vec<CasHydrateEntry>, String> {
    let response = serde_json::from_value::<HydrationScopeResponse>(value)
        .map_err(|e| format!("parse hydration-scope response: {e}"))?;
    let active_prefix = response.active_prefix.as_deref();
    let scratch_session_id = response.session_id.as_deref().unwrap_or(session_id);
    Ok(response
        .paths
        .into_iter()
        .filter_map(|path| {
            if path.kind.as_deref() == Some("deleted") {
                return None;
            }
            let sha = path.sha?.trim().to_string();
            if sha.is_empty() {
                return None;
            }
            Some(
                local_artifact_paths(&path.path, active_prefix, scratch_session_id)
                    .into_iter()
                    .map(move |local_path| CasHydrateEntry {
                        path: local_path,
                        seq: path.latest_seq,
                        sha: sha.clone(),
                    })
                    .collect::<Vec<_>>(),
            )
        })
        .flatten()
        .collect())
}

fn local_artifact_paths(path: &str, active_prefix: Option<&str>, session_id: &str) -> Vec<String> {
    if let Some(prefix) = active_prefix.map(|value| value.trim_matches('/'))
        && let Some(rest) = path.strip_prefix(&format!("{prefix}/"))
    {
        return vec![rest.to_string(), path.to_string()];
    }
    let scratch_prefix = format!("scratch/{session_id}/");
    if let Some(rest) = path.strip_prefix(&scratch_prefix) {
        return vec![format!("scratch/{rest}")];
    }
    vec![path.to_string()]
}

impl AtriumClient for HttpAtriumClient {
    fn post_capture(&mut self, path: &str, base_seq: u64, bytes: &[u8]) -> Result<u64, String> {
        let mut req = self
            .agent
            .post(&self.url(&format!("/artifacts/capture?path={}", enc(path))))
            .set("x-api-key", &self.api_key)
            .set("content-type", "application/octet-stream");
        if base_seq > 0 {
            req = req.set("x-artifact-base-seq", &base_seq.to_string());
        }
        let resp = req
            .send_bytes(bytes)
            .map_err(|e| format!("capture {path}: {e}"))?;
        let v: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
        v.get("seq")
            .and_then(|s| s.as_u64())
            .ok_or_else(|| "no seq in capture response".to_string())
    }

    fn post_capture_stream(
        &mut self,
        path: &str,
        base_seq: u64,
        reader: &mut dyn std::io::Read,
        size_hint: u64,
    ) -> Result<u64, String> {
        // Stream the body (chunked) — ureq reads `reader` to EOF without buffering it
        // whole, so an arbitrarily large file uploads in constant node memory. The
        // dedicated /capture-stream route streams the chunked body straight to S3;
        // x-artifact-size is an informational size hint.
        let mut req = self
            .agent
            .post(&self.url(&format!("/artifacts/capture-stream?path={}", enc(path))))
            .set("x-api-key", &self.api_key)
            .set("content-type", "application/octet-stream")
            .set("x-artifact-size", &size_hint.to_string());
        if base_seq > 0 {
            req = req.set("x-artifact-base-seq", &base_seq.to_string());
        }
        let resp = req
            .send(reader)
            .map_err(|e| format!("stream {path}: {e}"))?;
        let v: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
        v.get("seq")
            .and_then(|s| s.as_u64())
            .ok_or_else(|| "no seq in capture response".to_string())
    }

    fn post_delete(&mut self, path: &str, base_seq: u64) -> Result<u64, String> {
        let mut req = self
            .agent
            .post(&self.url(&format!("/artifacts/capture?path={}", enc(path))))
            .set("x-api-key", &self.api_key)
            .set("x-artifact-delete", "true");
        if base_seq > 0 {
            req = req.set("x-artifact-base-seq", &base_seq.to_string());
        }
        let resp = req
            .send_bytes(&[])
            .map_err(|e| format!("delete {path}: {e}"))?;
        let v: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
        v.get("seq")
            .and_then(|s| s.as_u64())
            .ok_or_else(|| "no seq in delete response".to_string())
    }

    fn fetch_bytes(&mut self, path: &str, seq: u64) -> Result<Vec<u8>, String> {
        let resp = self
            .agent
            .get(&self.url(&format!("/artifacts/raw?path={}&seq={}", enc(path), seq)))
            .set("x-api-key", &self.api_key)
            .call()
            .map_err(|e| format!("fetch {path}@{seq}: {e}"))?;
        let mut buf = Vec::new();
        std::io::copy(&mut resp.into_reader(), &mut buf).map_err(|e| e.to_string())?;
        Ok(buf)
    }

    fn hydration_scope(&self) -> Result<Vec<CasHydrateEntry>, String> {
        let resp = self
            .agent
            .get(&self.url("/hydration-scope"))
            .set("x-api-key", &self.api_key)
            .call()
            .map_err(|e| format!("hydration-scope: {e}"))?;
        let value: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
        parse_hydration_scope(value, &self.session_id)
    }

    fn warmcache_manifest(
        &self,
        lockfile_hash: &str,
        kind: &str,
    ) -> Result<Vec<crate::cas::WarmcacheManifestEntry>, String> {
        let resp = self
            .agent
            .get(&self.url(&format!(
                "/cache/hydration?lockfile_hash={}&kind={}",
                enc(lockfile_hash),
                enc(kind)
            )))
            .set("x-api-key", &self.api_key)
            .call()
            .map_err(|e| format!("cache/hydration: {e}"))?;
        #[derive(serde::Deserialize)]
        struct Resp {
            #[serde(default)]
            entries: Vec<crate::cas::WarmcacheManifestEntry>,
        }
        let parsed: Resp = resp.into_json().map_err(|e| e.to_string())?;
        Ok(parsed.entries)
    }

    fn fetch_cache_blob(&mut self, sha256: &str) -> Result<Vec<u8>, String> {
        // The blob route is workspace-agnostic (content-addressed), not session-scoped.
        let resp = self
            .agent
            .get(&format!(
                "{}/api/internal/cache/blob?sha256={}",
                self.base_url,
                enc(sha256)
            ))
            .set("x-api-key", &self.api_key)
            .call()
            .map_err(|e| format!("cache/blob: {e}"))?;
        // Defensive: read with a hard cap so an oversized/malicious body can't OOM
        // the node daemon (into_reader() is a trait object, so cap manually).
        let cap = crate::warmcache::MAX_WARMCACHE_BLOB_BYTES;
        let mut reader = resp.into_reader();
        let mut buf = Vec::new();
        let mut chunk = [0u8; 64 * 1024];
        loop {
            let n = std::io::Read::read(&mut reader, &mut chunk).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            if buf.len() as u64 + n as u64 > cap {
                return Err(format!("cache blob {sha256} exceeds {cap} bytes"));
            }
            buf.extend_from_slice(&chunk[..n]);
        }
        Ok(buf)
    }

    fn put_harness_transcript(&mut self, harness: &str, bytes: &[u8]) -> Result<(), String> {
        self.agent
            .put(&self.url(&format!("/harness-transcript?harness={}", enc(harness))))
            .set("x-api-key", &self.api_key)
            .set("content-type", "application/jsonl")
            .send_bytes(bytes)
            .map(|_| ())
            .map_err(|e| format!("put harness transcript {harness}: {e}"))
    }

    fn put_profile_candidates(
        &mut self,
        harness: &str,
        payload: &serde_json::Value,
    ) -> Result<(), String> {
        self.agent
            .put(&self.url(&format!("/profile-candidates?harness={}", enc(harness))))
            .set("x-api-key", &self.api_key)
            .set("content-type", "application/json")
            .send_json(payload)
            .map(|_| ())
            .map_err(|e| format!("put profile candidates {harness}: {e}"))
    }

    fn put_provider_credential_refresh(
        &mut self,
        harness: &str,
        body: &serde_json::Value,
    ) -> Result<(), String> {
        self.agent
            .put(&self.url(&format!(
                "/provider-credential-refresh?harness={}",
                enc(harness)
            )))
            .set("x-api-key", &self.api_key)
            .set("content-type", "application/json")
            .send_json(body)
            .map(|_| ())
            .map_err(|e| format!("put provider credential refresh {harness}: {e}"))
    }

    fn put_harness_state_bundle(
        &mut self,
        harness: &str,
        manifest: &serde_json::Value,
    ) -> Result<(), String> {
        self.agent
            .put(&self.url(&format!("/harness-state-bundle?harness={}", enc(harness))))
            .set("x-api-key", &self.api_key)
            .set("content-type", "application/json")
            .send_json(manifest)
            .map(|_| ())
            .map_err(|e| format!("put harness state bundle {harness}: {e}"))
    }

    fn put_profile_baseline(
        &mut self,
        harness: &str,
        payload: &serde_json::Value,
    ) -> Result<(), String> {
        self.agent
            .put(&self.url(&format!("/profile-baseline?harness={}", enc(harness))))
            .set("x-api-key", &self.api_key)
            .set("content-type", "application/json")
            .send_json(payload)
            .map(|_| ())
            .map_err(|e| format!("put profile baseline {harness}: {e}"))
    }

    fn put_profile_bundle_blob(
        &mut self,
        sha256: &str,
        path: &str,
        bytes: &[u8],
    ) -> Result<(), String> {
        self.agent
            .put(&self.url(&format!(
                "/profile-bundle-blob?sha256={}&path={}",
                enc(sha256),
                enc(path)
            )))
            .set("x-api-key", &self.api_key)
            .set("content-type", "application/octet-stream")
            .send_bytes(bytes)
            .map(|_| ())
            .map_err(|e| format!("put profile bundle blob {path}@{sha256}: {e}"))
    }

    fn get_profile_bundles(&self, harness: &str) -> Result<Vec<BundleRef>, String> {
        let resp = self
            .agent
            .get(&self.url(&format!("/profile-bundles?harness={}", enc(harness))))
            .set("x-api-key", &self.api_key)
            .call()
            .map_err(|e| format!("get profile bundles {harness}: {e}"))?;
        let value: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
        serde_json::from_value::<Vec<BundleRef>>(
            value
                .get("bundles")
                .cloned()
                .unwrap_or_else(|| serde_json::Value::Array(vec![])),
        )
        .map_err(|e| format!("parse profile bundles {harness}: {e}"))
    }

    fn get_profile_bundle_blob(&self, sha256: &str) -> Result<Vec<u8>, String> {
        let resp = self
            .agent
            .get(&self.url(&format!("/profile-bundle-blob?sha256={}", enc(sha256))))
            .set("x-api-key", &self.api_key)
            .call()
            .map_err(|e| format!("get profile bundle blob {sha256}: {e}"))?;
        let mut buf = Vec::new();
        std::io::copy(&mut resp.into_reader(), &mut buf).map_err(|e| e.to_string())?;
        Ok(buf)
    }

    fn poll_changes(
        &mut self,
        cursor: &str,
    ) -> Result<(Vec<(String, RemoteChange)>, String), String> {
        // The change-feed lives at the public session route (the node is allowed to
        // read it via the same api-key gate exposed on the internal mirror).
        let resp = self
            .agent
            .get(&self.url(&format!("/artifacts/changes?since={}", enc(cursor))))
            .set("x-api-key", &self.api_key)
            .call()
            .map_err(|e| format!("poll {cursor}: {e}"))?;
        let v: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
        let next = v
            .get("next_cursor")
            .and_then(|c| c.as_str())
            .unwrap_or(cursor)
            .to_string();
        let active_prefix = v.get("activePrefix").and_then(|p| p.as_str());
        let mut out = Vec::new();
        if let Some(rows) = v.get("rows").and_then(|r| r.as_array()) {
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
                for path in local_artifact_paths(&canonical_path, active_prefix, &self.session_id) {
                    out.push((
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
        Ok((out, next))
    }

    fn atrium_changes(&self, since: &str) -> Result<(Vec<String>, String), String> {
        let resp = self
            .agent
            .get(&self.url(&format!("/atrium/changes?since={}", enc(since))))
            .set("x-api-key", &self.api_key)
            .call()
            .map_err(|e| format!("atrium changes {since}: {e}"))?;
        let v: serde_json::Value = resp.into_json().map_err(|e| e.to_string())?;
        let next = v
            .get("next_cursor")
            .and_then(|c| c.as_str())
            .unwrap_or(since)
            .to_string();
        let mut session_ids = Vec::new();
        if let Some(rows) = v.get("rows").and_then(|r| r.as_array()) {
            for row in rows {
                if let Some(session_id) = row.get("sessionId").and_then(|s| s.as_str()) {
                    session_ids.push(session_id.to_string());
                }
            }
        }
        Ok((session_ids, next))
    }

    fn atrium_doc(&self, target_id: &str, doc: &str) -> Result<Vec<u8>, String> {
        let resp = self
            .agent
            .get(&self.url(&format!("/atrium/sessions/{}/{}", enc(target_id), doc)))
            .set("x-api-key", &self.api_key)
            .call()
            .map_err(|e| format!("atrium doc {target_id}/{doc}: {e}"))?;
        let mut buf = Vec::new();
        std::io::copy(&mut resp.into_reader(), &mut buf).map_err(|e| e.to_string())?;
        Ok(buf)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn harness_transcript_url_uses_internal_session_endpoint() {
        let client = HttpAtriumClient::new("http://atrium/", "key", "slack:C123:123.456");

        assert_eq!(
            client.url("/harness-transcript?harness=claude"),
            "http://atrium/api/internal/sessions/slack:C123:123.456/harness-transcript?harness=claude"
        );
    }

    #[test]
    fn profile_candidates_url_uses_internal_session_endpoint() {
        let client = HttpAtriumClient::new("http://atrium/", "key", "slack:C123:123.456");

        assert_eq!(
            client.url("/profile-candidates?harness=codex"),
            "http://atrium/api/internal/sessions/slack:C123:123.456/profile-candidates?harness=codex"
        );
    }

    #[test]
    fn new_profile_writeback_urls_use_internal_session_endpoint() {
        let client = HttpAtriumClient::new("http://atrium/", "key", "slack:C123:123.456");

        assert_eq!(
            client.url("/provider-credential-refresh?harness=codex"),
            "http://atrium/api/internal/sessions/slack:C123:123.456/provider-credential-refresh?harness=codex"
        );
        assert_eq!(
            client.url("/harness-state-bundle?harness=claude"),
            "http://atrium/api/internal/sessions/slack:C123:123.456/harness-state-bundle?harness=claude"
        );
        assert_eq!(
            client.url("/profile-baseline?harness=codex"),
            "http://atrium/api/internal/sessions/slack:C123:123.456/profile-baseline?harness=codex"
        );
        assert_eq!(
            client.url("/profile-bundles?harness=codex"),
            "http://atrium/api/internal/sessions/slack:C123:123.456/profile-bundles?harness=codex"
        );
        assert_eq!(
            client.url("/profile-bundle-blob?sha256=abc123&path=.codex/skills/a/SKILL.md"),
            "http://atrium/api/internal/sessions/slack:C123:123.456/profile-bundle-blob?sha256=abc123&path=.codex/skills/a/SKILL.md"
        );
    }

    #[test]
    fn hydration_scope_parse_skips_deleted_and_missing_sha() {
        let entries = parse_hydration_scope(serde_json::json!({
            "sessionId": "sess-1",
            "scope": "test",
            "activePrefix": "shared/channels/channel-1",
            "paths": [
                {"path": "shared/channels/channel-1/a.txt", "latestSeq": 4, "kind": "file", "sha": "aa11"},
                {"path": "scratch/sess-1/b.txt", "latestSeq": 5, "kind": "file", "sha": "bb22"},
                {"path": "shared/global/c.txt", "latestSeq": 6, "kind": "file", "sha": "cc33"},
                {"path": "shared/channels/channel-1/deleted.txt", "latestSeq": 7, "kind": "deleted", "sha": "dd44"},
                {"path": "shared/channels/channel-1/null.txt", "latestSeq": 8, "kind": "file", "sha": null},
                {"path": "shared/channels/channel-1/empty.txt", "latestSeq": 9, "kind": "file", "sha": ""}
            ]
        }), "sess-1")
        .unwrap();

        assert_eq!(
            entries,
            vec![
                CasHydrateEntry {
                    path: "a.txt".to_string(),
                    seq: 4,
                    sha: "aa11".to_string(),
                },
                CasHydrateEntry {
                    path: "shared/channels/channel-1/a.txt".to_string(),
                    seq: 4,
                    sha: "aa11".to_string(),
                },
                CasHydrateEntry {
                    path: "scratch/b.txt".to_string(),
                    seq: 5,
                    sha: "bb22".to_string(),
                },
                CasHydrateEntry {
                    path: "shared/global/c.txt".to_string(),
                    seq: 6,
                    sha: "cc33".to_string(),
                },
            ]
        );
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
            local_artifact_paths(
                "scratch/sess-1/draft.md",
                Some("shared/channels/channel-1"),
                "sess-1"
            ),
            vec!["scratch/draft.md".to_string()]
        );
        assert_eq!(
            local_artifact_paths(
                "scratch/sess-2/draft.md",
                Some("shared/channels/channel-1"),
                "sess-1"
            ),
            vec!["scratch/sess-2/draft.md".to_string()]
        );
    }
}
