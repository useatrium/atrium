//! Inbound adopt decision (the node-side merge, §4 / Track C6).
//!
//! For each remote advance on a hydrated path the node decides — from the
//! per-path state — WHICH adopt action to take. The actual 3-way merge is NOT
//! re-implemented here: when the agent has locally edited, the node delegates to
//! Atrium's already-built, already-tested write-back (diff3 + jj-style
//! conflict-state), then applies the reconciled bytes. So this module is a pure,
//! exhaustively-testable decision function; the I/O (fetch/write-through-merged/
//! HTTP) is the runtime around it.

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalState {
    /// The version this container hydrated / last cleanly adopted.
    pub base_seq: u64,
    /// sha of the base bytes (the lower's content for this path).
    pub base_sha: Option<String>,
    /// sha of the agent's current working copy (None = unedited = resolves to base).
    pub upper_sha: Option<String>,
    /// The last remote seq the node itself wrote through `merged` (echo gate, §8B #2).
    pub applied_remote_seq: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RemoteStatus {
    Normal,
    Conflict,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteChange {
    pub seq: u64,
    pub sha: Option<String>, // None = a delete tombstone
    pub status: RemoteStatus,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdoptAction {
    /// Nothing to do (already current / the node's own echo / converged bytes).
    Skip(SkipReason),
    /// Agent hasn't touched the path locally → write `theirs` through `merged` at a
    /// quiesce point, then advance base_seq + record applied_remote_seq.
    AdoptRemote { seq: u64, sha: Option<String> },
    /// Agent edited locally AND remote advanced → write-back `ours` against
    /// `base_seq` to Atrium; its diff3 yields a clean merge or a conflict version.
    /// The node then adopts the resulting latest-normal bytes.
    ReconcileViaWriteback { base_seq: u64 },
    /// The remote latest is itself an unresolved conflict version → surface it to
    /// the human (and as an agent steer); never auto-apply marker bytes.
    SurfaceConflict { seq: u64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkipReason {
    /// remote.seq <= base_seq — we already have this (or newer).
    AlreadyCurrent,
    /// remote.seq == applied_remote_seq — this advance is our own write-through.
    Echo,
    /// the agent's working copy already equals theirs — nothing to apply.
    Converged,
}

/// Decide the adopt action for one path. Pure + total.
pub fn decide_adopt(local: &LocalState, remote: &RemoteChange) -> AdoptAction {
    // Our own write-through coming back around — suppress (kills the echo loop and
    // the stale-base false conflict it would otherwise cause).
    if Some(remote.seq) == local.applied_remote_seq {
        return AdoptAction::Skip(SkipReason::Echo);
    }
    // Already have it (or something newer): nothing to do.
    if remote.seq <= local.base_seq {
        return AdoptAction::Skip(SkipReason::AlreadyCurrent);
    }
    // The remote latest is an unresolved conflict — surface, don't auto-apply.
    if remote.status == RemoteStatus::Conflict {
        return AdoptAction::SurfaceConflict { seq: remote.seq };
    }

    let edited = match &local.upper_sha {
        None => false,
        Some(u) => Some(u) != local.base_sha.as_ref(),
    };

    if !edited {
        // unedited locally → straight adopt of theirs (case 1 / resurrect of case 3).
        return AdoptAction::AdoptRemote { seq: remote.seq, sha: remote.sha.clone() };
    }

    // edited locally: if our bytes already match theirs, we converged independently.
    if local.upper_sha.is_some() && local.upper_sha == remote.sha {
        return AdoptAction::Skip(SkipReason::Converged);
    }
    // otherwise reconcile through Atrium's write-back (diff3 / conflict-state).
    AdoptAction::ReconcileViaWriteback { base_seq: local.base_seq }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local(base_seq: u64, base_sha: &str, upper: Option<&str>, applied: Option<u64>) -> LocalState {
        LocalState {
            base_seq,
            base_sha: Some(base_sha.to_string()),
            upper_sha: upper.map(|s| s.to_string()),
            applied_remote_seq: applied,
        }
    }
    fn remote(seq: u64, sha: Option<&str>, status: RemoteStatus) -> RemoteChange {
        RemoteChange { seq, sha: sha.map(|s| s.to_string()), status }
    }

    #[test]
    fn unedited_adopts_remote() {
        let l = local(5, "base5", None, None);
        let r = remote(6, Some("v6"), RemoteStatus::Normal);
        assert_eq!(decide_adopt(&l, &r), AdoptAction::AdoptRemote { seq: 6, sha: Some("v6".into()) });
    }

    #[test]
    fn own_echo_is_suppressed() {
        let l = local(5, "base5", None, Some(6));
        let r = remote(6, Some("v6"), RemoteStatus::Normal);
        assert_eq!(decide_adopt(&l, &r), AdoptAction::Skip(SkipReason::Echo));
    }

    #[test]
    fn already_current_is_skipped() {
        let l = local(6, "base6", None, None);
        let r = remote(6, Some("v6"), RemoteStatus::Normal);
        assert_eq!(decide_adopt(&l, &r), AdoptAction::Skip(SkipReason::AlreadyCurrent));
    }

    #[test]
    fn locally_edited_reconciles_via_writeback() {
        let l = local(5, "base5", Some("myedit"), None);
        let r = remote(6, Some("v6"), RemoteStatus::Normal);
        assert_eq!(decide_adopt(&l, &r), AdoptAction::ReconcileViaWriteback { base_seq: 5 });
    }

    #[test]
    fn independently_converged_is_skipped() {
        let l = local(5, "base5", Some("same"), None);
        let r = remote(6, Some("same"), RemoteStatus::Normal);
        assert_eq!(decide_adopt(&l, &r), AdoptAction::Skip(SkipReason::Converged));
    }

    #[test]
    fn remote_conflict_is_surfaced_not_applied() {
        let l = local(5, "base5", Some("myedit"), None);
        let r = remote(7, Some("markers"), RemoteStatus::Conflict);
        assert_eq!(decide_adopt(&l, &r), AdoptAction::SurfaceConflict { seq: 7 });
    }

    #[test]
    fn unedited_resurrect_after_local_delete_adopts_remote() {
        // agent deleted locally (upper_sha None == base means unedited here); remote
        // re-created → adopt. (The delete-vs-edit conflict is recorded Atrium-side
        // when the local DELETE was captured against a stale base.)
        let l = local(3, "base3", None, None);
        let r = remote(4, Some("resurrected"), RemoteStatus::Normal);
        assert_eq!(decide_adopt(&l, &r), AdoptAction::AdoptRemote { seq: 4, sha: Some("resurrected".into()) });
    }
}
