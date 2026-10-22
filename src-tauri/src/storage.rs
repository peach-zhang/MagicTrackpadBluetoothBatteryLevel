use crate::{
    alerts::AlertState,
    model::{ChartReading, DashboardStats, HistoryView, Reading, Settings},
};
use chrono::{DateTime, Local, NaiveDate, TimeZone};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension};
use std::{
    cell::RefCell,
    collections::VecDeque,
    io::Write,
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};

pub struct Storage {
    connection: Connection,
    warnings: RefCell<Vec<String>>,
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
        Ok(Self {
            connection,
            warnings: RefCell::new(Vec::new()),
        })
    }

    fn load<T>(
        &self,
        key: &str,
        validate: impl FnOnce(&T) -> Result<(), String>,
    ) -> Result<T, String>
    where
        T: serde::de::DeserializeOwned + serde::Serialize + Default,
    {
        // Read and recover in one transaction so the backup is exactly the value replaced.
        // Only JSON/validation failures are recoverable; database errors still reach the caller.
        let transaction = self
            .connection
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        let original: Option<String> = transaction
            .query_row("SELECT value FROM preferences WHERE key=?1", [key], |r| {
                r.get(0)
            })
            .optional()
            .map_err(|e| e.to_string())?;
        let Some(original) = original else {
            transaction.commit().map_err(|e| e.to_string())?;
            return Ok(T::default());
        };
        let decoded = serde_json::from_str::<T>(&original)
            .map_err(|e| e.to_string())
            .and_then(|value| validate(&value).map(|()| value));
        match decoded {
            Ok(value) => {
                transaction.commit().map_err(|e| e.to_string())?;
                Ok(value)
            }
            Err(reason) => {
                static RECOVERY_SEQUENCE: AtomicU64 = AtomicU64::new(0);
                let backup_key = loop {
                    let backup_key = format!(
                        "recovered:{key}:{}:{}:{}",
                        crate::model::now_ms(),
                        std::process::id(),
                        RECOVERY_SEQUENCE.fetch_add(1, Ordering::Relaxed)
                    );
                    let inserted = transaction
                        .execute(
                            "INSERT INTO preferences(key,value) VALUES(?1,?2) ON CONFLICT(key) DO NOTHING",
                            params![backup_key, original],
                        )
                        .map_err(|e| format!("备份损坏配置失败：{e}"))?;
                    if inserted == 1 {
                        break backup_key;
                    }
                };
                let defaults = T::default();
                let json = serde_json::to_string(&defaults).map_err(|e| e.to_string())?;
                transaction
                    .execute(
                        "UPDATE preferences SET value=?2 WHERE key=?1",
                        params![key, json],
                    )
                    .map_err(|e| format!("恢复默认配置失败：{e}"))?;
                transaction.commit().map_err(|e| e.to_string())?;
                self.warnings.borrow_mut().push(format!(
                    "本地配置 {key} 已损坏（{reason}），已恢复默认值；原始值备份于 {backup_key}。"
                ));
                Ok(defaults)
            }
        }
    }

    pub fn take_warnings(&mut self) -> Vec<String> {
        std::mem::take(self.warnings.get_mut())
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
        self.load("settings", Settings::validate)
    }
    pub fn save_settings(&self, settings: &Settings) -> Result<(), String> {
        self.save("settings", settings)
    }
    pub fn alert(&self) -> Result<AlertState, String> {
        self.load("alert", |_| Ok(()))
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
            .prepare(history_sql(since))
            .map_err(|e| e.to_string())?;
        let mut rows = match since {
            Some(since) => statement.query([since]),
            None => statement.query([]),
        }
        .map_err(|e| e.to_string())?;
        let mut readings = Vec::new();
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            readings.push(reading_from_row(row).map_err(|e| e.to_string())?);
        }
        Ok(readings)
    }

    pub fn history_count(&self) -> Result<u64, String> {
        self.connection
            .query_row("SELECT COUNT(*) FROM readings", [], |row| {
                row.get::<_, i64>(0)
            })
            .map(|count| count as u64)
            .map_err(|e| e.to_string())
    }

    pub fn history_view(
        &self,
        since: Option<i64>,
        poll_seconds: u64,
    ) -> Result<HistoryView, String> {
        // Keep aggregate bounds and streamed rows on the same database snapshot.
        let transaction = self
            .connection
            .unchecked_transaction()
            .map_err(|e| e.to_string())?;
        let bounds_sql = if since.is_some() {
            "SELECT COUNT(*),MIN(timestamp),MAX(timestamp) FROM readings WHERE timestamp >= ?1"
        } else {
            "SELECT COUNT(*),MIN(timestamp),MAX(timestamp) FROM readings"
        };
        let bounds =
            |row: &rusqlite::Row<'_>| -> rusqlite::Result<(i64, Option<i64>, Option<i64>)> {
                Ok((row.get(0)?, row.get(1)?, row.get(2)?))
            };
        let (total, minimum, maximum) = match since {
            Some(since) => transaction.query_row(bounds_sql, [since], bounds),
            None => transaction.query_row(bounds_sql, [], bounds),
        }
        .map_err(|e| e.to_string())?;
        let mut points = Vec::with_capacity(3600);
        let mut records = VecDeque::with_capacity(100);
        if let (Some(minimum), Some(maximum)) = (minimum, maximum) {
            let span = i128::from(maximum) - i128::from(minimum) + 1;
            let gap_limit = i128::from(poll_seconds) * 4000;
            let mut statement = transaction
                .prepare(history_sql(since))
                .map_err(|e| e.to_string())?;
            let mut rows = match since {
                Some(since) => statement.query([since]),
                None => statement.query([]),
            }
            .map_err(|e| e.to_string())?;
            let mut previous: Option<(i64, String)> = None;
            let mut segment = 0;
            let mut selected_segment = None;
            let mut active_bucket = None;
            let mut bucket = HistoryBucket::default();
            let mut order = 0;
            while let Some(row) = rows.next().map_err(|e| e.to_string())? {
                let reading = reading_from_row(row).map_err(|e| e.to_string())?;
                if let Some((timestamp, device_id)) = &previous {
                    if device_id != &reading.device_id
                        || i128::from(reading.timestamp) - i128::from(*timestamp) > gap_limit
                    {
                        segment += 1;
                    }
                }
                previous = Some((reading.timestamp, reading.device_id.clone()));
                let index =
                    ((i128::from(reading.timestamp) - i128::from(minimum)) * 900 / span) as u16;
                if active_bucket.is_some_and(|active| active != index) {
                    bucket.emit(&mut points, &mut selected_segment);
                }
                active_bucket = Some(index);
                if records.len() == 100 {
                    records.pop_front();
                }
                records.push_back(reading.clone());
                bucket.observe(HistorySample {
                    reading,
                    order,
                    segment,
                });
                order += 1;
            }
            bucket.emit(&mut points, &mut selected_segment);
        }
        transaction.commit().map_err(|e| e.to_string())?;
        Ok(HistoryView {
            points,
            records: records.into_iter().collect(),
            total: total as u64,
        })
    }

    pub fn export_reader(&self) -> Result<Storage, String> {
        let path = self
            .connection
            .path()
            .filter(|path| !path.is_empty() && *path != ":memory:")
            .ok_or("内存数据库无法打开独立导出连接")?;
        let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
            .map_err(|e| format!("无法打开历史数据库读取连接：{e}"))?;
        connection
            .busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        Ok(Self {
            connection,
            warnings: RefCell::new(Vec::new()),
        })
    }

    pub fn export_csv(&self, mut writer: impl Write) -> Result<(), String> {
        writer
            .write_all(CSV_HEADER.as_bytes())
            .map_err(|e| format!("写入导出文件失败：{e}"))?;
        let mut statement = self
            .connection
            .prepare(history_sql(None))
            .map_err(|e| e.to_string())?;
        let mut rows = statement.query([]).map_err(|e| e.to_string())?;
        while let Some(row) = rows.next().map_err(|e| e.to_string())? {
            let reading = reading_from_row(row).map_err(|e| e.to_string())?;
            write_csv_reading(&mut writer, &reading)
                .map_err(|e| format!("写入导出文件失败：{e}"))?;
        }
        writer.flush().map_err(|e| format!("写入导出文件失败：{e}"))
    }
}

