pub mod capture;
pub mod compositor;
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

#[tauri::command]
fn save_project(
    app: tauri::AppHandle,
    bundle_path: String,
    project_json: String,
    name: String,
) -> Result<(), String> {
    persistence::save_bundle(std::path::Path::new(&bundle_path), &project_json)?;
    persistence::touch_recent(&db_path(&app)?, &bundle_path, &name)?;
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
fn sync_view_menu(app: tauri::AppHandle, safe_zones: bool, snap: bool) {
    if let Some(m) = app.menu() {
        for (id, val) in [("view:safe_zones", safe_zones), ("view:snap", snap)] {
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
            spike_setup,
            autorun_demo,
            env_flag,
            report_test,
            probe_media,
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
