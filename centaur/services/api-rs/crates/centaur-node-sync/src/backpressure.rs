//! Backpressure (§8B #11). The overlay `upper` is the agent's live dirty set; if it
//! fills the node volume the agent's next write fails ENOSPC mid-operation. The node
//! measures the upper's dirty bytes each scan and, when it crosses the per-session
//! budget, emits a backpressure signal (the harness pauses the agent BEFORE the write
//! fails) plus a scan-lag metric (how many ticks since capture last fully drained).
//! Like the quiesce gate, the node can't stop the agent itself — the signal is
//! harness-coupled; this module is the measurement + policy, unit-tested.

use crate::overlay::{RawEntry, RawFileType};

#[derive(Debug, Clone, Copy)]
pub struct Budget {
    pub max_dirty_bytes: u64,
}

impl Budget {
    /// Over budget → the harness should pause the agent before ENOSPC.
    pub fn over(&self, dirty: u64) -> bool {
        dirty > self.max_dirty_bytes
    }
    /// A soft warning threshold (90%) so the harness can slow before the hard stop.
    pub fn near(&self, dirty: u64) -> bool {
        dirty * 10 >= self.max_dirty_bytes * 9
    }
    pub fn headroom(&self, dirty: u64) -> u64 {
        self.max_dirty_bytes.saturating_sub(dirty)
    }
}

/// Bytes the agent has written into the upper (the regular-file dirty set —
/// whiteouts/dirs carry ~no bytes).
pub fn dirty_bytes(entries: &[RawEntry]) -> u64 {
    entries
        .iter()
        .filter(|e| matches!(e.file_type, RawFileType::Regular))
        .map(|e| e.size)
        .sum()
}

/// Dirty bytes EXCLUDING large files (H8): files above `large_threshold` are
/// streamed straight to S3, never held in the buffered upload set, so they must not
/// count toward the per-session dirty-byte budget (a single huge log/checkpoint
/// would otherwise trip backpressure spuriously). `large_threshold == 0` disables
/// the exclusion (everything counts).
pub fn dirty_bytes_excluding_large(entries: &[RawEntry], large_threshold: u64) -> u64 {
    entries
        .iter()
        .filter(|e| matches!(e.file_type, RawFileType::Regular))
        .map(|e| e.size)
        .filter(|&size| large_threshold == 0 || size <= large_threshold)
        .sum()
}

/// Scan-lag: ticks since capture last fully drained the upper to Atrium. Growing
/// lag + near-budget is the danger signal (writes outpacing the egress).
#[derive(Debug, Default, Clone, Copy)]
pub struct ScanLag {
    pub last_drained_tick: u64,
    pub tick: u64,
}

impl ScanLag {
    pub fn advance(&mut self, drained: bool) {
        self.tick += 1;
        if drained {
            self.last_drained_tick = self.tick;
        }
    }
    pub fn lag(&self) -> u64 {
        self.tick.saturating_sub(self.last_drained_tick)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn reg(size: u64) -> RawEntry {
        RawEntry {
            rel_path: PathBuf::from("f"),
            file_type: RawFileType::Regular,
            rdev: 0,
            size,
            xattrs: vec![],
        }
    }
    fn whiteout() -> RawEntry {
        RawEntry {
            rel_path: PathBuf::from("d"),
            file_type: RawFileType::CharDevice,
            rdev: 0,
            size: 999,
            xattrs: vec![],
        }
    }

    #[test]
    fn dirty_bytes_sums_regular_files_only() {
        let entries = vec![reg(100), reg(50), whiteout()]; // whiteout's "size" doesn't count
        assert_eq!(dirty_bytes(&entries), 150);
    }

    #[test]
    fn dirty_bytes_excludes_large_streamed_files() {
        // a 10MiB checkpoint + two small files; the big one streams direct → excluded.
        let big = 10 * 1024 * 1024;
        let entries = vec![reg(big), reg(100), reg(50)];
        assert_eq!(dirty_bytes_excluding_large(&entries, 8 * 1024 * 1024), 150);
        // threshold 0 disables the exclusion (everything counts again).
        assert_eq!(dirty_bytes_excluding_large(&entries, 0), big + 150);
    }

    #[test]
    fn budget_flags_over_and_near() {
        let b = Budget {
            max_dirty_bytes: 1000,
        };
        assert!(!b.over(500));
        assert!(b.over(1001));
        assert!(!b.near(800));
        assert!(b.near(900)); // 90%
        assert_eq!(b.headroom(600), 400);
        assert_eq!(b.headroom(2000), 0);
    }

    #[test]
    fn scan_lag_grows_until_a_drained_sweep() {
        let mut l = ScanLag::default();
        l.advance(true); // drained
        assert_eq!(l.lag(), 0);
        l.advance(false);
        l.advance(false);
        assert_eq!(l.lag(), 2);
        l.advance(true);
        assert_eq!(l.lag(), 0);
    }
}
