mod alerts;
mod autostart;
pub mod hid;
mod model;
mod storage;

use alerts::AlertState;
use model::{now_ms, Dashboard, Settings};
use std::sync::{Mutex, MutexGuard};
use storage::Storage;
use tauri::menu::{CheckMenuItem, Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};
use tauri_plugin_notification::NotificationExt;

struct Runtime {
    db: Storage,
    settings: Settings,
    alert: AlertState,
    current: Option<model::Reading>,
    last_error: Option<String>,
    tray_available: bool,
}

#[derive(Clone)]
struct TrayMenu {
    autostart: CheckMenuItem<tauri::Wry>,
    status: MenuItem<tauri::Wry>,
}

struct AppState {
    inner: Mutex<Runtime>,
    sampling: tokio::sync::Mutex<()>,
    wake: tokio::sync::Notify,
    tray_menu: Mutex<Option<TrayMenu>>,
}

impl AppState {
    fn lock(&self) -> Result<MutexGuard<'_, Runtime>, String> {
        self.inner
            .lock()
            .map_err(|_| "应用状态锁异常，请重新启动应用。".into())
    }
    fn dashboard(&self) -> Result<Dashboard, String> {
        let state = self.lock()?;
        let now = now_ms();
        Ok(Dashboard {
            current: state.current.clone(),
            samples: state
                .db
                .history(Some(now.saturating_sub(24 * 60 * 60 * 1000)))?,
            stats: state.db.stats(
                state
                    .current
                    .as_ref()
                    .map(|reading| reading.device_id.as_str()),
                now,
            )?,
            settings: state.settings.clone(),
            last_error: state.last_error.clone(),
            monitoring: true,
        })
    }
}

#[tauri::command]
fn get_dashboard(state: tauri::State<'_, AppState>) -> Result<Dashboard, String> {
    state.dashboard()
}

#[tauri::command]
fn get_history(
    hours: Option<f64>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<model::Reading>, String> {
    let since = match hours {
        Some(hours) if !hours.is_finite() || hours <= 0.0 || hours > 876_000.0 => {
            return Err("历史时间范围必须为大于零的有效小时数".into())
        }
        Some(hours) => Some(now_ms().saturating_sub((hours * 3_600_000.0) as i64)),
        None => None,
    };
    state.lock()?.db.history(since)
}

fn persist_settings(app: &tauri::AppHandle, settings: Settings) -> Result<Settings, String> {
    settings.validate()?;
    let state = app.state::<AppState>();
    {
        let mut runtime = state.lock()?;
        let old = runtime.settings.clone();
        // Native registration must succeed before the preference is committed.
        autostart::apply(settings.autostart, settings.start_minimized)?;
        if let Err(error) = runtime.db.save_settings(&settings) {
            let rollback = autostart::apply(old.autostart, old.start_minimized);
            return Err(match rollback {
                Ok(()) => error,
                Err(rollback) => format!("{error}；恢复开机启动设置失败：{rollback}"),
            });
        }
        runtime.settings = settings.clone();
    }
    if let Ok(dashboard) = state.dashboard() {
        update_tray(app, &dashboard);
        let _ = app.emit("battery-updated", dashboard);
    }
    state.wake.notify_one();
    Ok(settings)
}

#[tauri::command]
fn save_settings(settings: Settings, app: tauri::AppHandle) -> Result<Settings, String> {
    persist_settings(&app, settings)
}

#[tauri::command]
async fn refresh_battery(app: tauri::AppHandle) -> Result<Dashboard, String> {
    sample(&app).await
}

#[tauri::command]
async fn export_history(app: tauri::AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let readings = app.state::<AppState>().lock()?.db.history(None)?;
        let destination = rfd::FileDialog::new()
            .set_title("导出妙控板电量历史")
            .add_filter("CSV 表格", &["csv"])
            .set_file_name("magic-trackpad-battery-history.csv")
            .save_file();
        let Some(mut path) = destination else {
            return Ok(None);
        };
        if path.extension().is_none() {
            path.set_extension("csv");
        }
        std::fs::write(&path, storage::csv(&readings))
            .map_err(|e| format!("无法保存 CSV 文件：{e}"))?;
        Ok(Some(path.to_string_lossy().into_owned()))
    })
    .await
    .map_err(|e| format!("导出任务失败：{e}"))?
}

