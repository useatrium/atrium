//! Node-sync orchestration: the glue that turns the classifier + adopt decision
//! into the two sweeps the node daemon runs per session. Kept platform-neutral
//! and dependency-injected (an [`AtriumClient`] + a byte reader) so the whole
//! control flow is unit-tested with fakes; the live wiring (HTTP to Atrium,
//! openat2 reads, write-through-`merged`) plugs the real impls in on the node.

use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};

use crate::adopt::{AdoptAction, LocalState, RemoteChange, RemoteStatus, decide_adopt};
use crate::echo::EchoGuard;
use crate::overlay::{OverlayOp, RawEntry};
use crate::scan_to_ops;

/// What the node needs from Atrium (egress-only). Errors are stringly-typed here;
/// the live impl maps HTTP failures into them.
pub trait AtriumClient {
    /// POST a captured upsert (path + bytes + base_seq) → the committed seq.
    fn post_capture(&mut self, path: &str, base_seq: u64, bytes: &[u8]) -> Result<u64, String>;
    /// POST a LARGE captured upsert by STREAMING the body (constant memory — never
    /// buffers the whole file). `size_hint` lets the impl set Content-Length so the
    /// server can stream straight to S3 (H8 / §8B #20/#12). The default reads the
    /// source fully and delegates to `post_capture`, so small impls + test fakes work
    /// unchanged; the live HTTP impl overrides it to stream the request body.
    fn post_capture_stream(
        &mut self,
        path: &str,
        base_seq: u64,
        reader: &mut dyn Read,
        _size_hint: u64,
    ) -> Result<u64, String> {
        let mut buf = Vec::new();
        reader.read_to_end(&mut buf).map_err(|e| e.to_string())?;
        self.post_capture(path, base_seq, &buf)
    }
    /// POST a captured delete (tombstone) → the committed seq.
    fn post_delete(&mut self, path: &str, base_seq: u64) -> Result<u64, String>;
    /// Fetch the bytes of a remote version (for an inbound adopt).
    fn fetch_bytes(&mut self, path: &str, seq: u64) -> Result<Vec<u8>, String>;
    /// Poll the gap-free change-feed past `cursor` → (path, remote-change) rows +
    /// the next cursor. Default: nothing (the live HTTP impl overrides it).
    fn poll_changes(
        &mut self,
        _cursor: &str,
    ) -> Result<(Vec<(String, RemoteChange)>, String), String> {
        Ok((vec![], _cursor.to_string()))
    }
}

/// Parse a change-feed JSON row's status into the adopt enum.
pub fn status_of(s: &str) -> RemoteStatus {
    if s == "conflict" {
        RemoteStatus::Conflict
    } else {
        RemoteStatus::Normal
    }
}

/// Read the current bytes of an upper path (the live impl is openat2-hardened +
/// torn-read; tests inject a map).
pub trait UpperReader {
    fn read(&self, path: &Path) -> Option<Vec<u8>>;
    /// Open a STREAMING reader over the upper path so a large file is never held
    /// whole in memory (H8). The default wraps `read()` in a cursor (small files +
    /// tests); the live hardened reader overrides it to stream from the openat2 fd.
    fn open_stream<'a>(&'a self, path: &Path) -> Option<Box<dyn Read + 'a>> {
        self.read(path)
            .map(|b| Box::new(std::io::Cursor::new(b)) as Box<dyn Read + 'a>)
    }
}

/// Stream a reader through the same FNV-1a identity hash as [`sha_hex`], without
/// buffering it — used to echo-check a large file before streaming it to Atrium.
pub fn hash_stream(reader: &mut dyn Read) -> std::io::Result<String> {
    let mut h: u64 = 0xcbf29ce484222325;
    let mut buf = [0u8; 64 * 1024];
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        for b in &buf[..n] {
            h ^= *b as u64;
            h = h.wrapping_mul(0x100000001b3);
        }
    }
    Ok(format!("{h:016x}"))
}

