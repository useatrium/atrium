//! Classify overlayfs `upper` entries into capture operations.
//!
//! The privileged node scanner walks each session's overlay `upper` (= the
//! changed set) and must translate overlayfs's on-disk encoding into logical
//! file operations. This module is the pure, platform-neutral classifier; the
//! syscalls that produce a `RawEntry` (statx/listxattr) live behind cfg(linux).
//! See notes/agent-sync-design.md §3 and cas-ledger-build-plan.md Track C4.

use std::path::{Component, Path, PathBuf};

/// An overlayfs whiteout is a character device with rdev makedev(0,0) == 0.
pub const WHITEOUT_RDEV: u64 = 0;
/// Directory whose lower contents are masked (a fresh dir replaced a lower one).
pub const XATTR_OPAQUE: &str = "trusted.overlay.opaque";
/// Present on a renamed entry; the value is the lower path it was renamed from.
pub const XATTR_REDIRECT: &str = "trusted.overlay.redirect";
/// Metadata-only copy-up (bytes still in lower). We mount `metacopy=off`, so this
/// should never appear; if it does we must NOT treat the (byte-less) upper as the
/// content.
pub const XATTR_METACOPY: &str = "trusted.overlay.metacopy";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RawFileType {
    Regular,
    Dir,
    CharDevice,
    Symlink,
    Other,
}

/// The raw, syscall-derived facts about one `upper` entry — everything the
/// classifier needs, with no I/O of its own (so it's trivially testable).
#[derive(Debug, Clone)]
pub struct RawEntry {
    /// Path relative to the upper root (never absolute, never containing `..`).
    pub rel_path: PathBuf,
    pub file_type: RawFileType,
    pub rdev: u64,
    pub size: u64,
    pub xattrs: Vec<(String, Vec<u8>)>,
}

