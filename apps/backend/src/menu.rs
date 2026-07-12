use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Emitter, Manager, Runtime};

// Native macOS menu bar (session 6, Part 3). Menu events are forwarded to the
// webview as a single "menu" event; the frontend dispatches focus-aware
// handlers (so Cmd+Z in a text field still edits text, not the timeline).

#[derive(Clone, serde::Serialize)]
pub struct MenuEvent {
    pub action: String,
    pub path: Option<String>,
}

pub fn build_and_set<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let recents = app
        .path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("motionaire.db"))
        .and_then(|db| crate::persistence::list_recents(&db).ok())
        .unwrap_or_default();

    // App menu (first slot on macOS: About / Quit).
    let app_menu = Submenu::with_items(
        app,
        "Motionaire",
        true,
        &[
            &PredefinedMenuItem::about(app, None, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;

    // File
    let mut recent_items: Vec<MenuItem<R>> = Vec::new();
    for r in recents.iter().take(10) {
        recent_items.push(MenuItem::with_id(
            app,
            format!("recent:{}", r.path),
            &r.name,
            true,
            None::<&str>,
        )?);
    }
    let open_recent = if recent_items.is_empty() {
        Submenu::with_items(
            app,
            "Open Recent",
            true,
            &[&MenuItem::with_id(app, "recent:none", "No Recent Projects", false, None::<&str>)?],
        )?
    } else {
        let refs: Vec<&dyn tauri::menu::IsMenuItem<R>> =
            recent_items.iter().map(|i| i as &dyn tauri::menu::IsMenuItem<R>).collect();
        Submenu::with_items(app, "Open Recent", true, &refs)?
    };

    let file = Submenu::with_items(
        app,
        "File",
        true,
        &[
            &MenuItem::with_id(app, "file:new", "New Project", true, Some("CmdOrCtrl+N"))?,
            &MenuItem::with_id(app, "file:open", "Open…", true, Some("CmdOrCtrl+O"))?,
            &open_recent,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "file:save", "Save", true, Some("CmdOrCtrl+S"))?,
            &MenuItem::with_id(app, "file:save_as", "Save As…", true, Some("CmdOrCtrl+Shift+S"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "file:import", "Import Media…", true, Some("CmdOrCtrl+I"))?,
        ],
    )?;

    // Edit — undo/redo/select-all are custom (focus-aware in the frontend);
    // cut/copy/paste are the native text-editing items (clip-level clipboard
    // is future work, logged in DECISIONS).
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &MenuItem::with_id(app, "edit:undo", "Undo", true, Some("CmdOrCtrl+Z"))?,
            &MenuItem::with_id(app, "edit:redo", "Redo", true, Some("CmdOrCtrl+Shift+Z"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "edit:delete", "Delete", true, None::<&str>)?,
            &MenuItem::with_id(app, "edit:ripple_delete", "Ripple Delete", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "edit:select_all", "Select All", true, Some("CmdOrCtrl+A"))?,
        ],
    )?;

    // View
    let view = Submenu::with_items(
        app,
        "View",
        true,
        &[
            &CheckMenuItem::with_id(app, "view:safe_zones", "Safe Zones", true, false, None::<&str>)?,
            &CheckMenuItem::with_id(app, "view:snap", "Snapping", true, true, None::<&str>)?,
            &CheckMenuItem::with_id(
                app,
                "view:full_preview",
                "Full Resolution Preview",
                true,
                false,
                None::<&str>,
            )?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "view:zoom_in", "Zoom In Timeline", true, Some("CmdOrCtrl+="))?,
            &MenuItem::with_id(app, "view:zoom_out", "Zoom Out Timeline", true, Some("CmdOrCtrl+-"))?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "view:pip_demo", "Load PiP Demo (dev)", true, None::<&str>)?,
        ],
    )?;

    let menu = Menu::with_items(app, &[&app_menu, &file, &edit, &view])?;
    app.set_menu(menu)?;
    Ok(())
}

pub fn handle_event<R: Runtime>(app: &AppHandle<R>, id: &str) {
    let payload = if let Some(path) = id.strip_prefix("recent:") {
        if path == "none" {
            return;
        }
        MenuEvent { action: "file:open_recent".into(), path: Some(path.to_string()) }
    } else {
        MenuEvent { action: id.to_string(), path: None }
    };
    log::debug!("menu event: {}", payload.action);
    if let Err(e) = app.emit("menu", payload) {
        log::error!("menu event emit failed: {e}");
    }
}
