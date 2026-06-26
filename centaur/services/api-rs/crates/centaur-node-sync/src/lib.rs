//! centaur-node-sync — the node-side overlay sync component (Track C4 + inbound).
//!
//! Privileged, one-per-node. Two halves, sharing the overlay `upper` as the
//! single observation point:
//!   - OUTBOUND (capture): scan the upper (the changed set), classify overlay
//!     encoding ([`overlay`]), read bytes with symlink-hardened ([`safety`]) +
//!     torn-read ([`tornread`]) safety, POST direct to Atrium S3.
//!   - INBOUND (merge): poll Atrium's change-feed for advances on hydrated paths,
//!     diff3 against the upper, write reconciled bytes through `merged`, with
//!     echo-suppression ([`echo`]) so the node's own writes aren't re-captured.
//!
//! This crate is platform-neutral logic + state machines (unit-tested everywhere);
//! the syscalls (openat2/statx/xattr/`/proc`) are in fs_linux.rs behind cfg(linux)
//! and exercised by the on-node integration tests.
#![allow(clippy::doc_lazy_continuation)]

pub mod adopt;
pub mod backpressure;
pub mod cas;
pub mod echo;
pub mod http_client;
pub mod manifest;
pub mod materializer;
pub mod overlay;
pub mod overlay_mount;
pub mod profile_candidates;
pub mod quiesce;
pub mod runtime;
pub mod safety;
pub mod secret;
pub mod session_manifest;
pub mod state;
pub mod tornread;
pub mod warmcache;
pub mod wip;

#[cfg(target_os = "linux")]
pub mod fs_linux;

use std::path::PathBuf;

pub use materializer::{ATRIUM_DOCS, materialize_once};
pub use overlay::{OverlayOp, RawEntry, RawFileType, SkipReason, classify};

/// Reduce a scan of upper entries to the capture operations worth shipping:
/// every classified op except the purely-structural `Dir` nodes (which carry no
/// content) and unreadable `Skip`s (returned separately for logging).
pub fn scan_to_ops(entries: &[RawEntry]) -> (Vec<OverlayOp>, Vec<(PathBuf, SkipReason)>) {
    let mut ops = Vec::new();
    let mut skipped = Vec::new();
    for e in entries {
        match classify(e) {
            OverlayOp::Dir { .. } => {}
            OverlayOp::Skip { path, reason } => skipped.push((path, reason)),
            op => ops.push(op),
        }
    }
    (ops, skipped)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn reg(p: &str, size: u64) -> RawEntry {
        RawEntry {
            rel_path: PathBuf::from(p),
            file_type: RawFileType::Regular,
            rdev: 0,
            size,
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
    fn dir(p: &str) -> RawEntry {
        RawEntry {
            rel_path: PathBuf::from(p),
            file_type: RawFileType::Dir,
            rdev: 0,
            size: 0,
            xattrs: vec![],
        }
    }

    #[test]
    fn scan_reduces_to_content_ops_and_drops_structural_dirs() {
        let entries = vec![
            dir("proj-x"),
            reg("proj-x/a.md", 10),
            whiteout("proj-x/old.md"),
        ];
        let (ops, skipped) = scan_to_ops(&entries);
        assert_eq!(ops.len(), 2); // upsert + delete; the dir is dropped
        assert!(skipped.is_empty());
        assert!(matches!(ops[0], OverlayOp::Upsert { .. }));
        assert!(matches!(ops[1], OverlayOp::Delete { .. }));
    }
}
