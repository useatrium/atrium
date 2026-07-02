use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

pub const DEFAULT_EVICT_GRACE_SECS: u64 = 3600;
pub const DEFAULT_EVICT_RECHECK_SECS: u64 = 300;
pub const DEFAULT_EVICT_HEARTBEAT_STALE_SECS: u64 = 900;
pub const DEFAULT_EVICT_NO_HEARTBEAT_GRACE_SECS: u64 = 86_400;
pub const HEARTBEAT_FILE: &str = ".heartbeat";

#[derive(Debug, Clone, Copy, Eq, PartialEq)]
pub enum EvictionReason {
    HeartbeatStale,
    HeartbeatMissing,
}

impl EvictionReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::HeartbeatStale => "heartbeat_stale",
            Self::HeartbeatMissing => "heartbeat_missing",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct EvictionSignals {
    pub now: Instant,
    pub heartbeat_age: Option<Duration>,
    pub heartbeat_mtime_nanos: Option<u128>,
    pub manifest_age: Option<Duration>,
    pub manifest_mtime_nanos: Option<u128>,
}

#[derive(Debug, Clone, Copy)]
pub struct EvictionThresholds {
    pub heartbeat_stale: Duration,
    pub no_heartbeat_grace: Duration,
}

#[derive(Debug, Clone, Default)]
pub struct SessionEvictionState {
    evicted_since: Option<Instant>,
    evicted_manifest_mtime_nanos: Option<u128>,
    evicted_heartbeat_mtime_nanos: Option<u128>,
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

