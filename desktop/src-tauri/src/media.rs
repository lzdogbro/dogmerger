use serde::Serialize;
use serde_json::Value;
use std::process::Command;


#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct VideoStreamInfo {
    pub index: u32,
    pub codec: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub pix_fmt: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AudioStreamInfo {
    pub index: u32,
    pub codec: String,
    pub channels: u32,
    pub sample_rate: u32,
    pub bit_rate: u64,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MediaInfo {
    pub path: String,
    pub size_bytes: u64,
    pub duration: f64,
    pub format_name: String,
    pub video: Option<VideoStreamInfo>,
    pub audio: Option<AudioStreamInfo>,
    pub video_stream_count: u32,
    pub audio_stream_count: u32,
}

fn as_f64(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Number(number)) => number.as_f64().unwrap_or(0.0),
        Some(Value::String(text)) => text.parse().unwrap_or(0.0),
        _ => 0.0,
    }
}

fn as_u64(value: Option<&Value>) -> u64 {
    match value {
        Some(Value::Number(number)) => number.as_u64().unwrap_or(0),
        Some(Value::String(text)) => text.parse().unwrap_or(0),
        _ => 0,
    }
}

fn as_str(value: Option<&Value>) -> Option<String> {
    value.and_then(|v| v.as_str()).map(|s| s.to_string())
}

/// "30000/1001" -> 29.97
fn parse_frame_rate(value: Option<&Value>) -> f64 {
    let Some(text) = value.and_then(|v| v.as_str()) else {
        return 0.0;
    };
    let mut parts = text.split('/');
    let numerator: f64 = parts.next().unwrap_or("0").parse().unwrap_or(0.0);
    let denominator: f64 = parts.next().unwrap_or("1").parse().unwrap_or(1.0);
    if denominator == 0.0 || !numerator.is_finite() {
        return 0.0;
    }
    numerator / denominator
}

pub fn probe(path: &str, ffprobe_path: &str) -> Result<MediaInfo, String> {
    let metadata = std::fs::metadata(path).map_err(|_| format!("文件不存在或无法读取：{path}"))?;
    if !metadata.is_file() {
        return Err(format!("不是文件：{path}"));
    }

    let output = Command::new(ffprobe_path)
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            path,
        ])
        .output()
        .map_err(|_| "无法运行 ffprobe。请安装 ffmpeg（brew install ffmpeg）或设置 FFPROBE_PATH。".to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let tail: Vec<&str> = stderr.lines().rev().take(3).collect();
        let message = tail.into_iter().rev().collect::<Vec<_>>().join(" ");
        return Err(if message.trim().is_empty() {
            "ffprobe 读取失败。".to_string()
        } else {
            message.trim().to_string()
        });
    }

    let parsed: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("ffprobe 输出无法解析：{error}"))?;

    let empty: Vec<Value> = Vec::new();
    let streams = parsed
        .get("streams")
        .and_then(|v| v.as_array())
        .unwrap_or(&empty);

    let of_type = |kind: &str| -> Vec<&Value> {
        streams
            .iter()
            .filter(|s| s.get("codec_type").and_then(|v| v.as_str()) == Some(kind))
            .collect()
    };
    let video_streams = of_type("video");
    let audio_streams = of_type("audio");

    let video = video_streams.first().map(|stream| VideoStreamInfo {
        index: as_u64(stream.get("index")) as u32,
        codec: as_str(stream.get("codec_name")).unwrap_or_else(|| "unknown".into()),
        width: as_u64(stream.get("width")) as u32,
        height: as_u64(stream.get("height")) as u32,
        fps: {
            let avg = parse_frame_rate(stream.get("avg_frame_rate"));
            if avg > 0.0 {
                avg
            } else {
                parse_frame_rate(stream.get("r_frame_rate"))
            }
        },
        pix_fmt: as_str(stream.get("pix_fmt")),
    });

    let audio = audio_streams.first().map(|stream| AudioStreamInfo {
        index: as_u64(stream.get("index")) as u32,
        codec: as_str(stream.get("codec_name")).unwrap_or_else(|| "unknown".into()),
        channels: as_u64(stream.get("channels")) as u32,
        sample_rate: as_u64(stream.get("sample_rate")) as u32,
        bit_rate: as_u64(stream.get("bit_rate")),
    });

    let format = parsed.get("format");
    let mut duration = as_f64(format.and_then(|f| f.get("duration")));
    if duration <= 0.0 {
        duration = streams
            .iter()
            .map(|s| as_f64(s.get("duration")))
            .fold(0.0_f64, f64::max);
    }

    Ok(MediaInfo {
        path: path.to_string(),
        size_bytes: {
            let from_format = as_u64(format.and_then(|f| f.get("size")));
            if from_format > 0 {
                from_format
            } else {
                metadata.len()
            }
        },
        duration,
        format_name: as_str(format.and_then(|f| f.get("format_name")))
            .unwrap_or_else(|| "unknown".into()),
        video,
        audio,
        video_stream_count: video_streams.len() as u32,
        audio_stream_count: audio_streams.len() as u32,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_rational_frame_rates() {
        assert_eq!(parse_frame_rate(Some(&json!("30/1"))), 30.0);
        let ntsc = parse_frame_rate(Some(&json!("30000/1001")));
        assert!((ntsc - 29.97).abs() < 0.01);
    }

    #[test]
    fn rejects_broken_frame_rates() {
        assert_eq!(parse_frame_rate(Some(&json!("0/0"))), 0.0);
        assert_eq!(parse_frame_rate(Some(&json!("abc"))), 0.0);
        assert_eq!(parse_frame_rate(None), 0.0);
    }

    #[test]
    fn reads_numbers_from_strings_or_numbers() {
        assert_eq!(as_f64(Some(&json!("12.5"))), 12.5);
        assert_eq!(as_f64(Some(&json!(3))), 3.0);
        assert_eq!(as_u64(Some(&json!("44100"))), 44100);
        assert_eq!(as_str(Some(&json!("h264"))).as_deref(), Some("h264"));
        assert_eq!(as_str(Some(&json!(1))), None);
    }

    #[test]
    fn missing_file_is_reported_clearly() {
        let error = probe("/definitely/not/here.mp4", "ffprobe").unwrap_err();
        assert!(error.contains("文件不存在"));
    }
}
