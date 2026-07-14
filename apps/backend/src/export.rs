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
    // Project output gain (foundation, Phase 3).
    #[serde(default = "default_master")]
    pub master_volume: f64,
    // Export range start (foundation, Phase 6): render begins at this
    // timeline second; audio specs arrive already range-relative.
    #[serde(default)]
    pub start: f64,
    // mp4 (h264) | hevc | prores | m4a | gif | png (foundation, Phase 6)
    #[serde(default = "default_format")]
    pub format: String,
    // Chapter markers (pro-editor Phase 8): (seconds-from-export-start,
    // title) — embedded as FFMETADATA chapters in container formats.
    #[serde(default)]
    pub chapters: Vec<(f64, String)>,
}

fn default_format() -> String {
    "mp4".into()
}

fn default_master() -> f64 {
    1.0
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
    // approximated linearly for audio (logged; the frontend pre-samples eased
    // curves densely since Foundation Phase 1).
    pub volume_points: Vec<(f64, f64)>,
    // Stereo balance -1..1 (foundation, Phase 3).
    #[serde(default)]
    pub pan: f64,
    // Audio effect chain (pro-editor session, Phase 6): pre-built FFmpeg
    // filter fragments (e.g. "acompressor=..."), applied IN ORDER after
    // trim/tempo and before volume. The frontend builds these from the
    // clip's effect stack via audio_fx_filter().
    #[serde(default)]
    pub fx: Vec<String>,
    // Track id: clips group into per-track submixes so TRACK effects can
    // apply to the summed track (Phase 6).
    #[serde(default)]
    pub track: String,
    // Track-level effect chain (same fragments), applied to the submix.
    #[serde(default)]
    pub track_fx: Vec<String>,
}

pub struct ExportJob {
    pub project: SyncProject,
    pub texts: std::collections::HashMap<String, TextRaster>,
    pub audio: Vec<AudioClipSpec>,
    pub settings: ExportSettings,
}

