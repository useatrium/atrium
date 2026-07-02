use std::path::Path;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const NOT_FOUND_STREAK_THRESHOLD: u32 = 30;
pub const DEFAULT_EVICT_GRACE_SECS: u64 = 3600;
pub const DEFAULT_EVICT_RECHECK_SECS: u64 = 300;

#[derive(Debug, Clone, Default)]
pub struct SessionEvictionState {
    pub not_found_streak: u32,
    evicted_since: Option<Instant>,
    evicted_manifest_mtime_nanos: Option<u128>,
    last_probe: Option<Instant>,
}

impl SessionEvictionState {
    pub fn is_evicted(&self) -> bool {
        self.evicted_since.is_some()
    }

    pub fn evicted_since(&self) -> Option<Instant> {
        self.evicted_since
    }

    pub fn evicted_manifest_mtime_nanos(&self) -> Option<u128> {
        self.evicted_manifest_mtime_nanos
    }

    pub fn observe_manifest_mtime(&mut self, mtime_nanos: Option<u128>) -> bool {
        if self.is_evicted()
            && mtime_nanos.is_some()
            && mtime_nanos != self.evicted_manifest_mtime_nanos
        {
            self.reset();
            return true;
        }
        false
    }

    pub fn record_found(&mut self) -> bool {
        let was_evicted = self.is_evicted();
        self.reset();
        was_evicted
    }

    pub fn record_not_found(&mut self) {
        self.not_found_streak = self.not_found_streak.saturating_add(1);
    }

    pub fn maybe_evict(
        &mut self,
        now: Instant,
        manifest_age: Option<Duration>,
        manifest_mtime_nanos: Option<u128>,
        has_active_mount: bool,
        grace: Duration,
    ) -> bool {
        if self.is_evicted()
            || self.not_found_streak < NOT_FOUND_STREAK_THRESHOLD
            || has_active_mount
            || manifest_age.is_none_or(|age| age < grace)
        {
            return false;
        }
        self.evicted_since = Some(now);
        self.evicted_manifest_mtime_nanos = manifest_mtime_nanos;
        self.last_probe = Some(now);
        true
    }

    pub fn should_probe(&self, now: Instant, recheck: Duration) -> bool {
        self.is_evicted()
            && self
                .last_probe
                .is_none_or(|last_probe| now.duration_since(last_probe) >= recheck)
    }

    pub fn mark_probe(&mut self, now: Instant) {
        self.last_probe = Some(now);
    }

    pub fn gc_eligible(
        &self,
        now: Instant,
        manifest_mtime_nanos: Option<u128>,
        has_active_mount: bool,
        grace: Duration,
    ) -> bool {
        !has_active_mount
            && self.evicted_since.is_some_and(|evicted_since| {
                now.duration_since(evicted_since) > grace
                    && manifest_mtime_nanos == self.evicted_manifest_mtime_nanos
            })
    }

    fn reset(&mut self) {
        self.not_found_streak = 0;
        self.evicted_since = None;
        self.evicted_manifest_mtime_nanos = None;
        self.last_probe = None;
    }
}

pub fn manifest_mtime_nanos(path: &Path) -> Option<u128> {
    std::fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(system_time_nanos)
}

pub fn manifest_age(now: SystemTime, mtime_nanos: Option<u128>) -> Option<Duration> {
    let now_nanos = system_time_nanos(now)?;
    let mtime_nanos = mtime_nanos?;
    (now_nanos >= mtime_nanos)
        .then(|| Duration::from_nanos((now_nanos - mtime_nanos).min(u64::MAX as u128) as u64))
}

fn system_time_nanos(time: SystemTime) -> Option<u128> {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .map(|duration| duration.as_nanos())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eviction_requires_streak_grace_and_no_mount() {
        let now = Instant::now();
        let grace = Duration::from_secs(60);
        let mut state = SessionEvictionState::default();
        for _ in 0..NOT_FOUND_STREAK_THRESHOLD {
            state.record_not_found();
        }

        assert!(!state.maybe_evict(now, Some(Duration::from_secs(59)), Some(10), false, grace));
        assert!(!state.maybe_evict(now, Some(Duration::from_secs(60)), Some(10), true, grace));
        assert!(state.maybe_evict(now, Some(Duration::from_secs(60)), Some(10), false, grace));
        assert!(state.is_evicted());
    }

    #[test]
    fn manifest_mtime_change_un_evicts_and_resets_streak() {
        let now = Instant::now();
        let mut state = SessionEvictionState::default();
        for _ in 0..NOT_FOUND_STREAK_THRESHOLD {
            state.record_not_found();
        }
        assert!(state.maybe_evict(
            now,
            Some(Duration::from_secs(60)),
            Some(10),
            false,
            Duration::from_secs(60),
        ));

        assert!(!state.observe_manifest_mtime(Some(10)));
        assert!(state.is_evicted());
        assert!(state.observe_manifest_mtime(Some(11)));
        assert!(!state.is_evicted());
        assert_eq!(state.not_found_streak, 0);
    }

    #[test]
    fn recheck_cadence_is_sparse_until_due() {
        let now = Instant::now();
        let mut state = SessionEvictionState::default();
        for _ in 0..NOT_FOUND_STREAK_THRESHOLD {
            state.record_not_found();
        }
        assert!(state.maybe_evict(
            now,
            Some(Duration::from_secs(60)),
            Some(10),
            false,
            Duration::from_secs(60),
        ));

        assert!(!state.should_probe(now + Duration::from_secs(299), Duration::from_secs(300)));
        assert!(state.should_probe(now + Duration::from_secs(300), Duration::from_secs(300)));
        state.mark_probe(now + Duration::from_secs(300));
        assert!(!state.should_probe(now + Duration::from_secs(599), Duration::from_secs(300)));
    }

    #[test]
    fn gc_requires_evicted_for_grace_no_mount_and_unchanged_manifest() {
        let now = Instant::now();
        let mut state = SessionEvictionState::default();
        for _ in 0..NOT_FOUND_STREAK_THRESHOLD {
            state.record_not_found();
        }
        assert!(state.maybe_evict(
            now,
            Some(Duration::from_secs(60)),
            Some(10),
            false,
            Duration::from_secs(60),
        ));

        assert!(!state.gc_eligible(
            now + Duration::from_secs(60),
            Some(10),
            false,
            Duration::from_secs(60),
        ));
        assert!(!state.gc_eligible(
            now + Duration::from_secs(61),
            Some(11),
            false,
            Duration::from_secs(60),
        ));
        assert!(!state.gc_eligible(
            now + Duration::from_secs(61),
            Some(10),
            true,
            Duration::from_secs(60),
        ));
        assert!(state.gc_eligible(
            now + Duration::from_secs(61),
            Some(10),
            false,
            Duration::from_secs(60),
        ));
    }
}
