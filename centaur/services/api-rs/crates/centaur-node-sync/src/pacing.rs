use std::time::{Duration, Instant};

pub const MIN_TICK_SPACING: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TickPacerAction {
    WaitMore(Duration),
    TickNow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TickPacerDecision {
    pub action: TickPacerAction,
    pub stream_disconnected: bool,
}

#[derive(Debug, Clone)]
pub struct TickPacer {
    min_tick_spacing: Duration,
    dirty_pending: bool,
}

impl Default for TickPacer {
    fn default() -> Self {
        Self::new(MIN_TICK_SPACING)
    }
}

impl TickPacer {
    pub fn new(min_tick_spacing: Duration) -> Self {
        Self {
            min_tick_spacing,
            dirty_pending: false,
        }
    }

    pub fn next(
        &self,
        now: Instant,
        last_tick_start: Instant,
        deadline: Instant,
    ) -> TickPacerDecision {
        TickPacerDecision {
            action: self.next_action(now, last_tick_start, deadline),
            stream_disconnected: false,
        }
    }

    pub fn observe_message(
        &mut self,
        now: Instant,
        last_tick_start: Instant,
        deadline: Instant,
        made_dirty: bool,
    ) -> TickPacerDecision {
        self.dirty_pending |= made_dirty;
        self.next(now, last_tick_start, deadline)
    }

    pub fn observe_timeout(
        &self,
        now: Instant,
        last_tick_start: Instant,
        deadline: Instant,
    ) -> TickPacerDecision {
        self.next(now, last_tick_start, deadline)
    }

    pub fn observe_disconnected(&self, now: Instant, deadline: Instant) -> TickPacerDecision {
        TickPacerDecision {
            action: wait_until(now, deadline),
            stream_disconnected: true,
        }
    }

    fn next_action(
        &self,
        now: Instant,
        last_tick_start: Instant,
        deadline: Instant,
    ) -> TickPacerAction {
        if now >= deadline {
            return TickPacerAction::TickNow;
        }

        if self.dirty_pending {
            let floor = last_tick_start + self.min_tick_spacing;
            if now >= floor {
                return TickPacerAction::TickNow;
            }
            return wait_until(now, floor.min(deadline));
        }

        wait_until(now, deadline)
    }
}

fn wait_until(now: Instant, until: Instant) -> TickPacerAction {
    if now >= until {
        TickPacerAction::TickNow
    } else {
        TickPacerAction::WaitMore(until.duration_since(now))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dirty_message_ticks_only_after_spacing_floor() {
        let last_tick = Instant::now();
        let deadline = last_tick + Duration::from_secs(2);
        let mut pacer = TickPacer::default();

        assert_eq!(
            pacer.observe_message(
                last_tick + Duration::from_millis(50),
                last_tick,
                deadline,
                true,
            ),
            TickPacerDecision {
                action: TickPacerAction::WaitMore(Duration::from_millis(200)),
                stream_disconnected: false,
            }
        );
        assert_eq!(
            pacer.observe_timeout(last_tick + MIN_TICK_SPACING, last_tick, deadline),
            TickPacerDecision {
                action: TickPacerAction::TickNow,
                stream_disconnected: false,
            }
        );
    }

    #[test]
    fn timeout_ticks_at_deadline() {
        let last_tick = Instant::now();
        let deadline = last_tick + Duration::from_secs(2);
        let pacer = TickPacer::default();

        assert_eq!(
            pacer.observe_timeout(deadline, last_tick, deadline),
            TickPacerDecision {
                action: TickPacerAction::TickNow,
                stream_disconnected: false,
            }
        );
    }

    #[test]
    fn clean_message_keeps_waiting() {
        let last_tick = Instant::now();
        let deadline = last_tick + Duration::from_secs(2);
        let mut pacer = TickPacer::default();

        assert_eq!(
            pacer.observe_message(
                last_tick + Duration::from_millis(50),
                last_tick,
                deadline,
                false,
            ),
            TickPacerDecision {
                action: TickPacerAction::WaitMore(Duration::from_millis(1950)),
                stream_disconnected: false,
            }
        );
    }

    #[test]
    fn disconnected_degrades_and_waits_for_deadline() {
        let last_tick = Instant::now();
        let deadline = last_tick + Duration::from_secs(2);
        let pacer = TickPacer::default();

        assert_eq!(
            pacer.observe_disconnected(last_tick + Duration::from_millis(50), deadline),
            TickPacerDecision {
                action: TickPacerAction::WaitMore(Duration::from_millis(1950)),
                stream_disconnected: true,
            }
        );
    }
}
