use crate::model::Settings;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct AlertState {
    pub last_notified_ms: Option<i64>,
    pub in_low_episode: bool,
    pub device_id: Option<String>,
}

impl AlertState {
    /// Rearm only after a 3-point recovery; an ongoing low episode gets reminders
    /// no more often than the persisted cooldown, even after restarting the app.
    pub fn observe(&mut self, percent: u8, device_id: &str, now: i64, settings: &Settings) -> bool {
        if self.device_id.as_deref() != Some(device_id) {
            *self = Self {
                device_id: Some(device_id.to_owned()),
                ..Self::default()
            };
        }
        if percent >= settings.threshold.saturating_add(3).min(100) {
            self.in_low_episode = false;
        }
        if percent >= settings.threshold || !settings.notifications_enabled {
            return false;
        }
        let cooldown = (settings.reminder_minutes * 60_000) as i64;
        let elapsed = self.last_notified_ms.map(|last| now.saturating_sub(last));
        // A clock moving backwards must not suppress alerts indefinitely.
        let ready = elapsed.is_none_or(|elapsed| elapsed >= cooldown || elapsed < 0);
        if ready {
            self.in_low_episode = true;
        }
        ready
    }

    pub fn delivered(&mut self, now: i64) {
        self.last_notified_ms = Some(now);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strict_threshold_zero_and_restart_cooldown() {
        let settings = Settings::default();
        let mut state = AlertState::default();
        assert!(!state.observe(20, "pad", 1_000, &settings));
        assert!(state.observe(0, "pad", 1_000, &settings));
        state.delivered(1_000);
        let mut restored: AlertState =
            serde_json::from_str(&serde_json::to_string(&state).unwrap()).unwrap();
        assert!(!restored.observe(1, "pad", 3_600_999, &settings));
        assert!(restored.observe(19, "pad", 3_601_000, &settings));
    }

    #[test]
    fn recovery_hysteresis_and_disabled_notifications() {
        let mut state = AlertState::default();
        let mut settings = Settings::default();
        assert!(state.observe(19, "pad", 0, &settings));
        state.delivered(0);
        assert!(!state.observe(21, "pad", 1, &settings));
        assert!(state.in_low_episode);
        assert!(!state.observe(23, "pad", 2, &settings));
        assert!(!state.in_low_episode);
        assert!(!state.observe(19, "pad", 3, &settings));
        settings.notifications_enabled = false;
        assert!(!state.observe(0, "pad", 9_000_000, &settings));
    }
}
