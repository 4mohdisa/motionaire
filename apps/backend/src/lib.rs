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
            emit_menu_action
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| match event {
            tauri::RunEvent::ExitRequested { .. } => log::info!("lifecycle: exit requested"),
            tauri::RunEvent::Exit => log::info!("lifecycle: clean exit"),
            _ => {}
        });
}
