//! Torn-read guard (§8B #3 / Track C4 commitment #2).
//!
//! A state-scan of the upper has no `FAN_CLOSE_WRITE`-style signal, so a file
//! being written while the scanner reads it can be captured half-written. Real
//! backup tools (rsync/restic) gate this with "stat → read → stat; if it changed,
//! re-read". This module is the platform-neutral state machine: it takes a `stat`
//! and a `read` closure so it can be unit-tested with no filesystem, and the node
//! wires the real statx/pread closures (plus a `/proc/<pid>/fd` open-for-write
//! pre-check) on Linux.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FileIdentity {
    pub size: u64,
    pub mtime_ns: i128,
    pub ino: u64,
}

#[derive(Debug)]
pub enum TornReadError {
    /// The file changed under us on every attempt — skip it this sweep; the next
    /// interval scan (a complete state-diff) will pick up the settled bytes.
    ChangedTooManyTimes,
    Io(String),
}

/// Read bytes, retrying while the file's identity changes mid-read. Returns the
/// bytes only when a `stat`-before and `stat`-after match (no change during the
/// read). `max_retries` extra attempts after the first (so total attempts =
/// max_retries + 1).
pub fn read_stable<S, R>(max_retries: u32, stat: S, read: R) -> Result<Vec<u8>, TornReadError>
where
    S: Fn() -> Result<FileIdentity, TornReadError>,
    R: Fn() -> Result<Vec<u8>, TornReadError>,
{
    for _ in 0..=max_retries {
        let before = stat()?;
        let bytes = read()?;
        let after = stat()?;
        if before == after {
            return Ok(bytes);
        }
    }
    Err(TornReadError::ChangedTooManyTimes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::Cell;

    fn id(size: u64) -> FileIdentity {
        FileIdentity {
            size,
            mtime_ns: size as i128,
            ino: 7,
        }
    }

    #[test]
    fn stable_file_reads_first_try() {
        let bytes = read_stable(2, || Ok(id(10)), || Ok(vec![1, 2, 3])).unwrap();
        assert_eq!(bytes, vec![1, 2, 3]);
    }

    #[test]
    fn changing_file_retries_then_settles() {
        // mutate on the first attempt (after-stat differs), settle on the second.
        let phase = Cell::new(0u32);
        let stat = || {
            // first attempt: before=10, after=20 (changed). second: before=20, after=20.
            let p = phase.get();
            Ok(if p == 0 { id(10) } else { id(20) })
        };
        let read = || {
            phase.set(phase.get() + 1); // the write that happened "during" the read
            Ok(vec![0u8; 4])
        };
        // attempt 1: before=10 (phase0), read bumps phase->1, after=20 → mismatch.
        // attempt 2: before=20 (phase1), read bumps phase->2, after=20 → match.
        let out = read_stable(3, stat, read).unwrap();
        assert_eq!(out.len(), 4);
    }

    #[test]
    fn never_settling_file_errors() {
        let n = Cell::new(0u64);
        let stat = || {
            n.set(n.get() + 1);
            Ok(id(n.get())) // identity changes on every single stat
        };
        let read = || Ok(vec![]);
        assert!(matches!(
            read_stable(2, stat, read),
            Err(TornReadError::ChangedTooManyTimes)
        ));
    }
}
