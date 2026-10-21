use crate::{
    alerts::AlertState,
    model::{DashboardStats, Reading, Settings},
};
use chrono::{DateTime, Local, NaiveDate, TimeZone};
use rusqlite::{params, Connection};
use std::path::Path;

pub struct Storage {
    connection: Connection,
}

impl Storage {
    pub fn open(path: &Path) -> Result<Self, String> {
        let connection = Connection::open(path).map_err(|e| format!("无法打开本地数据库：{e}"))?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL;
             PRAGMA synchronous=NORMAL;
             CREATE TABLE IF NOT EXISTS readings (
                 id INTEGER PRIMARY KEY, timestamp INTEGER NOT NULL,
                 percent INTEGER NOT NULL CHECK(percent BETWEEN 0 AND 100),
                 device_name TEXT NOT NULL, device_id TEXT NOT NULL, source TEXT NOT NULL
             );
             CREATE INDEX IF NOT EXISTS readings_time ON readings(timestamp);
             CREATE INDEX IF NOT EXISTS readings_device_time ON readings(device_id,timestamp);
             CREATE TABLE IF NOT EXISTS preferences (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             PRAGMA user_version=1;",
            )
            .map_err(|e| format!("无法初始化数据库：{e}"))?;
        Ok(Self { connection })
    }

    fn load<T: serde::de::DeserializeOwned + Default>(&self, key: &str) -> Result<T, String> {
        use rusqlite::OptionalExtension;
        let value: Option<String> = self
            .connection
            .query_row("SELECT value FROM preferences WHERE key=?1", [key], |r| {
                r.get(0)
            })
            .optional()
            .map_err(|e| e.to_string())?;
        match value {
            Some(value) => {
                serde_json::from_str(&value).map_err(|e| format!("本地配置 {key} 无法读取：{e}"))
            }
            None => Ok(T::default()),
        }
    }

    fn save<T: serde::Serialize>(&self, key: &str, value: &T) -> Result<(), String> {
        let json = serde_json::to_string(value).map_err(|e| e.to_string())?;
        self.connection.execute(
            "INSERT INTO preferences(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, json]
        ).map_err(|e| format!("保存配置失败：{e}"))?;
        Ok(())
    }

    pub fn settings(&self) -> Result<Settings, String> {
        let settings: Settings = self.load("settings")?;
        settings.validate()?;
        Ok(settings)
    }
    pub fn save_settings(&self, settings: &Settings) -> Result<(), String> {
        self.save("settings", settings)
    }
    pub fn alert(&self) -> Result<AlertState, String> {
        self.load("alert")
    }
    pub fn save_alert(&self, state: &AlertState) -> Result<(), String> {
        self.save("alert", state)
    }

    pub fn insert(&self, reading: &Reading) -> Result<(), String> {
        self.connection.execute(
            "INSERT INTO readings(timestamp,percent,device_name,device_id,source) VALUES(?1,?2,?3,?4,?5)",
            params![reading.timestamp, reading.percent, reading.device_name, reading.device_id, reading.source]
        ).map_err(|e| format!("保存电量记录失败：{e}"))?;
        Ok(())
    }

    pub fn stats(&self, device_id: Option<&str>, now: i64) -> Result<DashboardStats, String> {
        let today = DateTime::from_timestamp_millis(now)
            .ok_or("统计时间超出有效范围")?
            .with_timezone(&Local)
            .date_naive();
        let yesterday = today.pred_opt().ok_or("无法确定昨日日期")?;
        self.stats_for_days(
            device_id,
            local_day_start(&Local, yesterday)?,
            local_day_start(&Local, today)?,
            now,
        )
    }