async fn sample(app: &tauri::AppHandle) -> Result<Dashboard, String> {
    let state = app.state::<AppState>();
    // Manual clicks and the monitor share one gate. A busy call returns the
    // latest snapshot instead of creating additional blocked driver operations.
    let Ok(_guard) = state.sampling.try_lock() else {
        return state.dashboard();
    };
    let result = tauri::async_runtime::spawn_blocking(hid::read_isolated)
        .await
        .unwrap_or_else(|error| Err(format!("HID 读取任务失败：{error}")));
    let mut error_event = None;
    {
        let mut runtime = state.lock()?;
        match result {
            Ok(reading) => {
                runtime.last_error = None;
                if let Err(error) = runtime.db.insert(&reading) {
                    runtime.last_error = Some(error);
                }
                let mut alert = runtime.alert.clone();
                if alert.observe(
                    reading.percent,
                    &reading.device_id,
                    reading.timestamp,
                    &runtime.settings,
                ) {
                    match app
                        .notification()
                        .builder()
                        .title("妙控板电量偏低")
                        .body(format!(
                            "{} 当前电量 {}%，低于 {}% 提醒阈值，请及时充电。",
                            reading.device_name, reading.percent, runtime.settings.threshold
                        ))
                        .show()
                    {
                        Ok(()) => alert.delivered(reading.timestamp),
                        Err(error) => {
                            runtime.last_error = Some(format!(
                                "发送 Windows 通知失败，请检查系统通知权限：{error}"
                            ))
                        }
                    }
                }
                if alert != runtime.alert {
                    if let Err(error) = runtime.db.save_alert(&alert) {
                        runtime.last_error = Some(error);
                    }
                    runtime.alert = alert;
                }
                runtime.current = Some(reading);
                if let Some(error) = &runtime.last_error {
                    error_event = Some(error.clone());
                }
            }
            Err(error) => {
                // Keep real historical samples; a disconnected device has no
                // current value, rather than reusing an old percentage as live.
                runtime.current = None;
                runtime.last_error = Some(error.clone());
                error_event = Some(error);
            }
        }
    }
    let dashboard = state.dashboard()?;
    update_tray(app, &dashboard);
    let _ = app.emit("battery-updated", &dashboard);
    if let Some(error) = error_event {
        let _ = app.emit("battery-error", error);
    }
    Ok(dashboard)
}

fn show_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

fn update_tray(app: &tauri::AppHandle, dashboard: &Dashboard) {
    if let Some(tray) = app.tray_by_id("battery") {
        let tooltip = match &dashboard.current {
            Some(reading) => format!(
                "妙控板电量管家 · {} · {}%",
                reading.device_name, reading.percent
            ),
            None => "妙控板电量管家 · 电量未知，请检查蓝牙连接".into(),
        };
        let _ = tray.set_tooltip(Some(tooltip));
    }
    // Menu mutations can dispatch to the UI thread. Release the state mutex
    // first so a simultaneous menu event cannot deadlock that dispatch.
    let menu = app
        .state::<AppState>()
        .tray_menu
        .lock()
        .ok()
        .and_then(|menu| menu.clone());
    if let Some(menu) = menu {
        let _ = menu.autostart.set_checked(dashboard.settings.autostart);
        let label = dashboard
            .current
            .as_ref()
            .map(|r| format!("当前电量：{}%", r.percent))
            .unwrap_or_else(|| "当前电量：未知".into());
        let _ = menu.status.set_text(label);
    }
}

