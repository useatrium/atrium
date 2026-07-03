//! Daemon-owned overlay mount planning and lifecycle helpers.
//!
//! The pure path planning pieces are compiled everywhere so unit tests can run
//! off-node. The actual mount/umount operations are Linux-only and are called by
//! the privileged node-sync daemon.

use crate::session_manifest::{
    RepoCacheScope, RepoMount, validate_principal_cache_scope, validate_repo_cache_path_syntax,
    validate_repo_cache_snapshot_path_syntax, validate_repo_mounts, validate_repo_subdir_syntax,
};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Component, Path, PathBuf};
#[cfg(target_os = "linux")]
use std::time::Instant;

pub const DEFAULT_AGENT_UID: u32 = 1001;
pub const READY_MARKER_FILE: &str = ".centaur-workspace-ready";
#[cfg(target_os = "linux")]
const OVERLAY_SIGNATURE_FILE: &str = ".centaur-overlay-signature";
pub const DEFAULT_REPO_CACHE_ROOT: &str = "/cache";
/// Single top-level workspace dir that holds every session repo, nested as
/// `repos/<owner>/<repo>`. Reserving one prefix keeps the rest of `~` for
/// deliverables/config, avoids repo-basename collisions with reserved dirs, and
/// lets capture exclude all git-managed code by excluding this one prefix.
pub const REPOS_DIR: &str = "repos";
/// Host-root sibling dirs (peers of `overlays/`) the daemon creates per session
/// when planning an overlay mount: the overlayfs work dir and the composed/fixture
/// lower both live here, outside `overlays_root`. GC must remove these alongside
/// the upper or they leak — see [`session_sibling_dirs`].
pub const OVERLAY_WORK_DIRNAME: &str = "overlay-work";
pub const OVERLAY_LOWER_DIRNAME: &str = "overlay-lower";

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum LowerKind {
    Fixture,
    Repo,
    ComposedRepos,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct LowerSource {
    pub path: PathBuf,
    pub kind: LowerKind,
}

impl LowerSource {
    pub fn uses_fixture_seed(&self) -> bool {
        self.kind == LowerKind::Fixture
    }
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct OverlayMountPlan {
    pub session: String,
    pub upper: PathBuf,
    pub merged: PathBuf,
    pub work: PathBuf,
    pub lower: LowerSource,
    pub extra_lowers: Vec<PathBuf>,
    pub context_source: Option<PathBuf>,
    pub repo_mounts: Vec<RepoMount>,
    pub repo_cache_root: PathBuf,
}

impl OverlayMountPlan {
    pub fn ready_marker(&self) -> PathBuf {
        ready_marker_path(&self.merged)
    }

    pub fn overlay_options(&self) -> String {
        overlay_options_with_extra_lower(
            &self.extra_lowers,
            &self.lower.path,
            &self.upper,
            &self.work,
        )
    }
}

pub fn plan_overlay_mount(
    overlays_root: &Path,
    session: &str,
    merged: &Path,
    repo: &str,
    repos: &[RepoMount],
    lower_override: Option<&Path>,
) -> Result<OverlayMountPlan, String> {
    let host_root = overlays_root
        .parent()
        .ok_or_else(|| format!("{} has no parent", overlays_root.display()))?;
    let lower = select_lower_source(repo, repos, lower_override, host_root, session)?;
    let repo_mounts = if lower.kind == LowerKind::ComposedRepos {
        plan_repo_composition(&lower.path, Path::new(DEFAULT_REPO_CACHE_ROOT), repos)?
            .entries
            .into_iter()
            .map(|entry| entry.mount)
            .collect()
    } else {
        Vec::new()
    };
    Ok(OverlayMountPlan {
        session: session.to_owned(),
        upper: overlays_root.join(session),
        merged: merged.to_path_buf(),
        work: host_root.join(OVERLAY_WORK_DIRNAME).join(session),
        lower,
        extra_lowers: Vec::new(),
        context_source: None,
        repo_mounts,
        repo_cache_root: PathBuf::from(DEFAULT_REPO_CACHE_ROOT),
    })
}

pub fn select_lower_source(
    repo: &str,
    repos: &[RepoMount],
    lower_override: Option<&Path>,
    host_root: &Path,
    session: &str,
) -> Result<LowerSource, String> {
    if !repos.is_empty() {
        let lower = host_root
            .join(OVERLAY_LOWER_DIRNAME)
            .join(format!("{session}.repos"));
        plan_repo_composition(&lower, Path::new(DEFAULT_REPO_CACHE_ROOT), repos)?;
        return Ok(LowerSource {
            path: lower,
            kind: LowerKind::ComposedRepos,
        });
    }

    let repo = repo.trim();
    if !repo.is_empty() {
        validate_repo_path_syntax(repo)?;
        return Ok(LowerSource {
            path: PathBuf::from(repo),
            kind: LowerKind::Repo,
        });
    }

    Ok(LowerSource {
        path: lower_override
            .map(Path::to_path_buf)
            .unwrap_or_else(|| host_root.join(OVERLAY_LOWER_DIRNAME).join(session)),
        kind: LowerKind::Fixture,
    })
}

/// Per-session host-root dirs created by [`plan_overlay_mount`] that live *outside*
/// `overlays_root` and are therefore missed by an `overlays/<session>`-only GC. The
/// composed-repos lower holds materialized repo checkouts (MB–GB), so leaking these
/// is a real disk leak. Returns candidates for both lower layouts (fixture
/// `<session>` and composed `<session>.repos`); unique session ids mean at most one
/// lower exists on disk, so the extra path is a harmless NotFound no-op for callers.
pub fn session_sibling_dirs(overlays_root: &Path, session: &str) -> Vec<PathBuf> {
    let Some(host_root) = overlays_root.parent() else {
        return Vec::new();
    };
    vec![
        host_root.join(OVERLAY_WORK_DIRNAME).join(session),
        host_root.join(OVERLAY_LOWER_DIRNAME).join(session),
        host_root
            .join(OVERLAY_LOWER_DIRNAME)
            .join(format!("{session}.repos")),
    ]
}

pub fn validate_repo_path_syntax(repo: &str) -> Result<(), String> {
    if repo.contains('\0') {
        return Err("--repo must not contain NUL bytes".to_string());
    }
    let path = Path::new(repo);
    let mut normal_components = 0usize;
    for component in path.components() {
        match component {
            Component::Normal(_) => normal_components += 1,
            Component::RootDir => {}
            Component::CurDir | Component::ParentDir | Component::Prefix(_) => {
                return Err("--repo must not contain . or .. components".to_string());
            }
        }
    }
    if normal_components == 0 {
        return Err("--repo must name a directory".to_string());
    }
    Ok(())
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct RepoComposePlan {
    pub lower: PathBuf,
    pub entries: Vec<RepoComposeEntry>,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct RepoComposeEntry {
    pub mount: RepoMount,
    pub cache_path: PathBuf,
    pub target_path: PathBuf,
    pub target_subdir: String,
}

pub fn plan_repo_composition(
    lower: &Path,
    repo_cache_root: &Path,
    repos: &[RepoMount],
) -> Result<RepoComposePlan, String> {
    validate_repo_mounts(repos)?;
    let mut seen_specs = BTreeSet::new();
    let mut target_owners: BTreeMap<String, String> = BTreeMap::new();
    let mut entries = Vec::new();

    for mount in repos {
        let key = (
            mount.repo.clone(),
            mount.r#ref.clone(),
            mount.subdir.clone(),
        );
        if !seen_specs.insert(key) {
            continue;
        }

        let target_subdir = repo_target_subdir(mount)?;
        if let Some(existing) = target_owners.insert(target_subdir.clone(), mount.repo.clone()) {
            return Err(format!(
                "multiple repos target workspace subdir {target_subdir:?}: {existing:?} and {:?}",
                mount.repo
            ));
        }

        entries.push(RepoComposeEntry {
            mount: mount.clone(),
            cache_path: repo_cache_path(repo_cache_root, mount)?,
            target_path: lower.join(&target_subdir),
            target_subdir,
        });
    }

    Ok(RepoComposePlan {
        lower: lower.to_path_buf(),
        entries,
    })
}

pub fn repo_cache_path(repo_cache_root: &Path, mount: &RepoMount) -> Result<PathBuf, String> {
    if let Some(cache_path) = mount.cache_path.as_deref() {
        validate_repo_cache_snapshot_path_syntax(cache_path)?;
        if mount.private {
            return Err(format!(
                "private repo {:?} must not use explicit shared cache path {cache_path:?}",
                mount.repo
            ));
        }
        return Ok(repo_cache_root.join(cache_path));
    }

    if !mount.private {
        return Ok(repo_cache_root.join(&mount.repo));
    }

    match mount.cache_scope.as_ref() {
        Some(RepoCacheScope::Principal { principal_id }) => Ok(repo_cache_root
            .join("principals")
            .join(principal_cache_component(principal_id)?)
            .join(&mount.repo)),
        Some(RepoCacheScope::Shared) => Err(format!(
            "private repo {:?} must not use shared repo cache",
            mount.repo
        )),
        None => Err(format!(
            "private repo {:?} requires a principal cache scope",
            mount.repo
        )),
    }
}

pub fn principal_cache_component(principal_id: &str) -> Result<String, String> {
    validate_principal_cache_scope(principal_id)?;
    let mut encoded = String::from("principal-");
    for byte in principal_id.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' => {
                encoded.push(byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    Ok(encoded)
}

pub fn repo_target_subdir(mount: &RepoMount) -> Result<String, String> {
    // Both forms nest under the reserved `repos/` prefix (see REPOS_DIR).
    if let Some(subdir) = mount.subdir.as_deref() {
        validate_repo_subdir_syntax(subdir)?;
        return Ok(format!("{REPOS_DIR}/{subdir}"));
    }
    // Owner-scoped: `acme/widget` -> `repos/acme/widget`. Owner-scoping disambiguates
    // same-basename repos from different owners (which used to collide on the basename).
    validate_repo_cache_path_syntax(&mount.repo)?;
    let repo = mount.repo.trim_matches('/');
    if repo.is_empty() {
        return Err(format!(
            "repo {:?} has no path for workspace subdir",
            mount.repo
        ));
    }
    Ok(format!("{REPOS_DIR}/{repo}"))
}

pub fn overlay_options(lower: &Path, upper: &Path, work: &Path) -> String {
    overlay_options_with_extra_lower(&[], lower, upper, work)
}

pub fn overlay_options_with_extra_lower(
    extra_lowers: &[PathBuf],
    lower: &Path,
    upper: &Path,
    work: &Path,
) -> String {
    let lowerdir = extra_lowers
        .iter()
        .map(|path| path.display().to_string())
        .chain(std::iter::once(lower.display().to_string()))
        .collect::<Vec<_>>()
        .join(":");
    format!(
        "lowerdir={lowerdir},upperdir={},workdir={},metacopy=off",
        upper.display(),
        work.display(),
    )
}

pub fn ready_marker_path(merged: &Path) -> PathBuf {
    merged.join(READY_MARKER_FILE)
}

pub fn seed_fixture_lower(lower: &Path, agent_uid: Option<u32>) -> Result<(), String> {
    write_if_missing(&lower.join("seed.txt"), b"base seed\n")?;
    write_if_missing(&lower.join("delete-me.txt"), b"delete me\n")?;
    set_fixture_permissions(lower, agent_uid)
}

fn write_if_missing(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if path.exists() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create lower parent {}: {e}", parent.display()))?;
    }
    std::fs::write(path, bytes).map_err(|e| format!("write lower seed {}: {e}", path.display()))
}

#[cfg(unix)]
fn set_fixture_permissions(lower: &Path, agent_uid: Option<u32>) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    use std::os::unix::fs::chown;

    std::fs::set_permissions(lower, std::fs::Permissions::from_mode(0o777))
        .map_err(|e| format!("chmod lower {}: {e}", lower.display()))?;
    if let Some(uid) = agent_uid {
        chown(lower, Some(uid), Some(uid))
            .map_err(|e| format!("chown lower {} to {uid}: {e}", lower.display()))?;
    }
    for entry in
        std::fs::read_dir(lower).map_err(|e| format!("read lower {}: {e}", lower.display()))?
    {
        let entry = entry.map_err(|e| format!("read lower entry: {e}"))?;
        let path = entry.path();
        if path.is_dir() {
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o777))
                .map_err(|e| format!("chmod lower dir {}: {e}", path.display()))?;
        } else {
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o666))
                .map_err(|e| format!("chmod lower file {}: {e}", path.display()))?;
        }
        if let Some(uid) = agent_uid {
            chown(&path, Some(uid), Some(uid))
                .map_err(|e| format!("chown lower entry {} to {uid}: {e}", path.display()))?;
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn set_fixture_permissions(_lower: &Path, _agent_uid: Option<u32>) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn mount_overlay(
    plan: OverlayMountPlan,
    agent_uid: Option<u32>,
) -> Result<OverlayMountPlan, String> {
    use std::process::Command;

    prepare_upper_and_merged(&plan, agent_uid)?;
    let plan = resolve_lower_source(plan)?;
    if is_overlay_mount(&plan.merged)? {
        if overlay_signature_matches(&plan)? {
            mount_context_if_requested(&plan)?;
            write_overlay_signature(&plan)?;
            write_ready_marker(&plan.merged)?;
            println!(
                "overlay mount: session {} already mounted at {}",
                plan.session,
                plan.merged.display()
            );
            return Ok(plan);
        }
        unmount_overlay(&plan)?;
    }

    prepare_lower_source(&plan, agent_uid)?;
    reset_workdir(&plan.work)?;
    let opts = plan.overlay_options();
    let output = Command::new("mount")
        .args(["-t", "overlay", "overlay", "-o"])
        .arg(&opts)
        .arg(&plan.merged)
        .output()
        .map_err(|e| format!("spawn mount: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "mount overlay failed (status {}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    mount_context_if_requested(&plan)?;
    write_overlay_signature(&plan)?;
    write_ready_marker(&plan.merged)?;
    println!(
        "overlay mount: mounted session {} upper={} lower={} work={} merged={}",
        plan.session,
        plan.upper.display(),
        plan.lower.path.display(),
        plan.work.display(),
        plan.merged.display()
    );
    Ok(plan)
}

#[cfg(not(target_os = "linux"))]
pub fn mount_overlay(
    _plan: OverlayMountPlan,
    _agent_uid: Option<u32>,
) -> Result<OverlayMountPlan, String> {
    Err("overlay mounts are linux-only".to_string())
}

#[cfg(target_os = "linux")]
pub fn unmount_overlay(plan: &OverlayMountPlan) -> Result<(), String> {
    use std::process::Command;

    let _ = remove_ready_marker(plan);
    if let Err(e) = unmount_context_if_mounted(plan) {
        eprintln!(
            "overlay mount: session {} context unmount: {e}",
            plan.session
        );
    }
    if !is_overlay_mount(&plan.merged)? {
        let _ = remove_ready_marker(plan);
        return Ok(());
    }
    let output = Command::new("umount")
        .arg(&plan.merged)
        .output()
        .map_err(|e| format!("spawn umount: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "umount overlay failed (status {}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let _ = remove_ready_marker(plan);
    println!(
        "overlay mount: unmounted session {} merged={}",
        plan.session,
        plan.merged.display()
    );
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub fn unmount_overlay(_plan: &OverlayMountPlan) -> Result<(), String> {
    Err("overlay unmounts are linux-only".to_string())
}

#[cfg(target_os = "linux")]
fn mount_context_if_requested(plan: &OverlayMountPlan) -> Result<(), String> {
    use std::process::Command;

    let Some(source) = plan.context_source.as_ref() else {
        return Ok(());
    };
    std::fs::create_dir_all(source)
        .map_err(|e| format!("create context source {}: {e}", source.display()))?;
    let target = plan.merged.join("context");
    std::fs::create_dir_all(&target)
        .map_err(|e| format!("create context mount target {}: {e}", target.display()))?;
    if is_mount_at(&target)? {
        if same_file_identity(source, &target)? {
            return Ok(());
        }
        unmount_context_if_mounted(plan)?;
    }

    let output = Command::new("mount")
        .args(["--bind"])
        .arg(source)
        .arg(&target)
        .output()
        .map_err(|e| format!("spawn context bind mount: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "context bind mount failed (status {}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let output = Command::new("mount")
        .args(["-o", "remount,bind,ro"])
        .arg(&target)
        .output()
        .map_err(|e| format!("spawn context read-only remount: {e}"))?;
    if !output.status.success() {
        let _ = Command::new("umount").arg(&target).status();
        return Err(format!(
            "context read-only remount failed (status {}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn same_file_identity(left: &Path, right: &Path) -> Result<bool, String> {
    use std::os::unix::fs::MetadataExt;

    let left = std::fs::metadata(left).map_err(|e| format!("stat {}: {e}", left.display()))?;
    let right = std::fs::metadata(right).map_err(|e| format!("stat {}: {e}", right.display()))?;
    Ok(left.dev() == right.dev() && left.ino() == right.ino())
}

#[cfg(target_os = "linux")]
fn overlay_signature_matches(plan: &OverlayMountPlan) -> Result<bool, String> {
    let path = plan.merged.join(OVERLAY_SIGNATURE_FILE);
    let actual = match std::fs::read_to_string(&path) {
        Ok(actual) => actual,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(format!("read overlay signature {}: {e}", path.display())),
    };
    Ok(actual == overlay_signature(plan))
}

#[cfg(target_os = "linux")]
fn write_overlay_signature(plan: &OverlayMountPlan) -> Result<(), String> {
    let path = plan.merged.join(OVERLAY_SIGNATURE_FILE);
    std::fs::write(&path, overlay_signature(plan))
        .map_err(|e| format!("write overlay signature {}: {e}", path.display()))
}

#[cfg(target_os = "linux")]
fn overlay_signature(plan: &OverlayMountPlan) -> String {
    let mut signature = format!("lower={}\n", plan.lower.path.display());
    for lower in &plan.extra_lowers {
        signature.push_str("extra=");
        signature.push_str(&lower.display().to_string());
        signature.push('\n');
    }
    if let Some(context_source) = &plan.context_source {
        signature.push_str("context=");
        signature.push_str(&context_source.display().to_string());
        signature.push('\n');
    }
    signature
}

#[cfg(target_os = "linux")]
fn unmount_context_if_mounted(plan: &OverlayMountPlan) -> Result<(), String> {
    use std::process::Command;

    let target = plan.merged.join("context");
    if !is_mount_at(&target)? {
        return Ok(());
    }
    let output = Command::new("umount")
        .arg(&target)
        .output()
        .map_err(|e| format!("spawn context umount: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "context umount failed (status {}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn resolve_lower_source(mut plan: OverlayMountPlan) -> Result<OverlayMountPlan, String> {
    match plan.lower.kind {
        LowerKind::Fixture | LowerKind::ComposedRepos => Ok(plan),
        LowerKind::Repo => {
            let metadata = std::fs::metadata(&plan.lower.path)
                .map_err(|e| format!("--repo {}: {e}", plan.lower.path.display()))?;
            if !metadata.is_dir() {
                return Err(format!(
                    "--repo must be an existing directory, got {}",
                    plan.lower.path.display()
                ));
            }
            plan.lower.path =
                plan.lower.path.canonicalize().map_err(|e| {
                    format!("canonicalize --repo {}: {e}", plan.lower.path.display())
                })?;
            Ok(plan)
        }
    }
}

#[cfg(target_os = "linux")]
fn prepare_upper_and_merged(plan: &OverlayMountPlan, agent_uid: Option<u32>) -> Result<(), String> {
    std::fs::create_dir_all(&plan.upper)
        .map_err(|e| format!("create upper {}: {e}", plan.upper.display()))?;
    std::fs::create_dir_all(&plan.merged)
        .map_err(|e| format!("create merged {}: {e}", plan.merged.display()))?;

    match agent_uid {
        Some(uid) => chown_dir_owner(&plan.upper, uid)?,
        None => set_dir_mode(&plan.upper, 0o777)?,
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn prepare_lower_source(plan: &OverlayMountPlan, agent_uid: Option<u32>) -> Result<(), String> {
    for lower in &plan.extra_lowers {
        let metadata = std::fs::metadata(lower)
            .map_err(|e| format!("extra lower {}: {e}", lower.display()))?;
        if !metadata.is_dir() {
            return Err(format!(
                "extra lower must be an existing directory, got {}",
                lower.display()
            ));
        }
    }
    if plan.lower.uses_fixture_seed() {
        std::fs::create_dir_all(&plan.lower.path)
            .map_err(|e| format!("create lower {}: {e}", plan.lower.path.display()))?;
        seed_fixture_lower(&plan.lower.path, agent_uid)?;
    }
    if plan.lower.kind == LowerKind::ComposedRepos {
        materialize_composed_lower(plan)?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn materialize_composed_lower(plan: &OverlayMountPlan) -> Result<(), String> {
    let started = Instant::now();
    let compose =
        plan_repo_composition(&plan.lower.path, &plan.repo_cache_root, &plan.repo_mounts)?;
    eprintln!(
        "event=overlay_compose_lower_started lower={} entries={}",
        compose.lower.display(),
        compose.entries.len()
    );
    if compose.lower.exists() {
        std::fs::remove_dir_all(&compose.lower)
            .map_err(|e| format!("reset composed lower {}: {e}", compose.lower.display()))?;
    }
    std::fs::create_dir_all(&compose.lower)
        .map_err(|e| format!("create composed lower {}: {e}", compose.lower.display()))?;

    for entry in &compose.entries {
        materialize_repo_entry(entry)?;
    }
    remove_write_permissions(&compose.lower)?;
    eprintln!(
        "event=overlay_compose_lower_completed lower={} entries={} duration_ms={}",
        compose.lower.display(),
        compose.entries.len(),
        started.elapsed().as_millis()
    );
    Ok(())
}

#[cfg(target_os = "linux")]
fn materialize_repo_entry(entry: &RepoComposeEntry) -> Result<(), String> {
    let started = Instant::now();
    let source = if entry.cache_path.join(".git").is_dir() {
        "repo_cache"
    } else if entry.mount.private {
        "missing_private_cache"
    } else {
        "git_clone"
    };
    if let Some(parent) = entry.target_path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("create repo target parent {}: {e}", parent.display()))?;
    }

    if entry.cache_path.join(".git").is_dir() {
        copy_repo_from_cache(&entry.cache_path, &entry.target_path)?;
    } else if entry.mount.private {
        return Err(format!(
            "private repo {:?} is not present in its principal-scoped cache {}; direct clone is disabled",
            entry.mount.repo,
            entry.cache_path.display()
        ));
    } else {
        clone_repo(&entry.mount.repo, &entry.target_path)?;
    }

    if let Some(resolved_sha) = entry.mount.resolved_sha.as_deref() {
        checkout_repo_ref(&entry.target_path, resolved_sha)?;
    } else if let Some(git_ref) = entry.mount.r#ref.as_deref() {
        checkout_repo_ref(&entry.target_path, git_ref)?;
    }
    eprintln!(
        "event=overlay_compose_repo_entry_completed repo={} ref={} source={} target={} duration_ms={}",
        entry.mount.repo,
        entry.mount.r#ref.as_deref().unwrap_or(""),
        source,
        entry.target_path.display(),
        started.elapsed().as_millis()
    );
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn hydrate_private_repo_caches(
    repos: &[RepoMount],
    repo_cache_root: &Path,
    https_proxy: &str,
    git_ca_info: &str,
) -> Result<usize, String> {
    validate_repo_mounts(repos)?;
    let mut hydrated = 0usize;
    for repo in repos.iter().filter(|repo| repo.private) {
        let cache_path = repo_cache_path(repo_cache_root, repo)?;
        if cache_path.join(".git").is_dir() {
            continue;
        }
        clone_private_repo_to_cache(repo, &cache_path, https_proxy, git_ca_info)?;
        hydrated += 1;
    }
    Ok(hydrated)
}

#[cfg(not(target_os = "linux"))]
pub fn hydrate_private_repo_caches(
    _repos: &[RepoMount],
    _repo_cache_root: &Path,
    _https_proxy: &str,
    _git_ca_info: &str,
) -> Result<usize, String> {
    Err("private repo cache hydration is linux-only".to_string())
}

#[cfg(target_os = "linux")]
fn clone_private_repo_to_cache(
    repo: &RepoMount,
    cache_path: &Path,
    https_proxy: &str,
    git_ca_info: &str,
) -> Result<(), String> {
    use std::time::Duration;

    let parent = cache_path
        .parent()
        .ok_or_else(|| format!("cache path {} has no parent", cache_path.display()))?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("create private repo cache parent {}: {e}", parent.display()))?;

    let lock_path = cache_path.with_extension("clone.lock");
    for attempt in 0..120 {
        match std::fs::create_dir(&lock_path) {
            Ok(()) => {
                let result =
                    clone_private_repo_to_cache_locked(repo, cache_path, https_proxy, git_ca_info);
                let _ = std::fs::remove_dir(&lock_path);
                return result;
            }
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => {
                if cache_path.join(".git").is_dir() {
                    return Ok(());
                }
                if attempt == 119 {
                    return Err(format!(
                        "timed out waiting for private repo cache lock {}",
                        lock_path.display()
                    ));
                }
                std::thread::sleep(Duration::from_secs(1));
            }
            Err(err) => {
                return Err(format!(
                    "create private repo cache lock {}: {err}",
                    lock_path.display()
                ));
            }
        }
    }
    Err("unreachable private repo cache lock loop".to_string())
}

#[cfg(target_os = "linux")]
fn clone_private_repo_to_cache_locked(
    repo: &RepoMount,
    cache_path: &Path,
    https_proxy: &str,
    git_ca_info: &str,
) -> Result<(), String> {
    clone_private_repo_to_cache_locked_with_git(
        repo,
        cache_path,
        https_proxy,
        git_ca_info,
        Path::new("git"),
    )
}

#[cfg(target_os = "linux")]
fn clone_private_repo_to_cache_locked_with_git(
    repo: &RepoMount,
    cache_path: &Path,
    https_proxy: &str,
    git_ca_info: &str,
    git_binary: &Path,
) -> Result<(), String> {
    use std::process::Command;

    if cache_path.join(".git").is_dir() {
        return Ok(());
    }
    if cache_path.exists() {
        std::fs::remove_dir_all(cache_path)
            .map_err(|e| format!("reset private repo cache {}: {e}", cache_path.display()))?;
    }
    let tmp = cache_path.with_extension(format!("clone.tmp.{}", std::process::id()));
    if tmp.exists() {
        std::fs::remove_dir_all(&tmp)
            .map_err(|e| format!("reset private repo cache temp {}: {e}", tmp.display()))?;
    }

    let repo_url = private_repo_clone_url(repo);
    let (envs, args) =
        private_repo_clone_command_env_and_args(repo, &tmp, https_proxy, git_ca_info);
    let output = Command::new(git_binary)
        .envs(envs)
        .args(args)
        .output()
        .map_err(|e| format!("spawn private git clone {repo_url}: {e}"))?;
    if !output.status.success() {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(format!(
            "private git clone {repo_url} -> {} failed (status {}): {}",
            cache_path.display(),
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    std::fs::rename(&tmp, cache_path)
        .map_err(|e| format!("publish private repo cache {}: {e}", cache_path.display()))?;
    Ok(())
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn private_repo_clone_url(repo: &RepoMount) -> String {
    format!("https://github.com/{}.git", repo.repo)
}

#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn private_repo_clone_command_env_and_args(
    repo: &RepoMount,
    target: &Path,
    https_proxy: &str,
    git_ca_info: &str,
) -> (Vec<(&'static str, String)>, Vec<String>) {
    (
        vec![
            ("GIT_TERMINAL_PROMPT", "0".to_string()),
            ("HTTPS_PROXY", https_proxy.to_string()),
            ("HTTP_PROXY", https_proxy.to_string()),
            ("GIT_SSL_CAINFO", git_ca_info.to_string()),
        ],
        vec![
            "-c".to_string(),
            "http.https://github.com/.extraheader=Authorization: GITHUB_TOKEN".to_string(),
            "clone".to_string(),
            "--filter=blob:none".to_string(),
            "--quiet".to_string(),
            private_repo_clone_url(repo),
            target.display().to_string(),
        ],
    )
}

#[cfg(target_os = "linux")]
fn copy_repo_from_cache(source: &Path, target: &Path) -> Result<(), String> {
    use std::process::Command;

    if target.exists() {
        std::fs::remove_dir_all(target)
            .map_err(|e| format!("reset repo target {}: {e}", target.display()))?;
    }
    std::fs::create_dir_all(target)
        .map_err(|e| format!("create repo target {}: {e}", target.display()))?;
    let source_contents = source.join(".");
    let output = Command::new("cp")
        .arg("-a")
        .arg("--reflink=auto")
        .arg(&source_contents)
        .arg(target)
        .output()
        .map_err(|e| format!("spawn cp from repo-cache {}: {e}", source.display()))?;
    if !output.status.success() {
        return Err(format!(
            "copy repo-cache {} -> {} failed (status {}): {}",
            source.display(),
            target.display(),
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn clone_repo(repo: &str, target: &Path) -> Result<(), String> {
    use std::process::Command;

    if target.exists() {
        std::fs::remove_dir_all(target)
            .map_err(|e| format!("reset repo target {}: {e}", target.display()))?;
    }
    let repo_url = format!("https://github.com/{repo}.git");
    let output = Command::new("git")
        .args(["clone", "--filter=blob:none", "--quiet"])
        .arg(&repo_url)
        .arg(target)
        .output()
        .map_err(|e| format!("spawn git clone {repo_url}: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "git clone {repo_url} -> {} failed (status {}): {}",
            target.display(),
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn checkout_repo_ref(repo_dir: &Path, git_ref: &str) -> Result<(), String> {
    use std::process::Command;

    let local_ref = format!("{git_ref}^{{commit}}");
    let origin_ref = format!("origin/{git_ref}^{{commit}}");
    let checkout_target = if git_verify_ref(repo_dir, &origin_ref)? {
        format!("origin/{git_ref}")
    } else if git_verify_ref(repo_dir, &local_ref)? {
        git_ref.to_owned()
    } else {
        let output = Command::new("git")
            .arg("-C")
            .arg(repo_dir)
            .args(["-c", "gc.auto=0", "fetch", "--depth=1", "origin", git_ref])
            .output()
            .map_err(|e| format!("spawn git fetch {git_ref} in {}: {e}", repo_dir.display()))?;
        if !output.status.success() {
            return Err(format!(
                "git fetch {git_ref} in {} failed (status {}): {}",
                repo_dir.display(),
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        "FETCH_HEAD".to_string()
    };

    let output = Command::new("git")
        .arg("-C")
        .arg(repo_dir)
        .args(["checkout", "--quiet", "--detach"])
        .arg(&checkout_target)
        .output()
        .map_err(|e| {
            format!(
                "spawn git checkout {checkout_target} in {}: {e}",
                repo_dir.display()
            )
        })?;
    if !output.status.success() {
        return Err(format!(
            "git checkout {checkout_target} in {} failed (status {}): {}",
            repo_dir.display(),
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn git_verify_ref(repo_dir: &Path, git_ref: &str) -> Result<bool, String> {
    use std::process::Command;

    let status = Command::new("git")
        .arg("-C")
        .arg(repo_dir)
        .args(["rev-parse", "--verify", "--quiet", git_ref])
        .status()
        .map_err(|e| format!("spawn git rev-parse in {}: {e}", repo_dir.display()))?;
    Ok(status.success())
}

#[cfg(target_os = "linux")]
fn remove_write_permissions(root: &Path) -> Result<(), String> {
    use std::os::unix::fs::{FileTypeExt, PermissionsExt};

    fn visit(path: &Path) -> Result<(), String> {
        let metadata =
            std::fs::symlink_metadata(path).map_err(|e| format!("stat {}: {e}", path.display()))?;
        let file_type = metadata.file_type();
        if file_type.is_symlink() {
            return Ok(());
        }
        if file_type.is_dir() {
            for entry in
                std::fs::read_dir(path).map_err(|e| format!("read dir {}: {e}", path.display()))?
            {
                let entry = entry.map_err(|e| format!("read dir entry {}: {e}", path.display()))?;
                visit(&entry.path())?;
            }
            // Directories stay world-writable so the hardened non-root agent can
            // create files in repo subdirs through overlay copy-up. The lower itself
            // is never mutated -- new files and edits land in the overlay upper.
            return std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o777))
                .map_err(|e| format!("chmod composed dir {}: {e}", path.display()));
        } else if !file_type.is_file() && !file_type.is_fifo() && !file_type.is_socket() {
            return Ok(());
        }

        let mut perms = metadata.permissions();
        perms.set_mode(perms.mode() & !0o222);
        std::fs::set_permissions(path, perms)
            .map_err(|e| format!("chmod read-only {}: {e}", path.display()))
    }

    visit(root)
}

#[cfg(target_os = "linux")]
fn write_ready_marker(merged: &Path) -> Result<(), String> {
    let marker = ready_marker_path(merged);
    std::fs::write(&marker, b"ready\n").map_err(|e| format!("write {}: {e}", marker.display()))
}

#[cfg(target_os = "linux")]
fn remove_ready_marker(plan: &OverlayMountPlan) -> Result<(), String> {
    remove_file_if_exists(&ready_marker_path(&plan.merged))?;
    remove_file_if_exists(&plan.upper.join(READY_MARKER_FILE))
}

#[cfg(target_os = "linux")]
fn remove_file_if_exists(path: &Path) -> Result<(), String> {
    match std::fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove {}: {e}", path.display())),
    }
}

#[cfg(target_os = "linux")]
fn set_dir_mode(dir: &Path, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(mode))
        .map_err(|e| format!("chmod {}: {e}", dir.display()))
}

#[cfg(target_os = "linux")]
fn chown_dir_owner(dir: &Path, uid: u32) -> Result<(), String> {
    use std::os::unix::fs::chown;

    chown(dir, Some(uid), Some(uid)).map_err(|e| format!("chown {} to {uid}: {e}", dir.display()))
}

#[cfg(target_os = "linux")]
fn reset_workdir(work: &Path) -> Result<(), String> {
    if work.exists() {
        std::fs::remove_dir_all(work)
            .map_err(|e| format!("reset workdir {}: {e}", work.display()))?;
    }
    std::fs::create_dir_all(work).map_err(|e| format!("create workdir {}: {e}", work.display()))
}

#[cfg(target_os = "linux")]
fn is_overlay_mount(merged: &Path) -> Result<bool, String> {
    is_mount_with_fs_type(merged, Some("overlay"))
}

#[cfg(target_os = "linux")]
fn is_mount_at(path: &Path) -> Result<bool, String> {
    is_mount_with_fs_type(path, None)
}

#[cfg(target_os = "linux")]
fn is_mount_with_fs_type(path: &Path, fs_type_filter: Option<&str>) -> Result<bool, String> {
    let target = path
        .canonicalize()
        .unwrap_or_else(|_| path.to_path_buf())
        .to_string_lossy()
        .into_owned();
    let mountinfo = match std::fs::read_to_string("/proc/self/mountinfo") {
        Ok(s) => s,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(format!("read /proc/self/mountinfo: {e}")),
    };

    for line in mountinfo.lines() {
        let fields: Vec<&str> = line.split(' ').collect();
        if fields.len() < 10 {
            continue;
        }
        let mount_point = unescape_mountinfo(fields[4]);
        let Some(sep) = fields.iter().position(|f| *f == "-") else {
            continue;
        };
        let Some(fs_type) = fields.get(sep + 1) else {
            continue;
        };
        if mount_point == target && fs_type_filter.is_none_or(|wanted| *fs_type == wanted) {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(target_os = "linux")]
fn unescape_mountinfo(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    let bytes = value.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'\\'
            && i + 3 < bytes.len()
            && let Ok(octal) = u8::from_str_radix(&value[i + 1..i + 4], 8)
        {
            out.push(octal as char);
            i += 4;
            continue;
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plan_uses_fixture_lower_by_default() {
        let plan = plan_overlay_mount(
            Path::new("/var/lib/centaur/overlays"),
            "sess-1",
            Path::new("/run/centaur/merged/sess-1"),
            "",
            &[],
            None,
        )
        .unwrap();

        assert_eq!(
            plan.upper,
            PathBuf::from("/var/lib/centaur/overlays/sess-1")
        );
        assert_eq!(
            plan.work,
            PathBuf::from("/var/lib/centaur/overlay-work/sess-1")
        );
        assert_eq!(
            plan.lower,
            LowerSource {
                path: PathBuf::from("/var/lib/centaur/overlay-lower/sess-1"),
                kind: LowerKind::Fixture,
            }
        );
    }

    #[test]
    fn sibling_dirs_cover_planned_work_and_lower() {
        // Guards the leak's root cause: GC's cleanup set must always contain every
        // host-root dir the mount planner creates, for both lower layouts.
        let overlays_root = Path::new("/var/lib/centaur/overlays");
        let siblings = session_sibling_dirs(overlays_root, "sess-1");

        let fixture = plan_overlay_mount(
            overlays_root,
            "sess-1",
            Path::new("/run/centaur/merged/sess-1"),
            "",
            &[],
            None,
        )
        .unwrap();
        assert!(
            siblings.contains(&fixture.work),
            "work dir would leak: {siblings:?}"
        );
        assert!(
            siblings.contains(&fixture.lower.path),
            "fixture lower would leak: {siblings:?}"
        );
        // Composed-repos lower (`<session>.repos`) — the MB–GB offender — is covered.
        assert!(siblings.contains(&PathBuf::from(
            "/var/lib/centaur/overlay-lower/sess-1.repos"
        )));
    }

    #[test]
    fn sibling_dirs_empty_when_overlays_root_has_no_parent() {
        assert!(session_sibling_dirs(Path::new("/"), "sess-1").is_empty());
    }

    #[test]
    fn repo_lower_wins_over_fixture_override() {
        let plan = plan_overlay_mount(
            Path::new("/var/lib/centaur/overlays"),
            "sess-1",
            Path::new("/run/centaur/merged/sess-1"),
            "/var/lib/centaur/repos/sess-1",
            &[],
            Some(Path::new("/tmp/lower")),
        )
        .unwrap();

        assert_eq!(
            plan.lower,
            LowerSource {
                path: PathBuf::from("/var/lib/centaur/repos/sess-1"),
                kind: LowerKind::Repo,
            }
        );
    }

    #[test]
    fn overlay_options_match_mount_contract() {
        assert_eq!(
            overlay_options(Path::new("/lower"), Path::new("/upper"), Path::new("/work")),
            "lowerdir=/lower,upperdir=/upper,workdir=/work,metacopy=off"
        );
    }

    #[test]
    fn overlay_options_prepend_extra_lower_when_present() {
        let mut plan = plan_overlay_mount(
            Path::new("/var/lib/centaur/overlays"),
            "sess-1",
            Path::new("/run/centaur/merged/sess-1"),
            "/repo/lower",
            &[],
            None,
        )
        .unwrap();
        plan.extra_lowers
            .push(PathBuf::from("/var/lib/centaur/overlays/home-lower/sess-1"));
        plan.extra_lowers.push(PathBuf::from(
            "/var/lib/centaur/overlays/artifact-lower/sess-1",
        ));

        assert_eq!(
            plan.overlay_options(),
            "lowerdir=/var/lib/centaur/overlays/home-lower/sess-1:/var/lib/centaur/overlays/artifact-lower/sess-1:/repo/lower,upperdir=/var/lib/centaur/overlays/sess-1,workdir=/var/lib/centaur/overlay-work/sess-1,metacopy=off"
        );
    }

    #[test]
    fn ready_marker_lives_under_merged_root() {
        assert_eq!(
            ready_marker_path(Path::new("/run/centaur/merged/sess-1")),
            PathBuf::from("/run/centaur/merged/sess-1/.centaur-workspace-ready")
        );
    }

    #[test]
    fn repo_rejects_traversal_components() {
        let err = select_lower_source(
            "/var/lib/centaur/repos/../other",
            &[],
            None,
            Path::new("/var/lib/centaur"),
            "sess-1",
        )
        .unwrap_err();

        assert!(err.contains(". or .."));
    }

    #[test]
    fn multi_repo_plan_uses_composed_lower_and_dedupes_exact_repeats() {
        let repos = vec![
            RepoMount {
                repo: "acme/foo".to_string(),
                r#ref: Some("main".to_string()),
                subdir: None,
                resolved_sha: None,
                cache_path: None,
                private: false,
                cache_scope: None,
            },
            RepoMount {
                repo: "acme/foo".to_string(),
                r#ref: Some("main".to_string()),
                subdir: None,
                resolved_sha: None,
                cache_path: None,
                private: false,
                cache_scope: None,
            },
            RepoMount {
                repo: "acme/bar".to_string(),
                r#ref: None,
                subdir: Some("libbar".to_string()),
                resolved_sha: None,
                cache_path: None,
                private: false,
                cache_scope: None,
            },
        ];
        let plan = plan_overlay_mount(
            Path::new("/var/lib/centaur/overlays"),
            "sess-1",
            Path::new("/run/centaur/merged/sess-1"),
            "/ignored/single/repo",
            &repos,
            None,
        )
        .unwrap();

        assert_eq!(
            plan.lower,
            LowerSource {
                path: PathBuf::from("/var/lib/centaur/overlay-lower/sess-1.repos"),
                kind: LowerKind::ComposedRepos,
            }
        );
        assert_eq!(plan.repo_mounts.len(), 2);
        assert_eq!(plan.repo_cache_root, PathBuf::from(DEFAULT_REPO_CACHE_ROOT));
    }

    #[test]
    fn compose_plan_maps_repos_to_cache_and_workspace_subdirs() {
        let repos = vec![
            RepoMount {
                repo: "acme/foo".to_string(),
                r#ref: None,
                subdir: None,
                resolved_sha: None,
                cache_path: None,
                private: false,
                cache_scope: None,
            },
            RepoMount {
                repo: "acme/bar".to_string(),
                r#ref: Some("release/v1".to_string()),
                subdir: Some("vendor-bar".to_string()),
                resolved_sha: None,
                cache_path: None,
                private: false,
                cache_scope: None,
            },
        ];
        let plan = plan_repo_composition(Path::new("/lower"), Path::new("/cache"), &repos).unwrap();

        // Default: nested owner-scoped under repos/. Explicit subdir: repos/<subdir>.
        assert_eq!(plan.entries[0].target_subdir, "repos/acme/foo");
        assert_eq!(plan.entries[0].cache_path, PathBuf::from("/cache/acme/foo"));
        assert_eq!(
            plan.entries[0].target_path,
            PathBuf::from("/lower/repos/acme/foo")
        );
        assert_eq!(plan.entries[1].target_subdir, "repos/vendor-bar");
        assert_eq!(plan.entries[1].cache_path, PathBuf::from("/cache/acme/bar"));
        assert_eq!(
            plan.entries[1].target_path,
            PathBuf::from("/lower/repos/vendor-bar")
        );
    }

    #[test]
    fn compose_plan_uses_principal_scoped_cache_for_private_repos() {
        let repos = vec![RepoMount {
            repo: "acme/private".to_string(),
            r#ref: Some("main".to_string()),
            subdir: None,
            resolved_sha: None,
            cache_path: None,
            private: true,
            cache_scope: Some(RepoCacheScope::Principal {
                principal_id: "prn_user:one".to_string(),
            }),
        }];

        let plan = plan_repo_composition(Path::new("/lower"), Path::new("/cache"), &repos).unwrap();

        assert_eq!(plan.entries[0].target_subdir, "repos/acme/private");
        assert_eq!(
            plan.entries[0].cache_path,
            PathBuf::from("/cache/principals/principal-prn_user%3Aone/acme/private")
        );
    }

    #[test]
    fn compose_plan_uses_explicit_snapshot_cache_path() {
        let repos = vec![RepoMount {
            repo: "acme/widget".to_string(),
            r#ref: Some("main".to_string()),
            subdir: None,
            resolved_sha: Some("abc123".to_string()),
            cache_path: Some(".snapshots/acme/widget/abc123".to_string()),
            private: false,
            cache_scope: None,
        }];

        let plan = plan_repo_composition(Path::new("/lower"), Path::new("/cache"), &repos).unwrap();

        assert_eq!(plan.entries[0].target_subdir, "repos/acme/widget");
        assert_eq!(
            plan.entries[0].cache_path,
            PathBuf::from("/cache/.snapshots/acme/widget/abc123")
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn checkout_repo_ref_prefers_origin_ref_over_stale_local_branch() {
        use std::process::Command;

        fn git(repo: &Path, args: &[&str]) {
            let output = Command::new("git")
                .arg("-C")
                .arg(repo)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "git {:?} failed: {}",
                args,
                String::from_utf8_lossy(&output.stderr)
            );
        }

        fn head(repo: &Path) -> String {
            let output = Command::new("git")
                .arg("-C")
                .arg(repo)
                .args(["rev-parse", "HEAD"])
                .output()
                .unwrap();
            assert!(output.status.success());
            String::from_utf8(output.stdout).unwrap().trim().to_owned()
        }

        let tmp = tempfile::tempdir().unwrap();
        let repo = tmp.path().join("repo");
        std::fs::create_dir(&repo).unwrap();
        git(&repo, &["init", "-b", "master"]);
        git(&repo, &["config", "user.email", "test@example.com"]);
        git(&repo, &["config", "user.name", "Test User"]);
        std::fs::write(repo.join("file.txt"), "old").unwrap();
        git(&repo, &["add", "file.txt"]);
        git(&repo, &["commit", "-m", "old"]);
        let old = head(&repo);

        std::fs::write(repo.join("file.txt"), "new").unwrap();
        git(&repo, &["commit", "-am", "new"]);
        let new = head(&repo);

        git(&repo, &["update-ref", "refs/remotes/origin/master", &new]);
        git(&repo, &["update-ref", "refs/heads/master", &old]);
        git(&repo, &["checkout", "--quiet", "--detach", &new]);

        checkout_repo_ref(&repo, "master").unwrap();

        assert_eq!(head(&repo), new);
    }

    #[test]
    fn private_repo_clone_command_uses_proxy_placeholder_not_raw_token() {
        let repo = RepoMount {
            repo: "acme/private".to_string(),
            r#ref: None,
            subdir: None,
            resolved_sha: None,
            cache_path: None,
            private: true,
            cache_scope: Some(RepoCacheScope::Principal {
                principal_id: "prn_user:one".to_string(),
            }),
        };

        let (envs, args) = private_repo_clone_command_env_and_args(
            &repo,
            Path::new("/cache/principals/principal-prn_user%3Aone/acme/private"),
            "http://session-proxy:8080",
            "/proxy/ca.crt",
        );
        let serialized = format!("{envs:?} {args:?}");

        assert!(envs.contains(&("GIT_TERMINAL_PROMPT", "0".to_string())));
        assert!(envs.contains(&("HTTPS_PROXY", "http://session-proxy:8080".to_string())));
        assert!(envs.contains(&("HTTP_PROXY", "http://session-proxy:8080".to_string())));
        assert!(envs.contains(&("GIT_SSL_CAINFO", "/proxy/ca.crt".to_string())));
        assert!(args.contains(
            &"http.https://github.com/.extraheader=Authorization: GITHUB_TOKEN".to_string()
        ));
        assert!(args.contains(&"https://github.com/acme/private.git".to_string()));
        assert!(
            args.contains(&"/cache/principals/principal-prn_user%3Aone/acme/private".to_string())
        );
        assert!(!serialized.contains("ghp_"));
        assert!(!serialized.contains("github_pat_"));
        assert!(!serialized.contains("/tools-github-token"));
        assert!(!serialized.contains("CENTAUR_TOOLS_GITHUB_TOKEN_FILE"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn private_repo_cache_hydration_uses_proxy_placeholder_not_raw_token() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().unwrap();
        let fake_git = tmp.path().join("git");
        let log_path = tmp.path().join("git-call.log");
        std::fs::write(
            &fake_git,
            format!(
                r#"#!/bin/sh
set -eu
log="{}"
printf 'GIT_TERMINAL_PROMPT=%s\n' "${{GIT_TERMINAL_PROMPT-}}" > "$log"
printf 'HTTPS_PROXY=%s\n' "${{HTTPS_PROXY-}}" >> "$log"
printf 'HTTP_PROXY=%s\n' "${{HTTP_PROXY-}}" >> "$log"
printf 'GIT_SSL_CAINFO=%s\n' "${{GIT_SSL_CAINFO-}}" >> "$log"
printf 'ARGS=%s\n' "$*" >> "$log"
last=""
for arg in "$@"; do last="$arg"; done
mkdir -p "$last/.git"
"#,
                log_path.display()
            ),
        )
        .unwrap();
        let mut perms = std::fs::metadata(&fake_git).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&fake_git, perms).unwrap();

        let repo = RepoMount {
            repo: "acme/private".to_string(),
            r#ref: None,
            subdir: None,
            resolved_sha: None,
            cache_path: None,
            private: true,
            cache_scope: Some(RepoCacheScope::Principal {
                principal_id: "prn_user:one".to_string(),
            }),
        };
        let cache_path = repo_cache_path(tmp.path().join("cache").as_path(), &repo).unwrap();

        clone_private_repo_to_cache_locked_with_git(
            &repo,
            &cache_path,
            "http://session-proxy:8080",
            "/proxy/ca.crt",
            &fake_git,
        )
        .unwrap();

        assert_eq!(
            cache_path,
            tmp.path()
                .join("cache/principals/principal-prn_user%3Aone/acme/private")
        );
        assert!(cache_path.join(".git").is_dir());
        let log = std::fs::read_to_string(log_path).unwrap();
        assert!(log.contains("GIT_TERMINAL_PROMPT=0"));
        assert!(log.contains("HTTPS_PROXY=http://session-proxy:8080"));
        assert!(log.contains("HTTP_PROXY=http://session-proxy:8080"));
        assert!(log.contains("GIT_SSL_CAINFO=/proxy/ca.crt"));
        assert!(log.contains("Authorization: GITHUB_TOKEN"));
        assert!(log.contains("https://github.com/acme/private.git"));
        assert!(!log.contains("ghp_"));
        assert!(!log.contains("github_pat_"));
        assert!(!log.contains("/tools-github-token"));
        assert!(!log.contains("CENTAUR_TOOLS_GITHUB_TOKEN_FILE"));
    }

    #[test]
    fn compose_plan_same_basename_different_owners_no_collision() {
        // Used to collide on the shared basename "app"; owner-scoping under repos/ fixes it.
        let repos = vec![
            RepoMount {
                repo: "acme/app".to_string(),
                r#ref: None,
                subdir: None,
                resolved_sha: None,
                cache_path: None,
                private: false,
                cache_scope: None,
            },
            RepoMount {
                repo: "globex/app".to_string(),
                r#ref: None,
                subdir: None,
                resolved_sha: None,
                cache_path: None,
                private: false,
                cache_scope: None,
            },
        ];
        let plan = plan_repo_composition(Path::new("/lower"), Path::new("/cache"), &repos).unwrap();
        assert_eq!(plan.entries[0].target_subdir, "repos/acme/app");
        assert_eq!(plan.entries[1].target_subdir, "repos/globex/app");
    }

    #[test]
    fn compose_plan_rejects_target_collisions_and_traversal() {
        // Same-basename, different owners NO LONGER collide (owner-scoped under repos/);
        // a collision now requires two repos targeting the same path — e.g. a shared
        // explicit subdir.
        let err = plan_repo_composition(
            Path::new("/lower"),
            Path::new("/cache"),
            &[
                RepoMount {
                    repo: "acme/bar".to_string(),
                    r#ref: None,
                    subdir: Some("shared".to_string()),
                    resolved_sha: None,
                    cache_path: None,
                    private: false,
                    cache_scope: None,
                },
                RepoMount {
                    repo: "globex/baz".to_string(),
                    r#ref: None,
                    subdir: Some("shared".to_string()),
                    resolved_sha: None,
                    cache_path: None,
                    private: false,
                    cache_scope: None,
                },
            ],
        )
        .unwrap_err();
        assert!(err.contains("target workspace subdir"));

        let err = plan_repo_composition(
            Path::new("/lower"),
            Path::new("/cache"),
            &[RepoMount {
                repo: "/absolute/repo".to_string(),
                r#ref: None,
                subdir: Some("repo".to_string()),
                resolved_sha: None,
                cache_path: None,
                private: false,
                cache_scope: None,
            }],
        )
        .unwrap_err();
        assert!(err.contains("relative path"));
    }
}
