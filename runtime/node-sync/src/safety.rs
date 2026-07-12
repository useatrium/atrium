//! Path-resolution hardening for the privileged scanner (§8B #1 — the scariest
//! surface: a root host process resolving agent-controlled paths).
//!
//! The agent can plant `proj-x/leak -> /etc/shadow`; a naive `open(upper/leak)`
//! by the root scanner would exfiltrate it. The fix is `openat2(2)` with a
//! RESOLVE mask that refuses to traverse symlinks/magic-links and to leave the
//! upper subtree. POC-proven correction: `RESOLVE_NO_SYMLINKS` is load-bearing —
//! `RESOLVE_BENEATH` alone still follows in-bounds symlinks (naive `cat upper/leak`
//! printed `/etc/shadow`; the full mask → ELOOP).
//!
//! The constants mirror <linux/openat2.h>. The actual syscall is issued behind
//! cfg(linux) in fs_linux.rs; this module holds the mask + the defense-in-depth
//! relative-path validator so both can be unit-tested anywhere.

use std::path::{Component, Path};

pub const RESOLVE_NO_XDEV: u64 = 0x01;
pub const RESOLVE_NO_MAGICLINKS: u64 = 0x02;
pub const RESOLVE_NO_SYMLINKS: u64 = 0x04;
pub const RESOLVE_BENEATH: u64 = 0x08;

/// The exact mask the scanner MUST pass for every agent-controlled open. Order of
/// importance: NO_SYMLINKS (the load-bearing one), then NO_MAGICLINKS (/proc, fds),
/// BENEATH (no escaping the dirfd), NO_XDEV (no crossing mounts).
pub const HARDENED_RESOLVE: u64 =
    RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_BENEATH | RESOLVE_NO_XDEV;

/// Defense-in-depth alongside openat2: a relative path under the upper root must
/// have only normal components — no absolute root, no `..`, no prefix. (openat2 is
/// the real guard; this rejects obviously-bad paths before we even open.)
pub fn is_safe_relpath(p: &Path) -> bool {
    if p.as_os_str().is_empty() {
        return false;
    }
    p.components()
        .all(|c| matches!(c, Component::Normal(_) | Component::CurDir))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn hardened_mask_includes_no_symlinks() {
        // NO_SYMLINKS is the load-bearing flag — must be set.
        assert_ne!(HARDENED_RESOLVE & RESOLVE_NO_SYMLINKS, 0);
        // and the full mask is exactly these four.
        assert_eq!(
            HARDENED_RESOLVE,
            RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS | RESOLVE_BENEATH | RESOLVE_NO_XDEV,
        );
    }

    #[test]
    fn rejects_escape_paths() {
        assert!(!is_safe_relpath(&PathBuf::from("/etc/shadow")));
        assert!(!is_safe_relpath(&PathBuf::from("../../etc/shadow")));
        assert!(!is_safe_relpath(&PathBuf::from("proj-x/../../../etc")));
        assert!(!is_safe_relpath(&PathBuf::from("")));
    }

    #[test]
    fn accepts_normal_relpaths() {
        assert!(is_safe_relpath(&PathBuf::from("proj-x/plan.md")));
        assert!(is_safe_relpath(&PathBuf::from("shared/a/b/c.txt")));
        assert!(is_safe_relpath(&PathBuf::from("./scratch/x")));
    }
}
