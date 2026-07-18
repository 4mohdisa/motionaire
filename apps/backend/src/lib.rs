pub mod capture;
pub mod ai;
pub mod compositor;
pub mod export;
pub mod license;
pub mod proxy;
pub mod menu;
pub mod persistence;

use std::path::PathBuf;

use compositor::types::SyncProject;
use compositor::Compositor;
use tauri::{Emitter, Manager, State};

#[tauri::command]
fn sync_project(state: State<Compositor>, project: SyncProject) {
    log::info!(
        "sync_project: {} layer(s), first id: {:?}",
        project.layers.len(),
        project.layers.first().map(|l| l.id.as_str())
    );
    state.set_project(project);
}

#[tauri::command]
fn set_playhead(state: State<Compositor>, t: f64, playing: bool, rate: Option<f64>) {
    state.set_playhead(t, playing, rate.unwrap_or(1.0));
}

#[tauri::command]
fn set_preview_quality(state: State<Compositor>, full: bool) {
    state.set_preview_full(full);
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TextRasterMsg {
    clip_id: String,
    hash: String,
    width: u32,
    height: u32,
    png_base64: String,
}

// Text-into-compositor (session 9, Phase 4): the webview rasterizes each text
// clip on change (never per frame) and ships it here; the compositor treats
// it as one more texture layer.
#[tauri::command]
fn set_text_rasters(
    state: State<Compositor>,
    rasters: Vec<TextRasterMsg>,
    live: Vec<String>,
) -> Result<(), String> {
    use base64::Engine as _;
    let mut upserts = Vec::new();
    for m in rasters {
        let png_bytes = base64::engine::general_purpose::STANDARD
            .decode(&m.png_base64)
            .map_err(|e| format!("raster base64: {e}"))?;
        let decoder = png::Decoder::new(std::io::Cursor::new(png_bytes));
        let mut reader = decoder.read_info().map_err(|e| format!("raster png: {e}"))?;
        let mut buf = vec![0u8; reader.output_buffer_size().ok_or("raster too large")?];
        let info = reader.next_frame(&mut buf).map_err(|e| format!("raster png frame: {e}"))?;
        if info.width != m.width || info.height != m.height {
            return Err("raster dims mismatch".into());
        }
        let rgba = match info.color_type {
            png::ColorType::Rgba => buf[..(info.width * info.height * 4) as usize].to_vec(),
            png::ColorType::Rgb => {
                let n = (info.width * info.height) as usize;
                let mut out = Vec::with_capacity(n * 4);
                for px in buf[..n * 3].chunks_exact(3) {
                    out.extend_from_slice(px);
                    out.push(255);
                }
                out
            }
            other => return Err(format!("unsupported raster color type {other:?}")),
        };
        upserts.push((
            m.clip_id,
            compositor::types::TextRaster { hash: m.hash, w: m.width, h: m.height, rgba },
        ));
    }
    state.set_text_rasters(upserts, live);
    Ok(())
}

#[tauri::command]
fn spike_setup() -> Result<(compositor::demo::SpikeMedia, compositor::demo::SpikeMedia), String> {
    compositor::demo::spike_media_info()
}

// Verification helper: a deterministic 440Hz tone in the spike dir, so export
// tests have real audio to mix (the demo videos are silent by design).
#[tauri::command]
fn spike_audio(pattern: Option<String>) -> Result<String, String> {
    let dir = compositor::demo::spike_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let gapped = pattern.as_deref() == Some("gapped");
    let out = dir.join(if gapped { "tone-gapped.wav" } else { "tone.wav" });
    if !out.exists() {
        let mut args: Vec<String> = vec![
            "-v".into(), "error".into(), "-y".into(),
            "-f".into(), "lavfi".into(),
            "-i".into(), "sine=frequency=440:duration=10".into(),
        ];
        if gapped {
            // 1s on / 1s off — deterministic "speech" for the ducking test.
            args.push("-af".into());
            args.push("volume='if(lt(mod(t\\,2)\\,1)\\,1\\,0)':eval=frame".into());
        }
        args.extend(["-ar".into(), "48000".into(), out.to_str().ok_or("bad path")?.into()]);
        let status = std::process::Command::new(compositor::decoder::ffmpeg_bin())
            .args(&args)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("tone generation failed".into());
        }
    }
    Ok(out.to_string_lossy().into_owned())
}

