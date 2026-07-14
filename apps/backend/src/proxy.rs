// Proxy generation (foundation session, Phase 5 — THE performance item).
// Mac screen recordings are Retina (3-5K); decoding them full-size through
// the ffmpeg pipe is exactly what chokes the compositor. On import the app
// requests a 720p-class proxy here; PREVIEW decodes proxies, EXPORT decodes
// originals — never the reverse (enforced at flatten()).

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

use tauri::Emitter;

use crate::compositor::decoder::{ffmpeg_bin, probe};

// One heavy transcode at a time — three parallel 4K encodes would starve the
// preview decoders. ponytail: a mutex is the whole queue.
static PROXY_LOCK: Mutex<()> = Mutex::new(());

pub fn cache_path(src: &str, cache_dir: &Path) -> PathBuf {
    let stem = Path::new(src).file_stem().and_then(|s| s.to_str()).unwrap_or("media");
    let size = std::fs::metadata(src).map(|m| m.len()).unwrap_or(0);
    // Keyed by stem+size (the filmstrip/CFR convention): a true content hash
    // of multi-GB footage costs a full read — logged tradeoff.
    cache_dir.join(format!("{stem}-{size}-proxy.mp4"))
}

pub fn generate(app: tauri::AppHandle, src: String, cache_dir: PathBuf) {
    std::thread::Builder::new()
        .name("proxy".into())
        .spawn(move || {
            let _serialize = PROXY_LOCK.lock().unwrap();
            match run(&app, &src, &cache_dir) {
                Ok(proxy) => {
                    log::info!("proxy: ready for {src} → {proxy}");
                    let _ = app.emit(
                        "proxy:done",
                        serde_json::json!({ "src": src, "proxyPath": proxy }),
                    );
                }
                Err(e) => {
                    log::error!("proxy: FAILED for {src}: {e}");
                    let _ = app
                        .emit("proxy:failed", serde_json::json!({ "src": src, "error": e }));
                }
            }
        })
        .ok();
}

fn run(app: &tauri::AppHandle, src: &str, cache_dir: &Path) -> Result<String, String> {
    std::fs::create_dir_all(cache_dir).map_err(|e| e.to_string())?;
    let out = cache_path(src, cache_dir);
    let out_str = out.to_string_lossy().into_owned();
    if out.exists() {
        return Ok(out_str); // cache hit: re-import of known footage is free
    }
    let info = probe(src)?;
    let duration_us = (info.duration * 1_000_000.0).max(1.0);

    let vt = Command::new(ffmpeg_bin())
        .args(["-hide_banner", "-encoders"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("h264_videotoolbox"))
        .unwrap_or(false);
    let tmp = out.with_extension("part.mp4");
    let tmp_str = tmp.to_string_lossy().into_owned();
    let mut args: Vec<String> = vec![
        "-v".into(), "error".into(),
        "-nostats".into(),
        "-progress".into(), "pipe:1".into(),
        "-y".into(),
        "-i".into(), src.into(),
        "-vf".into(), "scale=-2:720".into(),
    ];
    if vt {
        args.extend(["-c:v".into(), "h264_videotoolbox".into(), "-b:v".into(), "6M".into()]);
    } else {
        args.extend([
            "-c:v".into(), "libx264".into(),
            "-preset".into(), "veryfast".into(),
            "-crf".into(), "23".into(),
        ]);
    }
    args.extend([
        "-c:a".into(), "aac".into(), "-b:a".into(), "160k".into(),
        "-movflags".into(), "+faststart".into(),
        tmp_str.clone(),
    ]);

    let mut child = Command::new(ffmpeg_bin())
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("ffmpeg spawn: {e}"))?;

    if let Some(stdout) = child.stdout.take() {
        let mut last_emit = std::time::Instant::now();
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(v) = line.strip_prefix("out_time_us=") {
                if let Ok(us) = v.trim().parse::<f64>() {
                    if last_emit.elapsed().as_millis() > 300 {
                        last_emit = std::time::Instant::now();
                        let progress = (us / duration_us).clamp(0.0, 1.0);
                        let _ = app.emit(
                            "proxy:progress",
                            serde_json::json!({ "src": src, "progress": progress }),
                        );
                    }
                }
            }
        }
    }
    let status = child.wait().map_err(|e| e.to_string())?;
    if !status.success() || !tmp.exists() {
        let _ = std::fs::remove_file(&tmp);
        return Err("proxy transcode failed".into());
    }
    std::fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
    Ok(out_str)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cache_key_is_stem_plus_size() {
        let dir = std::env::temp_dir().join(format!("mo-proxy-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("a")).unwrap();
        std::fs::create_dir_all(dir.join("b")).unwrap();
        let f1 = dir.join("a/clip.mp4");
        let f2 = dir.join("b/clip.mp4");
        std::fs::write(&f1, vec![0u8; 100]).unwrap();
        std::fs::write(&f2, vec![0u8; 100]).unwrap();
        let cache = dir.join("cache");
        // Same stem + same size → same key (dedupe across copies).
        assert_eq!(
            cache_path(f1.to_str().unwrap(), &cache),
            cache_path(f2.to_str().unwrap(), &cache)
        );
        // Same stem, different size → different key.
        std::fs::write(&f2, vec![0u8; 200]).unwrap();
        assert_ne!(
            cache_path(f1.to_str().unwrap(), &cache),
            cache_path(f2.to_str().unwrap(), &cache)
        );
        // Key always lands inside the cache dir, .mp4 suffixed.
        let p = cache_path(f1.to_str().unwrap(), &cache);
        assert!(p.starts_with(&cache));
        assert!(p.to_string_lossy().ends_with("-proxy.mp4"));
        // Nonexistent source still yields a stable path (size 0), no panic.
        let ghost = cache_path("/nope/ghost.mp4", &cache);
        assert!(ghost.to_string_lossy().contains("ghost-0-proxy"));
    }
}
