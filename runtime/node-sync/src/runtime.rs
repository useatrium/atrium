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
use crate::secret;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

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
    /// Fetch the session's artifact hydration scope. Default: no hydrated
    /// artifacts, so small test fakes and legacy mocks keep compiling.
    fn hydration_scope(&self) -> Result<Vec<crate::cas::CasHydrateEntry>, String> {
        Ok(vec![])
    }
    /// Fetch a warm-cache manifest (dep-store file paths + content hashes) for a
    /// dependency set, keyed by lockfile-hash + kind. Default empty so test fakes
    /// and legacy mocks keep compiling.
    fn warmcache_manifest(
        &self,
        _lockfile_hash: &str,
        _kind: &str,
    ) -> Result<Vec<crate::cas::WarmcacheManifestEntry>, String> {
        Ok(vec![])
    }
    /// Fetch a warm-cache blob's bytes by content sha (workspace-agnostic CAS).
    fn fetch_cache_blob(&mut self, _sha256: &str) -> Result<Vec<u8>, String> {
        Err("fetch_cache_blob not supported by this client".to_string())
    }
    /// Upload a warm-cache blob by content sha (capture/write-back). Idempotent —
    /// the server dedups on the durable CAS. Default errors — implementors override.
    fn put_cache_blob(&mut self, _sha256: &str, _bytes: &[u8]) -> Result<(), String> {
        Err("put_cache_blob not supported by this client".to_string())
    }
    /// Register a warm-cache manifest for a dependency set (atomic replace).
    /// Default errors — implementors override.
    fn register_cache_manifest(
        &mut self,
        _lockfile_hash: &str,
        _kind: &str,
        _entries: &[crate::cas::WarmcacheManifestEntry],
    ) -> Result<(), String> {
        Err("register_cache_manifest not supported by this client".to_string())
    }
    /// PUT the harness CLI's own transcript snapshot. This is internal harness
    /// state, not an artifact, so it bypasses the artifact ledger.
    fn put_harness_transcript(&mut self, _harness: &str, _bytes: &[u8]) -> Result<(), String> {
        Ok(())
    }
    /// PUT redacted agent profile candidates derived from harness config files.
    /// This is internal harness state, not an artifact, and must contain only
    /// sanitized JSON (never raw source bytes).
    fn put_profile_candidates(
        &mut self,
        _harness: &str,
        _payload: &serde_json::Value,
    ) -> Result<(), String> {
        Ok(())
    }
    /// PUT a provider credential refresh. The caller is responsible for ensuring
    /// credential bytes only reach this endpoint.
    fn put_provider_credential_refresh(
        &mut self,
        _harness: &str,
        _body: &serde_json::Value,
    ) -> Result<(), String> {
        Ok(())
    }
    /// PUT an exact-resume harness state bundle manifest.
    fn put_harness_state_bundle(
        &mut self,
        _harness: &str,
        _manifest: &serde_json::Value,
    ) -> Result<(), String> {
        Ok(())
    }
    /// PUT the first sanitized profile baseline snapshot for a session.
    fn put_profile_baseline(
        &mut self,
        _harness: &str,
        _payload: &serde_json::Value,
    ) -> Result<(), String> {
        Ok(())
    }
    /// PUT one profile bundle blob into Atrium's CAS.
    fn put_profile_bundle_blob(
        &mut self,
        _sha256: &str,
        _path: &str,
        _bytes: &[u8],
    ) -> Result<(), String> {
        Ok(())
    }
    /// Fetch bundle refs for the session's bound profile version.
    fn get_profile_bundles(&self, _harness: &str) -> Result<Vec<BundleRef>, String> {
        Ok(vec![])
    }
    /// Fetch one profile bundle blob by content hash.
    fn get_profile_bundle_blob(&self, _sha256: &str) -> Result<Vec<u8>, String> {
        Ok(vec![])
    }
    /// Poll the gap-free change-feed past `cursor` → (path, remote-change) rows +
    /// the next cursor. Default: nothing (the live HTTP impl overrides it).
    fn poll_changes(
        &mut self,
        _cursor: &str,
    ) -> Result<(Vec<(String, RemoteChange)>, String), String> {
        Ok((vec![], _cursor.to_string()))
    }
    /// Poll Atrium's session-level materializer change-feed past `since` →
    /// changed session ids + the next cursor.
    fn atrium_changes(&self, since: &str) -> Result<(Vec<String>, String), String>;
    /// Fetch one rendered Atrium document body for a target session. A request
    /// watermark is sent only when the caller has proven the bytes on disk.
    fn atrium_doc(&self, target_id: &str, doc: &str) -> Result<Vec<u8>, String>;
    fn atrium_doc_delta(
        &self,
        target_id: &str,
        doc: &str,
        delta: Option<&ContextDeltaRequest>,
    ) -> Result<ContextDocResponse, String> {
        let _ = delta;
        Ok(ContextDocResponse {
            body: self.atrium_doc(target_id, doc)?,
            epoch: None,
            mode: Some("full".to_string()),
            next_watermark: None,
        })
    }
    /// Fetch readable Atrium channels for this viewer session. Default empty so
    /// legacy test fakes that only exercise session docs keep their old shape.
    fn atrium_channels(&self) -> Result<Vec<AtriumChannel>, String> {
        Ok(vec![])
    }
    /// Fetch one rendered channel document body.
    fn atrium_channel_doc(&self, _channel_id: &str, _doc: &str) -> Result<Vec<u8>, String> {
        Err("atrium channel docs not supported by this client".to_string())
    }
    fn atrium_channel_doc_delta(
        &self,
        channel_id: &str,
        doc: &str,
        delta: Option<&ContextDeltaRequest>,
    ) -> Result<ContextDocResponse, String> {
        let _ = delta;
        Ok(ContextDocResponse {
            body: self.atrium_channel_doc(channel_id, doc)?,
            epoch: None,
            mode: Some("full".to_string()),
            next_watermark: None,
        })
    }
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct ContextDeltaRequest {
    pub epoch: String,
    pub watermark: u64,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct ContextDocResponse {
    pub body: Vec<u8>,
    pub epoch: Option<String>,
    pub mode: Option<String>,
    pub next_watermark: Option<u64>,
}

#[derive(Debug, Clone, Eq, PartialEq, serde::Serialize)]
pub struct AtriumChannel {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub active: bool,
    pub last_event_id: u64,
}

/// Manual impl instead of `#[derive(Deserialize)]` with an alias: the server
/// once emitted both `lastEventId` and `last_event_id` in the same object, and
/// a derived deserializer treats an alias pair as a duplicate field — rejecting
/// the whole payload and halting channel materialization for every session
/// (2026-07-14). Repeated spellings carry the same value, so last-wins is safe.
impl<'de> serde::Deserialize<'de> for AtriumChannel {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct ChannelVisitor;

        impl<'de> serde::de::Visitor<'de> for ChannelVisitor {
            type Value = AtriumChannel;

            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("an atrium channel object")
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: serde::de::MapAccess<'de>,
            {
                let mut id = None;
                let mut name = None;
                let mut kind = None;
                let mut active = false;
                let mut last_event_id = 0u64;
                while let Some(key) = map.next_key::<String>()? {
                    match key.as_str() {
                        "id" => id = Some(map.next_value()?),
                        "name" => name = Some(map.next_value()?),
                        "kind" => kind = Some(map.next_value()?),
                        "active" => active = map.next_value()?,
                        "last_event_id" | "lastEventId" => last_event_id = map.next_value()?,
                        _ => {
                            map.next_value::<serde::de::IgnoredAny>()?;
                        }
                    }
                }
                Ok(AtriumChannel {
                    id: id.ok_or_else(|| serde::de::Error::missing_field("id"))?,
                    name: name.ok_or_else(|| serde::de::Error::missing_field("name"))?,
                    kind: kind.ok_or_else(|| serde::de::Error::missing_field("kind"))?,
                    active,
                    last_event_id,
                })
            }
        }

        deserializer.deserialize_map(ChannelVisitor)
    }
}

#[derive(Debug, Clone, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct BundleRef {
    pub path: String,
    pub sha256: String,
    pub role: String,
    #[serde(default)]
    pub executable: bool,
}

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum HarnessTranscriptKind {
    Claude,
    Codex,
}

impl HarnessTranscriptKind {
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "claude" | "claude-code" | "claudecode" => Some(Self::Claude),
            "codex" => Some(Self::Codex),
            _ => None,
        }
    }

    pub fn atrium_harness(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
        }
    }

    pub fn default_home_rel(self) -> &'static str {
        match self {
            Self::Claude => ".claude",
            Self::Codex => ".codex",
        }
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

pub fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

pub fn is_denied_profile_path(path: &Path) -> bool {
    normalized_path_components(path).is_none_or(|components| is_denied_path(&components))
}

pub struct CaptureOutcome {
    pub captured: Vec<(String, u64, String)>, // (path, seq, sha) — inline (buffered) path
    pub streamed: Vec<(String, u64, String)>, // (path, seq, sha) — large-file streaming path (H8)
    pub deleted: Vec<(String, u64)>,
    pub skipped_echo: Vec<String>,
    pub skipped_other: Vec<String>,
    pub skipped_secret: usize,
    pub errors: Vec<(String, String)>,
}

/// Filesystem metadata recorded after a successful artifact capture. A matching
/// stamp lets the next sweep skip the read/hash/POST path entirely.
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub struct CaptureStamp {
    pub mtime_ns: i64,
    pub size: u64,
}

/// Files at/under this many bytes go through the in-memory `post_capture`; larger
/// ones stream (constant memory) and are routed OUT of the overlay dirty-byte
/// budget. 8 MiB keeps the common case (notes/code/configs) on the simple path.
pub const DEFAULT_LARGE_FILE_BYTES: u64 = 8 * 1024 * 1024;