#[tauri::command]
fn autorun_demo() -> bool {
    std::env::var("SPIKE_DEMO").is_ok_and(|v| v == "1")
}

// Dev harness: lets env-gated webview self-tests check flags and report results
// into the Rust log (the only channel visible from outside the webview).
#[tauri::command]
fn env_flag(name: String) -> bool {
    if !name.starts_with("SPIKE_") {
        return false;
    }
    std::env::var(name).is_ok_and(|v| v == "1")
}

#[tauri::command]
fn report_test(name: String, pass: bool, detail: String) {
    if pass {
        log::info!("WEBVIEW-TEST PASS [{name}] {detail}");
    } else {
        log::error!("WEBVIEW-TEST FAIL [{name}] {detail}");
    }
}

fn db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("motionaire.db"))
}

#[tauri::command]
fn probe_media(path: String) -> Result<compositor::decoder::FullMediaInfo, String> {
    compositor::decoder::probe_full(&path)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ParitySample {
    id: String,
    t: f64,
    x: f32,
    y: f32,
    scale: f32,
    rotation: f32,
    opacity: f32,
    corner_radius: f32,
    grade: [f32; 5],
    fx0: [f32; 2],
    src_t: f64,
}

// Foundation Phase 1: Rust is the single source of truth for property
// resolution. This probe runs the PRODUCTION resolver (resolve_layer +
// source_time — the exact code preview and export render with) over a
// fixture so the webview can assert its display-only mirror agrees.
// Any drift fails the f1-parity self-test loudly.
#[tauri::command]
fn resolve_parity_probe(project: SyncProject, times: Vec<f64>) -> Vec<ParitySample> {
    let mut out = Vec::new();
    for &t in &times {
        for layer in &project.layers {
            let r = compositor::keyframes::resolve_layer(layer, t);
            out.push(ParitySample {
                id: layer.id.clone(),
                t,
                x: r.x,
                y: r.y,
                scale: r.scale,
                rotation: r.rotation_deg,
                opacity: r.opacity,
                corner_radius: r.corner_radius,
                grade: r.grade,
                // First chain op's first two params (Phase 2): enough to pin
                // per-instance fx.<id>.<param> resolution against the mirror.
                fx0: r.chain.first().map(|c| [c.p[0], c.p[1]]).unwrap_or([0.0, 0.0]),
                src_t: layer.source_time(t),
            });
        }
    }
    out
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NormalizedMedia {
    path: String,
    was_vfr: bool,
}

// CONTEXT.md §6: VFR footage (screen recorders!) is normalized to CFR on
// import; the project references the normalized copy in the app cache.
#[tauri::command]
fn normalize_media(app: tauri::AppHandle, path: String) -> Result<NormalizedMedia, String> {
    let cache = app.path().app_data_dir().map_err(|e| e.to_string())?.join("normalized");
    let (p, was_vfr) = compositor::decoder::normalize_to_cfr(&path, &cache)?;
    Ok(NormalizedMedia { path: p, was_vfr })
}

// Font import: read the file once; bytes travel as base64 and are embedded in
// the bundle on save (persistence::save_fonts).
#[tauri::command]
fn import_font(path: String) -> Result<persistence::BundleFont, String> {
    use base64::Engine as _;
    let p = std::path::Path::new(&path);
    let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if ext != "ttf" && ext != "otf" {
        return Err("only .ttf/.otf fonts are supported".into());
    }
    let bytes = std::fs::read(p).map_err(|e| format!("read font: {e}"))?;
    if bytes.len() > 10 * 1024 * 1024 {
        return Err("font file too large (>10MB)".into());
    }
    Ok(persistence::BundleFont {
        file_name: p.file_name().unwrap_or_default().to_string_lossy().into_owned(),
        data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
    })
}

#[tauri::command]
fn save_fonts(bundle_path: String, fonts: Vec<persistence::BundleFont>) -> Result<(), String> {
    persistence::save_fonts(std::path::Path::new(&bundle_path), &fonts)
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct Filmstrip {
    path: String,
    width: u32,
    height: u32,
    frames: u32,
    duration: f64,
}

// Hover-scrub filmstrip: N frames sampled evenly across the source, tiled
// into ONE horizontal strip PNG in the app cache. Pre-sampled once per media
// — hovering never touches a live decoder.
#[tauri::command]
fn extract_filmstrip(app: tauri::AppHandle, path: String) -> Result<Filmstrip, String> {
    const N: u32 = 20;
    const H: u32 = 56;
    let info = compositor::decoder::probe(&path)?;
    if info.width == 0 || info.duration <= 0.0 {
        return Err("no video stream / zero duration".into());
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("filmstrips");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem = std::path::Path::new(&path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("strip");
    // ponytail: cache key is stem+N+H; a re-rendered source at the same path
    // serves a stale strip until the cache file is deleted.
    let out = dir.join(format!("{stem}-{N}x{H}.png"));
    let out_str = out.to_str().ok_or("bad output path")?.to_string();
    if !out.exists() {
        let vf = format!("fps={N}/{:.6},scale=-2:{H},tile={N}x1", info.duration);
        let status = std::process::Command::new(compositor::decoder::ffmpeg_bin())
            .args(["-v", "error", "-y", "-i", &path, "-vf", &vf, "-frames:v", "1", &out_str])
            .status()
            .map_err(|e| format!("ffmpeg spawn: {e}"))?;
        if !status.success() || !out.exists() {
            return Err(format!("filmstrip extraction failed for {path}"));
        }
    }
    let strip = compositor::decoder::probe(&out_str)?;
    Ok(Filmstrip {
        path: out_str,
        width: strip.width,
        height: strip.height,
        frames: N,
        duration: info.duration,
    })
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct FrozenFrame {
    path: String,
    width: u32,
    height: u32,
}

// Freeze frame: extract one still from a source at `time` into the app cache.
// The PNG is ordinary media afterwards — the decoder serves a single-frame
// source natively (duration 0 → frame 0 forever), no special image pipeline.
#[tauri::command]
fn extract_frame(app: tauri::AppHandle, path: String, time: f64) -> Result<FrozenFrame, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("freeze");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem = std::path::Path::new(&path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("frame");
    let out = dir.join(format!("{stem}-{}ms.png", (time * 1000.0).round() as i64));
    let out_str = out.to_str().ok_or("bad output path")?.to_string();
    let status = std::process::Command::new(compositor::decoder::ffmpeg_bin())
        .args(["-v", "error", "-y", "-ss", &format!("{time:.6}"), "-i", &path, "-frames:v", "1", &out_str])
        .status()
        .map_err(|e| format!("ffmpeg spawn: {e}"))?;
    if !status.success() || !out.exists() {
        return Err(format!("frame extraction failed for {path} at {time:.3}s"));
    }
    let info = compositor::decoder::probe(&out_str)?;
    Ok(FrozenFrame { path: out_str, width: info.width, height: info.height })
}

#[tauri::command]
fn start_export(
    app: tauri::AppHandle,
    comp: State<Compositor>,
    exporter: State<export::Exporter>,
    project: SyncProject,
    audio: Vec<export::AudioClipSpec>,
    settings: export::ExportSettings,
) -> Result<(), String> {
    use std::sync::atomic::Ordering;
    let texts = comp.clone_text_rasters();
    let job = export::ExportJob { project, texts, audio, settings };
    if exporter.running.swap(true, Ordering::SeqCst) {
        // Background queue (foundation, Phase 6): keep working, we'll run it.
        exporter.queue.lock().unwrap().push_back(job);
        let depth = exporter.queue.lock().unwrap().len();
        let _ = app.emit("export:queued", serde_json::json!({ "depth": depth }));
        return Ok(());
    }
    exporter.cancel.store(false, Ordering::SeqCst);
    let mgr = exporter.inner().clone();
    let app2 = app.clone();
    std::thread::Builder::new()
        .name("export".into())
        .spawn(move || export::run_export(app2, mgr, job))
        .map_err(|e| {
            exporter.running.store(false, Ordering::SeqCst);
            e.to_string()
        })?;
    Ok(())
}

#[tauri::command]
fn cancel_export(exporter: State<export::Exporter>) {
    exporter.cancel.store(true, std::sync::atomic::Ordering::SeqCst);
}

// Activity centroids (pro-editor session, Phase 7 auto-reframe): sample the
// file at ~2fps, diff consecutive frames' luma, return each diff's centroid.
// No ML: for screen recordings the change-centroid IS the action. Face mode
// stays deferred (needs a Vision/ML dependency — logged).
#[tauri::command]
fn analyze_activity(path: String, duration: f64) -> Result<Vec<(f64, f64, f64)>, String> {
    let mut dec = compositor::decoder::Decoder::new(&path)?;
    let (w, h) = (dec.info.width as usize, dec.info.height as usize);
    let mut out = Vec::new();
    let mut prev: Option<Vec<u8>> = None;
    let step = 0.5f64;
    let mut t = 0.0;
    while t < duration.min(600.0) {
        let Some(frame) = dec.frame_at(t) else { break };
        // Downsample luma 1/8 in both axes.
        let (sw, sh) = (w / 8, h / 8);
        let mut luma = vec![0u8; sw * sh];
        for y in 0..sh {
            for x in 0..sw {
                let i = ((y * 8) * w + x * 8) * 4;
                luma[y * sw + x] = ((frame[i] as u32 * 30
                    + frame[i + 1] as u32 * 59
                    + frame[i + 2] as u32 * 11)
                    / 100) as u8;
            }
        }
        if let Some(p) = &prev {
            let (mut sx, mut sy, mut sum) = (0f64, 0f64, 0f64);
            for y in 0..sh {
                for x in 0..sw {
                    let d = (luma[y * sw + x] as i32 - p[y * sw + x] as i32).unsigned_abs() as f64;
                    if d > 12.0 {
                        sx += x as f64 * d;
                        sy += y as f64 * d;
                        sum += d;
                    }
                }
            }
            if sum > 500.0 {
                out.push((t, sx / sum / sw as f64, sy / sum / sh as f64));
            }
        }
        prev = Some(luma);
        t += step;
    }
    Ok(out)
}

// Integrated loudness (pro-editor session, Phase 6): ffmpeg ebur128.
// LUFS normalize = measure once, apply gain — peak normalize can't fix a
// quiet-but-spiky recording; loudness normalize can.
#[tauri::command]
fn measure_loudness(path: String) -> Result<f64, String> {
    let out = std::process::Command::new(compositor::decoder::ffmpeg_bin())
        .args(["-i", &path, "-af", "ebur128", "-f", "null", "-"])
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stderr);
    // Summary block: "    I:         -23.0 LUFS"
    let lufs = text
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with("I:") && l.contains("LUFS"))
        .and_then(|l| l.split_whitespace().nth(1)?.parse::<f64>().ok())
        .ok_or("no integrated loudness in ebur128 output")?;
    Ok(lufs)
}

// Loudness probe (pro-editor session, Phase 1; groundwork for Phase 6 LUFS):
// ffmpeg volumedetect over the whole file. Cheap and dependency-free.
#[tauri::command]
fn analyze_audio(path: String) -> Result<serde_json::Value, String> {
    let out = std::process::Command::new(compositor::decoder::ffmpeg_bin())
        .args(["-i", &path, "-af", "volumedetect", "-f", "null", "-"])
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stderr);
    let grab = |key: &str| -> Option<f64> {
        text.lines()
            .find(|l| l.contains(key))?
            .split(':')
            .next_back()?
            .trim()
            .trim_end_matches(" dB")
            .parse()
            .ok()
    };
    Ok(serde_json::json!({
        "meanDb": grab("mean_volume"),
        "maxDb": grab("max_volume"),
        // Container chapters show in the input dump (Phase 8 verification).
        "chapters": text.lines().filter(|l| l.trim_start().starts_with("Chapter #")).count(),
    }))
}

// ---- AI layer (Run 1, Phase 2): keys in keychain, read only here. ----

#[tauri::command]
fn ai_set_key(provider: String, key: String) -> Result<(), String> {
    ai::keys::set(&provider, &key)
}

#[tauri::command]
fn ai_has_key(provider: String) -> bool {
    ai::keys::has(&provider)
}

#[tauri::command]
fn ai_clear_key(provider: String) -> Result<(), String> {
    ai::keys::clear(&provider)
}

// Blocking network on a worker thread: tauri commands marked async run on
// the async runtime; spawn_blocking keeps reqwest::blocking legal there.
#[tauri::command]
async fn ai_test_connection(provider: String, model: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if ai::CHAT_PROVIDERS.contains(&provider.as_str()) || provider == "mock" {
            ai::chat::provider_for(&provider)?
                .test_connection(model.as_deref().unwrap_or("claude-sonnet-4-5"))
        } else {
            ai::videogen::provider_for(&provider)?.test_connection()
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn save_recovery(bundle_path: String, project_json: String) -> Result<(), String> {
    persistence::save_recovery(std::path::Path::new(&bundle_path), &project_json)
}

// Untitled-project autosave (foundation, Phase 8): unsaved projects get a
// crash-recovery home in app_data/untitled/. Unlike bundle recovery there is
// no project.json to compare against — existence IS the signal.
fn untitled_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("untitled"))
}

#[tauri::command]
fn save_untitled_recovery(app: tauri::AppHandle, project_json: String) -> Result<(), String> {
    persistence::save_recovery(&untitled_dir(&app)?, &project_json)
}

#[tauri::command]
fn check_untitled_recovery(app: tauri::AppHandle) -> Result<Option<String>, String> {
    Ok(std::fs::read_to_string(untitled_dir(&app)?.join("recovery.json")).ok())
}

#[tauri::command]
fn clear_untitled_recovery(app: tauri::AppHandle) -> Result<(), String> {
    persistence::clear_recovery(&untitled_dir(&app)?);
    Ok(())
}

// macOS titlebar "edited" dot — the standard unsaved-changes convention.
// (No tauri v2 API for NSWindow.documentEdited; one objc2 message, on the
// main thread as AppKit requires.)
#[tauri::command]
fn set_edited(window: tauri::WebviewWindow, edited: bool) {
    let w = window.clone();
    let _ = window.run_on_main_thread(move || {
        #[cfg(target_os = "macos")]
        if let Ok(ns) = w.ns_window() {
            unsafe {
                let obj: *mut objc2::runtime::AnyObject = ns.cast();
                let _: () = objc2::msg_send![
                    &*obj,
                    setDocumentEdited: objc2::runtime::Bool::new(edited)
                ];
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (&w, edited);
    });
}

#[tauri::command]
fn request_proxy(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let cache = app.path().app_data_dir().map_err(|e| e.to_string())?.join("proxies");
    proxy::generate(app.clone(), path, cache);
    Ok(())
}

// 4K verification fixture (foundation, Phase 5): the plan demands proxy
// proof with genuinely large footage — synthesize a 3840x2160 test file.
#[tauri::command]
fn spike_4k() -> Result<String, String> {
    let dir = compositor::demo::spike_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let out = dir.join("uhd.mp4");
    if !out.exists() {
        let vt = std::process::Command::new(compositor::decoder::ffmpeg_bin())
            .args(["-hide_banner", "-encoders"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("h264_videotoolbox"))
            .unwrap_or(false);
        let mut args: Vec<String> = vec![
            "-v".into(), "error".into(), "-y".into(),
            "-f".into(), "lavfi".into(),
            "-i".into(), "testsrc2=size=3840x2160:rate=30".into(),
            "-t".into(), "20".into(),
        ];
        if vt {
            args.extend(["-c:v".into(), "h264_videotoolbox".into(), "-b:v".into(), "30M".into()]);
        } else {
            args.extend(["-c:v".into(), "libx264".into(), "-preset".into(), "veryfast".into(), "-crf".into(), "20".into()]);
        }
        args.extend(["-pix_fmt".into(), "yuv420p".into(), out.to_str().ok_or("bad path")?.into()]);
        let status = std::process::Command::new(compositor::decoder::ffmpeg_bin())
            .args(&args)
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("4K fixture generation failed".into());
        }
    }
    Ok(out.to_string_lossy().into_owned())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ConsolidatedFile {
    old_path: String,
    new_path: String,
}

// Consolidate media (foundation, Phase 7): copy every referenced source into
// the bundle's media/ dir so the project becomes fully portable — the
// counterpart to offline/relink handling.
#[tauri::command]
fn consolidate_media(
    bundle_path: String,
    files: Vec<String>,
) -> Result<Vec<ConsolidatedFile>, String> {
    let media_dir = std::path::Path::new(&bundle_path).join("media");
    std::fs::create_dir_all(&media_dir).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for f in files {
        let src = std::path::Path::new(&f);
        if !src.exists() {
            continue; // offline media stays offline; relink handles it
        }
        let name = src.file_name().and_then(|n| n.to_str()).unwrap_or("media");
        let mut dest = media_dir.join(name);
        // Same-name different-file: disambiguate with a numeric suffix.
        let mut n = 1;
        while dest.exists() {
            let same = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0)
                == std::fs::metadata(src).map(|m| m.len()).unwrap_or(1);
            if same {
                break; // already consolidated
            }
            let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("media");
            let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("dat");
            dest = media_dir.join(format!("{stem}-{n}.{ext}"));
            n += 1;
        }
        if !dest.exists() {
            std::fs::copy(src, &dest).map_err(|e| format!("copy {name}: {e}"))?;
        }
        out.push(ConsolidatedFile {
            old_path: f,
            new_path: dest.to_string_lossy().into_owned(),
        });
    }
    Ok(out)
}

#[tauri::command]
fn reveal_in_finder(path: String) -> Result<(), String> {
    let status = std::process::Command::new("open")
        .args(["-R", &path])
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() { Ok(()) } else { Err("open -R failed".into()) }
}

#[tauri::command]
fn license_status() -> bool {
    license::is_activated()
}

#[tauri::command]
fn activate_license(key: String) -> Result<(), String> {
    license::activate(&key)
}

#[tauri::command]
fn deactivate_license() -> Result<(), String> {
    license::deactivate()
}

#[tauri::command]
fn get_setting(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
    persistence::get_setting(&db_path(&app)?, &key)
}

#[tauri::command]
fn set_setting(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
    persistence::set_setting(&db_path(&app)?, &key, &value)
}

#[tauri::command]
fn remove_recent_project(app: tauri::AppHandle, path: String) -> Result<(), String> {
    persistence::remove_recent(&db_path(&app)?, &path)?;
    let _ = menu::build_and_set(&app);
    Ok(())
}

#[tauri::command]
fn save_project(
    app: tauri::AppHandle,
    bundle_path: String,
    project_json: String,
    name: String,
    thumb_jpeg_base64: Option<String>,
) -> Result<(), String> {
    use base64::Engine as _;
    let bundle = std::path::Path::new(&bundle_path);
    persistence::save_bundle(bundle, &project_json)?;
    persistence::clear_recovery(bundle); // explicit save supersedes autosave
    // Launcher thumbnail: regenerable cache, plain write is fine.
    let mut thumb_path: Option<String> = None;
    if let Some(b64) = thumb_jpeg_base64 {
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(b64) {
            let p = bundle.join("cache").join("thumb.jpg");
            let _ = std::fs::create_dir_all(bundle.join("cache"));
            if std::fs::write(&p, bytes).is_ok() {
                thumb_path = Some(p.to_string_lossy().into_owned());
            }
        }
    }
    persistence::touch_recent_thumb(&db_path(&app)?, &bundle_path, &name, thumb_path.as_deref())?;
    let _ = menu::build_and_set(&app); // refresh Open Recent
    Ok(())
}

#[tauri::command]
fn load_project(
    app: tauri::AppHandle,
    bundle_path: String,
    name: String,
) -> Result<persistence::LoadedBundle, String> {
    let loaded = persistence::load_bundle(std::path::Path::new(&bundle_path))?;
    persistence::touch_recent(&db_path(&app)?, &bundle_path, &name)?;
    let _ = menu::build_and_set(&app); // refresh Open Recent
    Ok(loaded)
}

// Native self-verification: snapshot the webview's real rendered pixels
// (GPU canvas layers included) to a PNG. No Screen Recording permission
// needed — an app may capture its own content.
#[tauri::command]
fn capture_preview(window: tauri::WebviewWindow, path: Option<String>) -> Result<String, String> {
    let out = path.map(std::path::PathBuf::from).unwrap_or_else(|| {
        std::env::temp_dir()
            .join("motionaire-spike")
            .join(format!("native-capture-{}.png", std::process::id()))
    });
    capture::snapshot_webview(&window, out)
}

// Dev harness: synthesize a menu event through the real handler so the
// menu→emit→webview plumbing is testable without clicking the native bar.
#[tauri::command]
fn emit_menu_action(app: tauri::AppHandle, action: String) {
    menu::handle_event(&app, &action);
}

// Keep View-menu checkboxes honest when the same toggles change from in-app UI.
#[tauri::command]
fn sync_view_menu(app: tauri::AppHandle, safe_zones: bool, snap: bool, full_preview: Option<bool>) {
    if let Some(m) = app.menu() {
        for (id, val) in [
            ("view:safe_zones", safe_zones),
            ("view:snap", snap),
            ("view:full_preview", full_preview.unwrap_or(false)),
        ] {
            if let Some(item) = m.get(id) {
                if let Some(check) = item.as_check_menuitem() {
                    let _ = check.set_checked(val);
                }
            }
        }
    }
}

#[tauri::command]
fn list_recent_projects(app: tauri::AppHandle) -> Result<Vec<persistence::RecentProject>, String> {
    persistence::list_recents(&db_path(&app)?)
}

#[cfg(debug_assertions)]
fn dev_remote_loop(app: tauri::AppHandle) {
    let trigger = std::env::temp_dir().join("motionaire-dev-trigger");
    let done = std::env::temp_dir().join("motionaire-dev-done");
    loop {
        std::thread::sleep(std::time::Duration::from_millis(300));
        let Ok(cmd) = std::fs::read_to_string(&trigger) else { continue };
        let _ = std::fs::remove_file(&trigger);
        let cmd = cmd.trim();
        log::info!("dev-remote: {cmd}");
        let result: Result<String, String> = (|| {
            let win = app
                .get_webview_window("main")
                .ok_or("no main window")?;
            match cmd.split_once(':').map(|(a, b)| (a, b)).unwrap_or((cmd, "")) {
                ("capture", rest) => {
                    let path = if rest.is_empty() {
                        std::env::temp_dir()
                            .join("motionaire-spike")
                            .join(format!(
                                "native-{}.png",
                                std::time::SystemTime::now()
                                    .duration_since(std::time::UNIX_EPOCH)
                                    .map(|d| d.as_millis())
                                    .unwrap_or(0)
                            ))
                    } else {
                        std::path::PathBuf::from(rest)
                    };
                    capture::snapshot_webview(&win, path)
                }
                ("minimize", _) => {
                    win.minimize().map_err(|e| e.to_string())?;
                    Ok("minimized".into())
                }
                ("restore", _) => {
                    win.unminimize().map_err(|e| e.to_string())?;
                    win.set_focus().map_err(|e| e.to_string())?;
                    Ok("restored".into())
                }
                ("menu", action) => {
                    menu::handle_event(&app, action);
                    Ok(format!("menu {action} dispatched"))
                }
                other => Err(format!("unknown dev-remote command: {other:?}")),
            }
        })();
        let line = match &result {
            Ok(s) => format!("OK {s}"),
            Err(e) => format!("ERR {e}"),
        };
        log::info!("dev-remote: {line}");
        let _ = std::fs::write(&done, line);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Lifecycle logging: session 3 ended one dev run with a silent, clean
    // termination and no trace. Every exit path now says why it happened.
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            // Start the compositor AFTER the logger attaches — its startup GPU
            // init / WS bind logs were being swallowed pre-attach, which is why
            // session 3 only ever saw adapter logs from LATE re-inits.
            use tauri::Manager as _;
            app.manage(compositor::start());
            app.manage::<export::Exporter>(std::sync::Arc::new(export::ExportManager::default()));
            // Enforce the window minimum in code as well as config: the layout
            // self-test found programmatic setSize sailing below the configured
            // minWidth/minHeight (AppKit min constrains user drags, not code).
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_min_size(Some(tauri::LogicalSize::new(960.0, 620.0)));
            }
            if let Err(e) = menu::build_and_set(app.handle()) {
                log::error!("native menu build failed: {e}");
            }
            // Dev remote (debug builds only): a trigger file lets the outside
            // world (the autonomous session's shell) drive native capture,
            // minimize/restore, and menu actions — the interaction gap that
            // kept sessions 1-6 from ever SEEING the native window.
            #[cfg(debug_assertions)]
            {
                let handle = app.handle().clone();
                std::thread::Builder::new()
                    .name("dev-remote".into())
                    .spawn(move || dev_remote_loop(handle))
                    .ok();
            }
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .on_menu_event(|app, event| menu::handle_event(app, event.id().as_ref()))
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { .. } => {
                log::info!("lifecycle: window '{}' close requested", window.label())
            }
            tauri::WindowEvent::Destroyed => {
                log::info!("lifecycle: window '{}' destroyed", window.label())
            }
            tauri::WindowEvent::Focused(f) => log::debug!("lifecycle: focused={f}"),
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            sync_project,
            set_playhead,
            set_preview_quality,
            set_text_rasters,
            spike_setup,
            spike_audio,
            autorun_demo,
            env_flag,
            report_test,
            extract_frame,
            extract_filmstrip,
            probe_media,
            resolve_parity_probe,
            normalize_media,
            license_status,
            activate_license,
            deactivate_license,
            get_setting,
            set_setting,
            remove_recent_project,
            reveal_in_finder,
            consolidate_media,
            request_proxy,
            spike_4k,
            analyze_audio,
            measure_loudness,
            analyze_activity,
            ai_set_key,
            ai_has_key,
            ai_clear_key,
            ai_test_connection,
            save_recovery,
            save_untitled_recovery,
            check_untitled_recovery,
            clear_untitled_recovery,
            set_edited,
            start_export,
            cancel_export,
            import_font,
            save_fonts,
            save_project,
            load_project,
            list_recent_projects,
            sync_view_menu,
            emit_menu_action,
            capture_preview
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| match event {
            tauri::RunEvent::ExitRequested { .. } => log::info!("lifecycle: exit requested"),
            tauri::RunEvent::Exit => log::info!("lifecycle: clean exit"),
            _ => {}
        });
}
