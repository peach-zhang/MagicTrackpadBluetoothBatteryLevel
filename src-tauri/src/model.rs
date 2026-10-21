use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Reading {
    pub timestamp: i64,
    pub percent: u8,
    pub device_name: String,
    pub device_id: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct Settings {
    pub threshold: u8,
    pub poll_seconds: u64,
    pub notifications_enabled: bool,
    pub autostart: bool,
    pub start_minimized: bool,
    pub close_to_tray: bool,
    pub reminder_minutes: u64,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            threshold: 20,
            poll_seconds: 300,
            notifications_enabled: true,
            autostart: false,
            start_minimized: false,
            close_to_tray: true,
            reminder_minutes: 60,
        }
    }
}

impl Settings {
    pub fn validate(&self) -> Result<(), String> {
        if !(1..=100).contains(&self.threshold) {
            return Err("提醒阈值必须为 1–100%".into());
        }
        if !(10..=86_400).contains(&self.poll_seconds) {
            return Err("检查间隔必须为 10–86400 秒".into());
        }
        if !(1..=10_080).contains(&self.reminder_minutes) {
            return Err("提醒冷却时间必须为 1–10080 分钟".into());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct DashboardStats {
    pub first_recorded_at: Option<i64>,
    pub today_consumption: Option<u32>,
    pub yesterday_consumption: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
pub struct Dashboard {
    pub current: Option<Reading>,
    pub samples: Vec<Reading>,
    pub stats: DashboardStats,
    pub settings: Settings,
    pub last_error: Option<String>,
    pub monitoring: bool,
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or(0)
}