fn history_sql(since: Option<i64>) -> &'static str {
    if since.is_some() {
        "SELECT timestamp,percent,device_name,device_id,source FROM readings
         WHERE timestamp >= ?1 ORDER BY timestamp ASC,id ASC"
    } else {
        "SELECT timestamp,percent,device_name,device_id,source FROM readings
         ORDER BY timestamp ASC,id ASC"
    }
}

fn reading_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Reading> {
    Ok(Reading {
        timestamp: row.get(0)?,
        percent: row.get(1)?,
        device_name: row.get(2)?,
        device_id: row.get(3)?,
        source: row.get(4)?,
    })
}

#[derive(Clone)]
struct HistorySample {
    reading: Reading,
    order: u64,
    segment: u64,
}

#[derive(Default)]
struct HistoryBucket {
    first: Option<HistorySample>,
    minimum: Option<HistorySample>,
    maximum: Option<HistorySample>,
    last: Option<HistorySample>,
}

impl HistoryBucket {
    fn observe(&mut self, sample: HistorySample) {
        if self.first.is_none() {
            self.first = Some(sample.clone());
        }
        if self
            .minimum
            .as_ref()
            .is_none_or(|minimum| sample.reading.percent < minimum.reading.percent)
        {
            self.minimum = Some(sample.clone());
        }
        if self
            .maximum
            .as_ref()
            .is_none_or(|maximum| sample.reading.percent > maximum.reading.percent)
        {
            self.maximum = Some(sample.clone());
        }
        self.last = Some(sample);
    }

