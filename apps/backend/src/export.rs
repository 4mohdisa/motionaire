// Real export (session 9, Phase 5). The rule that saves weeks (CONTEXT.md
// §3.1): preview and export share the exact same compositor — this module
// drives GpuCompositor::render_at frame by frame at FULL resolution and pipes
// raw RGBA into FFmpeg. Audio is mixed by an FFmpeg filter graph built from
// the clip list (volume keyframes → piecewise-linear volume expressions);
// chosen over a Rust mixer as materially less code (logged in DECISIONS).

use std::io::Write;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use serde::Deserialize;
use tauri::Emitter;

use crate::compositor::gpu::GpuCompositor;
use crate::compositor::types::{SyncProject, TextRaster};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSettings {
    pub output_path: String,
    pub height: u32, // render height; width follows the canvas aspect
    pub fps: f64,
    pub duration: f64,
    pub quality: u32, // 0..100 from the panel
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioClipSpec {
    pub path: String,
    #[serde(rename = "in")]
    pub in_: f64,
    pub out: f64,
    pub speed: f64,
    pub start: f64,
    pub volume: f64,
    // (clip-relative timeline seconds, value) — linear segments; easing is
    // approximated linearly for audio (logged).
    pub volume_points: Vec<(f64, f64)>,
}

#[derive(Default)]
pub struct ExportManager {
    pub running: AtomicBool,
    pub cancel: AtomicBool,
    pub done: AtomicU64,
    pub total: AtomicU64,
}

pub type Exporter = Arc<ExportManager>;

fn has_videotoolbox() -> bool {
    Command::new(crate::compositor::decoder::ffmpeg_bin())
        .args(["-hide_banner", "-encoders"])
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).contains("h264_videotoolbox"))
        .unwrap_or(false)
}

// Piecewise-linear volume expression over the clip's local time axis
// (post atrim+asetpts, which matches keyframe storage: clip-relative
// timeline seconds).
fn volume_expr(base: f64, points: &[(f64, f64)]) -> String {
    if points.is_empty() {
        return format!("{base:.4}");
    }
    let mut pts: Vec<(f64, f64)> = points.to_vec();
    pts.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
    // Innermost value: last keyframe's value (held after the final point).
    let mut expr = format!("{:.4}", pts[pts.len() - 1].1);
    for w in (0..pts.len() - 1).rev() {
        let (t0, v0) = pts[w];
        let (t1, v1) = pts[w + 1];
        let seg = if (t1 - t0).abs() < 1e-9 {
            format!("{v1:.4}")
        } else {
            format!("({v0:.4}+({v1:.4}-{v0:.4})*(t-{t0:.4})/({t1:.4}-{t0:.4}))")
        };
        expr = format!("if(lt(t\\,{t1:.4})\\,{seg}\\,{expr})");
    }
    // Before the first keyframe: hold its value.
    format!("if(lt(t\\,{:.4})\\,{:.4}\\,{})", pts[0].0, pts[0].1, expr)
}

fn atempo_chain(speed: f64) -> String {
    // atempo accepts 0.5..2.0 per instance; chain to cover the rest.
    let mut s = speed.clamp(0.0625, 16.0);
    let mut parts = Vec::new();
    while s > 2.0 {
        parts.push("atempo=2.0".to_string());
        s /= 2.0;
    }
    while s < 0.5 {
        parts.push("atempo=0.5".to_string());
        s *= 2.0;
    }
    parts.push(format!("atempo={s:.6}"));
    parts.join(",")
}

fn build_audio_graph(clips: &[AudioClipSpec]) -> String {
    let mut chains = Vec::new();
    let mut outs = Vec::new();
    for (i, c) in clips.iter().enumerate() {
        let input = i + 1; // input 0 is the rawvideo pipe
        let delay_ms = (c.start * 1000.0).round().max(0.0) as u64;
        let vol = volume_expr(c.volume, &c.volume_points);
        let mut chain = format!(
            "[{input}:a]atrim=start={:.6}:end={:.6},asetpts=PTS-STARTPTS",
            c.in_, c.out
        );
        if (c.speed - 1.0).abs() > 1e-6 {
            chain.push(',');
            chain.push_str(&atempo_chain(c.speed));
        }
        chain.push_str(&format!(",volume=eval=frame:volume='{vol}'"));
        chain.push_str(&format!(",adelay={delay_ms}|{delay_ms}"));
        let tag = format!("[a{i}]");
        chain.push_str(&tag);
        chains.push(chain);
        outs.push(tag);
    }
    format!(
        "{};{}amix=inputs={}:normalize=0[aout]",
        chains.join(";"),
        outs.join(""),
        clips.len()
    )
}

#[allow(clippy::too_many_arguments)]
pub fn run_export(
    app: tauri::AppHandle,
    mgr: Exporter,
    project: SyncProject,
    texts: std::collections::HashMap<String, TextRaster>,
    audio: Vec<AudioClipSpec>,
    settings: ExportSettings,
) {
    let result = export_inner(&app, &mgr, project, texts, audio, &settings);
    mgr.running.store(false, Ordering::SeqCst);
    match result {
        Ok(()) => {
            log::info!("export: done → {}", settings.output_path);
            let _ = app.emit("export:done", serde_json::json!({ "ok": true }));
        }
        Err(e) => {
            log::error!("export: FAILED: {e}");
            // Never leave a half-written file behind.
            let _ = std::fs::remove_file(&settings.output_path);
            let cancelled = mgr.cancel.load(Ordering::SeqCst);
            let _ = app.emit(
                "export:done",
                serde_json::json!({ "ok": false, "cancelled": cancelled, "error": e }),
            );
        }
    }
}

