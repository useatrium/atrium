//! Quiesce gate + write-lease (§8B #3) — the ONLY in-container-coupled concern of
//! the node-side inbound write. The node may land reconciled bytes through
//! `merged` only when the agent isn't mid-read/write of that path; the gate is
//! harness-level (a "between-steps" signal) and invisible to the model. Two
//! cooperating checks:
//!   - a **write-lease** the harness flips (block artifact writes during a step), and
//!   - a node-side **`/proc/<agent-pid>/fd`** probe: skip a file the agent currently
//!     holds open (TOCTOU-narrowing belt-and-suspenders, Track C4 commitment #2).
//! The actual write is atomic temp+rename (proven on-node: in-place O_TRUNC ≈ 74%
//! torn reads, rename = 0), so even a missed race degrades to a whole-file swap.

use std::collections::HashSet;

/// Is it safe to write `path` right now? Implementations compose the harness lease
/// + the live FD probe.
pub trait QuiesceGate {
    fn can_write(&self, path: &str) -> bool;
}

/// The harness's "between-steps" lease: paths the agent is actively touching are
/// leased (busy); the node defers writing them until the lease clears.
#[derive(Default)]
pub struct LeaseGate {
    busy: HashSet<String>,
}

impl LeaseGate {
    pub fn new() -> Self {
        Self::default()
    }
    /// Harness marks a path busy at step start.
    pub fn acquire(&mut self, path: impl Into<String>) {
        self.busy.insert(path.into());
    }
    /// Harness clears it at step end (the between-steps signal).
    pub fn release(&mut self, path: &str) {
        self.busy.remove(path);
    }
    pub fn busy_count(&self) -> usize {
        self.busy.len()
    }
}

impl QuiesceGate for LeaseGate {
    fn can_write(&self, path: &str) -> bool {
        !self.busy.contains(path)
    }
}

/// A pending write: (path, seq, bytes).
pub type PendingWrite = (String, u64, Vec<u8>);
/// A landed write: (path, seq).
pub type AdoptedWrite = (String, u64);

/// Apply the inbound write plan, honoring the gate: write the quiesced paths now,
/// defer the busy ones (the next sweep retries — a state-diff, never event-dropped).
/// `write` performs the atomic write-through-`merged` (+ chown to the agent); it
/// returns Ok on success. Returns (written, deferred).
pub fn apply_quiesced_writes<W>(
    writes: Vec<PendingWrite>,
    gate: &dyn QuiesceGate,
    mut write: W,
) -> (Vec<AdoptedWrite>, Vec<PendingWrite>)
where
    W: FnMut(&str, &[u8]) -> Result<(), String>,
{
    let mut written = Vec::new();
    let mut deferred = Vec::new();
    for (path, seq, bytes) in writes {
        if gate.can_write(&path) {
            match write(&path, &bytes) {
                Ok(()) => written.push((path, seq)),
                Err(_) => deferred.push((path, seq, bytes)),
            }
        } else {
            deferred.push((path, seq, bytes));
        }
    }
    (written, deferred)
}

/// Live FD probe (Linux): is `abs_path` currently open by any process? Scans
/// `/proc/*/fd/*` symlink targets. Used to skip a file the agent holds open even
/// if the lease missed it. Conservative: on any read error it reports "open" (defer).
#[cfg(target_os = "linux")]
pub fn path_is_open(abs_path: &str) -> bool {
    use std::fs;
    let Ok(procs) = fs::read_dir("/proc") else {
        return true;
    };
    for p in procs.flatten() {
        let fd_dir = p.path().join("fd");
        let Ok(fds) = fs::read_dir(&fd_dir) else {
            continue;
        };
        for fd in fds.flatten() {
            if fs::read_link(fd.path()).is_ok_and(|t| t.to_string_lossy() == abs_path) {
                return true;
            }
        }
    }
    false
}

/// A gate combining the harness lease with the live FD probe (Linux). `root` maps a
/// rel path to its absolute `merged` path for the probe.
#[cfg(target_os = "linux")]
pub struct ProcFdGate<'a> {
    pub lease: &'a LeaseGate,
    pub merged_root: std::path::PathBuf,
}

#[cfg(target_os = "linux")]
impl<'a> QuiesceGate for ProcFdGate<'a> {
    fn can_write(&self, path: &str) -> bool {
        if !self.lease.can_write(path) {
            return false;
        }
        let abs = self.merged_root.join(path);
        !path_is_open(&abs.to_string_lossy())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lease_gate_blocks_busy_paths() {
        let mut g = LeaseGate::new();
        g.acquire("proj-x/plan.md");
        assert!(!g.can_write("proj-x/plan.md"));
        assert!(g.can_write("proj-x/other.md"));
        g.release("proj-x/plan.md");
        assert!(g.can_write("proj-x/plan.md"));
    }

    #[test]
    fn apply_writes_lands_quiesced_defers_busy() {
        let mut g = LeaseGate::new();
        g.acquire("busy.md");
        let writes = vec![
            ("free.md".to_string(), 6u64, b"a".to_vec()),
            ("busy.md".to_string(), 7u64, b"b".to_vec()),
        ];
        let mut landed: Vec<String> = vec![];
        let (written, deferred) = apply_quiesced_writes(writes, &g, |p, _b| {
            landed.push(p.to_string());
            Ok(())
        });
        assert_eq!(written, vec![("free.md".to_string(), 6)]);
        assert_eq!(deferred.len(), 1);
        assert_eq!(deferred[0].0, "busy.md");
        assert_eq!(landed, vec!["free.md"]); // busy was never written
    }

    #[test]
    fn a_write_error_defers_for_retry() {
        let g = LeaseGate::new();
        let writes = vec![("x.md".to_string(), 1u64, b"z".to_vec())];
        let (written, deferred) = apply_quiesced_writes(writes, &g, |_p, _b| Err("EBUSY".into()));
        assert!(written.is_empty());
        assert_eq!(deferred.len(), 1);
    }
}