/// Lane for an upper-dir entry. The artifact lane (workspace work-product) and
/// the harness-state lane (Codex/Claude exact-resume) must never mix: harness
/// homes carry auth tokens, credentials, and config that must NOT become artifacts.
#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum EntryLane {
    Artifact,
    HarnessState,
    Denied,
}

#[derive(Debug, Default)]
pub struct PartitionedEntries {
    pub artifact_entries: Vec<RawEntry>,
    pub harness_entries: Vec<RawEntry>,
    pub denied_count: usize,
}

pub fn classify_entry(
    rel_path: &Path,
    harness_homes: &[PathBuf],
    repo_subdirs: &[PathBuf],
) -> EntryLane {
    let Some(path_components) = normalized_path_components(rel_path) else {
        return EntryLane::Denied;
    };
    if is_denied_path(&path_components) {
        return EntryLane::Denied;
    }
    if matches!(path_components.as_slice(), [file] if file == ".claude.json") {
        return EntryLane::HarnessState;
    }
    // Centaur's operating-contract prompt is written to the workspace root by the
    // entrypoint (`~/AGENTS.md`, plus the amp `~/AGENT.md` symlink). It is sandbox
    // plumbing — the agent's system instructions — not a deliverable, so it must
    // never be captured as an artifact. Only the top-level (single-component) copy
    // is excluded; a repo's own nested `AGENTS.md` lives under a repo subdir and is
    // handled by the repo-subdir denial below.
    if matches!(path_components.as_slice(), [file] if file == "agents.md" || file == "agent.md") {
        return EntryLane::Denied;
    }
    if repo_subdirs
        .iter()
        .any(|subdir| first_component_matches_normalized_subdir(&path_components, subdir))
    {
        return EntryLane::Denied;
    }
    // Reserved top-level workspace dirs that are never artifacts: `repos/` holds the
    // session's git-managed working repos (nested `repos/<owner>/<repo>`, versioned by
    // git) and `context/` is a read-only Atrium projection (chat/sibling/ledger).
    // Reserving the whole prefix is what supersedes per-repo subdir matching above.
    if path_components
        .first()
        .is_some_and(|first| first == "repos" || first == "context")
    {
        return EntryLane::Denied;
    }
    if harness_homes
        .iter()
        .any(|home| starts_with_normalized_components(&path_components, home))
    {
        return EntryLane::HarnessState;
    }
    // Flat-~ home capture: the agent's home IS the workspace, so top-level dotfile
    // entries are toolchain/config/cache/state plumbing, never deliverables
    // (.cargo/.config/.cache/.npm/.state/.branches). Harness homes (.claude/.codex)
    // are matched just above and routed to HarnessState; auth is Denied above that.
    // Only the FIRST component is checked, so a deliverable that merely *contains*
    // a dotfile deeper down (e.g. myproject/.github/workflows/ci.yml) is still captured.
    if path_components
        .first()
        .is_some_and(|first| first.starts_with('.'))
    {
        return EntryLane::Denied;
    }
    EntryLane::Artifact
}

pub fn partition_entries_by_lane(
    entries: &[RawEntry],
    harness_homes: &[PathBuf],
    repo_subdirs: &[PathBuf],
) -> PartitionedEntries {
    let mut partitioned = PartitionedEntries::default();
    for entry in entries {
        match classify_entry(&entry.rel_path, harness_homes, repo_subdirs) {
            EntryLane::Artifact => partitioned.artifact_entries.push(entry.clone()),
            EntryLane::HarnessState => partitioned.harness_entries.push(entry.clone()),
            EntryLane::Denied => partitioned.denied_count += 1,
        }
    }
    partitioned
}

fn normalized_path_components(path: &Path) -> Option<Vec<String>> {
    let mut components = Vec::new();
    for component in path.components() {
        match component {
            std::path::Component::Normal(value) => {
                components.push(value.to_string_lossy().to_ascii_lowercase());
            }
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir
            | std::path::Component::RootDir
            | std::path::Component::Prefix(_) => return None,
        }
    }
    (!components.is_empty()).then_some(components)
}

fn starts_with_normalized_components(path_components: &[String], home: &Path) -> bool {
    let Some(home_components) = normalized_path_components(home) else {
        return false;
    };
    path_components.len() >= home_components.len()
        && path_components
            .iter()
            .zip(home_components.iter())
            .all(|(path, home)| path == home)
}

fn first_component_matches_normalized_subdir(path_components: &[String], subdir: &Path) -> bool {
    let Some(subdir_components) = normalized_path_components(subdir) else {
        return false;
    };
    matches!(
        subdir_components.as_slice(),
        [repo_subdir] if path_components.first() == Some(repo_subdir)
    )
}

fn is_denied_path(components: &[String]) -> bool {
    if components
        .iter()
        .any(|component| component == ".ssh" || component == ".aws" || component == ".git")
    {
        return true;
    }
    if components
        .iter()
        .any(|component| component.contains("credentials"))
    {
        return true;
    }
    let Some(file_name) = components.last() else {
        return true;
    };
    matches!(
        file_name.as_str(),
        "auth.json"
            | ".netrc"
            | ".git-credentials"
            | "id_rsa"
            | "id_dsa"
            | "id_ecdsa"
            | "id_ed25519"
    ) || file_name.ends_with(".pem")
        || file_name.ends_with(".key")
        || is_junk_binary_file(file_name)
}

fn is_junk_binary_file(file_name: &str) -> bool {
    const JUNK_BINARY_EXTENSIONS: &[&str] = &[
        ".o", ".a", ".so", ".dylib", ".dll", ".obj", ".class", ".pyc", ".pyo", ".exe",
    ];
    JUNK_BINARY_EXTENSIONS
        .iter()
        .any(|extension| file_name.ends_with(extension))
}

#[derive(Debug, Default)]
pub struct HarnessTranscriptOutcome {
    pub captured: Option<(PathBuf, usize)>,
    pub state_bundle_files: usize,
    pub skipped: bool,
    pub error: Option<String>,
}

#[derive(Debug, Default)]
pub struct ProfileCandidateSweepOutcome {
    pub uploaded: bool,
    pub candidate_count: usize,
    pub excluded_count: usize,
    pub bundle_count: usize,
    pub warnings: Vec<String>,
    pub skipped: bool,
    pub error: Option<String>,
}

#[derive(Debug, Default)]
pub struct CredentialRefreshOutcome {
    pub uploaded: bool,
    pub current_hash: Option<String>,
    pub skipped: bool,
    pub error: Option<String>,
}

#[derive(Debug, Default)]
pub struct ProfileBundleMaterializeOutcome {
    pub written: usize,
    pub skipped: usize,
    pub errors: Vec<(String, String)>,
}