fn export_inner(
    app: &tauri::AppHandle,
    mgr: &Exporter,
    project: SyncProject,
    texts: std::collections::HashMap<String, TextRaster>,
    audio: Vec<AudioClipSpec>,
    settings: &ExportSettings,
) -> Result<(), String> {
    let canvas_w = project.canvas.width;
    let canvas_h = project.canvas.height;
    // Width follows the canvas aspect at the requested height (logged).
    let mut gpu = GpuCompositor::new(canvas_w, canvas_h, settings.height.min(canvas_h))?;
    let (w, h) = (gpu.out_w, gpu.out_h);
    let fps = settings.fps.max(1.0);
    let total = (settings.duration * fps).ceil().max(1.0) as u64;
    mgr.total.store(total, Ordering::SeqCst);
    mgr.done.store(0, Ordering::SeqCst);

    let vt = has_videotoolbox();
    let ffmpeg = crate::compositor::decoder::ffmpeg_bin();
    let mut args: Vec<String> = vec![
        "-y".into(),
        "-f".into(),
        "rawvideo".into(),
        "-pix_fmt".into(),
        "rgba".into(),
        "-s".into(),
        format!("{w}x{h}"),
        "-r".into(),
        format!("{fps}"),
        "-i".into(),
        "pipe:0".into(),
    ];
    for c in &audio {
        args.push("-i".into());
        args.push(c.path.clone());
    }
    if !audio.is_empty() {
        args.push("-filter_complex".into());
        args.push(build_audio_graph(&audio));
        args.push("-map".into());
        args.push("0:v".into());
        args.push("-map".into());
        args.push("[aout]".into());
        args.push("-c:a".into());
        args.push("aac".into());
        args.push("-b:a".into());
        args.push("192k".into());
    } else {
        args.push("-map".into());
        args.push("0:v".into());
        args.push("-an".into());
    }
    let q = settings.quality.min(100);
    if vt {
        // Bitrate heuristic scaled by pixel count relative to 1080p.
        let px_scale = (w as f64 * h as f64) / (1920.0 * 1080.0);
        let kbps = ((3000.0 + q as f64 * 150.0) * px_scale).round() as u64;
        args.extend(["-c:v".into(), "h264_videotoolbox".into(), "-b:v".into(), format!("{kbps}k")]);
    } else {
        let crf = (30.0 - q as f64 * 0.16).round().clamp(14.0, 30.0);
        args.extend([
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "veryfast".into(),
            "-crf".into(),
            format!("{crf}"),
        ]);
    }
    args.extend([
        "-pix_fmt".into(),
        "yuv420p".into(),
        "-t".into(),
        format!("{:.6}", settings.duration),
        "-movflags".into(),
        "+faststart".into(),
        settings.output_path.clone(),
    ]);

    log::info!(
        "export: {}x{} @{fps}fps, {total} frames, encoder={}, {} audio clip(s) → {}",
        w,
        h,
        if vt { "videotoolbox" } else { "x264" },
        audio.len(),
        settings.output_path
    );

    let mut child = Command::new(&ffmpeg)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("ffmpeg spawn: {e}"))?;
    let mut stdin = child.stdin.take().ok_or("no ffmpeg stdin")?;

    let mut frame_err: Option<String> = None;
    for n in 0..total {
        if mgr.cancel.load(Ordering::SeqCst) {
            frame_err = Some("cancelled".into());
            break;
        }
        let t = n as f64 / fps;
        let rgba = gpu.render_at(&project, t, &texts)?;
        if let Err(e) = stdin.write_all(&rgba) {
            frame_err = Some(format!("ffmpeg pipe closed at frame {n}: {e}"));
            break;
        }
        let done = n + 1;
        mgr.done.store(done, Ordering::SeqCst);
        if done % 15 == 0 || done == total {
            let _ = app.emit("export:progress", serde_json::json!({ "done": done, "total": total }));
        }
    }
    drop(stdin); // EOF → ffmpeg finalizes

    if mgr.cancel.load(Ordering::SeqCst) {
        let _ = child.kill();
        let _ = child.wait();
        return Err("cancelled".into());
    }
    let out = child.wait_with_output().map_err(|e| format!("ffmpeg wait: {e}"))?;
    if let Some(e) = frame_err {
        return Err(format!("{e}; ffmpeg: {}", String::from_utf8_lossy(&out.stderr)));
    }
    if !out.status.success() {
        return Err(format!("ffmpeg failed: {}", String::from_utf8_lossy(&out.stderr)));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn volume_expr_shapes() {
        assert_eq!(volume_expr(0.8, &[]), "0.8000");
        let e = volume_expr(1.0, &[(0.0, 1.0), (2.0, 0.0)]);
        assert!(e.contains("lt(t\\,2.0000)"), "{e}");
        assert!(e.starts_with("if(lt(t\\,0.0000)"), "{e}");
    }

    #[test]
    fn atempo_chains() {
        assert_eq!(atempo_chain(1.5), "atempo=1.500000");
        assert_eq!(atempo_chain(4.0), "atempo=2.0,atempo=2.000000");
        assert_eq!(atempo_chain(0.25), "atempo=0.5,atempo=0.500000");
    }
}
