pub mod compositor;

use compositor::types::SyncProject;
use compositor::Compositor;
use tauri::State;

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
            Ok(())
        })
        .manage(compositor::start())
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
            autorun_demo
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|_app, event| match event {
            tauri::RunEvent::ExitRequested { .. } => log::info!("lifecycle: exit requested"),
            tauri::RunEvent::Exit => log::info!("lifecycle: clean exit"),
            _ => {}
        });
}