    pub fn evicted_heartbeat_mtime_nanos(&self) -> Option<u128> {
        self.evicted_heartbeat_mtime_nanos
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

    pub fn observe_heartbeat_mtime(&mut self, mtime_nanos: Option<u128>) -> bool {
        if self.is_evicted()
            && mtime_nanos.is_some()
            && mtime_nanos != self.evicted_heartbeat_mtime_nanos
        {
            self.reset();
            return true;
        }
        false
    }

    pub fn record_found(&mut self) -> bool {
        false
    }

    pub fn record_not_found(&mut self) {}

    pub fn maybe_evict(
        &mut self,
        signals: EvictionSignals,
        thresholds: EvictionThresholds,
    ) -> Option<EvictionReason> {
        if self.is_evicted() {
            return None;
        }
        let reason = match (signals.heartbeat_mtime_nanos, signals.heartbeat_age) {
            (Some(_), Some(age)) if age > thresholds.heartbeat_stale => {
                EvictionReason::HeartbeatStale
            }
            (Some(_), _) => return None,
            (None, _)
                if signals
                    .manifest_age
                    .is_some_and(|age| age > thresholds.no_heartbeat_grace) =>
            {
                EvictionReason::HeartbeatMissing
            }
            (None, _) => return None,
        };
        self.evicted_since = Some(signals.now);
        self.evicted_manifest_mtime_nanos = signals.manifest_mtime_nanos;
        self.evicted_heartbeat_mtime_nanos = signals.heartbeat_mtime_nanos;
        self.last_probe = Some(signals.now);
        Some(reason)
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
        heartbeat_mtime_nanos: Option<u128>,
        grace: Duration,
    ) -> bool {
        self.evicted_since.is_some_and(|evicted_since| {
            now.duration_since(evicted_since) > grace
                && manifest_mtime_nanos == self.evicted_manifest_mtime_nanos
                && heartbeat_mtime_nanos == self.evicted_heartbeat_mtime_nanos
        })
    }

    fn reset(&mut self) {
        self.evicted_since = None;
        self.evicted_manifest_mtime_nanos = None;
        self.evicted_heartbeat_mtime_nanos = None;
        self.last_probe = None;
    }
}

pub fn manifest_mtime_nanos(path: &Path) -> Option<u128> {
    mtime_nanos(path)
}

pub fn heartbeat_path(upper: &Path) -> PathBuf {
    upper.join(HEARTBEAT_FILE)
}

pub fn heartbeat_mtime_nanos(upper: &Path) -> Option<u128> {
    mtime_nanos(&heartbeat_path(upper))
}

fn mtime_nanos(path: &Path) -> Option<u128> {
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

    fn signals(
        now: Instant,
        heartbeat_age: Option<u64>,
        heartbeat_mtime_nanos: Option<u128>,
        manifest_age: Option<u64>,
        manifest_mtime_nanos: Option<u128>,
    ) -> EvictionSignals {
        EvictionSignals {
            now,
            heartbeat_age: heartbeat_age.map(Duration::from_secs),
            heartbeat_mtime_nanos,
            manifest_age: manifest_age.map(Duration::from_secs),
            manifest_mtime_nanos,
        }
    }

    fn thresholds() -> EvictionThresholds {
        EvictionThresholds {
            heartbeat_stale: Duration::from_secs(900),
            no_heartbeat_grace: Duration::from_secs(86_400),
        }
    }

    #[test]
    fn stale_heartbeat_evicts() {
        let now = Instant::now();
        let mut state = SessionEvictionState::default();

        assert_eq!(
            state.maybe_evict(
                signals(now, Some(901), Some(20), Some(10), Some(10)),
                thresholds()
            ),
            Some(EvictionReason::HeartbeatStale)
        );
        assert!(state.is_evicted());
        assert_eq!(state.evicted_manifest_mtime_nanos(), Some(10));
        assert_eq!(state.evicted_heartbeat_mtime_nanos(), Some(20));
    }

    #[test]
    fn fresh_heartbeat_never_evicts_even_after_not_found_and_old_manifest() {
        let now = Instant::now();
        let mut state = SessionEvictionState::default();
        state.record_not_found();

        assert_eq!(
            state.maybe_evict(
                signals(now, Some(60), Some(20), Some(100_000), Some(10)),
                thresholds()
            ),
            None
        );
        assert!(!state.is_evicted());
    }

    #[test]
    fn missing_heartbeat_uses_manifest_age_fallback() {
        let now = Instant::now();
        let mut state = SessionEvictionState::default();

        assert_eq!(
            state.maybe_evict(
                signals(now, None, None, Some(86_400), Some(10)),
                thresholds()
            ),
            None
        );
        assert_eq!(
            state.maybe_evict(
                signals(now, None, None, Some(86_401), Some(10)),
                thresholds()
            ),
            Some(EvictionReason::HeartbeatMissing)
        );
        assert!(state.is_evicted());
    }

    #[test]
    fn manifest_mtime_change_un_evicts() {
        let now = Instant::now();
        let mut state = SessionEvictionState::default();
        assert_eq!(
            state.maybe_evict(
                signals(now, Some(901), Some(20), Some(60), Some(10)),
                thresholds()
            ),
            Some(EvictionReason::HeartbeatStale)
        );

        assert!(!state.observe_manifest_mtime(Some(10)));
        assert!(state.is_evicted());
        assert!(state.observe_manifest_mtime(Some(11)));
        assert!(!state.is_evicted());
    }

    #[test]
    fn heartbeat_touch_un_evicts() {
        let now = Instant::now();
        let mut state = SessionEvictionState::default();
        assert_eq!(
            state.maybe_evict(
                signals(now, Some(901), Some(20), Some(60), Some(10)),
                thresholds()
            ),
            Some(EvictionReason::HeartbeatStale)
        );

        assert!(!state.observe_heartbeat_mtime(Some(20)));
        assert!(state.is_evicted());
        assert!(state.observe_heartbeat_mtime(Some(21)));
        assert!(!state.is_evicted());
    }

    #[test]
    fn found_true_does_not_reset_eviction() {
        let now = Instant::now();
        let mut state = SessionEvictionState::default();
        assert_eq!(
            state.maybe_evict(
                signals(now, Some(901), Some(20), Some(60), Some(10)),
                thresholds()
            ),
            Some(EvictionReason::HeartbeatStale)
        );

        assert!(!state.record_found());
        assert!(state.is_evicted());
    }

    #[test]
    fn recheck_cadence_is_sparse_until_due() {
        let now = Instant::now();
        let mut state = SessionEvictionState::default();
        assert_eq!(
            state.maybe_evict(
                signals(now, Some(901), Some(20), Some(60), Some(10)),
                thresholds()
            ),
            Some(EvictionReason::HeartbeatStale)
        );

        assert!(!state.should_probe(now + Duration::from_secs(299), Duration::from_secs(300)));
        assert!(state.should_probe(now + Duration::from_secs(300), Duration::from_secs(300)));
        state.mark_probe(now + Duration::from_secs(300));
        assert!(!state.should_probe(now + Duration::from_secs(599), Duration::from_secs(300)));
    }

    #[test]
    fn gc_requires_evicted_for_grace_and_unchanged_manifest_and_heartbeat() {
        let now = Instant::now();
        let mut state = SessionEvictionState::default();
        assert_eq!(
            state.maybe_evict(
                signals(now, Some(901), Some(20), Some(60), Some(10)),
                thresholds()
            ),
            Some(EvictionReason::HeartbeatStale)
        );

        assert!(!state.gc_eligible(
            now + Duration::from_secs(60),
            Some(10),
            Some(20),
            Duration::from_secs(60),
        ));
        assert!(!state.gc_eligible(
            now + Duration::from_secs(61),
            Some(11),
            Some(20),
            Duration::from_secs(60),
        ));
        assert!(!state.gc_eligible(
            now + Duration::from_secs(61),
            Some(10),
            Some(21),
            Duration::from_secs(60),
        ));
        assert!(state.gc_eligible(
            now + Duration::from_secs(61),
            Some(10),
            Some(20),
            Duration::from_secs(60),
        ));
    }
}