impl RawEntry {
    pub fn xattr(&self, name: &str) -> Option<&[u8]> {
        self.xattrs
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_slice())
    }
    /// Overlay sets the opaque xattr to the byte 'y'.
    pub fn is_opaque(&self) -> bool {
        self.xattr(XATTR_OPAQUE) == Some(b"y")
    }
    pub fn redirect_target(&self) -> Option<PathBuf> {
        self.xattr(XATTR_REDIRECT).map(redirect_to_relpath)
    }
    /// A metacopy upper with size 0 carries no bytes (would be a torn capture).
    pub fn is_metacopy_only(&self) -> bool {
        self.xattr(XATTR_METACOPY).is_some()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum OverlayOp {
    /// Regular file present in upper → created OR modified. The upper alone can't
    /// distinguish the two; the ledger's per-path base_seq disambiguates.
    Upsert { path: PathBuf, size: u64 },
    /// char 0/0 whiteout → the path was deleted.
    Delete { path: PathBuf },
    /// directory carrying the opaque xattr → lower contents are masked.
    OpaqueDir { path: PathBuf },
    /// redirect xattr → a rename; `from` is the lower path, `to` the upper path.
    Rename { from: PathBuf, to: PathBuf },
    /// symlink → captured as METADATA ONLY. The scanner never follows it; the
    /// target is stored as opaque bytes elsewhere. This is the #1 escape defense.
    SymlinkMeta { path: PathBuf, target_len: u64 },
    /// a plain directory node — structural, nothing to capture.
    Dir { path: PathBuf },
    /// not understood / not ours → skipped, surfaced for logging.
    Skip { path: PathBuf, reason: SkipReason },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SkipReason {
    /// A real device/fifo/socket node the agent created — not overlay encoding.
    UnknownFileType,
    /// metacopy upper with no bytes (metacopy=off should prevent this).
    MetacopyWithoutBytes,
}

/// Classify one upper entry. Pure: no I/O, total over `RawEntry`.
pub fn classify(entry: &RawEntry) -> OverlayOp {
    let path = entry.rel_path.clone();
    match entry.file_type {
        // Whiteout: the load-bearing delete signal. Only rdev 0 is a whiteout; a
        // real char device (rdev != 0) the agent mknod'd is not ours → skip.
        RawFileType::CharDevice if entry.rdev == WHITEOUT_RDEV => OverlayOp::Delete { path },
        RawFileType::CharDevice => OverlayOp::Skip {
            path,
            reason: SkipReason::UnknownFileType,
        },

        // A symlink is NEVER followed; we record only that it exists + its length.
        RawFileType::Symlink => OverlayOp::SymlinkMeta {
            path,
            target_len: entry.size,
        },

        RawFileType::Dir => {
            if let Some(from) = entry.redirect_target() {
                OverlayOp::Rename { from, to: path }
            } else if entry.is_opaque() {
                OverlayOp::OpaqueDir { path }
            } else {
                OverlayOp::Dir { path }
            }
        }

        RawFileType::Regular => {
            if let Some(from) = entry.redirect_target() {
                OverlayOp::Rename { from, to: path }
            } else if entry.is_metacopy_only() && entry.size == 0 {
                OverlayOp::Skip {
                    path,
                    reason: SkipReason::MetacopyWithoutBytes,
                }
            } else {
                OverlayOp::Upsert {
                    path,
                    size: entry.size,
                }
            }
        }

        RawFileType::Other => OverlayOp::Skip {
            path,
            reason: SkipReason::UnknownFileType,
        },
    }
}

/// Parse a `trusted.overlay.redirect` value into a path relative to the overlay
/// root. The value is either absolute (leading '/', relative to the mount root)
/// or relative (to the entry's parent). We normalize to a root-relative path and
/// strip any escape components defensively.
pub fn redirect_to_relpath(value: &[u8]) -> PathBuf {
    let s = String::from_utf8_lossy(value);
    let trimmed = s.trim_start_matches('/');
    let mut out = PathBuf::new();
    for comp in Path::new(trimmed).components() {
        match comp {
            Component::Normal(c) => out.push(c),
            // never let a redirect value escape the root
            Component::ParentDir
            | Component::RootDir
            | Component::Prefix(_)
            | Component::CurDir => {}
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(p: &str, ft: RawFileType) -> RawEntry {
        RawEntry {
            rel_path: PathBuf::from(p),
            file_type: ft,
            rdev: 0,
            size: 0,
            xattrs: vec![],
        }
    }

    #[test]
    fn regular_file_is_upsert() {
        let mut e = entry("proj-x/plan.md", RawFileType::Regular);
        e.size = 42;
        assert_eq!(
            classify(&e),
            OverlayOp::Upsert {
                path: "proj-x/plan.md".into(),
                size: 42
            }
        );
    }

    #[test]
    fn char_dev_rdev_zero_is_delete() {
        // makedev(0,0) whiteout
        let e = RawEntry {
            rdev: WHITEOUT_RDEV,
            ..entry("proj-x/old.md", RawFileType::CharDevice)
        };
        assert_eq!(
            classify(&e),
            OverlayOp::Delete {
                path: "proj-x/old.md".into()
            }
        );
    }

    #[test]
    fn real_char_dev_is_skipped_not_deleted() {
        // a real device node (rdev != 0) must NOT be misread as a delete
        let e = RawEntry {
            rdev: 259,
            ..entry("dev/thing", RawFileType::CharDevice)
        };
        assert_eq!(
            classify(&e),
            OverlayOp::Skip {
                path: "dev/thing".into(),
                reason: SkipReason::UnknownFileType
            },
        );
    }

    #[test]
    fn symlink_is_metadata_only_never_followed() {
        let e = RawEntry {
            size: 11,
            ..entry("proj-x/leak", RawFileType::Symlink)
        };
        assert_eq!(
            classify(&e),
            OverlayOp::SymlinkMeta {
                path: "proj-x/leak".into(),
                target_len: 11
            }
        );
    }

    #[test]
    fn opaque_dir_detected() {
        let mut e = entry("proj-x/sub", RawFileType::Dir);
        e.xattrs.push((XATTR_OPAQUE.into(), b"y".to_vec()));
        assert_eq!(
            classify(&e),
            OverlayOp::OpaqueDir {
                path: "proj-x/sub".into()
            }
        );
    }

    #[test]
    fn plain_dir_is_structural() {
        let e = entry("proj-x/sub", RawFileType::Dir);
        assert_eq!(
            classify(&e),
            OverlayOp::Dir {
                path: "proj-x/sub".into()
            }
        );
    }

    #[test]
    fn redirect_xattr_is_rename() {
        let mut e = entry("proj-x/new.md", RawFileType::Regular);
        e.xattrs
            .push((XATTR_REDIRECT.into(), b"/proj-x/old.md".to_vec()));
        assert_eq!(
            classify(&e),
            OverlayOp::Rename {
                from: "proj-x/old.md".into(),
                to: "proj-x/new.md".into()
            },
        );
    }

    #[test]
    fn redirect_value_cannot_escape_root() {
        assert_eq!(
            redirect_to_relpath(b"/../../etc/shadow"),
            PathBuf::from("etc/shadow")
        );
        assert_eq!(redirect_to_relpath(b"a/../../b"), PathBuf::from("a/b"));
    }

    #[test]
    fn metacopy_without_bytes_is_skipped() {
        let mut e = entry("proj-x/big.bin", RawFileType::Regular);
        e.size = 0;
        e.xattrs.push((XATTR_METACOPY.into(), b"y".to_vec()));
        assert_eq!(
            classify(&e),
            OverlayOp::Skip {
                path: "proj-x/big.bin".into(),
                reason: SkipReason::MetacopyWithoutBytes
            },
        );
    }
}