#[derive(Default)]
pub struct ExportManager {
    pub running: AtomicBool,
    pub cancel: AtomicBool,
    pub done: AtomicU64,
    pub total: AtomicU64,
    // Background queue (foundation, Phase 6): exports submitted while one
    // runs wait here; the worker drains it.
    pub queue: std::sync::Mutex<std::collections::VecDeque<ExportJob>>,
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

fn build_audio_graph(clips: &[AudioClipSpec], master: f64) -> String {
    let mut chains = Vec::new();
    let mut clip_tags: Vec<(String, String)> = Vec::new(); // (track, tag)
    for (i, c) in clips.iter().enumerate() {
        let input = i + 1; // input 0 is the rawvideo pipe
        let delay_ms = (c.start * 1000.0).round().max(0.0) as u64;
        let vol = volume_expr(c.volume, &c.volume_points);
        // aformat first: pan expressions need a stereo layout even for mono
        // sources, and amix behaves best with uniform layouts.
        let mut chain = format!(
            "[{input}:a]atrim=start={:.6}:end={:.6},asetpts=PTS-STARTPTS,aformat=channel_layouts=stereo",
            c.in_, c.out
        );
        if (c.speed - 1.0).abs() > 1e-6 {
            chain.push(',');
            chain.push_str(&atempo_chain(c.speed));
        }
        // Clip effect chain (Phase 6): IN ORDER, pre-volume — matching the
        // preview graph's element → fx → gain topology.
        for f in &c.fx {
            chain.push(',');
            chain.push_str(f);
        }
        chain.push_str(&format!(",volume=eval=frame:volume='{vol}'"));
        if c.pan.abs() > 1e-6 {
            // Simple balance law: attenuate the far channel.
            let gl = (1.0 - c.pan).min(1.0).max(0.0);
            let gr = (1.0 + c.pan).min(1.0).max(0.0);
            chain.push_str(&format!(",pan=stereo|c0={gl:.4}*c0|c1={gr:.4}*c1"));
        }
        chain.push_str(&format!(",adelay={delay_ms}|{delay_ms}"));
        let tag = format!("[a{i}]");
        chain.push_str(&tag);
        chains.push(chain);
        clip_tags.push((c.track.clone(), tag));
    }

    // Per-track submix so TRACK effects hit the summed track (Phase 6).
    // Track order follows first appearance; a track's fx come from the first
    // clip carrying them (the frontend sends identical copies per clip).
    let mut track_order: Vec<String> = Vec::new();
    for (t, _) in &clip_tags {
        if !track_order.contains(t) {
            track_order.push(t.clone());
        }
    }
    let mut track_tags = Vec::new();
    for (ti, tid) in track_order.iter().enumerate() {
        let members: Vec<&String> =
            clip_tags.iter().filter(|(t, _)| t == tid).map(|(_, tag)| tag).collect();
        let track_fx: &[String] = clips
            .iter()
            .find(|c| &c.track == tid && !c.track_fx.is_empty())
            .map(|c| c.track_fx.as_slice())
            .unwrap_or(&[]);
        if members.len() == 1 && track_fx.is_empty() {
            // No submix needed — the clip tag feeds the master mix directly.
            track_tags.push(members[0].clone());
            continue;
        }
        let ttag = format!("[t{ti}]");
        let mut chain = format!(
            "{}amix=inputs={}:normalize=0",
            members.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(""),
            members.len()
        );
        for f in track_fx {
            chain.push(',');
            chain.push_str(f);
        }
        chain.push_str(&ttag);
        chains.push(chain);
        track_tags.push(ttag);
    }

    let master_tail = if (master - 1.0).abs() > 1e-6 {
        format!(",volume={master:.4}")
    } else {
        String::new()
    };
    if track_tags.len() == 1 {
        // Single source: amix of one input is legal but pointless; a null
        // pass-through keeps [aout] labeled.
        return format!(
            "{};{}anull{}[aout]",
            chains.join(";"),
            track_tags[0],
            master_tail
        );
    }
    format!(
        "{};{}amix=inputs={}:normalize=0{}[aout]",
        chains.join(";"),
        track_tags.join(""),
        track_tags.len(),
        master_tail
    )
}

#[allow(clippy::too_many_arguments)]
pub fn run_export(app: tauri::AppHandle, mgr: Exporter, job: ExportJob) {
    let mut job = job;
    loop {
        let ExportJob { project, texts, audio, settings } = job;
        let result = export_inner(&app, &mgr, project, texts, audio, &settings);
        match result {
            Ok(()) => {
                log::info!("export: done → {}", settings.output_path);
                let _ = app.emit(
                    "export:done",
                    serde_json::json!({ "ok": true, "path": settings.output_path }),
                );
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
        // Drain the queue (cancel clears only the current job).
        mgr.cancel.store(false, Ordering::SeqCst);
        let next = mgr.queue.lock().unwrap().pop_front();
        match next {
            Some(n) => {
                job = n;
                let _ = app.emit("export:dequeued", serde_json::json!({}));
            }
            None => break,
        }
    }
    mgr.running.store(false, Ordering::SeqCst);
}

fn export_inner(
    app: &tauri::AppHandle,
    mgr: &Exporter,
    project: SyncProject,
    texts: std::collections::HashMap<String, TextRaster>,
    audio: Vec<AudioClipSpec>,
    settings: &ExportSettings,
) -> Result<(), String> {
    if settings.format == "m4a" {
        return export_audio_only(mgr, &audio, settings);
    }
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
    let audio_capable = !matches!(settings.format.as_str(), "gif" | "png");
    let audio: Vec<AudioClipSpec> = if audio_capable { audio } else { Vec::new() };
    for c in &audio {
        args.push("-i".into());
        args.push(c.path.clone());
    }
    // Embedded chapters (Phase 8): an FFMETADATA side input after the audio
    // inputs; container formats only.
    let mut meta_input: Option<usize> = None;
    if !settings.chapters.is_empty()
        && matches!(settings.format.as_str(), "mp4" | "hevc" | "prores" | "m4a")
    {
        let mut meta = String::from(";FFMETADATA1\n");
        for (i, (t, title)) in settings.chapters.iter().enumerate() {
            let start_ms = (t * 1000.0).round().max(0.0) as u64;
            let end_ms = settings
                .chapters
                .get(i + 1)
                .map(|(t2, _)| (t2 * 1000.0).round() as u64)
                .unwrap_or(((settings.duration) * 1000.0).round() as u64)
                .max(start_ms + 1);
            meta.push_str(&format!(
                "[CHAPTER]\nTIMEBASE=1/1000\nSTART={start_ms}\nEND={end_ms}\ntitle={}\n",
                title.replace(['\n', '\r'], " ")
            ));
        }
        let meta_path = std::env::temp_dir().join("motionaire-chapters.ffmeta");
        if std::fs::write(&meta_path, meta).is_ok() {
            args.push("-i".into());
            args.push(meta_path.to_string_lossy().into_owned());
            meta_input = Some(1 + audio.len());
        }
    }
    if let Some(mi) = meta_input {
        args.push("-map_metadata".into());
        args.push(mi.to_string());
    }
    if !audio.is_empty() {
        args.push("-filter_complex".into());
        args.push(build_audio_graph(&audio, settings.master_volume));
        args.push("-map".into());
        args.push("0:v".into());
        args.push("-map".into());
        args.push("[aout]".into());
        if settings.format == "prores" {
            args.push("-c:a".into());
            args.push("pcm_s16le".into());
        } else {
            args.push("-c:a".into());
            args.push("aac".into());
            args.push("-b:a".into());
            args.push("192k".into());
        }
    } else {
        args.push("-map".into());
        // GIF's palette filter consumes [0:v]; map its labeled output instead.
        args.push(if settings.format == "gif" { "[gout]".into() } else { "0:v".to_string() });
        args.push("-an".into());
    }
    let q = settings.quality.min(100);
    let px_scale = (w as f64 * h as f64) / (1920.0 * 1080.0);
    let kbps = ((3000.0 + q as f64 * 150.0) * px_scale).round() as u64;
    let crf = (30.0 - q as f64 * 0.16).round().clamp(14.0, 30.0);
    match settings.format.as_str() {
        "hevc" => {
            if vt {
                args.extend([
                    "-c:v".into(), "hevc_videotoolbox".into(),
                    "-b:v".into(), format!("{kbps}k"),
                    "-tag:v".into(), "hvc1".into(), // QuickTime compatibility
                ]);
            } else {
                args.extend([
                    "-c:v".into(), "libx265".into(),
                    "-preset".into(), "fast".into(),
                    "-crf".into(), format!("{crf}"),
                    "-tag:v".into(), "hvc1".into(),
                ]);
            }
            args.extend(["-pix_fmt".into(), "yuv420p".into()]);
        }
        "prores" => {
            // ProRes 422 Standard; VideoToolbox on Apple Silicon, prores_ks fallback.
            if vt {
                args.extend(["-c:v".into(), "prores_videotoolbox".into(), "-profile:v".into(), "2".into()]);
            } else {
                args.extend(["-c:v".into(), "prores_ks".into(), "-profile:v".into(), "2".into()]);
            }
        }
        "gif" => {
            // Palette in one pass; GIF caps at 15fps and has no audio.
            args.extend([
                "-filter_complex".into(),
                "[0:v]fps=15,split[ga][gb];[ga]palettegen=stats_mode=diff[p];[gb][p]paletteuse=dither=bayer[gout]".into(),
            ]);
        }
        "png" => {
            args.extend(["-f".into(), "image2".into()]);
        }
        _ => {
            // mp4 / h264 — the original path.
            if vt {
                args.extend(["-c:v".into(), "h264_videotoolbox".into(), "-b:v".into(), format!("{kbps}k")]);
            } else {
                args.extend([
                    "-c:v".into(), "libx264".into(),
                    "-preset".into(), "veryfast".into(),
                    "-crf".into(), format!("{crf}"),
                ]);
            }
            args.extend(["-pix_fmt".into(), "yuv420p".into()]);
        }
    }
    args.extend(["-t".into(), format!("{:.6}", settings.duration)]);
    if matches!(settings.format.as_str(), "mp4" | "hevc") {
        args.extend(["-movflags".into(), "+faststart".into()]);
    }
    // PNG sequence writes a numbered pattern next to the chosen name.
    let out_path = if settings.format == "png" {
        settings.output_path.replace(".png", "-%05d.png")
    } else {
        settings.output_path.clone()
    };
    args.push(out_path);

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
        let t = settings.start + n as f64 / fps;
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
    fn graph_includes_pan_stereo_format_and_master() {
        let clips = vec![AudioClipSpec {
            path: "x.wav".into(),
            in_: 0.0,
            out: 2.0,
            speed: 1.0,
            start: 0.0,
            volume: 1.0,
            volume_points: vec![],
            pan: -0.5,
            fx: vec![],
            track: String::new(),
            track_fx: vec![],
        }];
        let g = build_audio_graph(&clips, 0.8);
        assert!(g.contains("aformat=channel_layouts=stereo"), "{g}");
        assert!(g.contains("pan=stereo|c0=1.0000*c0|c1=0.5000*c1"), "{g}");
        // Single source: null pass-through + master tail (Phase 6 restructure).
        assert!(g.contains("anull,volume=0.8000[aout]"), "{g}");
        // pan 0 / master 1 → no pan node, no master tail
        let g2 = build_audio_graph(
            &[AudioClipSpec {
                path: "x.wav".into(),
                in_: 0.0,
                out: 2.0,
                speed: 1.0,
                start: 0.0,
                volume: 1.0,
                volume_points: vec![],
                pan: 0.0,
            fx: vec![],
            track: String::new(),
            track_fx: vec![],
            }],
            1.0,
        );
        assert!(!g2.contains("pan=stereo|"), "{g2}");
        assert!(g2.contains("anull[aout]"), "{g2}");
    }

    #[test]
    fn volume_expr_sorts_unsorted_points() {
        // Callers pass keyframes in storage order; the expr must be built in
        // time order or every window boundary is wrong.
        let a = volume_expr(1.0, &[(2.0, 0.0), (0.0, 1.0)]);
        let b = volume_expr(1.0, &[(0.0, 1.0), (2.0, 0.0)]);
        assert_eq!(a, b);
    }

    #[test]
    fn multi_clip_graph_indexing_and_delay() {
        let mk = |start: f64| AudioClipSpec {
            path: "x.wav".into(),
            in_: 0.0,
            out: 1.0,
            speed: 1.0,
            start,
            volume: 1.0,
            volume_points: vec![],
            pan: 0.0,
            fx: vec![],
            track: String::new(),
            track_fx: vec![],
        };
        let g = build_audio_graph(&[mk(0.0), mk(2.5)], 1.0);
        // Input 0 is the rawvideo pipe: audio inputs are 1-based.
        assert!(g.contains("[1:a]"), "{g}");
        assert!(g.contains("[2:a]"), "{g}");
        assert!(g.contains("adelay=2500|2500"), "{g}");
        assert!(g.contains("amix=inputs=2:normalize=0"), "{g}");
    }

    #[test]
    fn clip_fx_and_track_submix_with_track_fx() {
        let mk = |start: f64, track: &str| AudioClipSpec {
            path: "x.wav".into(),
            in_: 0.0,
            out: 1.0,
            speed: 1.0,
            start,
            volume: 1.0,
            volume_points: vec![],
            pan: 0.0,
            fx: vec!["acompressor=threshold=0.1:ratio=8".into()],
            track: track.into(),
            track_fx: vec!["highshelf=g=-12:f=6000".into()],
        };
        let g = build_audio_graph(&[mk(0.0, "t1"), mk(2.0, "t1")], 1.0);
        // Clip fx sit AFTER tempo/trim and BEFORE volume…
        assert!(
            g.contains("stereo,acompressor=threshold=0.1:ratio=8,volume="),
            "{g}"
        );
        // …and the track submix applies track fx to the SUM of both clips.
        assert!(g.contains("[a0][a1]amix=inputs=2:normalize=0,highshelf=g=-12:f=6000[t0]"), "{g}");
        assert!(g.contains("[t0]anull[aout]"), "{g}");
        // Two tracks → two submixes into the master mix.
        let g2 = build_audio_graph(&[mk(0.0, "t1"), mk(0.0, "t2")], 1.0);
        assert!(g2.contains("amix=inputs=2:normalize=0[aout]") || g2.contains("[t0][t1]"), "{g2}");
    }

    #[test]
    fn atempo_chains() {
        assert_eq!(atempo_chain(1.5), "atempo=1.500000");
        assert_eq!(atempo_chain(4.0), "atempo=2.0,atempo=2.000000");
        assert_eq!(atempo_chain(0.25), "atempo=0.5,atempo=0.500000");
        // Boundaries: exactly 2.0 needs no chain; absurd speeds clamp.
        assert_eq!(atempo_chain(2.0), "atempo=2.000000");
        assert!(atempo_chain(0.001).starts_with("atempo=0.5")); // clamped at 0.0625
        assert!(!atempo_chain(100.0).contains("atempo=6")); // clamped at 16
    }
}


// Audio-only export (foundation, Phase 6): the mix graph without the video
// pipe — no GPU, no frame loop; the mix is effectively instant.
fn export_audio_only(
    mgr: &Exporter,
    audio: &[AudioClipSpec],
    settings: &ExportSettings,
) -> Result<(), String> {
    if audio.is_empty() {
        return Err("No audible clips in the export range.".into());
    }
    mgr.total.store(1, Ordering::SeqCst);
    mgr.done.store(0, Ordering::SeqCst);
    let ffmpeg = crate::compositor::decoder::ffmpeg_bin();
    let mut args: Vec<String> = vec!["-y".into()];
    for c in audio {
        args.push("-i".into());
        args.push(c.path.clone());
    }
    // The graph indexes inputs from 1 (video pipe convention); with no video
    // input, shift by feeding a dummy silent first input.
    args.splice(1..1, ["-f".into(), "lavfi".into(), "-i".into(), "anullsrc=r=48000:cl=stereo".into()]);
    args.extend([
        "-filter_complex".into(),
        build_audio_graph(audio, settings.master_volume),
        "-map".into(), "[aout]".into(),
        "-vn".into(),
        "-c:a".into(), "aac".into(),
        "-b:a".into(), "192k".into(),
        "-t".into(), format!("{:.6}", settings.duration),
        settings.output_path.clone(),
    ]);
    let status = Command::new(&ffmpeg)
        .args(&args)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("ffmpeg spawn: {e}"))?;
    if !status.status.success() {
        return Err(format!("ffmpeg failed: {}", String::from_utf8_lossy(&status.stderr)));
    }
    mgr.done.store(1, Ordering::SeqCst);
    Ok(())
}
