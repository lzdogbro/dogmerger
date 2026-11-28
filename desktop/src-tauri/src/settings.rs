use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Persisted between launches, in the platform config dir:
/// macOS   ~/Library/Application Support/com.lzdogbro.dogmerger/settings.json
/// Windows %APPDATA%\com.lzdogbro.dogmerger\settings.json
/// Linux   ~/.config/com.lzdogbro.dogmerger/settings.json
#[derive(Serialize, Deserialize, Default, Clone)]
pub struct Settings {
    #[serde(default)]
    pub ffmpeg_path: Option<String>,
    #[serde(default)]
    pub ffprobe_path: Option<String>,
}

pub fn file(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|dir| dir.join("settings.json"))
}

pub fn load(app: &AppHandle) -> Settings {
    let Some(path) = file(app) else {
        return Settings::default();
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn save(app: &AppHandle, settings: &Settings) -> Result<(), String> {
    let path = file(app).ok_or_else(|| "无法定位配置目录".to_string())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|error| format!("无法创建配置目录：{error}"))?;
    }
    let json = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    std::fs::write(&path, json).map_err(|error| format!("无法写入配置：{error}"))
}
