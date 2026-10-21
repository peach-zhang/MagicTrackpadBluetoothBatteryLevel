use crate::model::{now_ms, Reading};
use std::{
    io::Read,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

pub const HELPER_ARGUMENT: &str = "--read-battery-json";

pub fn decode_report(report: &[u8]) -> Result<u8, String> {
    if report.len() < 3 {
        return Err(format!(
            "HID 报告长度不足：收到 {} 字节，至少需要 3 字节",
            report.len()
        ));
    }
    if report[0] != 0x90 {
        return Err(format!(
            "HID 报告 ID 不符：期望 0x90，收到 0x{:02X}",
            report[0]
        ));
    }
    if report[2] > 100 {
        return Err(format!(
            "设备返回无效电量 {}%，有效范围为 0–100%",
            report[2]
        ));
    }
    Ok(report[2])
}

#[cfg(windows)]
fn read_native() -> Result<Reading, String> {
    let api = hidapi::HidApi::new().map_err(|e| {
        format!("无法枚举 Windows HID 设备：{e}。请确认蓝牙和系统 HID 服务已启用。")
    })?;
    let mut candidates: Vec<_> = api
        .device_list()
        .filter(|device| {
            matches!(device.vendor_id(), 0x05ac | 0x004c)
                && (device.product_id() == 0x0265
                    || device
                        .product_string()
                        .is_some_and(|p| p.to_lowercase().contains("trackpad")))
        })
        .collect();
    // Apple Multi-touch Auxiliary Services usually exposes a vendor-defined
    // collection. Ordinary pointer collections often reject report 0x90.
    candidates.sort_by_key(|device| {
        (
            device.usage_page() < 0xff00,
            !device
                .product_string()
                .is_some_and(|p| p.to_lowercase().contains("auxiliary")),
        )
    });
    if candidates.is_empty() {
        return Err("未找到支持的 Apple Magic Trackpad HID 设备。请先在 Windows 蓝牙设置中连接妙控板；Lightning 型号需系统提供 Apple Multi-touch Auxiliary Services。部分 USB-C 型号或驱动未公开 0x90 电量报告，无法读取时不会估算电量。".into());
    }
    let mut errors = Vec::new();
    for info in candidates {
        let name = info
            .product_string()
            .unwrap_or("Apple Magic Trackpad")
            .to_owned();
        let result = (|| {
            let device = info
                .open_device(&api)
                .map_err(|e| format!("打开设备失败：{e}"))?;
            let mut report = [0_u8; 512];
            report[0] = 0x90;
            let length = device
                .get_input_report(&mut report)
                .map_err(|e| format!("读取 0x90 输入报告失败：{e}"))?;
            let bytes = report
                .get(..length)
                .ok_or("HID 驱动返回的报告长度超出缓冲区")?;
            let percent = decode_report(bytes)?;
            Ok::<_, String>(Reading {
                timestamp: now_ms(),
                percent,
                device_name: name.clone(),
                device_id: info.path().to_string_lossy().into_owned(),
                source: "Windows HID · input report 0x90".into(),
            })
        })();
        match result {
            Ok(reading) => return Ok(reading),
            Err(error) => errors.push(format!(
                "{name} (usage {:04X}:{:04X})：{error}",
                info.usage_page(),
                info.usage()
            )),
        }
    }
    Err(format!("已找到妙控板，但所有 HID 集合均读取失败。请重新连接蓝牙，确认 Apple Multi-touch Auxiliary Services 可用，并关闭可能独占 HID 的工具。无需替换键盘驱动。{}", errors.join("；")))
}

#[cfg(not(windows))]
fn read_native() -> Result<Reading, String> {
    Err("此应用的妙控板电量读取仅支持 Windows。".into())
}

/// Called before Tauri initialization: no windows, tray, DB, or second-instance
/// handoff is created in the disposable helper process.
pub fn run_helper_if_requested() -> bool {
    if !std::env::args().any(|a| a == HELPER_ARGUMENT) {
        return false;
    }
    let result = std::panic::catch_unwind(read_native)
        .unwrap_or_else(|_| Err("Windows HID 读取进程意外终止".into()));
    if let Ok(json) = serde_json::to_string(&result) {
        println!("{json}");
    }
    true
}

/// A native HID input-report request can block in a third-party driver indefinitely.
/// A disposable process, rather than a timed-out Rust thread, bounds its life.
pub fn read_isolated() -> Result<Reading, String> {
    let exe = std::env::current_exe().map_err(|e| format!("无法定位读取程序：{e}"))?;
    let mut command = Command::new(exe);
    command
        .arg(HELPER_ARGUMENT)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动隔离的 HID 读取进程：{e}"))?;
    let stdout = child.stdout.take().ok_or("读取进程没有返回通道")?;
    // Drain concurrently: an error containing several HID collections can be
    // larger than a Windows anonymous pipe buffer, even before the child exits.
    let reader = std::thread::spawn(move || {
        let mut output = String::new();
        stdout
            .take(65_536)
            .read_to_string(&mut output)
            .map(|_| output)
    });
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                if !status.success() {
                    return Err(format!(
                        "HID 读取进程异常退出（{status}），请重新连接妙控板。"
                    ));
                }
                let output = reader
                    .join()
                    .map_err(|_| "读取结果通道异常终止".to_owned())?
                    .map_err(|e| format!("读取设备结果失败：{e}"))?;
                return serde_json::from_str::<Result<Reading, String>>(output.trim())
                    .map_err(|e| format!("设备读取返回格式错误：{e}"))?;
            }
            Ok(None) if started.elapsed() < Duration::from_secs(10) => {
                std::thread::sleep(Duration::from_millis(50))
            }
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("HID 电量读取超过 10 秒，已终止读取进程。请重新连接蓝牙，检查 Apple Multi-touch Auxiliary Services，并关闭独占设备的程序；监控将自动重试。".into());
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("无法等待设备读取进程：{e}"));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn accepts_only_real_valid_report_including_empty_battery() {
        assert_eq!(decode_report(&[0x90, 0, 0]).unwrap(), 0);
        assert_eq!(decode_report(&[0x90, 99, 100, 0xff]).unwrap(), 100);
        assert!(decode_report(&[0x90, 0]).is_err());
        assert!(decode_report(&[0x91, 0, 50]).is_err());
        assert!(decode_report(&[0x90, 0, 101]).is_err());
        assert!(decode_report(&[]).is_err());
    }
}
