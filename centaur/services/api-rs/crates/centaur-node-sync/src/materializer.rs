use std::path::{Path, PathBuf};

use crate::runtime::AtriumClient;

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
    if session_ids.is_empty() {
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

    Ok(next_cursor)
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
    }

    impl FakeClient {
        fn with_sessions(sessions: &[&str], next_cursor: &str) -> Self {
            Self {
                sessions: sessions.iter().map(|s| (*s).to_string()).collect(),
                next_cursor: next_cursor.to_string(),
                fail_docs: HashSet::new(),
            }
        }

        fn failing(mut self, session_id: &str, doc: &str) -> Self {
            self.fail_docs
                .insert((session_id.to_string(), doc.to_string()));
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
            Ok(format!("{target_id}/{doc}").into_bytes())
        }
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
                    format!("{session_id}/{doc}").into_bytes()
                );
            }
        }
    }

    #[test]
    fn empty_changes_page_keeps_cursor_and_writes_nothing() {
        let temp = tempfile::tempdir().unwrap();
        let client = FakeClient::with_sessions(&[], "7.8");

        let cursor = materialize_once(&client, temp.path(), "1.2").unwrap();

        assert_eq!(cursor, "1.2");
        assert!(!temp.path().join("sessions").exists());
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
                format!("good/{doc}").into_bytes()
            );
        }
    }
}
