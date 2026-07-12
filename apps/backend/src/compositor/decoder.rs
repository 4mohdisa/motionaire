use std::io::Read;
use std::process::{Child, ChildStdout, Command, Stdio};

// FFmpeg as a subprocess piping rawvideo RGBA — CONTEXT.md §3.4's blessed pattern
// ("FFmpeg CLI, run as a subprocess"). No libav linking, no version hell.
// ponytail: no hardware-decode surface sharing this way; the C-API + VideoToolbox
// zero-copy path is the upgrade when decode becomes the measured bottleneck.

pub fn ffmpeg_bin() -> String {
    if let Ok(p) = std::env::var("MOTIONAIRE_FFMPEG") {
        return p;
    }
    for cand in ["ffmpeg", "/opt/homebrew/bin/ffmpeg", "/usr/local/bin/ffmpeg"] {
        if Command::new(cand).arg("-version").stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok() {
            return cand.to_string();
        }
    }
    "ffmpeg".to_string()
}

pub fn ffprobe_bin() -> String {
    let f = ffmpeg_bin();
    if f.ends_with("ffmpeg") {
        f.replace("ffmpeg", "ffprobe")
    } else {
        "ffprobe".to_string()
    }
}

#[derive(Debug, Clone, Copy)]
pub struct MediaInfo {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub duration: f64,
}

pub fn probe(path: &str) -> Result<MediaInfo, String> {
    let out = Command::new(ffprobe_bin())
        .args([
            "-v", "error",
            "-select_streams", "v:0",
            "-show_entries", "stream=width,height,avg_frame_rate,duration",
            "-of", "json",
            path,
        ])
        .output()
        .map_err(|e| format!("ffprobe spawn: {e}"))?;
    if !out.status.success() {
        return Err(format!("ffprobe failed for {path}: {}", String::from_utf8_lossy(&out.stderr)));
    }
    let v: serde_json::Value =
        serde_json::from_slice(&out.stdout).map_err(|e| format!("ffprobe json: {e}"))?;
    let s = v["streams"]
        .get(0)
        .ok_or_else(|| format!("no video stream in {path}"))?;
    let rate = s["avg_frame_rate"].as_str().unwrap_or("30/1");
    let fps = {
        let mut it = rate.split('/');
        let n: f64 = it.next().unwrap_or("30").parse().unwrap_or(30.0);
        let d: f64 = it.next().unwrap_or("1").parse().unwrap_or(1.0);
        if d > 0.0 && n > 0.0 { n / d } else { 30.0 }
    };
    Ok(MediaInfo {
        width: s["width"].as_u64().unwrap_or(0) as u32,
        height: s["height"].as_u64().unwrap_or(0) as u32,
        fps,
        duration: s["duration"].as_str().and_then(|d| d.parse().ok()).unwrap_or(0.0),
    })
}

// Sequential rawvideo reader with reseek-on-jump. Forward playback reads ahead
// frame by frame; a backward jump or a large forward jump respawns ffmpeg with -ss.
pub struct Decoder {
    pub path: String,
    pub info: MediaInfo,
    child: Option<Child>,
    stdout: Option<ChildStdout>,
    cur_idx: i64, // frame index currently held in `frame`, -1 = none
    frame: Vec<u8>,
    frame_bytes: usize,
}

impl Decoder {
    pub fn new(path: &str) -> Result<Self, String> {
        let info = probe(path)?;
        if info.width == 0 || info.height == 0 {
            return Err(format!("bad dimensions for {path}"));
        }
        let frame_bytes = (info.width * info.height * 4) as usize;
        Ok(Self {
            path: path.to_string(),
            info,
            child: None,
            stdout: None,
            cur_idx: -1,
            frame: vec![0u8; frame_bytes],
            frame_bytes,
        })
    }

    fn respawn(&mut self, at_idx: i64) -> Result<(), String> {
        self.kill();
        let seek_t = at_idx.max(0) as f64 / self.info.fps;
        let mut child = Command::new(ffmpeg_bin())
            .args([
                "-v", "error",
                "-ss", &format!("{seek_t:.6}"),
                "-i", &self.path,
                "-f", "rawvideo",
                "-pix_fmt", "rgba",
                "-an",
                "pipe:1",
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("ffmpeg spawn: {e}"))?;
        self.stdout = child.stdout.take();
        self.child = Some(child);
        self.cur_idx = at_idx - 1; // next read produces at_idx
        Ok(())
    }

    fn read_next(&mut self) -> bool {
        let Some(out) = self.stdout.as_mut() else { return false };
        match out.read_exact(&mut self.frame) {
            Ok(()) => {
                self.cur_idx += 1;
                true
            }
            Err(_) => false, // EOF — hold last frame
        }
    }

    // Frame covering source time `src_t`, or None before any frame was decoded.
    pub fn frame_at(&mut self, src_t: f64) -> Option<&[u8]> {
        let last_idx = ((self.info.duration * self.info.fps).ceil() as i64 - 1).max(0);
        let target = ((src_t * self.info.fps).floor() as i64).clamp(0, last_idx);

        let need_respawn = self.child.is_none()
            || target < self.cur_idx
            || target > self.cur_idx + (self.info.fps as i64) * 2;
        if need_respawn {
            if self.respawn(target).is_err() {
                return None;
            }
        }
        while self.cur_idx < target {
            if !self.read_next() {
                break;
            }
        }
        if self.cur_idx >= 0 {
            Some(&self.frame)
        } else {
            None
        }
    }

    pub fn frame_bytes(&self) -> usize {
        self.frame_bytes
    }

    fn kill(&mut self) {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        self.stdout = None;
        self.cur_idx = -1;
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        self.kill();
    }
}
