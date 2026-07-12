pub mod capture;
pub mod compositor;
pub mod license;
pub mod menu;
pub mod persistence;

use std::path::PathBuf;

use compositor::types::SyncProject;
use compositor::Compositor;
use tauri::{Manager, State};

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
            autorun_demo,
            env_flag,
            report_test,
            extract_frame,
            extract_filmstrip,
            probe_media,
            license_status,
            activate_license,
            deactivate_license,
            get_setting,
            set_setting,
            remove_recent_project,
            reveal_in_finder,
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
