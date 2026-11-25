use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

/// A GUI app on macOS launches with a minimal PATH (`/usr/bin:/bin:...`), so
/// Homebrew's bin directories are usually absent. Look in the usual install
/// locations before falling back to a bare command name.
pub fn resolve(name: &str) -> String {
    let env_key = if name.contains("probe") {
        "FFPROBE_PATH"
    } else {
        "FFMPEG_PATH"
    };
    if let Ok(value) = env::var(env_key) {
        if !value.trim().is_empty() {
            return value.trim().to_string();
        }
    }

    if let Some(found) = search_paths(name) {
        return found.to_string_lossy().into_owned();
    }
    name.to_string()
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
    dirs.into_iter()
        .map(|dir| dir.join(name))
        .find(|candidate| is_executable(candidate))
}

fn is_executable(path: &Path) -> bool {
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

/// First line of `<bin> -version`, e.g. "9.0.2".
pub fn version(name: &str) -> Option<String> {
    let output = Command::new(resolve(name)).arg("-version").output().ok()?;
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

pub struct BinaryInfo {
    pub available: bool,
    pub path: String,
    pub version: Option<String>,
}

pub fn inspect(name: &str) -> BinaryInfo {
    let path = resolve(name);
    let version = version(name);
    BinaryInfo {
        available: version.is_some(),
        path,
        version,
    }
}
