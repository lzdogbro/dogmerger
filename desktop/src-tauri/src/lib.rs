mod ffmpeg;
mod jobs;
mod media;
mod plan;
mod settings;

use serde::Serialize;
use std::path::{Path, PathBuf};
#[cfg(debug_assertions)]
use std::time::Duration;
use tauri::{AppHandle, Manager};
#[cfg(debug_assertions)]
use tauri::Emitter;

use ffmpeg::BinaryInfo;
use jobs::{Job, JobStore};
use media::MediaInfo;
use plan::MergePlan;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Binaries {
    ffmpeg: BinaryInfo,
    ffprobe: BinaryInfo,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Picker {
    supported: bool,
    reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Health {
    ok: bool,
    platform: String,
    binaries: Binaries,
    picker: Picker,
}

/// Echoes a line to stderr when DOGMERGER_DEBUG is set. Used by the frontend to
/// prove that IPC and the native drag-drop listener actually came up.
#[tauri::command]
fn debug_log(message: String) {
    if std::env::var("DOGMERGER_DEBUG").is_ok() {
        eprintln!("[dogmerger:web] {message}");
    }
}

fn build_health(app: &AppHandle) -> Health {
    let config = settings::load(app);
    let ffmpeg_info = ffmpeg::inspect(config.ffmpeg_path.as_deref(), "ffmpeg");
    let ffprobe_info = ffmpeg::inspect(config.ffprobe_path.as_deref(), "ffprobe");
    if std::env::var("DOGMERGER_DEBUG").is_ok() {
        eprintln!(
            "[dogmerger:web] health invoked, ffmpeg={:?} source={:?} at {}",
            ffmpeg_info.version, ffmpeg_info.source, ffmpeg_info.path
        );
    }
    Health {
        ok: ffmpeg_info.available && ffprobe_info.available,
        platform: std::env::consts::OS.to_string(),
        binaries: Binaries {
            ffmpeg: ffmpeg_info,
            ffprobe: ffprobe_info,
        },
        // The desktop build always has a native picker available.
        picker: Picker {
            supported: true,
            reason: None,
        },
    }
}

#[tauri::command]
fn health(app: AppHandle) -> Health {
    build_health(&app)
}

/// Saves a user-picked binary (or clears it with `path: null`).
#[tauri::command]
fn set_binary_path(
    app: AppHandle,
    kind: String,
    path: Option<String>,
) -> Result<Health, String> {
    let picked = path
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    if let Some(value) = &picked {
        let expected = if kind == "ffprobe" { "ffprobe" } else { "ffmpeg" };
        ffmpeg::validate(value, expected)?;
    }

    let mut config = settings::load(&app);
    match kind.as_str() {
        "ffmpeg" => config.ffmpeg_path = picked,
        "ffprobe" => config.ffprobe_path = picked,
        other => return Err(format!("未知的依赖：{other}")),
    }
    settings::save(&app, &config)?;
    Ok(build_health(&app))
}

#[tauri::command]
fn probe_media(app: AppHandle, path: String) -> Result<MediaInfo, String> {
    if std::env::var("DOGMERGER_DEBUG").is_ok() {
        eprintln!("[dogmerger:web] probe invoked: {path}");
    }
    let config = settings::load(&app);
    let ffprobe = ffmpeg::resolve(config.ffprobe_path.as_deref(), "ffprobe");
    media::probe(&path, &ffprobe.path)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PlanResponse {
    #[serde(flatten)]
    plan: MergePlan,
    suggested_output: String,
}

fn resolve_plan(
    app: &AppHandle,
    video_path: &str,
    audio_path: &str,
    output_path: Option<&str>,
) -> Result<(MergePlan, String), String> {
    let config = settings::load(app);
    let ffprobe = ffmpeg::resolve(config.ffprobe_path.as_deref(), "ffprobe");
    if ffprobe.source.is_none() {
        return Err("找不到 ffprobe，请在右上角「依赖状态」里指定它的位置。".to_string());
    }
    let video = media::probe(video_path, &ffprobe.path)?;
    let audio = media::probe(audio_path, &ffprobe.path)?;
    let plan = plan::build(video, audio)?;

    let suggested = match output_path {
        Some(path) if !path.trim().is_empty() => {
            plan::normalize_output(path.trim(), &plan.container)
        }
        _ => plan::suggested_output(video_path, &plan.container),
    };

    Ok((plan, suggested.to_string_lossy().into_owned()))
}

#[tauri::command]
fn build_plan(
    app: AppHandle,
    video_path: String,
    audio_path: String,
    output_path: Option<String>,
) -> Result<PlanResponse, String> {
    let (plan, suggested_output) =
        resolve_plan(&app, &video_path, &audio_path, output_path.as_deref())?;
    Ok(PlanResponse {
        plan,
        suggested_output,
    })
}

#[tauri::command]
fn start_job(
    app: AppHandle,
    video_path: String,
    audio_path: String,
    output_path: Option<String>,
) -> Result<Job, String> {
    let explicit = output_path
        .as_deref()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let (plan, suggested) = resolve_plan(&app, &video_path, &audio_path, explicit.as_deref())?;
    let config = settings::load(&app);
    let ffmpeg_bin = ffmpeg::resolve(config.ffmpeg_path.as_deref(), "ffmpeg");
    if ffmpeg_bin.source.is_none() {
        return Err("找不到 ffmpeg，请在右上角「依赖状态」里指定它的位置。".to_string());
    }
    let output = match explicit {
        // An explicitly chosen path is an explicit overwrite.
        Some(_) => PathBuf::from(suggested),
        None => plan::find_free_output(Path::new(&suggested)),
    };

    jobs::start(&app, plan, output, ffmpeg_bin.path)
}

#[tauri::command]
fn get_job(app: AppHandle, id: String) -> Result<Job, String> {
    jobs::get(&app, &id).ok_or_else(|| "任务不存在".to_string())
}

#[tauri::command]
fn cancel_job(app: AppHandle, id: String) -> Result<bool, String> {
    Ok(jobs::cancel(&app, &id))
}

#[tauri::command]
fn rename_job(app: AppHandle, id: String, name: String) -> Result<Job, String> {
    let job = jobs::get(&app, &id).ok_or_else(|| "任务不存在".to_string())?;
    if job.status != "done" {
        return Err("任务还没有完成".to_string());
    }

    let trimmed = name.trim();
    let file_name = Path::new(trimmed)
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .filter(|value| !value.is_empty() && value != "." && value != "..")
        .ok_or_else(|| format!("文件名不合法：{trimmed}"))?;

    let current = PathBuf::from(&job.output_path);
    let directory = current
        .parent()
        .ok_or_else(|| "输出路径无效".to_string())?
        .to_path_buf();
    let target = directory.join(&file_name);

    if target == current {
        return Ok(job);
    }
    if target.exists() {
        return Err(format!("同名文件已存在：{file_name}"));
    }

    std::fs::rename(&current, &target)
        .map_err(|_| format!("重命名失败，请检查目录权限：{}", target.display()))?;
    let size = std::fs::metadata(&target).ok().map(|meta| meta.len());

    jobs::replace_output(&app, &id, target, size).ok_or_else(|| "任务不存在".to_string())
}

#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err(format!("路径不存在：{path}"));
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .status()
            .map_err(|error| error.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{path}"))
            .status()
            .map_err(|error| error.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let directory = Path::new(&path)
            .parent()
            .map(|value| value.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("/"));
        std::process::Command::new("xdg-open")
            .arg(directory)
            .status()
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn open_path(path: String) -> Result<(), String> {
    if !Path::new(&path).exists() {
        return Err(format!("路径不存在：{path}"));
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&path)
            .status()
            .map_err(|error| error.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", &path])
            .status()
            .map_err(|error| error.to_string())?;
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .status()
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(JobStore::default())
        .setup(|app| {
            #[cfg(not(debug_assertions))]
            let _ = &app;
            if std::env::var("DOGMERGER_DEBUG").is_ok() {
                eprintln!("[dogmerger] setup complete");
            }
            // Lets a headless run drive a whole merge through the real command path.
            #[cfg(debug_assertions)]
            if let Ok(spec) = std::env::var("DOGMERGER_SIMULATE_MERGE") {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(2));
                    let parts: Vec<&str> = spec.split('|').collect();
                    if parts.len() < 3 {
                        eprintln!("[dogmerger] simulate-merge: spec must be video|audio|output");
                        return;
                    }
                    let (video, audio, output) = (parts[0], parts[1], parts[2]);
                    let plan = match resolve_plan(&handle, video, audio, Some(output)) {
                        Ok((plan, _)) => plan,
                        Err(error) => {
                            eprintln!("[dogmerger] simulate-merge: plan failed: {error}");
                            return;
                        }
                    };
                    let ffmpeg_bin = ffmpeg::resolve(None, "ffmpeg").path;
                    let job = match jobs::start(&handle, plan, PathBuf::from(output), ffmpeg_bin)
                    {
                        Ok(job) => job,
                        Err(error) => {
                            eprintln!("[dogmerger] simulate-merge: start failed: {error}");
                            return;
                        }
                    };
                    eprintln!("[dogmerger] job started: {}", job.id);
                    for _ in 0..240 {
                        std::thread::sleep(Duration::from_millis(250));
                        if let Some(current) = jobs::get(&handle, &job.id) {
                            if current.status != "running" {
                                eprintln!(
                                    "[dogmerger] job finished: status={} bytes={:?} elapsed={:?} progress={}% error={:?}",
                                    current.status,
                                    current.output_bytes,
                                    current.elapsed_seconds,
                                    current.progress.percent,
                                    current.error
                                );
                                return;
                            }
                        }
                    }
                    eprintln!("[dogmerger] job timed out");
                });
            }

            // Lets a headless run exercise the native drop path end to end.
            #[cfg(debug_assertions)]
            if let Ok(spec) = std::env::var("DOGMERGER_SIMULATE_DROP") {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_secs(5));
                    // "x|y|path" so a headless run can aim at a specific column.
                    let parts: Vec<&str> = spec.split('|').collect();
                    let (x, y, dropped) = if parts.len() >= 3 {
                        (
                            parts[0].parse::<f64>().unwrap_or(300.0),
                            parts[1].parse::<f64>().unwrap_or(300.0),
                            parts[2].to_string(),
                        )
                    } else {
                        (300.0, 300.0, spec.clone())
                    };
                    let payload = serde_json::json!({
                        "type": "drop",
                        "paths": [dropped],
                        "position": { "x": x, "y": y },
                    });
                    match handle.emit("tauri://drag-drop", payload) {
                        Ok(()) => eprintln!("[dogmerger] simulated drop emitted"),
                        Err(error) => eprintln!("[dogmerger] simulated drop failed: {error}"),
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // Single-window utility: closing the window means quitting, and
                // an in-flight ffmpeg must not survive the app.
                jobs::shutdown(window.app_handle());
                window.app_handle().exit(0);
            }
        })
        .on_page_load(|_webview, payload| {
            if std::env::var("DOGMERGER_DEBUG").is_ok() {
                eprintln!("[dogmerger] page loaded: {}", payload.url());
            }
        })
        .invoke_handler(tauri::generate_handler![
            debug_log,
            health,
            set_binary_path,
            probe_media,
            build_plan,
            start_job,
            get_job,
            cancel_job,
            rename_job,
            reveal_path,
            open_path
        ])
        .run(tauri::generate_context!())
        .expect("error while running dogmerger");
}
