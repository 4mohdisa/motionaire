use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use rusqlite::Connection;

// Project bundle per CONTEXT.md §8.1:
//   Name.motionaire/
//     project.json      — the document model
//     transcript.json   — word-level transcript (placeholder until Whisper lands)
//     history.jsonl     — append-only AI turn log (created empty for now)
//     cache/            — regenerable artifacts

// Crash-safe write: temp file in the SAME directory (rename must not cross
// filesystems), fsync, then atomic rename over the target.
pub fn atomic_write(target: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = target.parent().ok_or("target has no parent dir")?;
    fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    let tmp = dir.join(format!(
        ".{}.tmp-{}",
        target.file_name().and_then(|n| n.to_str()).unwrap_or("file"),
        std::process::id()
    ));
    {
        let mut f = fs::File::create(&tmp).map_err(|e| format!("create tmp: {e}"))?;
        f.write_all(bytes).map_err(|e| format!("write tmp: {e}"))?;
        f.sync_all().map_err(|e| format!("fsync tmp: {e}"))?;
    }
    fs::rename(&tmp, target).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("rename into place: {e}")
    })
}

pub fn save_bundle(bundle_dir: &Path, project_json: &str) -> Result<(), String> {
    // Validate before touching disk — never atomically install garbage.
    serde_json::from_str::<serde_json::Value>(project_json)
        .map_err(|e| format!("refusing to save invalid project JSON: {e}"))?;
    fs::create_dir_all(bundle_dir.join("cache")).map_err(|e| e.to_string())?;
    atomic_write(&bundle_dir.join("project.json"), project_json.as_bytes())?;
    let transcript = bundle_dir.join("transcript.json");
    if !transcript.exists() {
        atomic_write(&transcript, br#"{"words":[]}"#)?;
    }
    let history = bundle_dir.join("history.jsonl");
    if !history.exists() {
        atomic_write(&history, b"")?;
    }
    log::info!("saved project bundle: {}", bundle_dir.display());
    Ok(())
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BundleFont {
    pub file_name: String,
    pub data_base64: String,
}

// Fonts embed INTO the bundle (fonts/ dir) — external references would recreate
// the dies-when-the-path-dies problem media had before native import.
pub fn save_fonts(bundle_dir: &Path, fonts: &[BundleFont]) -> Result<(), String> {
    use base64::Engine as _;
    let dir = bundle_dir.join("fonts");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    for f in fonts {
        // File names come from our own import flow; strip any path parts anyway.
        let name = Path::new(&f.file_name)
            .file_name()
            .ok_or("bad font file name")?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(&f.data_base64)
            .map_err(|e| format!("font b64: {e}"))?;
        atomic_write(&dir.join(name), &bytes)?;
    }
    Ok(())
}

pub fn load_fonts(bundle_dir: &Path) -> Vec<BundleFont> {
    use base64::Engine as _;
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(bundle_dir.join("fonts")) else { return out };
    for entry in rd.flatten() {
        let p = entry.path();
        let ext = p.extension().and_then(|e| e.to_str()).unwrap_or("");
        if !matches!(ext.to_ascii_lowercase().as_str(), "ttf" | "otf") {
            continue;
        }
        if let Ok(bytes) = fs::read(&p) {
            out.push(BundleFont {
                file_name: entry.file_name().to_string_lossy().into_owned(),
                data_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
            });
        }
    }
    out
}

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedBundle {
    pub project_json: String,
    pub missing_media: Vec<String>,
    pub fonts: Vec<BundleFont>,
    // Autosave newer than the last explicit save (session 9, Phase 6).
    pub recovery_json: Option<String>,
}

pub fn load_bundle(bundle_dir: &Path) -> Result<LoadedBundle, String> {
    let path = bundle_dir.join("project.json");
    let project_json = fs::read_to_string(&path)
        .map_err(|e| format!("read {}: {e}", path.display()))?;
    let v: serde_json::Value = serde_json::from_str(&project_json)
        .map_err(|e| format!("project.json is not valid JSON: {e}"))?;
    if v["version"].as_u64() != Some(1) {
        return Err(format!(
            "unsupported project version {:?} (expected 1)",
            v["version"]
        ));
    }
    // Flag source files that no longer exist — the UI shows them as offline.
    let mut missing_media = Vec::new();
    if let Some(media) = v["media"].as_array() {
        for m in media {
            if let Some(p) = m["path"].as_str() {
                if p.starts_with('/') && !Path::new(p).exists() {
                    missing_media.push(p.to_string());
                }
            }
        }
    }
    let fonts = load_fonts(bundle_dir);
    Ok(LoadedBundle {
        project_json,
        missing_media,
        fonts,
        recovery_json: check_recovery(bundle_dir),
    })
}

// ---- App-level SQLite (CONTEXT.md §8.2) ----

fn db_open(db_path: &Path) -> Result<Connection, String> {
    if let Some(dir) = db_path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS recent_projects (
            path TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            last_opened_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS transcript_cache (
            media_hash TEXT PRIMARY KEY,
            transcript_json TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );",
    )
    .map_err(|e| e.to_string())?;
    // Migration (session 9): launcher thumbnails. Errors mean "column exists".
    let _ = conn.execute("ALTER TABLE recent_projects ADD COLUMN thumbnail TEXT", ());
    Ok(conn)
}

// Autosave recovery (session 9, Phase 6): a sidecar file inside the bundle,
// never clobbering project.json. Newer-than-last-save is the recovery signal.
pub fn save_recovery(bundle_dir: &Path, project_json: &str) -> Result<(), String> {
    serde_json::from_str::<serde_json::Value>(project_json)
        .map_err(|e| format!("recovery json invalid: {e}"))?;
    fs::create_dir_all(bundle_dir).map_err(|e| e.to_string())?;
    atomic_write(&bundle_dir.join("recovery.json"), project_json.as_bytes())
}

pub fn clear_recovery(bundle_dir: &Path) {
    let _ = fs::remove_file(bundle_dir.join("recovery.json"));
}

pub fn check_recovery(bundle_dir: &Path) -> Option<String> {
    let rec = bundle_dir.join("recovery.json");
    let newer = match (fs::metadata(&rec), fs::metadata(bundle_dir.join("project.json"))) {
        (Ok(r), Ok(p)) => match (r.modified(), p.modified()) {
            (Ok(rm), Ok(pm)) => rm > pm,
            _ => false,
        },
        _ => false,
    };
    if newer { fs::read_to_string(&rec).ok() } else { None }
}

pub fn get_setting(db_path: &Path, key: &str) -> Result<Option<String>, String> {
    let conn = db_open(db_path)?;
    conn.query_row("SELECT value FROM settings WHERE key = ?1", (key,), |r| r.get(0))
        .map(Some)
        .or_else(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => Ok(None),
            e => Err(e.to_string()),
        })
}

pub fn set_setting(db_path: &Path, key: &str, value: &str) -> Result<(), String> {
    let conn = db_open(db_path)?;
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = ?2",
        (key, value),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentProject {
    pub path: String,
    pub name: String,
    pub last_opened_at: i64,
    pub thumbnail: Option<String>,
    pub missing: bool,
}

pub fn touch_recent(db_path: &Path, project_path: &str, name: &str) -> Result<(), String> {
    touch_recent_thumb(db_path, project_path, name, None)
}

// Thumbnail updates only when Some — opening a project must not clobber the
// thumbnail its last save wrote.
pub fn touch_recent_thumb(
    db_path: &Path,
    project_path: &str,
    name: &str,
    thumbnail: Option<&str>,
) -> Result<(), String> {
    let conn = db_open(db_path)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    conn.execute(
        "INSERT INTO recent_projects (path, name, last_opened_at, thumbnail) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(path) DO UPDATE SET name = ?2, last_opened_at = ?3,
           thumbnail = COALESCE(?4, thumbnail)",
        (project_path, name, now, thumbnail),
    )
    .map_err(|e| e.to_string())?;
    // Keep the list bounded.
    conn.execute(
        "DELETE FROM recent_projects WHERE path NOT IN
         (SELECT path FROM recent_projects ORDER BY last_opened_at DESC LIMIT 20)",
        (),
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("motionaire-persist-test-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn save_load_roundtrip() {
        let dir = tmp_dir("roundtrip");
        let bundle = dir.join("P.motionaire");
        let json = r##"{"version":1,"canvas":{"width":1920,"height":1080,"fps":30,"background":"#000000"},"duration":0,"media":[],"tracks":[],"transcript":{"words":[]}}"##;
        save_bundle(&bundle, json).unwrap();
        assert!(bundle.join("project.json").exists());
        assert!(bundle.join("transcript.json").exists());
        assert!(bundle.join("history.jsonl").exists());
        let loaded = load_bundle(&bundle).unwrap();
        assert_eq!(loaded.project_json, json);
        assert!(loaded.missing_media.is_empty());
        // No temp litter after a clean save.
        let litter: Vec<_> = fs::read_dir(&bundle)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
            .collect();
        assert!(litter.is_empty(), "tmp files left behind: {litter:?}");
    }

    #[test]
    fn rejects_garbage_on_save_and_load() {
        let dir = tmp_dir("garbage");
        let bundle = dir.join("P.motionaire");
        // Saving invalid JSON must fail without creating a broken project.json.
        assert!(save_bundle(&bundle, "{not json").is_err());
        assert!(!bundle.join("project.json").exists());
        // Loading a truncated/corrupt file must error, not panic.
        fs::create_dir_all(&bundle).unwrap();
        fs::write(bundle.join("project.json"), &br#"{"version":1,"canvas":{"wi"#[..]).unwrap();
        assert!(load_bundle(&bundle).is_err());
        // Wrong version is refused with a clear message.
        fs::write(bundle.join("project.json"), br#"{"version":99}"#).unwrap();
        let err = load_bundle(&bundle).unwrap_err();
        assert!(err.contains("version"), "got: {err}");
        // Missing bundle entirely.
        assert!(load_bundle(&dir.join("Nope.motionaire")).is_err());
    }

    #[test]
    fn flags_missing_media() {
        let dir = tmp_dir("missing");
        let bundle = dir.join("P.motionaire");
        let real = dir.join("real.mp4");
        fs::write(&real, b"x").unwrap();
        let json = format!(
            r#"{{"version":1,"media":[{{"path":"{}"}},{{"path":"/nonexistent/gone.mp4"}},{{"path":"blob:http://x/y"}}],"tracks":[]}}"#,
            real.display()
        );
        save_bundle(&bundle, &json).unwrap();
        let loaded = load_bundle(&bundle).unwrap();
        assert_eq!(loaded.missing_media, vec!["/nonexistent/gone.mp4".to_string()]);
    }

    #[test]
    fn atomic_write_replaces_never_truncates() {
        let dir = tmp_dir("atomic");
        let target = dir.join("f.json");
        atomic_write(&target, b"first-version").unwrap();
        atomic_write(&target, b"second-version-longer").unwrap();
        assert_eq!(fs::read(&target).unwrap(), b"second-version-longer");
    }

    #[test]
    fn recents_upsert_prune_and_vanished() {
        let dir = tmp_dir("recents");
        let db = dir.join("db.sqlite");
        // A bundle that exists...
        let bundle = dir.join("A.motionaire");
        fs::create_dir_all(&bundle).unwrap();
        fs::write(bundle.join("project.json"), b"{}").unwrap();
        touch_recent(&db, bundle.to_str().unwrap(), "A").unwrap();
        // ...and one that doesn't (deleted after being recorded).
        touch_recent(&db, "/gone/B.motionaire", "B").unwrap();
        let recents = list_recents(&db).unwrap();
        assert_eq!(recents.len(), 1, "vanished bundles are filtered out");
        assert_eq!(recents[0].name, "A");
        // Upsert bumps, doesn't duplicate.
        touch_recent(&db, bundle.to_str().unwrap(), "A-renamed").unwrap();
        let recents = list_recents(&db).unwrap();
        assert_eq!(recents.len(), 1);
        assert_eq!(recents[0].name, "A-renamed");
    }
}

pub fn list_recents(db_path: &Path) -> Result<Vec<RecentProject>, String> {
    let conn = db_open(db_path)?;
    let mut stmt = conn
        .prepare("SELECT path, name, last_opened_at, thumbnail FROM recent_projects ORDER BY last_opened_at DESC")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map((), |r| {
            Ok(RecentProject {
                path: r.get(0)?,
                name: r.get(1)?,
                last_opened_at: r.get(2)?,
                thumbnail: r.get(3)?,
                missing: false,
            })
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows {
        let mut rec = r.map_err(|e| e.to_string())?;
        // Vanished bundles are flagged, not dropped (session 9: the launcher
        // shows them grayed with a remove action instead of lying by omission).
        rec.missing = !PathBuf::from(&rec.path).join("project.json").exists();
        out.push(rec);
    }
    Ok(out)
}

pub fn remove_recent(db_path: &Path, project_path: &str) -> Result<(), String> {
    let conn = db_open(db_path)?;
    conn.execute("DELETE FROM recent_projects WHERE path = ?1", (project_path,))
        .map_err(|e| e.to_string())?;
    Ok(())
}
