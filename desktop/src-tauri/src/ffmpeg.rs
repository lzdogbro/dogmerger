use serde::Serialize;
use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Where a resolved binary came from, so the UI can explain the result.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum BinSource {
    /// Chosen by the user in the app settings.
    Custom,
    /// FFMPEG_PATH / FFPROBE_PATH.
    Env,
    /// Shipped next to the executable (sidecar).
    Bundled,
    /// Found on PATH or in a well-known install directory.
    Path,
}

pub struct Resolved {
    pub path: String,
    /// None when nothing was found at all.
    pub source: Option<BinSource>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BinaryInfo {
    pub available: bool,
    pub path: String,
    pub version: Option<String>,
    pub source: Option<BinSource>,
    /// Present when the user set a path that does not point at a usable file.
    pub custom_path: Option<String>,
}

fn env_key(name: &str) -> &'static str {
    if name.contains("probe") {
        "FFPROBE_PATH"
    } else {
        "FFMPEG_PATH"
    }
}

/// Binaries shipped next to the main executable (Tauri sidecars live there).
fn bundled(name: &str) -> Option<PathBuf> {
    let exe = env::current_exe().ok()?;
    let dir = exe.parent()?;
    let file_names: Vec<String> = if cfg!(windows) {
        vec![format!("{name}.exe"), name.to_string()]
    } else {
        vec![name.to_string()]
    };
    file_names
        .into_iter()
        .map(|file| dir.join(file))
        .find(|candidate| is_executable(candidate))
}

fn search_paths(name: &str) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(path) = env::var("PATH") {
        dirs.extend(env::split_paths(&path));
    }
    for fixed in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/opt/local/bin",
        "/usr/bin",
        "/bin",
    ] {
        dirs.push(PathBuf::from(fixed));
    }

    // Windows executables carry an extension, so a bare "ffmpeg" never matches.
    let file_names: Vec<String> = if cfg!(windows) {
        vec![format!("{name}.exe"), name.to_string()]
    } else {
        vec![name.to_string()]
    };

    dirs.iter()
        .flat_map(|dir| file_names.iter().map(move |file| dir.join(file)))
        .find(|candidate| is_executable(candidate))
}

pub fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        match std::fs::metadata(path) {
            Ok(meta) => meta.is_file() && meta.permissions().mode() & 0o111 != 0,
            Err(_) => false,
        }
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

/// Resolution order: user setting -> env var -> bundled -> PATH/known dirs.
pub fn resolve(custom: Option<&str>, name: &str) -> Resolved {
    if let Some(value) = custom {
        let trimmed = value.trim();
        if !trimmed.is_empty() && is_executable(Path::new(trimmed)) {
            return Resolved {
                path: trimmed.to_string(),
                source: Some(BinSource::Custom),
            };
        }
    }

    if let Ok(value) = env::var(env_key(name)) {
        let trimmed = value.trim();
        if !trimmed.is_empty() && is_executable(Path::new(trimmed)) {
            return Resolved {
                path: trimmed.to_string(),
                source: Some(BinSource::Env),
            };
        }
    }

    if let Some(found) = bundled(name) {
        return Resolved {
            path: found.to_string_lossy().into_owned(),
            source: Some(BinSource::Bundled),
        };
    }

    if let Some(found) = search_paths(name) {
        return Resolved {
            path: found.to_string_lossy().into_owned(),
            source: Some(BinSource::Path),
        };
    }

    Resolved {
        path: name.to_string(),
        source: None,
    }
}

/// First line of `<bin> -version`, e.g. "9.0.2".
pub fn version_of(path: &str) -> Option<String> {
    let output = Command::new(path).arg("-version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let first = stdout.lines().next()?.trim().to_string();
    first
        .split_whitespace()
        .skip_while(|part| *part != "version")
        .nth(1)
        .map(|value| value.to_string())
        .or(Some(first))
}

pub fn inspect(custom: Option<&str>, name: &str) -> BinaryInfo {
    let resolved = resolve(custom, name);
    let version = resolved.source.and_then(|_| version_of(&resolved.path));
    let custom_path = custom
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    BinaryInfo {
        available: version.is_some(),
        path: resolved.path,
        version,
        source: resolved.source,
        custom_path,
    }
}

/// Confirms a user-picked file really is the expected binary.
pub fn validate(path: &str, name: &str) -> Result<(), String> {
    let candidate = Path::new(path);
    if !candidate.is_file() {
        return Err(format!("不是有效文件：{path}"));
    }
    if !is_executable(candidate) {
        return Err(format!("没有执行权限：{path}"));
    }
    let output = Command::new(path).arg("-version").output().map_err(|_| {
        format!("无法执行这个文件：{path}")
    })?;
    let text = String::from_utf8_lossy(&output.stdout);
    if !output.status.success() || !text.contains(name) {
        return Err(format!("这个文件不是 {name}：{path}"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn missing_binary_reports_no_source() {
        let resolved = resolve(None, "definitely-not-installed-binary");
        assert!(resolved.source.is_none());
        // Falls back to the bare name so spawning still gives a clear error.
        assert_eq!(resolved.path, "definitely-not-installed-binary");
    }

    #[test]
    fn custom_path_wins_over_path_lookup() {
        let resolved = resolve(Some("/bin/ls"), "ffmpeg");
        assert_eq!(resolved.source, Some(BinSource::Custom));
        assert_eq!(resolved.path, "/bin/ls");
    }

    #[test]
    fn unusable_custom_path_falls_through() {
        let resolved = resolve(Some("/nope/missing-binary"), "ffmpeg");
        assert_ne!(resolved.source, Some(BinSource::Custom));
    }

    #[test]
    fn inspect_of_missing_binary_is_unavailable() {
        let info = inspect(None, "definitely-not-installed-binary");
        assert!(!info.available);
        assert!(info.version.is_none());
    }

    #[test]
    fn validate_rejects_the_wrong_binary() {
        let error = validate("/bin/ls", "ffmpeg").unwrap_err();
        assert!(error.contains("不是 ffmpeg"), "unexpected: {error}");
    }

    #[test]
    fn validate_rejects_missing_file() {
        let error = validate("/nope/nothing-here", "ffprobe").unwrap_err();
        assert!(error.contains("不是有效文件"), "unexpected: {error}");
    }

    #[test]
    fn validate_accepts_a_real_ffmpeg() {
        if let Some(source) = resolve(None, "ffmpeg").source {
            let path = resolve(None, "ffmpeg").path;
            assert!(validate(&path, "ffmpeg").is_ok(), "source={source:?}");
        }
    }
}
