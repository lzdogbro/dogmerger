use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::media::MediaInfo;

const DURATION_TOLERANCE_SECONDS: f64 = 0.5;
const MP4_VIDEO_CODECS: [&str; 5] = ["h264", "hevc", "av1", "vp9", "mpeg4"];
const REPLACEABLE_EXTENSIONS: [&str; 12] = [
    "mp4", "mkv", "mov", "m4v", "avi", "webm", "ts", "m2ts", "flv", "wmv", "mpg", "mpeg",
];

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MergePlan {
    pub video: MediaInfo,
    pub audio: MediaInfo,
    pub container: String,
    pub audio_copy: bool,
    pub audio_tail_seconds: f64,
    pub video_tail_seconds: f64,
    pub output_duration: f64,
}

fn round3(value: f64) -> f64 {
    (value * 1000.0).round() / 1000.0
}

pub fn build(video: MediaInfo, audio: MediaInfo) -> Result<MergePlan, String> {
    let Some(video_stream) = video.video.clone() else {
        return Err(format!(
            "{} 里没有找到视频流。第一个文件必须是视频（如 MP4/MOV）。",
            video.path
        ));
    };
    let Some(audio_stream) = audio.audio.clone() else {
        return Err(format!(
            "{} 里没有找到音频流。第二个文件必须是音频（如 MP3/AAC）。",
            audio.path
        ));
    };
    if video.duration <= 0.0 {
        return Err(format!("无法读取 {} 的时长。", video.path));
    }
    if audio.duration <= 0.0 {
        return Err(format!("无法读取 {} 的时长。", audio.path));
    }

    let raw_audio_tail = audio.duration - video.duration;
    let raw_video_tail = video.duration - audio.duration;

    let container = if MP4_VIDEO_CODECS.contains(&video_stream.codec.as_str()) {
        "mp4"
    } else {
        "mkv"
    };

    Ok(MergePlan {
        audio_copy: audio_stream.codec == "aac",
        audio_tail_seconds: if raw_audio_tail > DURATION_TOLERANCE_SECONDS {
            round3(raw_audio_tail)
        } else {
            0.0
        },
        video_tail_seconds: if raw_video_tail > DURATION_TOLERANCE_SECONDS {
            round3(raw_video_tail)
        } else {
            0.0
        },
        output_duration: round3(video.duration.max(audio.duration)),
        container: container.to_string(),
        video,
        audio,
    })
}

/// `<原文件名>_merged.<容器后缀>`, next to the source video.
pub fn suggested_output(video_path: &str, container: &str) -> PathBuf {
    let source = Path::new(video_path);
    let dir = source.parent().unwrap_or_else(|| Path::new("."));
    let stem = source
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "output".to_string());
    let extension = if container == "mp4" { "mp4" } else { "mkv" };
    dir.join(format!("{stem}_merged.{extension}"))
}

/// Keeps the extension in sync with the container actually being written.
pub fn normalize_output(output: &str, container: &str) -> PathBuf {
    let path = Path::new(output);
    let wanted = if container == "mp4" { "mp4" } else { "mkv" };
    let current = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if current == wanted {
        return path.to_path_buf();
    }
    if REPLACEABLE_EXTENSIONS.contains(&current.as_str()) {
        return path.with_extension(wanted);
    }
    PathBuf::from(format!("{output}.{wanted}"))
}