pub fn sha_hex(bytes: &[u8]) -> String {
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
    pub captured: Vec<(String, u64, String)>, // (path, seq, sha) — inline (buffered) path
    pub streamed: Vec<(String, u64, String)>, // (path, seq, sha) — large-file streaming path (H8)
    pub deleted: Vec<(String, u64)>,
    pub skipped_echo: Vec<String>,
    pub skipped_other: Vec<String>,
    pub errors: Vec<(String, String)>,
}

/// Files at/under this many bytes go through the in-memory `post_capture`; larger
/// ones stream (constant memory) and are routed OUT of the overlay dirty-byte
/// budget. 8 MiB keeps the common case (notes/code/configs) on the simple path.
pub const DEFAULT_LARGE_FILE_BYTES: u64 = 8 * 1024 * 1024;

/// One capture sweep: classify the upper, read bytes for each upsert, and POST to
/// Atrium with the hydrated base_seq — suppressing the node's own write-backs via
/// the echo guard. `base_seqs` is the hydration manifest (path → base_seq).
pub fn capture_sweep(
    entries: &[RawEntry],
    base_seqs: &HashMap<String, u64>,
    reader: &dyn UpperReader,
    echo: &mut EchoGuard,
    client: &mut dyn AtriumClient,
    large_threshold: u64,
) -> CaptureOutcome {
    let mut out = CaptureOutcome {
        captured: vec![],
        streamed: vec![],
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
            OverlayOp::Upsert { path, size } => {
                let key = path.to_string_lossy().into_owned();
                let base = base_seqs.get(&key).copied().unwrap_or(0);
                if size > large_threshold {
                    // Large file: stream it (constant memory, routed out of the
                    // dirty-byte budget). Echo-check via a streaming hash pass first
                    // so the node never re-captures its own (large) inbound write.
                    let Some(mut hr) = reader.open_stream(&path) else {
                        out.errors.push((key, "unreadable (torn/escaped)".into()));
                        continue;
                    };
                    let sha = match hash_stream(&mut *hr) {
                        Ok(s) => s,
                        Err(e) => {
                            out.errors.push((key, format!("hash: {e}")));
                            continue;
                        }
                    };
                    if echo.is_echo(&path, &sha) {
                        out.skipped_echo.push(key);
                        continue;
                    }
                    let Some(mut body) = reader.open_stream(&path) else {
                        out.errors.push((key, "unreadable (torn/escaped)".into()));
                        continue;
                    };
                    match client.post_capture_stream(&key, base, &mut *body, size) {
                        Ok(seq) => out.streamed.push((key, seq, sha)),
                        Err(e) => out.errors.push((key, e)),
                    }
                    continue;
                }
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
                    Ok(seq) => out.captured.push((key, seq, sha)),
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

/// Capture uncommitted repo WIP to the ledger as a recovery point (§5A / H6).
/// PURE-READ: the bytes come from `wip::capture_wip` (a `git diff HEAD` + untracked
/// snapshot, zero git writes). Lands as normal artifacts under `wip/<repo>/…` so a
/// crash/destroy doesn't lose uncommitted work; recovery = re-clone @ HEAD + apply
/// the patch + drop the untracked files. Content-dedup means an unchanged WIP is
/// idempotent (no churn). Returns the captured (path, seq, sha) for state tracking.
pub fn wip_sweep(
    repo_name: &str,
    patch: &crate::wip::WipPatch,
    base_seqs: &HashMap<String, u64>,
    client: &mut dyn AtriumClient,
) -> Vec<(String, u64, String)> {
    let mut captured = Vec::new();
    if patch.is_empty() {
        return captured;
    }
    // the base HEAD sha (so recovery knows what to clone), the tracked diff, and
    // each untracked file — each a normal artifact under wip/<repo>/.
    let mut items: Vec<(String, Vec<u8>)> = vec![
        (
            format!("wip/{repo_name}/HEAD"),
            patch.base_head_sha.clone().into_bytes(),
        ),
        (
            format!("wip/{repo_name}/patch.diff"),
            patch.diff.clone().into_bytes(),
        ),
    ];
    for (rel, bytes) in &patch.untracked {
        items.push((format!("wip/{repo_name}/untracked/{rel}"), bytes.clone()));
    }
    for (path, bytes) in items {
        let base = base_seqs.get(&path).copied().unwrap_or(0);
        if let Ok(seq) = client.post_capture(&path, base, &bytes) {
            captured.push((path, seq, sha_hex(&bytes)));
        }
    }
    captured
}

/// One entry of the hydration manifest: the path + the version to materialize.
#[derive(Debug, Clone)]
pub struct HydrateEntry {
    pub path: String,
    pub seq: u64,
}

pub struct HydrateOutcome {
    /// (path, base_seq) — the seed for `artifact_sync_state` + base-aware capture.
    pub base_seqs: HashMap<String, u64>,
    pub bytes_written: u64,
    pub errors: Vec<(String, String)>,
}

/// Hydrate the artifact `lower` (Phase 5 / C-hydrate): for each manifest entry,
/// fetch the version's bytes from Atrium and materialize them into the lowerdir
/// tree (one file per path, creating parent dirs). The returned `base_seqs` IS the
/// per-path base the capture sweep + adopt need. The live node reflinks from a
/// node-local CAS cache instead of re-fetching; this is the correctness core.
/// `write_file` is injected so the call flow is unit-tested without a real FS.
pub fn hydrate_lower(
    manifest: &[HydrateEntry],
    client: &mut dyn AtriumClient,
    mut write_file: impl FnMut(&str, &[u8]) -> Result<(), String>,
) -> HydrateOutcome {
    let mut out = HydrateOutcome {
        base_seqs: HashMap::new(),
        bytes_written: 0,
        errors: vec![],
    };
    for entry in manifest {
        match client.fetch_bytes(&entry.path, entry.seq) {
            Ok(bytes) => match write_file(&entry.path, &bytes) {
                Ok(()) => {
                    out.bytes_written += bytes.len() as u64;
                    out.base_seqs.insert(entry.path.clone(), entry.seq);
                }
                Err(e) => out.errors.push((entry.path.clone(), e)),
            },
            Err(e) => out.errors.push((entry.path.clone(), e)),
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
    let mut plan = InboundPlan {
        to_write: vec![],
        to_reconcile: vec![],
        conflicts: vec![],
        skipped: vec![],
    };
    let default = LocalState {
        base_seq: 0,
        base_sha: None,
        upper_sha: None,
        applied_remote_seq: None,
    };
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
            AdoptAction::ReconcileViaWriteback { base_seq } => {
                plan.to_reconcile.push((path.clone(), base_seq))
            }
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
        fn read(&self, path: &Path) -> Option<Vec<u8>> {
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
        RawEntry {
            rel_path: PathBuf::from(p),
            file_type: RawFileType::Regular,
            rdev: 0,
            size: 4,
            xattrs: vec![],
        }
    }
    fn whiteout(p: &str) -> RawEntry {
        RawEntry {
            rel_path: PathBuf::from(p),
            file_type: RawFileType::CharDevice,
            rdev: 0,
            size: 0,
            xattrs: vec![],
        }
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

        let out = capture_sweep(
            &entries,
            &base,
            &reader,
            &mut echo,
            &mut client,
            DEFAULT_LARGE_FILE_BYTES,
        );
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

        let out = capture_sweep(
            &entries,
            &HashMap::new(),
            &reader,
            &mut echo,
            &mut client,
            DEFAULT_LARGE_FILE_BYTES,
        );
        assert_eq!(out.skipped_echo.len(), 1);
        assert!(out.captured.is_empty()); // not re-captured
    }

    #[test]
    fn hydrate_lower_materializes_files_and_returns_base_seqs() {
        let manifest = vec![
            HydrateEntry {
                path: "proj-x/plan.md".into(),
                seq: 5,
            },
            HydrateEntry {
                path: "shared/notes.md".into(),
                seq: 2,
            },
        ];
        let mut client = FakeClient::default();
        let mut written: HashMap<String, Vec<u8>> = HashMap::new();
        let out = hydrate_lower(&manifest, &mut client, |path, bytes| {
            written.insert(path.to_string(), bytes.to_vec());
            Ok(())
        });
        assert_eq!(out.base_seqs.get("proj-x/plan.md"), Some(&5));
        assert_eq!(out.base_seqs.get("shared/notes.md"), Some(&2));
        assert_eq!(written.len(), 2);
        assert!(out.errors.is_empty());
        assert!(out.bytes_written > 0);
    }

    #[test]
    fn hydrate_lower_records_write_errors_without_aborting() {
        let manifest = vec![
            HydrateEntry {
                path: "ok.md".into(),
                seq: 1,
            },
            HydrateEntry {
                path: "bad.md".into(),
                seq: 1,
            },
        ];
        let mut client = FakeClient::default();
        let out = hydrate_lower(&manifest, &mut client, |path, _bytes| {
            if path == "bad.md" {
                Err("disk full".into())
            } else {
                Ok(())
            }
        });
        assert_eq!(out.base_seqs.len(), 1); // only ok.md hydrated
        assert_eq!(out.errors.len(), 1);
        assert_eq!(out.errors[0].0, "bad.md");
    }

    #[test]
    fn wip_sweep_posts_head_diff_and_untracked() {
        let patch = crate::wip::WipPatch {
            base_head_sha: "abc123".into(),
            diff: "diff --git a/x b/x".into(),
            untracked: vec![("new.txt".into(), b"hi".to_vec())],
        };
        let mut client = FakeClient::default();
        let captured = wip_sweep("myrepo", &patch, &HashMap::new(), &mut client);
        let paths: Vec<&str> = captured.iter().map(|(p, _, _)| p.as_str()).collect();
        assert_eq!(captured.len(), 3); // HEAD + patch.diff + 1 untracked
        assert!(paths.contains(&"wip/myrepo/HEAD"));
        assert!(paths.contains(&"wip/myrepo/patch.diff"));
        assert!(paths.contains(&"wip/myrepo/untracked/new.txt"));
    }

    #[test]
    fn wip_sweep_skips_an_empty_patch() {
        let patch = crate::wip::WipPatch {
            base_head_sha: "x".into(),
            diff: String::new(),
            untracked: vec![],
        };
        let mut client = FakeClient::default();
        assert!(wip_sweep("r", &patch, &HashMap::new(), &mut client).is_empty());
    }

    #[test]
    fn inbound_sweep_fetches_for_adopt_and_routes_edited_to_reconcile() {
        let changes = vec![
            (
                "unedited.md".to_string(),
                RemoteChange {
                    seq: 6,
                    sha: Some("v6".into()),
                    status: RemoteStatus::Normal,
                },
            ),
            (
                "edited.md".to_string(),
                RemoteChange {
                    seq: 6,
                    sha: Some("v6".into()),
                    status: RemoteStatus::Normal,
                },
            ),
        ];
        let mut locals = HashMap::new();
        locals.insert(
            "unedited.md".to_string(),
            LocalState {
                base_seq: 5,
                base_sha: Some("b".into()),
                upper_sha: None,
                applied_remote_seq: None,
            },
        );
        locals.insert(
            "edited.md".to_string(),
            LocalState {
                base_seq: 5,
                base_sha: Some("b".into()),
                upper_sha: Some("mine".into()),
                applied_remote_seq: None,
            },
        );
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

    /// A fake that records WHICH path (buffered vs streamed) each capture took, and
    /// the bytes it received, so we can prove large files stream and round-trip.
    #[derive(Default)]
    struct StreamingFakeClient {
        buffered: Vec<(String, Vec<u8>)>,
        streamed: Vec<(String, Vec<u8>, u64)>, // (path, bytes, size_hint)
        next_seq: u64,
    }
    impl AtriumClient for StreamingFakeClient {
        fn post_capture(&mut self, path: &str, _b: u64, bytes: &[u8]) -> Result<u64, String> {
            self.next_seq += 1;
            self.buffered.push((path.to_string(), bytes.to_vec()));
            Ok(self.next_seq)
        }
        fn post_capture_stream(
            &mut self,
            path: &str,
            _b: u64,
            reader: &mut dyn Read,
            size_hint: u64,
        ) -> Result<u64, String> {
            self.next_seq += 1;
            let mut buf = Vec::new();
            reader.read_to_end(&mut buf).map_err(|e| e.to_string())?;
            self.streamed.push((path.to_string(), buf, size_hint));
            Ok(self.next_seq)
        }
        fn post_delete(&mut self, _p: &str, _b: u64) -> Result<u64, String> {
            self.next_seq += 1;
            Ok(self.next_seq)
        }
        fn fetch_bytes(&mut self, _p: &str, _s: u64) -> Result<Vec<u8>, String> {
            Ok(vec![])
        }
    }

    fn reg_sized(p: &str, size: u64) -> RawEntry {
        RawEntry {
            rel_path: PathBuf::from(p),
            file_type: RawFileType::Regular,
            rdev: 0,
            size,
            xattrs: vec![],
        }
    }

    #[test]
    fn capture_sweep_streams_large_files_and_buffers_small() {
        let big = vec![b'x'; 100];
        let small = vec![b'y'; 4];
        let entries = vec![reg_sized("logs/big.log", 100), reg_sized("proj-x/a.md", 4)];
        let mut files = HashMap::new();
        files.insert(PathBuf::from("logs/big.log"), big.clone());
        files.insert(PathBuf::from("proj-x/a.md"), small.clone());
        let reader = MapReader(files);
        let mut echo = EchoGuard::new();
        let mut client = StreamingFakeClient::default();

        // threshold = 16 bytes → big.log streams, a.md stays buffered.
        let out = capture_sweep(
            &entries,
            &HashMap::new(),
            &reader,
            &mut echo,
            &mut client,
            16,
        );

        assert_eq!(
            out.streamed.len(),
            1,
            "the large file took the streaming path"
        );
        assert_eq!(out.streamed[0].0, "logs/big.log");
        assert_eq!(
            out.captured.len(),
            1,
            "the small file took the buffered path"
        );
        assert_eq!(out.captured[0].0, "proj-x/a.md");
        // round-trip: streamed bytes match, size_hint forwarded for Content-Length.
        assert_eq!(client.streamed[0].1, big);
        assert_eq!(client.streamed[0].2, 100);
        assert_eq!(client.buffered[0].1, small);
    }

    #[test]
    fn capture_sweep_suppresses_echo_on_a_large_streamed_file() {
        let big = vec![b'z'; 100];
        let entries = vec![reg_sized("logs/big.log", 100)];
        let mut files = HashMap::new();
        files.insert(PathBuf::from("logs/big.log"), big.clone());
        let reader = MapReader(files);
        let mut echo = EchoGuard::new();
        // the node just wrote this large file inbound → recorded by its content hash.
        echo.record_intent(PathBuf::from("logs/big.log"), sha_hex(&big));
        let mut client = StreamingFakeClient::default();

        let out = capture_sweep(
            &entries,
            &HashMap::new(),
            &reader,
            &mut echo,
            &mut client,
            16,
        );
        assert_eq!(
            out.skipped_echo.len(),
            1,
            "own large inbound write is suppressed"
        );
        assert!(out.streamed.is_empty());
        assert!(client.streamed.is_empty());
    }

    #[test]
    fn hash_stream_matches_sha_hex() {
        let data = b"the quick brown fox";
        let mut cur = std::io::Cursor::new(&data[..]);
        assert_eq!(hash_stream(&mut cur).unwrap(), sha_hex(data));
    }
}
