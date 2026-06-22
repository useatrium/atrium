//! Daemon-owned overlay mount planning and lifecycle helpers.
//!
//! The pure path planning pieces are compiled everywhere so unit tests can run
//! off-node. The actual mount/umount operations are Linux-only and are called by
//! the privileged node-sync daemon.

use std::path::{Component, Path, PathBuf};

pub const DEFAULT_AGENT_UID: u32 = 1001;
pub const READY_MARKER_FILE: &str = ".centaur-workspace-ready";

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum LowerKind {
    Fixture,
    Repo,
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
}

impl OverlayMountPlan {
    pub fn ready_marker(&self) -> PathBuf {
        ready_marker_path(&self.merged)
    }

    pub fn overlay_options(&self) -> String {
        overlay_options(&self.lower.path, &self.upper, &self.work)
    }
}

pub fn plan_overlay_mount(
    overlays_root: &Path,
    session: &str,
    merged: &Path,
    repo: &str,
    lower_override: Option<&Path>,
) -> Result<OverlayMountPlan, String> {
    let host_root = overlays_root
        .parent()
        .ok_or_else(|| format!("{} has no parent", overlays_root.display()))?;
    let lower = select_lower_source(repo, lower_override, host_root, session)?;
    Ok(OverlayMountPlan {
        session: session.to_owned(),
        upper: overlays_root.join(session),
        merged: merged.to_path_buf(),
        work: host_root.join("overlay-work").join(session),
        lower,
    })
}

pub fn select_lower_source(
    repo: &str,
    lower_override: Option<&Path>,
    host_root: &Path,
    session: &str,
) -> Result<LowerSource, String> {
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
            .unwrap_or_else(|| host_root.join("overlay-lower").join(session)),
        kind: LowerKind::Fixture,
    })
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

pub fn overlay_options(lower: &Path, upper: &Path, work: &Path) -> String {
    format!(
        "lowerdir={},upperdir={},workdir={},metacopy=off",
        lower.display(),
        upper.display(),
        work.display()
    )
}

pub fn ready_marker_path(merged: &Path) -> PathBuf {
    merged.join(READY_MARKER_FILE)
}

pub fn seed_fixture_lower(lower: &Path) -> Result<(), String> {
    write_if_missing(&lower.join("seed.txt"), b"base seed\n")?;
    write_if_missing(&lower.join("delete-me.txt"), b"delete me\n")?;
    set_fixture_permissions(lower)
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
fn set_fixture_permissions(lower: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;

    std::fs::set_permissions(lower, std::fs::Permissions::from_mode(0o777))
        .map_err(|e| format!("chmod lower {}: {e}", lower.display()))?;
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
    }
    Ok(())
}

#[cfg(not(unix))]
fn set_fixture_permissions(_lower: &Path) -> Result<(), String> {
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn mount_overlay(
    plan: OverlayMountPlan,
    agent_uid: Option<u32>,
) -> Result<OverlayMountPlan, String> {
    use std::process::Command;

    let plan = resolve_lower_source(plan)?;
    prepare_mount_dirs(&plan, agent_uid)?;
    if is_overlay_mount(&plan.merged)? {
        write_ready_marker(&plan.merged)?;
        println!(
            "overlay mount: session {} already mounted at {}",
            plan.session,
            plan.merged.display()
        );
        return Ok(plan);
    }

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
fn resolve_lower_source(mut plan: OverlayMountPlan) -> Result<OverlayMountPlan, String> {
    if plan.lower.kind != LowerKind::Repo {
        return Ok(plan);
    }

    let metadata = std::fs::metadata(&plan.lower.path)
        .map_err(|e| format!("--repo {}: {e}", plan.lower.path.display()))?;
    if !metadata.is_dir() {
        return Err(format!(
            "--repo must be an existing directory, got {}",
            plan.lower.path.display()
        ));
    }
    plan.lower.path = plan
        .lower
        .path
        .canonicalize()
        .map_err(|e| format!("canonicalize --repo {}: {e}", plan.lower.path.display()))?;
    Ok(plan)
}

#[cfg(target_os = "linux")]
fn prepare_mount_dirs(plan: &OverlayMountPlan, agent_uid: Option<u32>) -> Result<(), String> {
    std::fs::create_dir_all(&plan.upper)
        .map_err(|e| format!("create upper {}: {e}", plan.upper.display()))?;
    if plan.lower.uses_fixture_seed() {
        std::fs::create_dir_all(&plan.lower.path)
            .map_err(|e| format!("create lower {}: {e}", plan.lower.path.display()))?;
        seed_fixture_lower(&plan.lower.path)?;
    }
    std::fs::create_dir_all(&plan.merged)
        .map_err(|e| format!("create merged {}: {e}", plan.merged.display()))?;

    match agent_uid {
        Some(uid) => chown_dir_owner(&plan.upper, uid)?,
        None => set_dir_mode(&plan.upper, 0o777)?,
    }
    Ok(())
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
    let target = merged
        .canonicalize()
        .unwrap_or_else(|_| merged.to_path_buf())
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
        if mount_point == target && *fs_type == "overlay" {
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
    fn repo_lower_wins_over_fixture_override() {
        let plan = plan_overlay_mount(
            Path::new("/var/lib/centaur/overlays"),
            "sess-1",
            Path::new("/run/centaur/merged/sess-1"),
            "/var/lib/centaur/repos/sess-1",
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
            None,
            Path::new("/var/lib/centaur"),
            "sess-1",
        )
        .unwrap_err();

        assert!(err.contains(". or .."));
    }
}