    fn emit(&mut self, points: &mut Vec<ChartReading>, previous_segment: &mut Option<u64>) {
        let mut selected: Vec<_> = [
            self.first.take(),
            self.minimum.take(),
            self.maximum.take(),
            self.last.take(),
        ]
        .into_iter()
        .flatten()
        .collect();
        selected.sort_unstable_by_key(|sample| sample.order);
        selected.dedup_by_key(|sample| sample.order);
        for sample in selected {
            points.push(ChartReading {
                reading: sample.reading,
                break_before: previous_segment.is_some_and(|previous| previous != sample.segment),
            });
            *previous_segment = Some(sample.segment);
        }
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

const CSV_HEADER: &str = "\u{feff}timestamp_ms,percent,device_name,device_id,source\r\n";

fn write_csv_reading(writer: &mut impl Write, reading: &Reading) -> std::io::Result<()> {
    write!(writer, "{},{},", reading.timestamp, reading.percent)?;
    for (index, value) in [&reading.device_name, &reading.device_id, &reading.source]
        .into_iter()
        .enumerate()
    {
        if index > 0 {
            writer.write_all(b",")?;
        }
        writer.write_all(b"\"")?;
        if value.starts_with(['=', '+', '-', '@', '\t', '\r']) {
            writer.write_all(b"'")?;
        }
        for (index, part) in value.split('"').enumerate() {
            if index > 0 {
                writer.write_all(b"\"\"")?;
            }
            writer.write_all(part.as_bytes())?;
        }
        writer.write_all(b"\"")?;
    }
    writer.write_all(b"\r\n")
}

#[cfg(test)]
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

    fn preference(db: &Storage, key: &str) -> String {
        db.connection
            .query_row("SELECT value FROM preferences WHERE key=?1", [key], |row| {
                row.get(0)
            })
            .unwrap()
    }

    fn backups(db: &Storage, key: &str) -> Vec<(String, String)> {
        let mut statement = db
            .connection
            .prepare("SELECT key,value FROM preferences WHERE key LIKE ?1 ORDER BY key")
            .unwrap();
        statement
            .query_map([format!("recovered:{key}:%")], |row| {
                Ok((row.get(0)?, row.get(1)?))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap()
    }

    #[test]
    fn corrupt_preferences_recover_defaults_and_preserve_exact_unique_backups() {
        let mut db = Storage::open(Path::new(":memory:")).unwrap();
        let malformed = " \n{invalid settings 原始值\t";
        let invalid = serde_json::to_string(&Settings {
            threshold: 0,
            ..Settings::default()
        })
        .unwrap();
        for original in [malformed, invalid.as_str()] {
            db.connection
                .execute(
                    "INSERT OR REPLACE INTO preferences VALUES('settings',?1)",
                    [original],
                )
                .unwrap();
            assert_eq!(db.settings().unwrap(), Settings::default());
            assert_eq!(
                serde_json::from_str::<Settings>(&preference(&db, "settings")).unwrap(),
                Settings::default()
            );
        }
        let recovered = backups(&db, "settings");
        assert_eq!(recovered.len(), 2);
        assert_ne!(recovered[0].0, recovered[1].0);
        assert!(recovered.iter().any(|(_, value)| value == malformed));
        assert!(recovered.iter().any(|(_, value)| value == &invalid));

        let alert = " {\"last_notified_ms\":\"wrong type\"}\n";
        db.connection
            .execute("INSERT INTO preferences VALUES('alert',?1)", [alert])
            .unwrap();
        assert_eq!(db.alert().unwrap(), AlertState::default());
        assert_eq!(backups(&db, "alert")[0].1, alert);
        assert_eq!(
            serde_json::from_str::<AlertState>(&preference(&db, "alert")).unwrap(),
            AlertState::default()
        );
        assert_eq!(db.take_warnings().len(), 3);
        assert!(db.take_warnings().is_empty());
        db.settings().unwrap();
        db.alert().unwrap();
        assert!(db.take_warnings().is_empty());
    }

    #[test]
    fn healthy_preferences_remain_byte_for_byte_unchanged() {
        let mut db = Storage::open(Path::new(":memory:")).unwrap();
        let settings = " \n{\"threshold\":15, \"poll_seconds\":60}\t";
        let alert = " {\"last_notified_ms\":42,\"in_low_episode\":true,\"device_id\":\"pad\"} ";
        db.connection
            .execute("INSERT INTO preferences VALUES('settings',?1)", [settings])
            .unwrap();
        db.connection
            .execute("INSERT INTO preferences VALUES('alert',?1)", [alert])
            .unwrap();
        assert_eq!(db.settings().unwrap().threshold, 15);
        assert_eq!(db.alert().unwrap().last_notified_ms, Some(42));
        assert_eq!(preference(&db, "settings"), settings);
        assert_eq!(preference(&db, "alert"), alert);
        assert!(backups(&db, "settings").is_empty());
        assert!(backups(&db, "alert").is_empty());
        assert!(db.take_warnings().is_empty());
    }

    #[test]
    fn recovery_does_not_hide_sqlite_errors_and_rolls_back_backup_on_write_failure() {
        let mut db = Storage::open(Path::new(":memory:")).unwrap();
        db.connection
            .execute("INSERT INTO preferences VALUES('settings','broken')", [])
            .unwrap();
        db.connection.execute_batch("CREATE TRIGGER reject_recovery BEFORE UPDATE ON preferences BEGIN SELECT RAISE(ABORT,'write rejected'); END;").unwrap();
        assert!(db.settings().unwrap_err().contains("write rejected"));
        assert_eq!(preference(&db, "settings"), "broken");
        assert!(backups(&db, "settings").is_empty());
        assert!(db.take_warnings().is_empty());
        db.connection
            .execute_batch("DROP TABLE preferences;")
            .unwrap();
        assert!(db.settings().unwrap_err().contains("no such table"));
        assert!(db.alert().unwrap_err().contains("no such table"));
        assert!(db.take_warnings().is_empty());
    }

    #[test]
    fn history_view_is_bounded_and_preserves_bucket_extrema_endpoints_and_last_records() {
        let db = Storage::open(Path::new(":memory:")).unwrap();
        let transaction = db.connection.unchecked_transaction().unwrap();
        let mut expected_records = Vec::new();
        for index in 0..18_000 {
            let percent = match index % 20 {
                3 => 0,
                12 => 100,
                _ => 50,
            };
            let sample = reading(index, percent);
            db.insert(&sample).unwrap();
            if index >= 17_900 {
                expected_records.push(sample);
            }
        }
        transaction.commit().unwrap();
        let view = db.history_view(None, 10).unwrap();
        assert_eq!(view.total, 18_000);
        assert_eq!(db.history_count().unwrap(), 18_000);
        assert_eq!(view.points.len(), 3600);
        assert_eq!(view.records, expected_records);
        for (bucket, selected) in view.points.chunks_exact(4).enumerate() {
            let start = bucket as i64 * 20;
            assert_eq!(
                selected
                    .iter()
                    .map(|point| point.reading.timestamp)
                    .collect::<Vec<_>>(),
                [start, start + 3, start + 12, start + 19]
            );
            assert_eq!(selected[1].reading.percent, 0);
            assert_eq!(selected[2].reading.percent, 100);
        }
        assert_eq!(view.points.first().unwrap().reading.timestamp, 0);
        assert_eq!(view.points.last().unwrap().reading.timestamp, 17_999);
        assert!(view.points.iter().all(|point| !point.break_before));
    }

    #[test]
    fn downsampling_breaks_at_hidden_device_switches_and_time_gaps() {
        let db = Storage::open(Path::new(":memory:")).unwrap();
        // The first bucket contains an unselected switch away and back, then a hidden gap.
        // A far-away endpoint makes all these rows share the same time bucket.
        for (timestamp, percent, device) in [
            (0, 50, "pad"),
            (1, 50, "other"),
            (2, 50, "pad"),
            (3, 0, "pad"),
            (4, 50, "pad"),
            (5000, 50, "pad"),
            (5001, 100, "pad"),
            (5002, 50, "pad"),
            (9_000_000, 50, "pad"),
        ] {
            let mut sample = reading(timestamp, percent);
            sample.device_id = device.into();
            db.insert(&sample).unwrap();
        }
        let view = db.history_view(None, 1).unwrap();
        assert_eq!(
            view.points
                .iter()
                .map(|point| (point.reading.timestamp, point.break_before))
                .collect::<Vec<_>>(),
            [
                (0, false),
                (3, true),
                (5001, true),
                (5002, false),
                (9_000_000, true)
            ]
        );
    }

    #[test]
    fn history_view_handles_empty_filters_equal_timestamps_and_large_poll_intervals() {
        let db = Storage::open(Path::new(":memory:")).unwrap();
        let empty = db.history_view(None, 10).unwrap();
        assert_eq!(empty.total, 0);
        assert!(empty.points.is_empty() && empty.records.is_empty());
        assert_eq!(db.history_count().unwrap(), 0);
        for (timestamp, percent) in [(i64::MIN, 50), (100, 50), (100, 0), (100, 100), (100, 60)] {
            db.insert(&reading(timestamp, percent)).unwrap();
        }
        let excluded = db.history_view(Some(101), 10).unwrap();
        assert_eq!(excluded.total, 0);
        assert!(excluded.points.is_empty() && excluded.records.is_empty());
        db.insert(&reading(i64::MAX, 70)).unwrap();
        let filtered = db.history_view(Some(100), u64::MAX).unwrap();
        assert_eq!(filtered.total, 5);
        assert_eq!(filtered.records, db.history(Some(100)).unwrap());
        assert_eq!(
            filtered
                .points
                .iter()
                .map(|point| point.reading.percent)
                .collect::<Vec<_>>(),
            [50, 0, 100, 60, 70]
        );
        assert!(filtered.points.iter().all(|point| !point.break_before));
        assert_eq!(db.history_view(Some(101), 1).unwrap().total, 1);
        let equal = db.history_view(Some(i64::MAX), 1).unwrap();
        assert_eq!(equal.points.len(), 1);
        assert_eq!(equal.records.len(), 1);
        assert_eq!(db.history_view(None, u64::MAX).unwrap().total, 6);
    }

    #[test]
    fn streaming_csv_matches_legacy_bytes_with_escaping_and_propagates_writer_errors() {
        let db = Storage::open(Path::new(":memory:")).unwrap();
        let mut empty = Vec::new();
        db.export_csv(&mut empty).unwrap();
        assert_eq!(empty, csv(&[]).as_bytes());
        for (index, prefix) in ["=", "+", "-", "@", "\t", "\r", "", "普通"]
            .into_iter()
            .enumerate()
        {
            let mut sample = reading(100 - index as i64, index as u8);
            sample.device_name = format!("{prefix}device,\"name\"\r\nnext");
            sample.device_id = format!("{prefix}id");
            sample.source = format!("{prefix}source");
            db.insert(&sample).unwrap();
        }
        let mut bytes = Vec::new();
        db.export_csv(&mut bytes).unwrap();
        assert_eq!(bytes, csv(&db.history(None).unwrap()).as_bytes());
        struct FailingWriter;
        impl Write for FailingWriter {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::Error::other("disk full"))
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        assert!(db
            .export_csv(FailingWriter)
            .unwrap_err()
            .contains("disk full"));
    }

    #[test]
    fn export_reader_reopens_disk_database_read_only_and_independent_of_runtime_storage() {
        static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "trackpad-export-{}-{}-{}.sqlite",
            std::process::id(),
            crate::model::now_ms(),
            TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let db = Storage::open(&path).unwrap();
        db.insert(&reading(100, 20)).unwrap();
        let reader = db.export_reader().unwrap();
        assert!(reader.insert(&reading(200, 30)).is_err());
        drop(db);
        let mut output = Vec::new();
        reader.export_csv(&mut output).unwrap();
        assert_eq!(output, csv(&[reading(100, 20)]).as_bytes());
        drop(reader);
        std::fs::remove_file(path).unwrap();
        assert!(Storage::open(Path::new(":memory:"))
            .unwrap()
            .export_reader()
            .is_err());
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