/// One capture sweep: classify the upper, read bytes for each upsert, and POST to
/// Atrium with the hydrated base_seq — suppressing the node's own write-backs via
/// the echo guard. `base_seqs` is the hydration manifest (path → base_seq).
pub fn capture_sweep(
    entries: &[RawEntry],
    base_seqs: &HashMap<String, u64>,
    captured_stamps: &mut HashMap<String, CaptureStamp>,
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
        skipped_secret: 0,
        errors: vec![],
    };
    let entry_stamps: HashMap<&Path, CaptureStamp> = entries
        .iter()
        .map(|entry| {
            (
                entry.rel_path.as_path(),
                CaptureStamp {
                    mtime_ns: entry.mtime_ns,
                    size: entry.size,
                },
            )
        })
        .collect();
    let (ops, skipped) = scan_to_ops(entries);
    for (p, _r) in skipped {
        out.skipped_other.push(p.to_string_lossy().into_owned());
    }
    for op in ops {
        match op {
            OverlayOp::Upsert { path, size } => {
                let key = path.to_string_lossy().into_owned();
                let base = base_seqs.get(&key).copied().unwrap_or(0);
                let stamp = entry_stamps
                    .get(path.as_path())
                    .copied()
                    .expect("upsert operation must retain its source entry");
                // sqlite WAL/shared-memory files can be mmap-written without a
                // trustworthy mtime transition. Their backstop sweep must always
                // read and capture them even when the stat tuple appears stable.
                if !crate::scoped::is_mmap_pattern_path(&path)
                    && captured_stamps.get(&key) == Some(&stamp)
                {
                    out.skipped_other.push(key);
                    continue;
                }
                if size > large_threshold {
                    let sample = match read_secret_sample(reader, &path) {
                        Ok(sample) => sample,
                        Err(error) => {
                            out.errors.push((key, error));
                            continue;
                        }
                    };
                    if secret::is_secret(&path, &sample) {
                        out.skipped_secret += 1;
                        eprintln!("skip: suspected secret {key}");
                        continue;
                    }
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
                        captured_stamps.insert(key.clone(), stamp);
                        out.skipped_echo.push(key);
                        continue;
                    }
                    if echo.is_denied(&path, &sha) {
                        out.skipped_other.push(key);
                        continue;
                    }
                    let Some(mut body) = reader.open_stream(&path) else {
                        out.errors.push((key, "unreadable (torn/escaped)".into()));
                        continue;
                    };
                    match client.post_capture_stream(&key, base, &mut *body, size) {
                        Ok(seq) => {
                            captured_stamps.insert(key.clone(), stamp);
                            out.streamed.push((key, seq, sha));
                        }
                        Err(e) => {
                            if is_permanent_capture_denial(&e) {
                                echo.record_denied(path.clone(), sha.clone());
                            }
                            out.errors.push((key, e));
                        }
                    }
                    continue;
                }
                let Some(bytes) = reader.read(&path) else {
                    out.errors.push((key, "unreadable (torn/escaped)".into()));
                    continue;
                };
                let sample_len = bytes.len().min(secret::SECRET_SCAN_BYTES);
                if secret::is_secret(&path, &bytes[..sample_len]) {
                    out.skipped_secret += 1;
                    eprintln!("skip: suspected secret {key}");
                    continue;
                }
                let sha = sha_hex(&bytes);
                if echo.is_echo(&path, &sha) {
                    captured_stamps.insert(key.clone(), stamp);
                    out.skipped_echo.push(key);
                    continue;
                }
                if echo.is_denied(&path, &sha) {
                    out.skipped_other.push(key);
                    continue;
                }
                match client.post_capture(&key, base, &bytes) {
                    Ok(seq) => {
                        captured_stamps.insert(key.clone(), stamp);
                        out.captured.push((key, seq, sha));
                    }
                    Err(e) => {
                        if is_permanent_capture_denial(&e) {
                            echo.record_denied(path.clone(), sha.clone());
                        }
                        out.errors.push((key, e));
                    }
                }
            }
            OverlayOp::Delete { path } => {
                let key = path.to_string_lossy().into_owned();
                let base = base_seqs.get(&key).copied().unwrap_or(0);
                match client.post_delete(&key, base) {
                    Ok(seq) => {
                        captured_stamps.remove(&key);
                        out.deleted.push((key, seq));
                    }
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

/// A 403 from the capture endpoint is a policy verdict on these exact bytes
/// (unwritable root), not a transient fault — retrying the same content every
/// tick would spam forever. New bytes at the path clear the denial.
fn is_permanent_capture_denial(error: &str) -> bool {
    error.contains("status code 403")
}

fn read_secret_sample(reader: &dyn UpperReader, path: &Path) -> Result<Vec<u8>, String> {
    let Some(mut body) = reader.open_stream(path) else {
        return Err("unreadable (torn/escaped)".into());
    };
    let mut sample = Vec::new();
    let mut limited = (&mut *body).take(secret::SECRET_SCAN_BYTES as u64);
    limited
        .read_to_end(&mut sample)
        .map_err(|error| format!("secret sample: {error}"))?;
    Ok(sample)
}

pub fn locate_harness_transcript(
    entries: &[RawEntry],
    harness: HarnessTranscriptKind,
    harness_home: &Path,
    thread_id: &str,
    flat_home: bool,
) -> Option<PathBuf> {
    let thread_id = thread_id.trim();
    match harness {
        HarnessTranscriptKind::Claude if !thread_id.is_empty() => {
            let path = harness_home
                .join("projects")
                .join(claude_transcript_project_key(flat_home))
                .join(format!("{thread_id}.jsonl"));
            entries
                .iter()
                .any(|entry| {
                    entry.file_type == crate::overlay::RawFileType::Regular
                        && entry.rel_path == path
                })
                .then_some(path)
        }
        HarnessTranscriptKind::Claude => entries
            .iter()
            .filter(|entry| entry.file_type == crate::overlay::RawFileType::Regular)
            .filter(|entry| {
                entry.rel_path.starts_with(
                    harness_home
                        .join("projects")
                        .join(claude_transcript_project_key(flat_home)),
                )
            })
            .filter(|entry| {
                entry
                    .rel_path
                    .extension()
                    .is_some_and(|extension| extension == "jsonl")
            })
            .map(|entry| entry.rel_path.clone())
            .max(),
        HarnessTranscriptKind::Codex if !thread_id.is_empty() => {
            let file_suffix = format!("-{thread_id}.jsonl");
            entries
                .iter()
                .filter(|entry| entry.file_type == crate::overlay::RawFileType::Regular)
                .filter(|entry| entry.rel_path.starts_with(harness_home.join("sessions")))
                .filter(|entry| {
                    entry.rel_path.file_name().is_some_and(|name| {
                        let name = name.to_string_lossy();
                        name.starts_with("rollout-") && name.ends_with(&file_suffix)
                    })
                })
                .map(|entry| entry.rel_path.clone())
                .max()
        }
        HarnessTranscriptKind::Codex => entries
            .iter()
            .filter(|entry| entry.file_type == crate::overlay::RawFileType::Regular)
            .filter(|entry| entry.rel_path.starts_with(harness_home.join("sessions")))
            .filter(|entry| {
                entry.rel_path.file_name().is_some_and(|name| {
                    let name = name.to_string_lossy();
                    name.starts_with("rollout-") && name.ends_with(".jsonl")
                })
            })
            .map(|entry| entry.rel_path.clone())
            .max(),
    }
}

pub fn claude_transcript_project_key(flat_home: bool) -> &'static str {
    if flat_home {
        "-home-agent"
    } else {
        "-home-agent-workspace"
    }
}

pub fn harness_transcript_sweep(
    entries: &[RawEntry],
    reader: &dyn UpperReader,
    client: &mut dyn AtriumClient,
    harness: HarnessTranscriptKind,
    harness_home: &Path,
    thread_id: &str,
    flat_home: bool,
) -> HarnessTranscriptOutcome {
    let Some(path) =
        locate_harness_transcript(entries, harness, harness_home, thread_id, flat_home)
    else {
        return HarnessTranscriptOutcome {
            skipped: true,
            ..HarnessTranscriptOutcome::default()
        };
    };
    let Some(bytes) = reader.read(&path) else {
        return HarnessTranscriptOutcome {
            error: Some(format!("unreadable transcript {}", path.display())),
            ..HarnessTranscriptOutcome::default()
        };
    };
    match client.put_harness_transcript(harness.atrium_harness(), &bytes) {
        Ok(()) => {
            let state_bundle = harness_state_bundle_payload(entries, reader, &path);
            match client.put_harness_state_bundle(harness.atrium_harness(), &state_bundle) {
                Ok(()) => HarnessTranscriptOutcome {
                    captured: Some((path, bytes.len())),
                    state_bundle_files: state_bundle["manifest"]["files"]
                        .as_array()
                        .map_or(0, Vec::len),
                    ..HarnessTranscriptOutcome::default()
                },
                Err(error) => HarnessTranscriptOutcome {
                    captured: Some((path, bytes.len())),
                    error: Some(error),
                    ..HarnessTranscriptOutcome::default()
                },
            }
        }
        Err(error) => HarnessTranscriptOutcome {
            error: Some(error),
            ..HarnessTranscriptOutcome::default()
        },
    }
}

fn harness_state_bundle_payload(
    entries: &[RawEntry],
    reader: &dyn UpperReader,
    transcript_path: &Path,
) -> Value {
    let transcript_parent = transcript_path.parent();
    let mut files = entries
        .iter()
        .filter(|entry| entry.file_type == crate::overlay::RawFileType::Regular)
        .filter(|entry| entry.rel_path.parent() == transcript_parent)
        .filter(|entry| !is_denied_profile_path(&entry.rel_path))
        .filter_map(|entry| {
            let bytes = reader.read(&entry.rel_path)?;
            let role = if entry.rel_path == transcript_path {
                "transcript"
            } else {
                // TODO: replace same-directory sidecar discovery with richer,
                // provider-version-specific exact-resume bundle discovery.
                "resume_sidecar"
            };
            Some(json!({
                "path": path_string(&entry.rel_path),
                "sha256": sha256_hex(&bytes),
                "sizeBytes": bytes.len() as u64,
                "role": role,
            }))
        })
        .collect::<Vec<_>>();
    files.sort_by(|a, b| {
        a["path"]
            .as_str()
            .unwrap_or_default()
            .cmp(b["path"].as_str().unwrap_or_default())
    });
    json!({
        "adapterVersion": crate::profile_candidates::ADAPTER_VERSION,
        "manifest": { "files": files },
    })
}

pub fn profile_candidate_sweep(
    entries: &[RawEntry],
    reader: &dyn UpperReader,
    client: &mut dyn AtriumClient,
    harness: HarnessTranscriptKind,
    harness_home: &Path,
) -> ProfileCandidateSweepOutcome {
    let report = crate::profile_candidates::extract_profile_candidates(
        entries,
        reader,
        harness,
        harness_home,
    );
    let source_count = report
        .manifest
        .get("source_count")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    let candidate_count = report.candidates.len();
    let excluded_count = report.excluded.len();
    let bundle_count = report.bundles.len();
    let warnings = report.warnings.clone();
    if source_count == 0
        && candidate_count == 0
        && excluded_count == 0
        && bundle_count == 0
        && warnings.is_empty()
    {
        return ProfileCandidateSweepOutcome {
            skipped: true,
            ..ProfileCandidateSweepOutcome::default()
        };
    }
    for bundle in &report.bundles {
        if let Err(error) =
            client.put_profile_bundle_blob(&bundle.sha256, &bundle.path, &bundle.bytes)
        {
            return ProfileCandidateSweepOutcome {
                candidate_count,
                excluded_count,
                bundle_count,
                warnings,
                error: Some(format!("put profile bundle blob {}: {error}", bundle.path)),
                ..ProfileCandidateSweepOutcome::default()
            };
        }
    }
    let payload = report.into_payload();
    match client.put_profile_candidates(harness.atrium_harness(), &payload) {
        Ok(()) => ProfileCandidateSweepOutcome {
            uploaded: true,
            candidate_count,
            excluded_count,
            bundle_count,
            warnings,
            ..ProfileCandidateSweepOutcome::default()
        },
        Err(error) => ProfileCandidateSweepOutcome {
            candidate_count,
            excluded_count,
            bundle_count,
            warnings,
            error: Some(error),
            ..ProfileCandidateSweepOutcome::default()
        },
    }
}

pub fn profile_baseline_sweep(
    entries: &[RawEntry],
    reader: &dyn UpperReader,
    client: &mut dyn AtriumClient,
    harness: HarnessTranscriptKind,
    harness_home: &Path,
) -> ProfileCandidateSweepOutcome {
    let report = crate::profile_candidates::extract_profile_candidates(
        entries,
        reader,
        harness,
        harness_home,
    );
    let source_count = report
        .manifest
        .get("source_count")
        .and_then(|value| value.as_u64())
        .unwrap_or(0);
    let candidate_count = report.candidates.len();
    let excluded_count = report.excluded.len();
    let bundle_count = report.bundles.len();
    let warnings = report.warnings.clone();
    if source_count == 0
        && candidate_count == 0
        && excluded_count == 0
        && bundle_count == 0
        && warnings.is_empty()
    {
        return ProfileCandidateSweepOutcome {
            skipped: true,
            ..ProfileCandidateSweepOutcome::default()
        };
    }
    let payload = report.into_baseline_payload();
    match client.put_profile_baseline(harness.atrium_harness(), &payload) {
        Ok(()) => ProfileCandidateSweepOutcome {
            uploaded: true,
            candidate_count,
            excluded_count,
            bundle_count,
            warnings,
            ..ProfileCandidateSweepOutcome::default()
        },
        Err(error) => ProfileCandidateSweepOutcome {
            candidate_count,
            excluded_count,
            bundle_count,
            warnings,
            error: Some(error),
            ..ProfileCandidateSweepOutcome::default()
        },
    }
}

/// `seen_hash` is the sha256 of the credential file we have already accounted for
/// in this session (the injected baseline, or the last value written back). It is
/// `None` only on the very first sweep of a session, where the credential file is
/// always the entrypoint-injected baseline (in brokered/subscription mode this is a
/// static dummy, e.g. a far-future-exp `.credentials.json`). We must NEVER echo that
/// baseline back: Atrium's credential store overwrites unconditionally for Claude, so
/// echoing the dummy would clobber the user's real stored credential. Only a genuine
/// in-session change (current != baseline) is written back.
pub fn credential_refresh_sweep(
    reader: &dyn UpperReader,
    client: &mut dyn AtriumClient,
    harness: HarnessTranscriptKind,
    harness_home: &Path,
    seen_hash: Option<&str>,
) -> CredentialRefreshOutcome {
    let path = match harness {
        HarnessTranscriptKind::Codex => harness_home.join("auth.json"),
        HarnessTranscriptKind::Claude => harness_home.join(".credentials.json"),
    };
    let Some(bytes) = reader.read(&path) else {
        return CredentialRefreshOutcome {
            skipped: true,
            ..CredentialRefreshOutcome::default()
        };
    };
    let current_hash = sha256_hex(&bytes);
    // First sight of the credential file = the entrypoint-injected baseline. Record it
    // (the caller persists `current_hash`) but never write it back. Returning the hash
    // with `skipped` lets the next sweep compare against this baseline.
    if seen_hash.is_none() || seen_hash == Some(current_hash.as_str()) {
        return CredentialRefreshOutcome {
            current_hash: Some(current_hash),
            skipped: true,
            ..CredentialRefreshOutcome::default()
        };
    }
    let body = match harness {
        HarnessTranscriptKind::Codex => match String::from_utf8(bytes) {
            Ok(text) => json!({ "authJson": text }),
            Err(error) => {
                return CredentialRefreshOutcome {
                    current_hash: Some(current_hash),
                    error: Some(format!("credential file is not utf-8: {error}")),
                    ..CredentialRefreshOutcome::default()
                };
            }
        },
        HarnessTranscriptKind::Claude => match extract_claude_oauth_access_token(&bytes) {
            Ok(token) => json!({ "token": token }),
            Err(error) => {
                return CredentialRefreshOutcome {
                    current_hash: Some(current_hash),
                    error: Some(error),
                    ..CredentialRefreshOutcome::default()
                };
            }
        },
    };
    match client.put_provider_credential_refresh(harness.atrium_harness(), &body) {
        Ok(()) => CredentialRefreshOutcome {
            uploaded: true,
            current_hash: Some(current_hash),
            ..CredentialRefreshOutcome::default()
        },
        Err(error) => CredentialRefreshOutcome {
            current_hash: Some(current_hash),
            error: Some(error),
            ..CredentialRefreshOutcome::default()
        },
    }
}

fn extract_claude_oauth_access_token(bytes: &[u8]) -> Result<String, String> {
    let value = serde_json::from_slice::<Value>(bytes)
        .map_err(|error| format!("parse Claude credentials: {error}"))?;
    for path in [
        &["claudeAiOauth", "accessToken"][..],
        &["claudeAiOauth", "access_token"][..],
        &["oauth", "accessToken"][..],
        &["oauth", "access_token"][..],
        &["accessToken"][..],
        &["access_token"][..],
    ] {
        let mut cursor = &value;
        for key in path {
            cursor = cursor.get(*key).unwrap_or(&Value::Null);
        }
        if let Some(token) = cursor.as_str().map(str::trim)
            && !token.is_empty()
        {
            return Ok(token.to_string());
        }
    }
    Err("Claude credentials did not contain an OAuth access token".to_string())
}

pub fn materialize_profile_bundles(
    client: &dyn AtriumClient,
    harness: HarnessTranscriptKind,
    harness_home: &Path,
    root: &Path,
    already_materialized: &mut HashMap<String, String>,
    write: impl FnMut(&Path, &[u8], bool) -> Result<(), String>,
) -> ProfileBundleMaterializeOutcome {
    let mut out = ProfileBundleMaterializeOutcome::default();
    let bundles = match client.get_profile_bundles(harness.atrium_harness()) {
        Ok(bundles) => bundles,
        Err(error) => {
            out.errors
                .push((harness.atrium_harness().to_string(), error));
            return out;
        }
    };
    materialize_profile_bundles_from_refs(
        client,
        harness,
        harness_home,
        root,
        already_materialized,
        bundles,
        write,
    )
}

pub fn materialize_profile_bundles_from_refs(
    client: &dyn AtriumClient,
    _harness: HarnessTranscriptKind,
    harness_home: &Path,
    root: &Path,
    already_materialized: &mut HashMap<String, String>,
    bundles: Vec<BundleRef>,
    mut write: impl FnMut(&Path, &[u8], bool) -> Result<(), String>,
) -> ProfileBundleMaterializeOutcome {
    let mut out = ProfileBundleMaterializeOutcome::default();
    for bundle in bundles {
        let rel_path = materialized_bundle_path(harness_home, &bundle.path);
        if is_denied_profile_path(&rel_path) {
            out.skipped += 1;
            continue;
        }
        if already_materialized
            .get(&bundle.path)
            .is_some_and(|sha| sha == &bundle.sha256)
        {
            out.skipped += 1;
            continue;
        }
        match client.get_profile_bundle_blob(&bundle.sha256) {
            Ok(bytes) => {
                if sha256_hex(&bytes) != bundle.sha256 {
                    out.errors.push((
                        bundle.path.clone(),
                        "profile bundle blob sha256 mismatch".to_string(),
                    ));
                    continue;
                }
                if let Err(error) = write(&root.join(&rel_path), &bytes, bundle.executable) {
                    out.errors.push((bundle.path.clone(), error));
                    continue;
                }
                already_materialized.insert(bundle.path.clone(), bundle.sha256.clone());
                out.written += 1;
            }
            Err(error) => out.errors.push((bundle.path.clone(), error)),
        }
    }
    out
}

fn materialized_bundle_path(harness_home: &Path, path: &str) -> PathBuf {
    let path = PathBuf::from(path);
    if path.starts_with(harness_home) {
        path
    } else {
        harness_home.join(path)
    }
}

fn path_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

#[derive(Debug, Default)]
pub struct WipSweepOutcome {
    pub captured: Vec<(String, u64, String)>,
    pub deleted: Vec<(String, u64)>,
    pub errors: Vec<(String, String)>,
}

/// Capture uncommitted repo WIP to the ledger as a recovery point (§5A / H6).
/// PURE-READ: the bytes come from `wip::capture_wip` (a `git diff HEAD` +
/// untracked snapshot, zero git writes). Lands under session scratch
/// (`scratch/wip/<repo>/…`) so another live agent does not adopt it as shared
/// workspace state. A versioned snapshot is published first and `latest.json` is
/// written last as the visible commit point.
pub fn wip_sweep(
    repo_name: &str,
    patch: &crate::wip::WipPatch,
    base_seqs: &HashMap<String, u64>,
    client: &mut dyn AtriumClient,
) -> WipSweepOutcome {
    let mut out = WipSweepOutcome::default();
    let latest_path = crate::wip::latest_path(repo_name);
    if patch.is_empty() {
        if let Some(base) = base_seqs.get(&latest_path).copied()
            && base > 0
        {
            match client.post_delete(&latest_path, base) {
                Ok(seq) => out.deleted.push((latest_path, seq)),
                Err(e) => out.errors.push((latest_path, e)),
            }
        }
        return out;
    }
    let snapshot = match crate::wip::snapshot_from_patch(repo_name, patch) {
        Ok(Some(snapshot)) => snapshot,
        Ok(None) => return out,
        Err(e) => {
            out.errors.push((latest_path, e));
            return out;
        }
    };
    for (path, bytes, _mime) in snapshot.files {
        let base = base_seqs.get(&path).copied().unwrap_or(0);
        match client.post_capture(&path, base, &bytes) {
            Ok(seq) => out.captured.push((path, seq, sha_hex(&bytes))),
            Err(e) => out.errors.push((path, e)),
        }
    }
    if out.errors.is_empty() {
        let base = base_seqs.get(&snapshot.latest_path).copied().unwrap_or(0);
        match client.post_capture(&snapshot.latest_path, base, &snapshot.latest_bytes) {
            Ok(seq) => {
                out.captured
                    .push((snapshot.latest_path, seq, sha_hex(&snapshot.latest_bytes)))
            }
            Err(e) => out.errors.push((snapshot.latest_path, e)),
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
    use std::cell::Cell;

    struct MapReader(HashMap<PathBuf, Vec<u8>>);
    impl UpperReader for MapReader {
        fn read(&self, path: &Path) -> Option<Vec<u8>> {
            self.0.get(path).cloned()
        }
    }

    struct CountingReader {
        bytes: Vec<u8>,
        reads: Cell<usize>,
        streams: Cell<usize>,
    }

    impl CountingReader {
        fn new(bytes: &[u8]) -> Self {
            Self {
                bytes: bytes.to_vec(),
                reads: Cell::new(0),
                streams: Cell::new(0),
            }
        }
    }

    impl UpperReader for CountingReader {
        fn read(&self, _path: &Path) -> Option<Vec<u8>> {
            self.reads.set(self.reads.get() + 1);
            Some(self.bytes.clone())
        }

        fn open_stream<'a>(&'a self, _path: &Path) -> Option<Box<dyn Read + 'a>> {
            self.streams.set(self.streams.get() + 1);
            Some(Box::new(std::io::Cursor::new(self.bytes.clone())))
        }
    }

    #[derive(Default)]
    struct FakeClient {
        captures: Vec<(String, u64)>,
        deletes: Vec<(String, u64)>,
        transcripts: Vec<(String, Vec<u8>)>,
        profile_candidates: Vec<(String, serde_json::Value)>,
        credential_refreshes: Vec<(String, serde_json::Value)>,
        state_bundles: Vec<(String, serde_json::Value)>,
        baselines: Vec<(String, serde_json::Value)>,
        profile_bundle_blobs: Vec<(String, String, Vec<u8>)>,
        profile_bundles: Vec<BundleRef>,
        profile_bundle_blob_bytes: HashMap<String, Vec<u8>>,
        next_seq: u64,
        capture_attempts: u64,
        deny_captures: bool,
    }
    impl AtriumClient for FakeClient {
        fn post_capture(&mut self, path: &str, _base: u64, _bytes: &[u8]) -> Result<u64, String> {
            self.capture_attempts += 1;
            if self.deny_captures {
                return Err(format!("capture {path}: status code 403"));
            }
            self.next_seq += 1;
            self.captures.push((path.to_string(), self.next_seq));
            Ok(self.next_seq)
        }
        fn post_delete(&mut self, path: &str, _base: u64) -> Result<u64, String> {
            self.next_seq += 1;
            self.deletes.push((path.to_string(), self.next_seq));
            Ok(self.next_seq)
        }
        fn fetch_bytes(&mut self, _path: &str, _seq: u64) -> Result<Vec<u8>, String> {
            Ok(b"remote bytes".to_vec())
        }
        fn put_harness_transcript(&mut self, harness: &str, bytes: &[u8]) -> Result<(), String> {
            self.transcripts.push((harness.to_owned(), bytes.to_vec()));
            Ok(())
        }
        fn put_profile_candidates(
            &mut self,
            harness: &str,
            payload: &serde_json::Value,
        ) -> Result<(), String> {
            self.profile_candidates
                .push((harness.to_owned(), payload.clone()));
            Ok(())
        }
        fn put_provider_credential_refresh(
            &mut self,
            harness: &str,
            body: &serde_json::Value,
        ) -> Result<(), String> {
            self.credential_refreshes
                .push((harness.to_owned(), body.clone()));
            Ok(())
        }
        fn put_harness_state_bundle(
            &mut self,
            harness: &str,
            manifest: &serde_json::Value,
        ) -> Result<(), String> {
            self.state_bundles
                .push((harness.to_owned(), manifest.clone()));
            Ok(())
        }
        fn put_profile_baseline(
            &mut self,
            harness: &str,
            payload: &serde_json::Value,
        ) -> Result<(), String> {
            self.baselines.push((harness.to_owned(), payload.clone()));
            Ok(())
        }
        fn put_profile_bundle_blob(
            &mut self,
            sha256: &str,
            path: &str,
            bytes: &[u8],
        ) -> Result<(), String> {
            self.profile_bundle_blobs
                .push((sha256.to_string(), path.to_string(), bytes.to_vec()));
            Ok(())
        }
        fn get_profile_bundles(&self, _harness: &str) -> Result<Vec<BundleRef>, String> {
            Ok(self.profile_bundles.clone())
        }
        fn get_profile_bundle_blob(&self, sha256: &str) -> Result<Vec<u8>, String> {
            self.profile_bundle_blob_bytes
                .get(sha256)
                .cloned()
                .ok_or_else(|| format!("missing blob {sha256}"))
        }
        fn atrium_changes(&self, since: &str) -> Result<(Vec<String>, String), String> {
            Ok((vec![], since.to_string()))
        }
        fn atrium_doc(&self, target_id: &str, doc: &str) -> Result<Vec<u8>, String> {
            Ok(format!("{target_id}/{doc}").into_bytes())
        }
    }

    fn reg(p: &str) -> RawEntry {
        RawEntry {
            rel_path: PathBuf::from(p),
            file_type: RawFileType::Regular,
            rdev: 0,
            size: 4,
            mtime_ns: 0,
            xattrs: vec![],
        }
    }
    fn whiteout(p: &str) -> RawEntry {
        RawEntry {
            rel_path: PathBuf::from(p),
            file_type: RawFileType::CharDevice,
            rdev: 0,
            size: 0,
            mtime_ns: 0,
            xattrs: vec![],
        }
    }

    fn stamped_reg(p: &str, mtime_ns: i64, size: u64) -> RawEntry {
        RawEntry {
            rel_path: PathBuf::from(p),
            file_type: RawFileType::Regular,
            rdev: 0,
            size,
            mtime_ns,
            xattrs: vec![],
        }
    }

    #[test]
    fn capture_sweep_skips_unchanged_present_file_before_reading() {
        let entries = vec![stamped_reg("proj-x/a.md", 123, 4)];
        let mut stamps = HashMap::from([(
            "proj-x/a.md".to_string(),
            CaptureStamp {
                mtime_ns: 123,
                size: 4,
            },
        )]);
        let reader = CountingReader::new(b"data");
        let mut echo = EchoGuard::new();
        let mut client = FakeClient::default();

        let out = capture_sweep(
            &entries,
            &HashMap::new(),
            &mut stamps,
            &reader,
            &mut echo,
            &mut client,
            DEFAULT_LARGE_FILE_BYTES,
        );

        assert_eq!(reader.reads.get(), 0);
        assert_eq!(reader.streams.get(), 0);
        assert_eq!(client.capture_attempts, 0);
        assert!(out.captured.is_empty());
    }

    #[test]
    fn capture_sweep_captures_file_when_mtime_changed() {
        let entries = vec![stamped_reg("proj-x/a.md", 124, 4)];
        let mut stamps = HashMap::from([(
            "proj-x/a.md".to_string(),
            CaptureStamp {
                mtime_ns: 123,
                size: 4,
            },
        )]);
        let reader = CountingReader::new(b"data");
        let mut echo = EchoGuard::new();
        let mut client = FakeClient::default();

        let out = capture_sweep(
            &entries,
            &HashMap::new(),
            &mut stamps,
            &reader,
            &mut echo,
            &mut client,
            DEFAULT_LARGE_FILE_BYTES,
        );

        assert_eq!(reader.reads.get(), 1);
        assert_eq!(out.captured.len(), 1);
        assert_eq!(stamps["proj-x/a.md"].mtime_ns, 124);
    }

    #[test]
    fn capture_sweep_captures_file_when_size_changed() {
        let entries = vec![stamped_reg("proj-x/a.md", 123, 5)];
        let mut stamps = HashMap::from([(
            "proj-x/a.md".to_string(),
            CaptureStamp {
                mtime_ns: 123,
                size: 4,
            },
        )]);
        let reader = CountingReader::new(b"data!");
        let mut echo = EchoGuard::new();
        let mut client = FakeClient::default();

        let out = capture_sweep(
            &entries,
            &HashMap::new(),
            &mut stamps,
            &reader,
            &mut echo,
            &mut client,
            DEFAULT_LARGE_FILE_BYTES,
        );

        assert_eq!(reader.reads.get(), 1);
        assert_eq!(out.captured.len(), 1);
        assert_eq!(stamps["proj-x/a.md"].size, 5);
    }

    #[test]
    fn capture_sweep_captures_file_missing_recorded_state() {
        let entries = vec![stamped_reg("proj-x/a.md", 123, 4)];
        let mut stamps = HashMap::new();
        let reader = CountingReader::new(b"data");
        let mut echo = EchoGuard::new();
        let mut client = FakeClient::default();

        let out = capture_sweep(
            &entries,
            &HashMap::new(),
            &mut stamps,
            &reader,
            &mut echo,
            &mut client,
            DEFAULT_LARGE_FILE_BYTES,
        );

        assert_eq!(reader.reads.get(), 1);
        assert_eq!(out.captured.len(), 1);
        assert_eq!(stamps["proj-x/a.md"].size, 4);
    }

    #[test]
    fn capture_sweep_posts_delete_despite_matching_recorded_state() {
        let entries = vec![whiteout("proj-x/a.md")];
        let mut stamps = HashMap::from([(
            "proj-x/a.md".to_string(),
            CaptureStamp {
                mtime_ns: 0,
                size: 0,
            },
        )]);
        let reader = CountingReader::new(b"");
        let mut echo = EchoGuard::new();
        let mut client = FakeClient::default();

        let out = capture_sweep(
            &entries,
            &HashMap::new(),
            &mut stamps,
            &reader,
            &mut echo,
            &mut client,
            DEFAULT_LARGE_FILE_BYTES,
        );

        assert_eq!(out.deleted.len(), 1);
        assert_eq!(client.deletes.len(), 1);
        assert!(!stamps.contains_key("proj-x/a.md"));
    }

    #[test]
    fn capture_sweep_never_metadata_skips_sqlite_mmap_files() {
        let entries = vec![stamped_reg("db.sqlite-wal", 123, 4)];
        let mut stamps = HashMap::from([(
            "db.sqlite-wal".to_string(),
            CaptureStamp {
                mtime_ns: 123,
                size: 4,
            },
        )]);
        let reader = CountingReader::new(b"data");
        let mut echo = EchoGuard::new();
        let mut client = FakeClient::default();

        let out = capture_sweep(
            &entries,
            &HashMap::new(),
            &mut stamps,
            &reader,
            &mut echo,
            &mut client,
            DEFAULT_LARGE_FILE_BYTES,
        );

        assert_eq!(reader.reads.get(), 1);
        assert_eq!(out.captured.len(), 1);
    }

    #[test]
    fn classify_entry_routes_harness_home_entries_to_harness_state() {
        let homes = vec![PathBuf::from(".claude"), PathBuf::from(".codex")];

        assert_eq!(
            classify_entry(
                Path::new(".claude/projects/x/transcript.jsonl"),
                &homes,
                &[]
            ),
            EntryLane::HarnessState
        );
        assert_eq!(
            classify_entry(
                Path::new(".codex/sessions/2026/01/01/rollout-x.jsonl"),
                &homes,
                &[]
            ),
            EntryLane::HarnessState
        );
    }

    #[test]
    fn classify_entry_denies_top_level_dotfile_entries_but_allows_nested_dotfiles() {
        let homes = vec![PathBuf::from(".claude"), PathBuf::from(".codex")];

        for path in [
            ".heartbeat",
            ".cargo/registry/foo.rs",
            ".config/app/settings.json",
            ".state/anything",
        ] {
            assert_eq!(
                classify_entry(Path::new(path), &homes, &[]),
                EntryLane::Denied,
                "{path} should be denied"
            );
        }
        assert_eq!(
            classify_entry(
                Path::new(".claude/projects/x/transcript.jsonl"),
                &homes,
                &[]
            ),
            EntryLane::HarnessState
        );
        assert_eq!(
            classify_entry(
                Path::new(".codex/sessions/2026/01/01/rollout-x.jsonl"),
                &homes,
                &[]
            ),
            EntryLane::HarnessState
        );
        assert_eq!(
            classify_entry(Path::new(".claude.json"), &homes, &[]),
            EntryLane::HarnessState
        );
        assert_eq!(
            classify_entry(Path::new("report.md"), &homes, &[]),
            EntryLane::Artifact
        );
        assert_eq!(
            classify_entry(Path::new("myproject/.github/workflows/ci.yml"), &homes, &[]),
            EntryLane::Artifact
        );
    }

    #[test]
    fn classify_entry_denies_sensitive_paths_regardless_of_location() {
        let homes = vec![PathBuf::from(".claude"), PathBuf::from(".codex")];
        for path in [
            ".codex/auth.json",
            ".claude/.credentials.json",
            "proj/secrets/id_rsa",
            "proj/secrets/cert.pem",
            "proj/secrets/signing.key",
            ".aws/credentials",
            ".git-credentials",
            ".ssh/id_ed25519",
        ] {
            assert_eq!(
                classify_entry(Path::new(path), &homes, &[]),
                EntryLane::Denied,
                "{path} should be denied"
            );
        }
    }

    #[test]
    fn classify_entry_denies_git_metadata_components() {
        let homes = vec![PathBuf::from(".claude"), PathBuf::from(".codex")];

        for path in [".git/index", "foo/.git/HEAD"] {
            assert_eq!(
                classify_entry(Path::new(path), &homes, &[]),
                EntryLane::Denied,
                "{path} should be denied"
            );
        }
        for path in ["report.md", "src/main.rs"] {
            assert_eq!(
                classify_entry(Path::new(path), &homes, &[]),
                EntryLane::Artifact,
                "{path} should remain an artifact"
            );
        }
    }

    #[test]
    fn classify_entry_denies_binary_junk_extensions() {
        let homes = vec![PathBuf::from(".claude"), PathBuf::from(".codex")];

        assert_eq!(
            classify_entry(Path::new("target/foo.o"), &homes, &[]),
            EntryLane::Denied
        );
        for path in ["report.pdf", "data.csv", "notes.md"] {
            assert_eq!(
                classify_entry(Path::new(path), &homes, &[]),
                EntryLane::Artifact,
                "{path} should remain an artifact"
            );
        }
    }

    #[test]
    fn classify_entry_routes_workspace_files_to_artifacts() {
        let homes = vec![PathBuf::from(".claude"), PathBuf::from(".codex")];

        assert_eq!(
            classify_entry(Path::new("proj-x/note.md"), &homes, &[]),
            EntryLane::Artifact
        );
        assert_eq!(
            classify_entry(Path::new("src/app.ts"), &homes, &[]),
            EntryLane::Artifact
        );
    }

    #[test]
    fn classify_entry_denies_top_level_centaur_prompt_files() {
        let homes = vec![PathBuf::from(".claude"), PathBuf::from(".codex")];

        // The entrypoint-written operating contract at the workspace root is plumbing,
        // never a captured artifact — case-insensitively, and including amp's AGENT.md.
        assert_eq!(
            classify_entry(Path::new("AGENTS.md"), &homes, &[]),
            EntryLane::Denied
        );
        assert_eq!(
            classify_entry(Path::new("AGENT.md"), &homes, &[]),
            EntryLane::Denied
        );
        assert_eq!(
            classify_entry(Path::new("agents.md"), &homes, &[]),
            EntryLane::Denied
        );
        // A genuine deliverable the agent authors deeper in the tree is still captured;
        // only the top-level (single-component) contract copy is excluded.
        assert_eq!(
            classify_entry(Path::new("notes/AGENTS.md"), &homes, &[]),
            EntryLane::Artifact
        );
    }

    #[test]
    fn classify_entry_denies_reserved_repos_and_context_dirs() {
        let homes = vec![PathBuf::from(".claude"), PathBuf::from(".codex")];

        // repos/ holds git-managed working repos (nested repos/<owner>/<repo>) — never
        // an artifact; context/ is a read-only Atrium projection.
        assert_eq!(
            classify_entry(Path::new("repos/acme/widget/src/main.rs"), &homes, &[]),
            EntryLane::Denied
        );
        assert_eq!(
            classify_entry(Path::new("context/thread.json"), &homes, &[]),
            EntryLane::Denied
        );
        // A deliverable whose name merely starts similarly is still captured.
        assert_eq!(
            classify_entry(Path::new("reports/q3.md"), &homes, &[]),
            EntryLane::Artifact
        );
    }

    #[test]
    fn classify_entry_denies_repo_subdir_working_tree_entries() {
        let homes = vec![PathBuf::from(".claude"), PathBuf::from(".codex")];
        let repo_subdirs = vec![PathBuf::from("foo")];

        assert_eq!(
            classify_entry(Path::new("foo/agent-created.txt"), &homes, &repo_subdirs),
            EntryLane::Denied
        );
        assert_eq!(
            classify_entry(Path::new("shared/foo"), &homes, &repo_subdirs),
            EntryLane::Artifact
        );
        assert_eq!(
            classify_entry(
                Path::new("foo-report/agent-created.txt"),
                &homes,
                &repo_subdirs
            ),
            EntryLane::Artifact
        );
        assert_eq!(
            classify_entry(Path::new("foo/agent-created.txt"), &homes, &[]),
            EntryLane::Artifact
        );
    }

    #[test]
    fn partition_entries_by_lane_keeps_harness_and_denied_paths_out_of_capture_sweep() {
        let entries = vec![
            reg("proj-x/note.md"),
            reg("src/app.ts"),
            reg("foo/agent-created.txt"),
            reg(".codex/sessions/y/rollout.jsonl"),
            reg(".claude/projects/x/transcript.jsonl"),
            reg(".codex/auth.json"),
            reg(".ssh/id_ed25519"),
            reg(".heartbeat"),
        ];
        let homes = vec![PathBuf::from(".claude"), PathBuf::from(".codex")];
        let repo_subdirs = vec![PathBuf::from("foo")];
        let partitioned = partition_entries_by_lane(&entries, &homes, &repo_subdirs);
        let artifact_paths: Vec<&Path> = partitioned
            .artifact_entries
            .iter()
            .map(|entry| entry.rel_path.as_path())
            .collect();

        assert_eq!(
            artifact_paths,
            vec![Path::new("proj-x/note.md"), Path::new("src/app.ts")]
        );
        assert_eq!(partitioned.harness_entries.len(), 2);
        assert_eq!(partitioned.denied_count, 4);

        let mut files = HashMap::new();
        files.insert(PathBuf::from("proj-x/note.md"), b"note".to_vec());
        files.insert(PathBuf::from("src/app.ts"), b"code".to_vec());
        let reader = MapReader(files);
        let mut echo = EchoGuard::new();
        let mut client = FakeClient::default();

        let out = capture_sweep(
            &partitioned.artifact_entries,
            &HashMap::new(),
            &mut HashMap::new(),
            &reader,
            &mut echo,
            &mut client,
            DEFAULT_LARGE_FILE_BYTES,
        );
        assert!(out.errors.is_empty());

        let captured_paths: Vec<&str> = client
            .captures
            .iter()
            .map(|(path, _seq)| path.as_str())
            .collect();
        assert_eq!(captured_paths, vec!["proj-x/note.md", "src/app.ts"]);
        assert!(
            captured_paths
                .iter()
                .all(|path| !path.starts_with(".codex") && !path.starts_with(".claude"))
        );
        assert!(
            captured_paths
                .iter()
                .all(|path| !path.contains("auth.json") && !path.contains(".ssh"))
        );
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
            &mut HashMap::new(),
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
    fn capture_sweep_tombstones_denied_captures_until_content_changes() {
        let entries = vec![reg("shared/channels/other/plan.md")];
        let mut files = HashMap::new();
        files.insert(
            PathBuf::from("shared/channels/other/plan.md"),
            b"the plan".to_vec(),
        );
        let reader = MapReader(files);
        let base = HashMap::new();
        let mut echo = EchoGuard::new();
        let mut client = FakeClient {
            deny_captures: true,
            ..FakeClient::default()
        };

        // First sweep: the server refuses with 403 — one attempt, one error.
        let first = capture_sweep(
            &entries,
            &base,
            &mut HashMap::new(),
            &reader,
            &mut echo,
            &mut client,
            1 << 20,
        );
        assert_eq!(client.capture_attempts, 1);
        assert_eq!(first.errors.len(), 1);

        // Second sweep, same bytes: tombstoned — NO further attempt, no error.
        let second = capture_sweep(
            &entries,
            &base,
            &mut HashMap::new(),
            &reader,
            &mut echo,
            &mut client,
            1 << 20,
        );
        assert_eq!(client.capture_attempts, 1, "denied capture must not retry");
        assert!(second.errors.is_empty());
        assert_eq!(second.skipped_other, vec!["shared/channels/other/plan.md"]);

        // New bytes at the path clear the denial and capture again.
        let mut changed = HashMap::new();
        changed.insert(
            PathBuf::from("shared/channels/other/plan.md"),
            b"the revised plan".to_vec(),
        );
        let reader = MapReader(changed);
        client.deny_captures = false;
        let third = capture_sweep(
            &entries,
            &base,
            &mut HashMap::new(),
            &reader,
            &mut echo,
            &mut client,
            1 << 20,
        );
        assert_eq!(client.capture_attempts, 2);
        assert_eq!(third.captured.len(), 1);
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
            &mut HashMap::new(),
            &reader,
            &mut echo,
            &mut client,
            DEFAULT_LARGE_FILE_BYTES,
        );
        assert_eq!(out.skipped_echo.len(), 1);
        assert!(out.captured.is_empty()); // not re-captured
    }

    #[test]
    fn capture_sweep_skips_suspected_secret_files() {
        let entries = vec![reg("secrets.txt"), reg("report.md")];
        let mut files = HashMap::new();
        files.insert(
            PathBuf::from("secrets.txt"),
            b"ANTHROPIC_API_KEY=sk-ant-api03-placeholder".to_vec(),
        );
        files.insert(PathBuf::from("report.md"), b"# Report\n".to_vec());
        let reader = MapReader(files);
        let mut echo = EchoGuard::new();
        let mut client = FakeClient::default();

        let out = capture_sweep(
            &entries,
            &HashMap::new(),
            &mut HashMap::new(),
            &reader,
            &mut echo,
            &mut client,
            DEFAULT_LARGE_FILE_BYTES,
        );

        assert_eq!(out.skipped_secret, 1);
        assert!(out.errors.is_empty());
        assert_eq!(out.captured.len(), 1);
        assert_eq!(out.captured[0].0, "report.md");
        assert_eq!(client.captures, vec![("report.md".to_string(), 1)]);
    }

    #[test]
    fn claude_transcript_project_key_tracks_flat_home() {
        assert_eq!(claude_transcript_project_key(true), "-home-agent");
        assert_eq!(
            claude_transcript_project_key(false),
            "-home-agent-workspace"
        );
    }

    #[test]
    fn locates_claude_transcript_at_workspace_project_path() {
        let entries = vec![reg(".claude/projects/-home-agent-workspace/thread-1.jsonl")];

        assert_eq!(
            locate_harness_transcript(
                &entries,
                HarnessTranscriptKind::Claude,
                Path::new(".claude"),
                "thread-1",
                false,
            ),
            Some(PathBuf::from(
                ".claude/projects/-home-agent-workspace/thread-1.jsonl"
            ))
        );
    }

    #[test]
    fn locates_claude_transcript_at_flat_home_project_path() {
        let entries = vec![reg(".claude/projects/-home-agent/thread-1.jsonl")];

        assert_eq!(
            locate_harness_transcript(
                &entries,
                HarnessTranscriptKind::Claude,
                Path::new(".claude"),
                "thread-1",
                true,
            ),
            Some(PathBuf::from(".claude/projects/-home-agent/thread-1.jsonl"))
        );
    }

    #[test]
    fn locates_codex_rollout_transcript_under_sessions() {
        let entries = vec![reg(".codex/sessions/2026/06/21/rollout-thread-1.jsonl")];

        assert_eq!(
            locate_harness_transcript(
                &entries,
                HarnessTranscriptKind::Codex,
                Path::new(".codex"),
                "thread-1",
                true,
            ),
            Some(PathBuf::from(
                ".codex/sessions/2026/06/21/rollout-thread-1.jsonl"
            ))
        );
    }

    #[test]
    fn locates_codex_rollout_transcript_by_thread_id_suffix() {
        let thread_id = "550e8400-e29b-41d4-a716-446655440000";
        let entries = vec![reg(
            ".codex/sessions/2026/07/06/rollout-2026-07-06T16-20-40-550e8400-e29b-41d4-a716-446655440000.jsonl",
        )];

        assert_eq!(
            locate_harness_transcript(
                &entries,
                HarnessTranscriptKind::Codex,
                Path::new(".codex"),
                thread_id,
                true,
            ),
            Some(PathBuf::from(
                ".codex/sessions/2026/07/06/rollout-2026-07-06T16-20-40-550e8400-e29b-41d4-a716-446655440000.jsonl",
            ))
        );
    }

    #[test]
    fn locates_claude_transcript_without_manual_thread_id() {
        let entries = vec![
            reg(".claude/projects/-home-agent-workspace/thread-1.jsonl"),
            reg(".claude/projects/-home-agent-workspace/thread-2.jsonl"),
        ];

        assert_eq!(
            locate_harness_transcript(
                &entries,
                HarnessTranscriptKind::Claude,
                Path::new(".claude"),
                "",
                false,
            ),
            Some(PathBuf::from(
                ".claude/projects/-home-agent-workspace/thread-2.jsonl"
            ))
        );
    }

    #[test]
    fn locates_codex_rollout_without_manual_thread_id() {
        let entries = vec![
            reg(".codex/sessions/2026/06/20/rollout-thread-1.jsonl"),
            reg(".codex/sessions/2026/06/21/rollout-thread-2.jsonl"),
        ];

        assert_eq!(
            locate_harness_transcript(
                &entries,
                HarnessTranscriptKind::Codex,
                Path::new(".codex"),
                "",
                false,
            ),
            Some(PathBuf::from(
                ".codex/sessions/2026/06/21/rollout-thread-2.jsonl"
            ))
        );
    }

    #[test]
    fn harness_transcript_sweep_puts_bytes_without_artifact_capture() {
        let entries = vec![
            reg(".claude/projects/-home-agent-workspace/thread-1.jsonl"),
            reg(".claude/projects/-home-agent-workspace/thread-1.state"),
            reg(".claude/projects/-home-agent-workspace/auth.json"),
        ];
        let mut files = HashMap::new();
        files.insert(
            PathBuf::from(".claude/projects/-home-agent-workspace/thread-1.jsonl"),
            b"{\"type\":\"assistant\"}\n".to_vec(),
        );
        files.insert(
            PathBuf::from(".claude/projects/-home-agent-workspace/thread-1.state"),
            b"sidecar".to_vec(),
        );
        files.insert(
            PathBuf::from(".claude/projects/-home-agent-workspace/auth.json"),
            b"secret".to_vec(),
        );
        let reader = MapReader(files);
        let mut client = FakeClient::default();

        let out = harness_transcript_sweep(
            &entries,
            &reader,
            &mut client,
            HarnessTranscriptKind::Claude,
            Path::new(".claude"),
            "thread-1",
            false,
        );

        assert_eq!(
            out.captured,
            Some((
                PathBuf::from(".claude/projects/-home-agent-workspace/thread-1.jsonl"),
                21,
            ))
        );
        assert_eq!(client.captures, Vec::new());
        assert_eq!(
            client.transcripts,
            vec![("claude".to_owned(), b"{\"type\":\"assistant\"}\n".to_vec())]
        );
        assert_eq!(client.state_bundles.len(), 1);
        let files = client.state_bundles[0].1["manifest"]["files"]
            .as_array()
            .unwrap();
        assert_eq!(files.len(), 2);
        let serialized = serde_json::to_string(&client.state_bundles[0].1).unwrap();
        assert!(serialized.contains("thread-1.jsonl"));
        assert!(serialized.contains("thread-1.state"));
        assert!(!serialized.contains("auth.json"));
    }

    #[test]
    fn profile_candidate_sweep_puts_sanitized_payload_without_artifact_capture() {
        let entries = vec![
            reg(".codex/config.toml"),
            reg(".codex/skills/demo/SKILL.md"),
        ];
        let mut files = HashMap::new();
        files.insert(
            PathBuf::from(".codex/config.toml"),
            b"model = \"gpt-5\"\napi_key = \"sk-secretsecretsecretsecretsecret\"\n".to_vec(),
        );
        files.insert(
            PathBuf::from(".codex/skills/demo/SKILL.md"),
            b"# Demo skill\nUse carefully.\n".to_vec(),
        );
        let reader = MapReader(files);
        let mut client = FakeClient::default();

        let out = profile_candidate_sweep(
            &entries,
            &reader,
            &mut client,
            HarnessTranscriptKind::Codex,
            Path::new(".codex"),
        );

        assert!(out.uploaded);
        assert_eq!(out.candidate_count, 1);
        assert!(client.captures.is_empty());
        assert_eq!(client.profile_candidates.len(), 1);
        assert_eq!(client.profile_bundle_blobs.len(), 1);
        assert_eq!(
            client.profile_bundle_blobs[0].1,
            ".codex/skills/demo/SKILL.md"
        );
        assert_eq!(
            client.profile_bundle_blobs[0].2,
            b"# Demo skill\nUse carefully.\n"
        );
        assert_eq!(client.profile_candidates[0].0, "codex");
        let serialized = serde_json::to_string(&client.profile_candidates[0].1).unwrap();
        assert!(serialized.contains("\"provider\":\"codex\""));
        assert!(serialized.contains("profile-candidates/v1"));
        assert!(serialized.contains("\"bundles\""));
        assert!(serialized.contains(&client.profile_bundle_blobs[0].0));
        assert!(!serialized.contains("sk-secret"));
    }

    #[test]
    fn credential_refresh_reads_denied_file_only_for_credential_endpoint_and_dedupes() {
        let injected = br#"{"auth_mode":"chatgpt","tokens":{"access":"injected-baseline"}}"#;
        let refreshed = br#"{"auth_mode":"chatgpt","tokens":{"access":"secret-access"}}"#;
        let entries = vec![reg(".codex/auth.json"), reg(".codex/config.toml")];
        let partitioned = partition_entries_by_lane(&entries, &[PathBuf::from(".codex")], &[]);
        assert_eq!(partitioned.denied_count, 1);
        let mut files = HashMap::new();
        files.insert(PathBuf::from(".codex/auth.json"), injected.to_vec());
        files.insert(
            PathBuf::from(".codex/config.toml"),
            b"model = \"gpt-5\"\n".to_vec(),
        );
        let reader = MapReader(files);
        let mut client = FakeClient::default();

        // First sweep: the entrypoint-injected baseline is recorded but never written
        // back (echoing it would clobber the user's real stored credential).
        let out0 = credential_refresh_sweep(
            &reader,
            &mut client,
            HarnessTranscriptKind::Codex,
            Path::new(".codex"),
            None,
        );
        assert!(out0.skipped);
        assert!(client.credential_refreshes.is_empty());
        let baseline = out0.current_hash.clone();

        // Same file again: still the baseline, still nothing written back.
        let out_same = credential_refresh_sweep(
            &reader,
            &mut client,
            HarnessTranscriptKind::Codex,
            Path::new(".codex"),
            baseline.as_deref(),
        );
        assert!(out_same.skipped);
        assert!(client.credential_refreshes.is_empty());

        // A genuine in-session refresh (file differs from baseline) IS written back.
        let mut files2 = HashMap::new();
        files2.insert(PathBuf::from(".codex/auth.json"), refreshed.to_vec());
        let reader2 = MapReader(files2);
        let out = credential_refresh_sweep(
            &reader2,
            &mut client,
            HarnessTranscriptKind::Codex,
            Path::new(".codex"),
            baseline.as_deref(),
        );
        assert!(out.uploaded);
        assert_eq!(client.credential_refreshes.len(), 1);
        assert_eq!(client.credential_refreshes[0].0, "codex");
        assert_eq!(
            client.credential_refreshes[0].1,
            serde_json::json!({ "authJson": std::str::from_utf8(refreshed).unwrap() })
        );
        let capture_serialized = serde_json::to_string(&client.profile_candidates).unwrap();
        assert!(!capture_serialized.contains("secret-access"));

        // Once written back, the same refreshed value dedupes.
        let out2 = credential_refresh_sweep(
            &reader2,
            &mut client,
            HarnessTranscriptKind::Codex,
            Path::new(".codex"),
            out.current_hash.as_deref(),
        );
        assert!(out2.skipped);
        assert_eq!(client.credential_refreshes.len(), 1);
    }

    #[test]
    fn claude_credential_refresh_extracts_access_token_only() {
        let mut files = HashMap::new();
        files.insert(
            PathBuf::from(".claude/.credentials.json"),
            br#"{"claudeAiOauth":{"accessToken":"access-token","refreshToken":"refresh-token"}}"#
                .to_vec(),
        );
        let reader = MapReader(files);

        // First sight (None) is the injected dummy baseline — never written back.
        let mut baseline_client = FakeClient::default();
        let out_baseline = credential_refresh_sweep(
            &reader,
            &mut baseline_client,
            HarnessTranscriptKind::Claude,
            Path::new(".claude"),
            None,
        );
        assert!(out_baseline.skipped);
        assert!(baseline_client.credential_refreshes.is_empty());

        // A genuine refresh (differs from a prior baseline) writes back only the
        // OAuth access token, never the refresh token.
        let mut client = FakeClient::default();
        let out = credential_refresh_sweep(
            &reader,
            &mut client,
            HarnessTranscriptKind::Claude,
            Path::new(".claude"),
            Some("prior-baseline-hash"),
        );

        assert!(out.uploaded);
        assert_eq!(
            client.credential_refreshes[0].1,
            serde_json::json!({ "token": "access-token" })
        );
        assert!(
            !serde_json::to_string(&client.credential_refreshes[0].1)
                .unwrap()
                .contains("refresh-token")
        );
    }

    #[test]
    fn profile_baseline_sweep_puts_baseline_payload_once_when_caller_tracks_state() {
        let entries = vec![reg(".codex/config.toml")];
        let mut files = HashMap::new();
        files.insert(
            PathBuf::from(".codex/config.toml"),
            b"model = \"gpt-5\"\n".to_vec(),
        );
        let reader = MapReader(files);
        let mut client = FakeClient::default();

        let out = profile_baseline_sweep(
            &entries,
            &reader,
            &mut client,
            HarnessTranscriptKind::Codex,
            Path::new(".codex"),
        );

        assert!(out.uploaded);
        assert_eq!(client.baselines.len(), 1);
        assert_eq!(client.baselines[0].0, "codex");
        assert_eq!(
            client.baselines[0].1["adapterVersion"],
            crate::profile_candidates::ADAPTER_VERSION
        );
        assert_eq!(
            client.baselines[0].1["manifest"]["settings"]["model"],
            "gpt-5"
        );
    }

    #[test]
    fn materialize_profile_bundles_writes_verified_non_denied_blobs() {
        let bytes = b"# Skill\n".to_vec();
        let sha = sha256_hex(&bytes);
        let mut client = FakeClient {
            profile_bundles: vec![
                BundleRef {
                    path: ".codex/skills/demo/SKILL.md".to_string(),
                    sha256: sha.clone(),
                    role: "skill".to_string(),
                    executable: false,
                },
                BundleRef {
                    path: ".codex/auth.json".to_string(),
                    sha256: sha.clone(),
                    role: "credential".to_string(),
                    executable: false,
                },
            ],
            ..FakeClient::default()
        };
        client
            .profile_bundle_blob_bytes
            .insert(sha.clone(), bytes.clone());
        let mut materialized = HashMap::new();
        let mut writes = Vec::new();

        let out = materialize_profile_bundles(
            &client,
            HarnessTranscriptKind::Codex,
            Path::new(".codex"),
            Path::new("/merged"),
            &mut materialized,
            |path, bytes, executable| {
                writes.push((path.to_path_buf(), bytes.to_vec(), executable));
                Ok(())
            },
        );

        assert_eq!(out.written, 1);
        assert_eq!(out.skipped, 1);
        assert!(out.errors.is_empty());
        assert_eq!(
            writes[0].0,
            PathBuf::from("/merged/.codex/skills/demo/SKILL.md")
        );
        assert_eq!(writes[0].1, bytes);
        assert!(!writes[0].2);
        assert_eq!(materialized.get(".codex/skills/demo/SKILL.md"), Some(&sha));
    }

    #[test]
    fn wip_sweep_posts_scratch_snapshot_and_latest_last() {
        let patch = crate::wip::WipPatch {
            base_head_sha: "abc123".into(),
            diff: "diff --git a/x b/x".into(),
            untracked: vec![("new.txt".into(), b"hi".to_vec())],
        };
        let mut client = FakeClient::default();
        let out = wip_sweep("myrepo", &patch, &HashMap::new(), &mut client);
        let paths: Vec<&str> = out.captured.iter().map(|(p, _, _)| p.as_str()).collect();
        assert_eq!(out.captured.len(), 4); // patch + manifest + 1 untracked + latest
        assert!(
            paths
                .iter()
                .any(|path| path.starts_with("scratch/wip/myrepo/snapshots/")
                    && path.ends_with("/patch.diff"))
        );
        assert!(
            paths
                .iter()
                .any(|path| path.starts_with("scratch/wip/myrepo/snapshots/")
                    && path.ends_with("/untracked/new.txt"))
        );
        assert_eq!(paths.last(), Some(&"scratch/wip/myrepo/latest.json"));
        assert!(out.errors.is_empty());
    }

    #[test]
    fn wip_sweep_deletes_latest_when_patch_becomes_empty() {
        let patch = crate::wip::WipPatch {
            base_head_sha: "x".into(),
            diff: String::new(),
            untracked: vec![],
        };
        let mut base = HashMap::new();
        base.insert("scratch/wip/r/latest.json".to_string(), 9);
        let mut client = FakeClient::default();
        let out = wip_sweep("r", &patch, &base, &mut client);
        assert!(out.captured.is_empty());
        assert_eq!(
            out.deleted,
            vec![("scratch/wip/r/latest.json".to_string(), 1)]
        );
        assert_eq!(
            client.deletes,
            vec![("scratch/wip/r/latest.json".to_string(), 1)]
        );
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
                    group_id: None,
                },
            ),
            (
                "edited.md".to_string(),
                RemoteChange {
                    seq: 6,
                    sha: Some("v6".into()),
                    status: RemoteStatus::Normal,
                    group_id: None,
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
        fn atrium_changes(&self, since: &str) -> Result<(Vec<String>, String), String> {
            Ok((vec![], since.to_string()))
        }
        fn atrium_doc(&self, target_id: &str, doc: &str) -> Result<Vec<u8>, String> {
            Ok(format!("{target_id}/{doc}").into_bytes())
        }
    }

    fn reg_sized(p: &str, size: u64) -> RawEntry {
        RawEntry {
            rel_path: PathBuf::from(p),
            file_type: RawFileType::Regular,
            rdev: 0,
            size,
            mtime_ns: 0,
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
            &mut HashMap::new(),
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
    fn capture_sweep_skips_suspected_secret_before_streaming_large_files() {
        let big = b"AWS_SECRET_ACCESS_KEY=example\n".repeat(8);
        let entries = vec![reg_sized("logs/big.log", big.len() as u64)];
        let mut files = HashMap::new();
        files.insert(PathBuf::from("logs/big.log"), big);
        let reader = MapReader(files);
        let mut echo = EchoGuard::new();
        let mut client = StreamingFakeClient::default();

        let out = capture_sweep(
            &entries,
            &HashMap::new(),
            &mut HashMap::new(),
            &reader,
            &mut echo,
            &mut client,
            16,
        );

        assert_eq!(out.skipped_secret, 1);
        assert!(out.captured.is_empty());
        assert!(out.streamed.is_empty());
        assert!(client.buffered.is_empty());
        assert!(client.streamed.is_empty());
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
            &mut HashMap::new(),
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