fn setup_tray(
    app: &tauri::AppHandle,
    settings: &Settings,
) -> Result<(), Box<dyn std::error::Error>> {
    let status = MenuItem::with_id(app, "status", "当前电量：正在检查", false, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "打开妙控板电量管家", true, None::<&str>)?;
    let refresh = MenuItem::with_id(app, "refresh", "立即检查电量", true, None::<&str>)?;
    let autostart = CheckMenuItem::with_id(
        app,
        "autostart",
        "开机自动启动",
        true,
        settings.autostart,
        None::<&str>,
    )?;
    let exit = MenuItem::with_id(app, "exit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&status, &open, &refresh, &autostart, &exit])?;
    TrayIconBuilder::with_id("battery")
        .icon(tauri::image::Image::from_bytes(include_bytes!(
            "../../design/trackpad-battery.ico"
        ))?)
        .tooltip("妙控板电量管家 · 正在检查")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            if matches!(
                event,
                TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                }
            ) {
                show_window(tray.app_handle());
            }
        })
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_window(app),
            "refresh" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = sample(&app).await;
                });
            }
            "autostart" => {
                let settings = app.state::<AppState>().lock().map(|s| {
                    let mut settings = s.settings.clone();
                    settings.autostart = !settings.autostart;
                    settings
                });
                match settings.and_then(|settings| persist_settings(app, settings)) {
                    Ok(_) => (),
                    Err(error) => {
                        let _ = app.emit("battery-error", &error);
                        if let Ok(dashboard) = app.state::<AppState>().dashboard() {
                            update_tray(app, &dashboard);
                        }
                    }
                }
            }
            "exit" => app.exit(0),
            _ => (),
        })
        .build(app)?;
    *app.state::<AppState>()
        .tray_menu
        .lock()
        .map_err(|_| "托盘菜单状态锁异常")? = Some(TrayMenu { autostart, status });
    Ok(())
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_window(app)
        }))
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![
            get_dashboard,
            refresh_battery,
            get_history,
            save_settings,
            export_history
        ])
        .setup(|app| {
            let directory = app.path().app_data_dir()?;
            std::fs::create_dir_all(&directory)?;
            let db = Storage::open(&directory.join("battery.sqlite3"))?;
            let settings = db.settings()?;
            let alert = db.alert()?;
            app.manage(AppState {
                inner: Mutex::new(Runtime {
                    db,
                    settings: settings.clone(),
                    alert,
                    current: None,
                    last_error: None,
                    tray_available: false,
                }),
                sampling: tokio::sync::Mutex::new(()),
                wake: tokio::sync::Notify::new(),
                tray_menu: Mutex::new(None),
            });
            let tray = setup_tray(app.handle(), &settings);
            let tray_available = tray.is_ok();
            if let Err(error) = tray {
                app.state::<AppState>().lock()?.last_error =
                    Some(format!("系统托盘初始化失败：{error}"));
            }
            app.state::<AppState>().lock()?.tray_available = tray_available;
            let minimized =
                settings.start_minimized || std::env::args().any(|a| a == "--minimized");
            if !minimized || !tray_available {
                show_window(app.handle());
            }
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    let _ = sample(&handle).await;
                    let state = handle.state::<AppState>();
                    let seconds = state.lock().map(|s| s.settings.poll_seconds).unwrap_or(300);
                    tokio::select! {
                        _ = tokio::time::sleep(std::time::Duration::from_secs(seconds)) => (),
                        _ = state.wake.notified() => (),
                    }
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if let Some(state) = window.app_handle().try_state::<AppState>() {
                    let hide = state
                        .lock()
                        .map(|s| s.settings.close_to_tray && s.tray_available)
                        .unwrap_or(false);
                    if hide {
                        api.prevent_close();
                        let _ = window.hide();
                    }
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("无法启动妙控板电量管家");
}

#[cfg(test)]
mod tests {
    #[test]
    fn requested_tray_ico_decodes() {
        let icon =
            tauri::image::Image::from_bytes(include_bytes!("../../design/trackpad-battery.ico"))
                .unwrap();
        assert!(icon.width() > 0 && icon.height() > 0);
        assert_eq!(
            icon.rgba().len(),
            (icon.width() * icon.height() * 4) as usize
        );
    }
}
