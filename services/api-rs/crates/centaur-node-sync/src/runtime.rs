//! Node-sync orchestration: the glue that turns the classifier + adopt decision
//! into the two sweeps the node daemon runs per session. Kept platform-neutral
//! and dependency-injected (an [`AtriumClient`] + a byte reader) so the whole
//! control flow is unit-tested with fakes; the live wiring (HTTP to Atrium,
//! openat2 reads, write-through-`merged`) plugs the real impls in on the node.

use std::collections::HashMap;
use std::path::PathBuf;

use crate::adopt::{decide_adopt, AdoptAction, LocalState, RemoteChange};
use crate::echo::EchoGuard;
use crate::overlay::{OverlayOp, RawEntry};
use crate::scan_to_ops;

/// What the node needs from Atrium (egress-only). Errors are stringly-typed here;
/// the live impl maps HTTP failures into them.
pub trait AtriumClient {
    /// POST a captured upsert (path + bytes + base_seq) → the committed seq.
    fn post_capture(&mut self, path: &str, base_seq: u64, bytes: &[u8]) -> Result<u64, String>;
    /// POST a captured delete (tombstone) → the committed seq.
    fn post_delete(&mut self, path: &str, base_seq: u64) -> Result<u64, String>;
    /// Fetch the bytes of a remote version (for an inbound adopt).
    fn fetch_bytes(&mut self, path: &str, seq: u64) -> Result<Vec<u8>, String>;
}

/// Read the current bytes of an upper path (the live impl is openat2-hardened +
/// torn-read; tests inject a map).
pub trait UpperReader {
    fn read(&self, path: &PathBuf) -> Option<Vec<u8>>;
}

