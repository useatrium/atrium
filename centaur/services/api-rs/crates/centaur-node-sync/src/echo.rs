//! Echo-suppression for the inbound→outbound loop (§8B #2, POC-verified).
//!
//! When the node writes reconciled bytes through `merged` (inbound adopt), those
//! bytes land in the `upper` and the next capture scan would re-capture them as a
//! fresh agent edit — an infinite echo, and a false conflict (the captured base
//! would lag the just-advanced ledger seq). The fix: the node records the sha it
//! intends to write per path before writing; the capture scan suppresses any
//! upsert whose `(path, sha)` matches a pending intent. Matching is by content
//! hash, so a genuine *new* agent edit (different bytes) is never suppressed.

use std::collections::HashMap;
use std::path::PathBuf;

#[derive(Default)]
pub struct EchoGuard {
    /// path -> the sha the node last wrote through `merged` (its own bytes).
    intended: HashMap<PathBuf, String>,
}

impl EchoGuard {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record that the node is about to write `sha` to `path` (an adopt). Call
    /// this BEFORE the write-through-merged so a fast scan can't race ahead.
    pub fn record_intent(&mut self, path: PathBuf, sha: impl Into<String>) {
        self.intended.insert(path, sha.into());
    }

    /// Should this captured `(path, sha)` be suppressed as the node's own echo?
    /// Consumes the intent on match (a later genuine edit to the same bytes is
    /// vanishingly unlikely and would just re-record on the next adopt).
    pub fn is_echo(&mut self, path: &PathBuf, sha: &str) -> bool {
        match self.intended.get(path) {
            Some(intended) if intended == sha => {
                self.intended.remove(path);
                true
            }
            _ => false,
        }
    }

    pub fn pending(&self) -> usize {
        self.intended.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn suppresses_the_nodes_own_write() {
        let mut g = EchoGuard::new();
        let p = PathBuf::from("proj-x/plan.md");
        g.record_intent(p.clone(), "deadbeef");
        assert!(g.is_echo(&p, "deadbeef"));
        // consumed — a second capture of the same bytes is not suppressed forever
        assert!(!g.is_echo(&p, "deadbeef"));
    }

    #[test]
    fn does_not_suppress_a_genuine_new_edit() {
        let mut g = EchoGuard::new();
        let p = PathBuf::from("proj-x/plan.md");
        g.record_intent(p.clone(), "deadbeef");
        // the agent edited the file to DIFFERENT bytes after the adopt → capture it
        assert!(!g.is_echo(&p, "cafef00d"));
        assert_eq!(g.pending(), 1);
    }

    #[test]
    fn unknown_path_is_never_echo() {
        let mut g = EchoGuard::new();
        assert!(!g.is_echo(&PathBuf::from("other.md"), "abc"));
    }
}