/// Never clobber an existing result: output.mp4 -> output-1.mp4 -> ...
pub fn find_free_output(preferred: &Path) -> PathBuf {
    if !preferred.exists() {
        return preferred.to_path_buf();
    }
    let stem = preferred
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "output".to_string());
    let extension = preferred
        .extension()
        .map(|e| e.to_string_lossy().into_owned())
        .unwrap_or_else(|| "mp4".to_string());
    let dir = preferred.parent().unwrap_or_else(|| Path::new("."));
    for index in 1..1000 {
        let candidate = dir.join(format!("{stem}-{index}.{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    preferred.to_path_buf()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::{AudioStreamInfo, VideoStreamInfo};

    fn media(path: &str, duration: f64, video_codec: Option<&str>, audio_codec: Option<&str>) -> MediaInfo {
        MediaInfo {
            path: path.to_string(),
            size_bytes: 1000,
            duration,
            format_name: "test".to_string(),
            video: video_codec.map(|codec| VideoStreamInfo {
                index: 0,
                codec: codec.to_string(),
                width: 1920,
                height: 1080,
                fps: 30.0,
                pix_fmt: Some("yuv420p".to_string()),
            }),
            audio: audio_codec.map(|codec| AudioStreamInfo {
                index: 1,
                codec: codec.to_string(),
                channels: 2,
                sample_rate: 44100,
                bit_rate: 128000,
            }),
            video_stream_count: if video_codec.is_some() { 1 } else { 0 },
            audio_stream_count: if audio_codec.is_some() { 1 } else { 0 },
        }
    }

    #[test]
    fn audio_longer_than_video_reports_tail() {
        let plan = build(
            media("/v/a.mp4", 20.0, Some("h264"), None),
            media("/v/b.mp3", 30.0, None, Some("mp3")),
        )
        .unwrap();
        assert_eq!(plan.audio_tail_seconds, 10.0);
        assert_eq!(plan.video_tail_seconds, 0.0);
        assert_eq!(plan.output_duration, 30.0);
    }

    #[test]
    fn video_longer_than_audio_reports_tail() {
        let plan = build(
            media("/v/a.mp4", 30.0, Some("h264"), None),
            media("/v/b.mp3", 20.0, None, Some("mp3")),
        )
        .unwrap();
        assert_eq!(plan.video_tail_seconds, 10.0);
        assert_eq!(plan.audio_tail_seconds, 0.0);
    }

    #[test]
    fn sub_tolerance_difference_is_ignored() {
        let plan = build(
            media("/v/a.mp4", 20.0, Some("h264"), None),
            media("/v/b.mp3", 20.3, None, Some("mp3")),
        )
        .unwrap();
        assert_eq!(plan.audio_tail_seconds, 0.0);
        assert_eq!(plan.video_tail_seconds, 0.0);
    }

    #[test]
    fn only_aac_is_copied_verbatim() {
        let aac = build(
            media("/v/a.mp4", 20.0, Some("h264"), None),
            media("/v/b.m4a", 20.0, None, Some("aac")),
        )
        .unwrap();
        assert!(aac.audio_copy);

        let mp3 = build(
            media("/v/a.mp4", 20.0, Some("h264"), None),
            media("/v/b.mp3", 20.0, None, Some("mp3")),
        )
        .unwrap();
        assert!(!mp3.audio_copy);
    }

    #[test]
    fn unsupported_video_codec_falls_back_to_mkv() {
        let plan = build(
            media("/v/a.mov", 20.0, Some("prores"), None),
            media("/v/b.wav", 20.0, None, Some("pcm_s16le")),
        )
        .unwrap();
        assert_eq!(plan.container, "mkv");
    }

    #[test]
    fn missing_video_stream_is_rejected() {
        let error = build(
            media("/v/a.mp3", 20.0, None, Some("mp3")),
            media("/v/b.mp3", 20.0, None, Some("mp3")),
        )
        .unwrap_err();
        assert!(error.contains("没有找到视频流"));
    }

    #[test]
    fn missing_audio_stream_is_rejected() {
        let error = build(
            media("/v/a.mp4", 20.0, Some("h264"), None),
            media("/v/b.mp4", 20.0, Some("h264"), None),
        )
        .unwrap_err();
        assert!(error.contains("没有找到音频流"));
    }

    #[test]
    fn suggested_output_uses_source_name() {
        let path = suggested_output("/movies/My Holiday.mp4", "mp4");
        assert_eq!(path, PathBuf::from("/movies/My Holiday_merged.mp4"));

        let mkv = suggested_output("/movies/clip.MOV", "mkv");
        assert_eq!(mkv, PathBuf::from("/movies/clip_merged.mkv"));
    }

    #[test]
    fn normalize_output_keeps_container_extension() {
        assert_eq!(
            normalize_output("/movies/out.mov", "mp4"),
            PathBuf::from("/movies/out.mp4")
        );
        assert_eq!(
            normalize_output("/movies/out", "mp4"),
            PathBuf::from("/movies/out.mp4")
        );
        assert_eq!(
            normalize_output("/movies/out.mp4", "mp4"),
            PathBuf::from("/movies/out.mp4")
        );
    }
}
