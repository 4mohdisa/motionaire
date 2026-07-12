use std::collections::VecDeque;
use std::io::Read;
use std::process::{Child, ChildStdout, Command, Stdio};

// FFmpeg as a subprocess piping rawvideo RGBA — CONTEXT.md §3.4's blessed pattern.
//
// Forward playback reads sequentially, paced by pipe backpressure. Every decoded
// frame also lands in a byte-capped trailing ring, which makes reverse playback
// real: backward targets serve from the ring at full rate; a ring miss refills a
// whole chunk with ONE seek-respawn instead of one per frame (what the browser
// had to do in session 2).
// ponytail: ring is plain copies, ~a hundred MB cap; zero-copy hw-decode surfaces
// are the upgrade when 4K sources arrive.

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

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FullMediaInfo {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub duration: f64,
    pub has_audio: bool,
}

pub fn probe(path: &str) -> Result<MediaInfo, String> {
    let f = probe_full(path)?;
    Ok(MediaInfo { width: f.width, height: f.height, fps: f.fps, duration: f.duration })
}

pub fn probe_full(path: &str) -> Result<FullMediaInfo, String> {
    let out = Command::new(ffprobe_bin())
        .args([
            "-v", "error",
            "-show_entries", "stream=codec_type,width,height,avg_frame_rate,duration:format=duration",
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
    let streams = v["streams"].as_array().cloned().unwrap_or_default();
    let video = streams.iter().find(|s| s["codec_type"] == "video");
    let has_audio = streams.iter().any(|s| s["codec_type"] == "audio");
    let format_duration: f64 = v["format"]["duration"]
        .as_str()
        .and_then(|d| d.parse().ok())
        .unwrap_or(0.0);

    let Some(s) = video else {
        // Audio-only media is legitimate (detached audio, music beds).
        return Ok(FullMediaInfo { width: 0, height: 0, fps: 0.0, duration: format_duration, has_audio });
    };
    let rate = s["avg_frame_rate"].as_str().unwrap_or("30/1");
    let fps = {
        let mut it = rate.split('/');
        let n: f64 = it.next().unwrap_or("30").parse().unwrap_or(30.0);
        let d: f64 = it.next().unwrap_or("1").parse().unwrap_or(1.0);
        if d > 0.0 && n > 0.0 { n / d } else { 30.0 }
    };
    let duration = s["duration"]
        .as_str()
        .and_then(|d| d.parse().ok())
        .unwrap_or(format_duration);
    Ok(FullMediaInfo {
        width: s["width"].as_u64().unwrap_or(0) as u32,
        height: s["height"].as_u64().unwrap_or(0) as u32,
        fps,
        duration,
        has_audio,
    })
}

fn ring_budget_bytes() -> usize {
    std::env::var("MOTIONAIRE_RING_MB")
        .ok()
        .and_then(|v| v.parse::<usize>().ok())
        .unwrap_or(96)
        * 1024
        * 1024
}

pub struct Decoder {
    pub path: String,
    pub info: MediaInfo,
    short_name: String,
    child: Option<Child>,
    stdout: Option<ChildStdout>,
    cur_idx: i64, // frame index currently held in `frame`, -1 = none
    frame: Vec<u8>,
    frame_bytes: usize,
    // Trailing ring of decoded frames (idx ascending), byte-capped.
    ring: VecDeque<(i64, Box<[u8]>)>,
    ring_bytes: usize,
    ring_cap_bytes: usize,
    pub respawns: u64,
    pub child_deaths: u64,
    // Back-off after repeated immediate deaths (deleted/corrupt file): without
    // this, a missing source means one ffmpeg spawn attempt per rendered frame.
    consecutive_deaths: u32,
    next_retry: Option<std::time::Instant>,
}

const DEATHS_BEFORE_BACKOFF: u32 = 3;
const RETRY_COOLDOWN: std::time::Duration = std::time::Duration::from_secs(2);

impl Decoder {
    pub fn new(path: &str) -> Result<Self, String> {
        let info = probe(path)?;
        if info.width == 0 || info.height == 0 {
            return Err(format!("no video stream in {path}"));
        }
        let frame_bytes = (info.width * info.height * 4) as usize;
        let short_name = std::path::Path::new(path)
            .file_name()
            .map(|f| f.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string());
        Ok(Self {
            path: path.to_string(),
            info,
            short_name,
            child: None,
            stdout: None,
            cur_idx: -1,
            frame: vec![0u8; frame_bytes],
            frame_bytes,
            ring: VecDeque::new(),
            ring_bytes: 0,
            ring_cap_bytes: ring_budget_bytes(),
            respawns: 0,
            child_deaths: 0,
            consecutive_deaths: 0,
            next_retry: None,
        })
    }

    pub fn ring_capacity_frames(&self) -> i64 {
        (self.ring_cap_bytes / self.frame_bytes).max(4) as i64
    }

    fn respawn(&mut self, at_idx: i64, reason: &str) -> Result<(), String> {
        self.kill_child();
        // The ring requires contiguous indices; any seek invalidates it.
        self.ring.clear();
        self.ring_bytes = 0;
        self.respawns += 1;
        log::info!(
            "decoder[{}]: respawn #{} at frame {} ({reason})",
            self.short_name,
            self.respawns,
            at_idx
        );
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
        self.cur_idx = at_idx - 1;
        Ok(())
    }

    fn read_next(&mut self) -> bool {
        let Some(out) = self.stdout.as_mut() else { return false };
        match out.read_exact(&mut self.frame) {
            Ok(()) => {
                self.cur_idx += 1;
                self.push_ring(self.cur_idx);
                true
            }
            Err(_) => false, // EOF or dead child; classified by caller
        }
    }

    fn push_ring(&mut self, idx: i64) {
        self.ring.push_back((idx, self.frame.clone().into_boxed_slice()));
        self.ring_bytes += self.frame_bytes;
        while self.ring_bytes > self.ring_cap_bytes {
            if let Some((_, f)) = self.ring.pop_front() {
                self.ring_bytes -= f.len();
            } else {
                break;
            }
        }
    }

    fn ring_get(&self, idx: i64) -> Option<&[u8]> {
        // Ring indices are contiguous ascending; direct offset lookup.
        let first = self.ring.front()?.0;
        let offset = idx - first;
        if offset < 0 {
            return None;
        }
        self.ring.get(offset as usize).map(|(i, f)| {
            debug_assert_eq!(*i, idx);
            &f[..]
        })
    }

    fn last_frame_idx(&self) -> i64 {
        ((self.info.duration * self.info.fps).ceil() as i64 - 1).max(0)
    }

    // Frame covering source time `src_t`, or None before anything decoded.
    pub fn frame_at(&mut self, src_t: f64) -> Option<&[u8]> {
        // In back-off after repeated immediate deaths: serve nothing (or the
        // stale frame) until the cooldown expires, instead of spawning ffmpeg
        // per rendered frame against a gone/corrupt file.
        if let Some(at) = self.next_retry {
            if std::time::Instant::now() < at {
                return if self.cur_idx >= 0 { Some(&self.frame) } else { None };
            }
            self.next_retry = None;
        }

        let target = ((src_t * self.info.fps).floor() as i64).clamp(0, self.last_frame_idx());

        // Ring hit covers reverse playback and short back-scrubs at full rate.
        if target != self.cur_idx && self.ring_get(target).is_some() {
            return self.ring_get(target);
        }

        if target < self.cur_idx {
            // Backward miss: refill a whole chunk ending at `target` with one seek.
            let chunk = self.ring_capacity_frames().min(target + 1);
            let start = (target - chunk + 1).max(0);
            if self.respawn(start, "reverse chunk refill").is_err() {
                return None;
            }
        } else if self.child.is_none() {
            if self.respawn(target, "no active child").is_err() {
                return None;
            }
        } else if target > self.cur_idx + (self.info.fps as i64) * 2 {
            if self.respawn(target, "forward jump").is_err() {
                return None;
            }
        }

        let mut made_progress = false;
        while self.cur_idx < target {
            if self.read_next() {
                made_progress = true;
                continue;
            }
            // Premature EOF = dead/killed ffmpeg (real EOF only at file end).
            if self.cur_idx < self.last_frame_idx() - 1 {
                self.child_deaths += 1;
                self.consecutive_deaths += 1;
                log::warn!(
                    "decoder[{}]: ffmpeg pipe ended early at frame {} (death #{}) — respawning",
                    self.short_name,
                    self.cur_idx,
                    self.child_deaths
                );
                if self.consecutive_deaths >= DEATHS_BEFORE_BACKOFF {
                    log::error!(
                        "decoder[{}]: {} immediate deaths in a row — backing off {:?} (file deleted or corrupt?)",
                        self.short_name,
                        self.consecutive_deaths,
                        RETRY_COOLDOWN
                    );
                    self.next_retry = Some(std::time::Instant::now() + RETRY_COOLDOWN);
                    self.kill_child();
                    break;
                }
                let resume = (self.cur_idx + 1).max(0).min(target);
                if self.respawn(resume, "child died").is_err() {
                    break;
                }
                // One recovery attempt per frame_at call; if the pipe dies
                // again immediately, the next call (or back-off) handles it.
                if !self.read_next() {
                    break;
                }
                made_progress = true;
            } else {
                break; // legitimate end of file — hold last frame
            }
        }
        if made_progress {
            self.consecutive_deaths = 0;
        }
        if self.cur_idx >= 0 {
            Some(&self.frame)
        } else {
            None
        }
    }

    fn kill_child(&mut self) {
        if let Some(mut c) = self.child.take() {
            let _ = c.kill();
            let _ = c.wait();
        }
        self.stdout = None;
    }
}

impl Drop for Decoder {
    fn drop(&mut self) {
        self.kill_child();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Deterministic proof of the deleted-file back-off: generate a real file,
    // decode a frame, delete the file, then hammer frame_at — spawn attempts
    // must stop after DEATHS_BEFORE_BACKOFF and resume only after the cooldown.
    #[test]
    fn backoff_engages_when_source_vanishes() {
        let ffmpeg = ffmpeg_bin();
        if Command::new(&ffmpeg).arg("-version").stdout(Stdio::null()).stderr(Stdio::null()).status().is_err() {
            eprintln!("skipping: ffmpeg unavailable");
            return;
        }
        let dir = std::env::temp_dir().join(format!("motionaire-decoder-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("v.mp4");
        assert!(Command::new(&ffmpeg)
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-t", "2", "-pix_fmt", "yuv420p", file.to_str().unwrap()])
            .status()
            .unwrap()
            .success());

        let mut d = Decoder::new(file.to_str().unwrap()).unwrap();
        assert!(d.frame_at(0.5).is_some(), "healthy decode first");

        std::fs::remove_file(&file).unwrap();
        // Force respawns against the missing file: jump far forward each call
        // so the ring can't serve and a fresh spawn is required.
        d.kill_child();
        for i in 0..10 {
            let _ = d.frame_at(1.0 + (i % 3) as f64 * 0.2);
        }
        assert!(d.next_retry.is_some(), "back-off must engage after repeated deaths");
        let spawns_during_backoff = d.respawns;
        // Cooldown active: further calls must not spawn anything.
        for _ in 0..20 {
            let _ = d.frame_at(1.5);
        }
        assert_eq!(d.respawns, spawns_during_backoff, "no spawns while backing off");
        // Old frame is still served (stale better than black).
        assert!(d.frame_at(1.5).is_some());
    }
}