    fn stats_for_days(
        &self,
        device_id: Option<&str>,
        yesterday_start: i64,
        today_start: i64,
        now: i64,
    ) -> Result<DashboardStats, String> {
        // MIN uses the device/time index without loading the full history.
        let first_recorded_at = match device_id {
            Some(device_id) => self.connection.query_row(
                "SELECT MIN(timestamp) FROM readings WHERE device_id = ?1",
                [device_id],
                |row| row.get(0),
            ),
            None => self
                .connection
                .query_row("SELECT MIN(timestamp) FROM readings", [], |row| row.get(0)),
        }
        .map_err(|e| e.to_string())?;
        let sql = if device_id.is_some() {
            "SELECT timestamp,percent,device_id FROM readings
             WHERE timestamp >= ?1 AND timestamp <= ?2 AND device_id = ?3
             ORDER BY timestamp ASC,id ASC"
        } else {
            "SELECT timestamp,percent,device_id FROM readings
             WHERE timestamp >= ?1 AND timestamp <= ?2
             ORDER BY timestamp ASC,id ASC"
        };
        let mut statement = self.connection.prepare(sql).map_err(|e| e.to_string())?;
        let mut rows = match device_id {
            Some(device_id) => statement.query(params![yesterday_start, now, device_id]),
            None => statement.query(params![yesterday_start, now]),
        }
        .map_err(|e| e.to_string())?;
        let mut today = DailyConsumption::default();
        let mut yesterday = DailyConsumption::default();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let timestamp: i64 = row.get(0).map_err(|e| e.to_string())?;
            let percent: u8 = row.get(1).map_err(|e| e.to_string())?;
            let device_id: String = row.get(2).map_err(|e| e.to_string())?;
            let day = if timestamp >= today_start {
                &mut today
            } else {
                &mut yesterday
            };
            day.observe(percent, device_id);
        }
        Ok(DashboardStats {
            first_recorded_at,
            today_consumption: today.total(),
            yesterday_consumption: yesterday.total(),
        })
    }

    pub fn history(&self, since: Option<i64>) -> Result<Vec<Reading>, String> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT timestamp,percent,device_name,device_id,source FROM readings
             WHERE (?1 IS NULL OR timestamp >= ?1) ORDER BY timestamp ASC,id ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map([since], |row| {
                Ok(Reading {
                    timestamp: row.get(0)?,
                    percent: row.get(1)?,
                    device_name: row.get(2)?,
                    device_id: row.get(3)?,
                    source: row.get(4)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())
    }
}

// Resolve each calendar day independently: a local day may have 23 or 25 hours.
// Some time zones move their clocks at midnight; use the first valid instant.
fn local_day_start<T: TimeZone>(timezone: &T, date: NaiveDate) -> Result<i64, String> {
    let midnight = date.and_hms_opt(0, 0, 0).ok_or("无法确定本地日期边界")?;
    for second in 0..86_400 {
        let local = midnight + chrono::Duration::seconds(second);
        if let Some(start) = timezone.from_local_datetime(&local).earliest() {
            return Ok(start.timestamp_millis());
        }
    }
    Err("无法确定本地日期边界".into())
}

#[derive(Default)]
struct DailyConsumption {
    previous: Option<(u8, String)>,
    consumption: u32,
    has_pair: bool,
}

impl DailyConsumption {
    fn observe(&mut self, percent: u8, device_id: String) {
        if let Some((previous, previous_device)) = &self.previous {
            if previous_device == &device_id {
                self.has_pair = true;
                self.consumption = self
                    .consumption
                    .saturating_add(previous.saturating_sub(percent) as u32);
            }
        }
        self.previous = Some((percent, device_id));
    }

    fn total(&self) -> Option<u32> {
        self.has_pair.then_some(self.consumption)
    }
}

pub fn csv(readings: &[Reading]) -> String {
    fn quote(value: &str) -> String {
        // Guard spreadsheet formula interpretation for device-provided strings.
        let safe = if value.starts_with(['=', '+', '-', '@', '\t', '\r']) {
            format!("'{value}")
        } else {
            value.to_owned()
        };
        format!("\"{}\"", safe.replace('"', "\"\""))
    }
    let mut output = String::from("\u{feff}timestamp_ms,percent,device_name,device_id,source\r\n");
    for r in readings {
        output.push_str(&format!(
            "{},{},{},{},{}\r\n",
            r.timestamp,
            r.percent,
            quote(&r.device_name),
            quote(&r.device_id),
            quote(&r.source)
        ));
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reading(timestamp: i64, percent: u8) -> Reading {
        Reading {
            timestamp,
            percent,
            device_name: "妙控板,\"Alice\"".into(),
            device_id: "pad".into(),
            source: "HID".into(),
        }
    }

    #[test]
    fn stores_zero_and_returns_chronological_filtered_history() {
        let db = Storage::open(Path::new(":memory:")).unwrap();
        db.insert(&reading(300, 30)).unwrap();
        db.insert(&reading(100, 0)).unwrap();
        db.insert(&reading(200, 20)).unwrap();
        assert_eq!(
            db.history(None)
                .unwrap()
                .iter()
                .map(|r| (r.timestamp, r.percent))
                .collect::<Vec<_>>(),
            [(100, 0), (200, 20), (300, 30)]
        );
        assert_eq!(db.history(Some(200)).unwrap().len(), 2);
        let settings = Settings {
            threshold: 15,
            ..Settings::default()
        };
        db.save_settings(&settings).unwrap();
        assert_eq!(db.settings().unwrap(), settings);
    }

    #[test]
    fn daily_stats_require_a_pair_and_do_not_cross_midnight() {
        let db = Storage::open(Path::new(":memory:")).unwrap();
        let empty = db.stats_for_days(Some("pad"), 100, 200, 300).unwrap();
        assert_eq!(empty.first_recorded_at, None);
        assert_eq!(empty.today_consumption, None);
        assert_eq!(empty.yesterday_consumption, None);

        for (timestamp, percent) in [(99, 95), (100, 90), (199, 85), (200, 80)] {
            db.insert(&reading(timestamp, percent)).unwrap();
        }
        let stats = db.stats_for_days(Some("pad"), 100, 200, 300).unwrap();
        assert_eq!(stats.first_recorded_at, Some(99));
        assert_eq!(stats.yesterday_consumption, Some(5));
        assert_eq!(stats.today_consumption, None);
        db.insert(&reading(300, 78)).unwrap();
        db.insert(&reading(301, 20)).unwrap();
        let stats = db.stats_for_days(Some("pad"), 100, 200, 300).unwrap();
        assert_eq!(stats.today_consumption, Some(2));
    }

    #[test]
    fn daily_consumption_sums_decreases_without_subtracting_charging() {
        let db = Storage::open(Path::new(":memory:")).unwrap();
        for (timestamp, percent) in [(200, 80), (210, 75), (220, 90), (230, 88)] {
            db.insert(&reading(timestamp, percent)).unwrap();
        }
        let stats = db.stats_for_days(Some("pad"), 100, 200, 300).unwrap();
        assert_eq!(stats.today_consumption, Some(7));
        assert_eq!(stats.yesterday_consumption, None);
    }

    #[test]
    fn daily_stats_filter_active_device_and_never_compare_device_switches() {
        let db = Storage::open(Path::new(":memory:")).unwrap();
        for (timestamp, percent, device_id) in [
            (50, 99, "other"),
            (200, 80, "pad"),
            (210, 40, "other"),
            (220, 75, "pad"),
            (230, 74, "pad"),
        ] {
            let mut sample = reading(timestamp, percent);
            sample.device_id = device_id.into();
            db.insert(&sample).unwrap();
        }
        let active = db.stats_for_days(Some("pad"), 100, 200, 300).unwrap();
        assert_eq!(active.first_recorded_at, Some(200));
        assert_eq!(active.today_consumption, Some(6));
        let unknown = db.stats_for_days(None, 100, 200, 300).unwrap();
        assert_eq!(unknown.first_recorded_at, Some(50));
        assert_eq!(unknown.today_consumption, Some(1));
        let other = db.stats_for_days(Some("other"), 100, 200, 300).unwrap();
        assert_eq!(other.today_consumption, None);
        let missing = db.stats_for_days(Some("missing"), 100, 200, 300).unwrap();
        assert_eq!(missing.first_recorded_at, None);
    }

    #[test]
    fn local_calendar_boundaries_use_timezone_and_variable_day_lengths() {
        let timezone = chrono::FixedOffset::east_opt(8 * 60 * 60).unwrap();
        let date = NaiveDate::from_ymd_opt(2026, 10, 21).unwrap();
        let midnight = local_day_start(&timezone, date).unwrap();
        assert_eq!(
            midnight,
            chrono::Utc
                .with_ymd_and_hms(2026, 10, 20, 16, 0, 0)
                .unwrap()
                .timestamp_millis()
        );

        // Calendar boundaries supplied by the timezone may be 23 or 25 hours apart.
        for day_hours in [23, 25] {
            let db = Storage::open(Path::new(":memory:")).unwrap();
            let yesterday_start = midnight - day_hours * 3_600_000;
            for (timestamp, percent) in [
                (yesterday_start - 1, 99),
                (yesterday_start, 80),
                (midnight - 1, 75),
                (midnight, 70),
                (midnight + 1, 68),
            ] {
                db.insert(&reading(timestamp, percent)).unwrap();
            }
            let stats = db
                .stats_for_days(Some("pad"), yesterday_start, midnight, midnight + 1)
                .unwrap();
            assert_eq!(stats.yesterday_consumption, Some(5));
            assert_eq!(stats.today_consumption, Some(2));
        }
    }

    #[test]
    fn daily_stats_report_zero_for_unchanged_or_only_charging_readings() {
        let db = Storage::open(Path::new(":memory:")).unwrap();
        for (timestamp, percent) in [(200, 80), (210, 80), (220, 90)] {
            db.insert(&reading(timestamp, percent)).unwrap();
        }
        assert_eq!(
            db.stats_for_days(Some("pad"), 100, 200, 300)
                .unwrap()
                .today_consumption,
            Some(0)
        );
    }

    #[test]
    fn csv_handles_device_strings_and_formula_injection() {
        let mut sample = reading(100, 0);
        sample.device_id = "=malicious".into();
        let output = csv(&[sample]);
        assert!(output.contains("100,0,\"妙控板,\"\"Alice\"\"\""));
        assert!(output.contains("\"'=malicious\""));
        assert!(output.starts_with('\u{feff}'));
    }
}
