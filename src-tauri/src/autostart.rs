#[cfg(windows)]
const VALUE_NAME: &str = "MagicTrackpadBattery";
#[cfg(windows)]
const RUN_KEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Run";

#[cfg(windows)]
pub fn apply(enabled: bool, minimized: bool) -> Result<(), String> {
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    let (key, _) = RegKey::predef(HKEY_CURRENT_USER)
        .create_subkey(RUN_KEY)
        .map_err(|e| format!("无法打开当前用户的开机启动配置：{e}"))?;
    if enabled {
        let exe = std::env::current_exe().map_err(|e| format!("无法定位应用程序：{e}"))?;
        let command = format!(
            "\"{}\" --autostart{}",
            exe.display(),
            if minimized { " --minimized" } else { "" }
        );
        key.set_value(VALUE_NAME, &command)
            .map_err(|e| format!("设置开机启动失败：{e}"))?;
    } else {
        match key.delete_value(VALUE_NAME) {
            Ok(()) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(e) => return Err(format!("关闭开机启动失败：{e}")),
        }
    }
    Ok(())
}

#[cfg(not(windows))]
pub fn apply(enabled: bool, _minimized: bool) -> Result<(), String> {
    if enabled {
        Err("开机启动仅支持 Windows".into())
    } else {
        Ok(())
    }
}