fn sha_hex(bytes: &[u8]) -> String {
    // A tiny FNV-1a — enough for echo/identity comparison in tests + matches by
    // content. The live node uses sha256 (cas key); this stays dependency-free.
    let mut h: u64 = 0xcbf29ce484222325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

pub struct CaptureOutcome {
    pub captured: Vec<(String, u64)>, // (path, seq)
    pub deleted: Vec<(String, u64)>,
    pub skipped_echo: Vec<String>,
    pub skipped_other: Vec<String>,
    pub errors: Vec<(String, String)>,
}

/// One capture sweep: classify the upper, read bytes for each upsert, and POST to
/// Atrium with the hydrated base_seq — suppressing the node's own write-backs via
/// the echo guard. `base_seqs` is the hydration manifest (path → base_seq).
pub fn capture_sweep(
    entries: &[RawEntry],
    base_seqs: &HashMap<String, u64>,
    reader: &dyn UpperReader,
    echo: &mut EchoGuard,
    client: &mut dyn AtriumClient,
) -> CaptureOutcome {
    let mut out = CaptureOutcome {
        captured: vec![],
        deleted: vec![],
        skipped_echo: vec![],
        skipped_other: vec![],
        errors: vec![],
    };
    let (ops, skipped) = scan_to_ops(entries);
    for (p, _r) in skipped {
        out.skipped_other.push(p.to_string_lossy().into_owned());
    }
    for op in ops {
        match op {
            OverlayOp::Upsert { path, .. } => {
                let key = path.to_string_lossy().into_owned();
                let base = base_seqs.get(&key).copied().unwrap_or(0);
                let Some(bytes) = reader.read(&path) else {
                    out.errors.push((key, "unreadable (torn/escaped)".into()));
                    continue;
                };
                let sha = sha_hex(&bytes);
                if echo.is_echo(&path, &sha) {
                    out.skipped_echo.push(key);
                    continue;
                }
                match client.post_capture(&key, base, &bytes) {
                    Ok(seq) => out.captured.push((key, seq)),
                    Err(e) => out.errors.push((key, e)),
                }
            }
            OverlayOp::Delete { path } => {
                let key = path.to_string_lossy().into_owned();
                let base = base_seqs.get(&key).copied().unwrap_or(0);
                match client.post_delete(&key, base) {
                    Ok(seq) => out.deleted.push((key, seq)),
                    Err(e) => out.errors.push((key, e)),
                }
            }
            // Renames are encoded as delete+create by overlay in practice (#16
            // fallback, validated on-node); SymlinkMeta/OpaqueDir are recorded by
            // the live node as metadata side-channels, not byte captures.
            _ => {}
        }
    }
    out
}

pub struct InboundPlan {
    /// Paths to write through `merged` with the fetched bytes (path, seq, bytes).
    pub to_write: Vec<(String, u64, Vec<u8>)>,
    /// Paths whose local edit must be reconciled via Atrium write-back (path, base_seq).
    pub to_reconcile: Vec<(String, u64)>,
    /// Paths whose remote latest is an unresolved conflict (surface to the human).
    pub conflicts: Vec<(String, u64)>,
    pub skipped: Vec<String>,
}

/// One inbound sweep: for each remote change, decide + (for straight adopts) fetch
/// the bytes so the caller can write them through `merged` at a quiesce point.
/// Records `applied_remote_seq` in the echo guard so the next capture sweep
/// doesn't re-capture the node's own write.
pub fn inbound_sweep(
    changes: &[(String, RemoteChange)],
    locals: &HashMap<String, LocalState>,
    echo: &mut EchoGuard,
    client: &mut dyn AtriumClient,
) -> InboundPlan {
    let mut plan = InboundPlan { to_write: vec![], to_reconcile: vec![], conflicts: vec![], skipped: vec![] };
    let default = LocalState { base_seq: 0, base_sha: None, upper_sha: None, applied_remote_seq: None };
    for (path, remote) in changes {
        let local = locals.get(path).unwrap_or(&default);
        match decide_adopt(local, remote) {
            AdoptAction::AdoptRemote { seq, sha } => match client.fetch_bytes(path, seq) {
                Ok(bytes) => {
                    // record the intent BEFORE the write so a racing capture suppresses it
                    if let Some(s) = sha.clone() {
                        echo.record_intent(PathBuf::from(path), s);
                    } else {
                        echo.record_intent(PathBuf::from(path), sha_hex(&bytes));
                    }
                    plan.to_write.push((path.clone(), seq, bytes));
                }
                Err(_) => plan.skipped.push(path.clone()),
            },
            AdoptAction::ReconcileViaWriteback { base_seq } => plan.to_reconcile.push((path.clone(), base_seq)),
            AdoptAction::SurfaceConflict { seq } => plan.conflicts.push((path.clone(), seq)),
            AdoptAction::Skip(_) => plan.skipped.push(path.clone()),
        }
    }
    plan
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::adopt::RemoteStatus;
    use crate::overlay::RawFileType;

    struct MapReader(HashMap<PathBuf, Vec<u8>>);
    impl UpperReader for MapReader {
        fn read(&self, path: &PathBuf) -> Option<Vec<u8>> {
            self.0.get(path).cloned()
        }
    }

    #[derive(Default)]
    struct FakeClient {
        captures: Vec<(String, u64)>,
        next_seq: u64,
    }
    impl AtriumClient for FakeClient {
        fn post_capture(&mut self, path: &str, _base: u64, _bytes: &[u8]) -> Result<u64, String> {
            self.next_seq += 1;
            self.captures.push((path.to_string(), self.next_seq));
            Ok(self.next_seq)
        }
        fn post_delete(&mut self, _path: &str, _base: u64) -> Result<u64, String> {
            self.next_seq += 1;
            Ok(self.next_seq)
        }
        fn fetch_bytes(&mut self, _path: &str, _seq: u64) -> Result<Vec<u8>, String> {
            Ok(b"remote bytes".to_vec())
        }
    }

    fn reg(p: &str) -> RawEntry {
        RawEntry { rel_path: PathBuf::from(p), file_type: RawFileType::Regular, rdev: 0, size: 4, xattrs: vec![] }
    }
    fn whiteout(p: &str) -> RawEntry {
        RawEntry { rel_path: PathBuf::from(p), file_type: RawFileType::CharDevice, rdev: 0, size: 0, xattrs: vec![] }
    }

    #[test]
    fn capture_sweep_posts_upserts_and_deletes_with_base_seq() {
        let entries = vec![reg("proj-x/a.md"), whiteout("proj-x/old.md")];
        let mut files = HashMap::new();
        files.insert(PathBuf::from("proj-x/a.md"), b"data".to_vec());
        let reader = MapReader(files);
        let mut base = HashMap::new();
        base.insert("proj-x/a.md".to_string(), 5u64);
        let mut echo = EchoGuard::new();
        let mut client = FakeClient::default();

        let out = capture_sweep(&entries, &base, &reader, &mut echo, &mut client);
        assert_eq!(out.captured.len(), 1);
        assert_eq!(out.deleted.len(), 1);
        assert!(out.errors.is_empty());
    }

    #[test]
    fn capture_sweep_suppresses_the_nodes_own_echo() {
        let entries = vec![reg("proj-x/a.md")];
        let mut files = HashMap::new();
        files.insert(PathBuf::from("proj-x/a.md"), b"data".to_vec());
        let reader = MapReader(files);
        let mut echo = EchoGuard::new();
        echo.record_intent(PathBuf::from("proj-x/a.md"), sha_hex(b"data")); // node just wrote this
        let mut client = FakeClient::default();

        let out = capture_sweep(&entries, &HashMap::new(), &reader, &mut echo, &mut client);
        assert_eq!(out.skipped_echo.len(), 1);
        assert!(out.captured.is_empty()); // not re-captured
    }

    #[test]
    fn inbound_sweep_fetches_for_adopt_and_routes_edited_to_reconcile() {
        let changes = vec![
            ("unedited.md".to_string(), RemoteChange { seq: 6, sha: Some("v6".into()), status: RemoteStatus::Normal }),
            ("edited.md".to_string(), RemoteChange { seq: 6, sha: Some("v6".into()), status: RemoteStatus::Normal }),
        ];
        let mut locals = HashMap::new();
        locals.insert("unedited.md".to_string(), LocalState { base_seq: 5, base_sha: Some("b".into()), upper_sha: None, applied_remote_seq: None });
        locals.insert("edited.md".to_string(), LocalState { base_seq: 5, base_sha: Some("b".into()), upper_sha: Some("mine".into()), applied_remote_seq: None });
        let mut echo = EchoGuard::new();
        let mut client = FakeClient::default();

        let plan = inbound_sweep(&changes, &locals, &mut echo, &mut client);
        assert_eq!(plan.to_write.len(), 1);
        assert_eq!(plan.to_write[0].0, "unedited.md");
        assert_eq!(plan.to_reconcile.len(), 1);
        assert_eq!(plan.to_reconcile[0].0, "edited.md");
        // the node recorded its write intent → next capture won't echo it.
        assert_eq!(echo.pending(), 1);
    }
}
