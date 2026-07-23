// VideoGenProvider (Run 1, Phase 6). Built against live docs 2026-07-18:
// - Seedance 2.0 (BytePlus ModelArk): POST
//   https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks
//   Bearer auth; body { model: "dreamina-seedance-2-0-260128",
//   content: [{type:"text",text}], ratio, resolution, duration };
//   poll GET .../tasks/{id} → status queued|running|succeeded|failed|
//   expired|cancelled, video at content.video_url (temporary, 24h).
// - Google Veo 3.1 (Gemini API): POST
//   .../v1beta/models/veo-3.1-generate-preview:predictLongRunning with
//   x-goog-api-key; body { instances:[{prompt}], parameters:{aspectRatio,
//   durationSeconds ("4"|"6"|"8"), resolution} }; poll /v1beta/{operation}
//   until done:true; file at
//   response.generateVideoResponse.generatedSamples[0].video.uri.
// - MockGen: ffmpeg-local, offline — the suite runs the ENTIRE job/import/
//   place pipeline with zero keys and zero spend.
//
// Generation is minutes-long → jobs run on a thread and report through
// events (the proxy system's pattern): videogen:progress / :done / :failed.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::Emitter;

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct GenRequest {
    pub provider: String, // seedance | gemini | mockgen
    pub prompt: String,
    pub duration_secs: u32,
    pub aspect: String, // "16:9" | "9:16" | "1:1"
    #[serde(default)]
    pub place_at: Option<f64>, // chat tool: drop on the timeline on arrival
}

enum PollState {
    Working(String), // human-readable phase
    Done(String),    // video url (http… or file:…)
    Failed(String),
}

trait GenBackend {
    fn start(&self, req: &GenRequest) -> Result<String, String>; // job handle
    fn poll(&self, handle: &str) -> Result<PollState, String>;
}

fn backend_for(id: &str) -> Result<Box<dyn GenBackend>, String> {
    match id {
        "seedance" => Ok(Box::new(Seedance)),
        "gemini" => Ok(Box::new(Veo)),
        "mockgen" => Ok(Box::new(MockGen)),
        _ => Err(format!("unknown video provider '{id}'")),
    }
}

pub trait VideoGenProvider: Send + Sync {
    fn id(&self) -> &'static str;
    fn test_connection(&self) -> Result<String, String>;
}

pub fn provider_for(id: &str) -> Result<Box<dyn VideoGenProvider>, String> {
    match id {
        "seedance" => Ok(Box::new(Seedance)),
        "gemini" => Ok(Box::new(Veo)),
        "mockgen" => Ok(Box::new(MockGen)),
        _ => Err(format!("unknown video provider '{id}'")),
    }
}

fn http() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .expect("http client")
}

pub fn run_generation(app: tauri::AppHandle, out_dir: std::path::PathBuf, req: GenRequest) {
    std::thread::Builder::new()
        .name("videogen".into())
        .spawn(move || {
            let emit_fail = |msg: String| {
                log::error!("videogen: {msg}");
                let _ = app.emit(
                    "videogen:failed",
                    json!({ "error": msg, "prompt": req.prompt }),
                );
            };
            let backend = match backend_for(&req.provider) {
                Ok(b) => b,
                Err(e) => return emit_fail(e),
            };
            let handle = match backend.start(&req) {
                Ok(h) => h,
                Err(e) => return emit_fail(e),
            };
            let _ = app.emit(
                "videogen:progress",
                json!({ "state": "submitted", "prompt": req.prompt }),
            );
            let started = std::time::Instant::now();
            let url = loop {
                if started.elapsed().as_secs() > 900 {
                    return emit_fail("generation timed out after 15 minutes".into());
                }
                match backend.poll(&handle) {
                    Ok(PollState::Done(url)) => break url,
                    Ok(PollState::Failed(e)) => return emit_fail(e),
                    Ok(PollState::Working(phase)) => {
                        let _ = app.emit(
                            "videogen:progress",
                            json!({ "state": phase, "secs": started.elapsed().as_secs() }),
                        );
                    }
                    Err(e) => return emit_fail(e),
                }
                std::thread::sleep(std::time::Duration::from_secs(
                    if req.provider == "mockgen" { 1 } else { 5 },
                ));
            };
            // Download (or adopt the local file from the mock).
            let _ = std::fs::create_dir_all(&out_dir);
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs())
                .unwrap_or(0);
            let dest = out_dir.join(format!("ai-gen-{stamp}.mp4"));
            let path = if let Some(local) = url.strip_prefix("file://") {
                if std::fs::rename(local, &dest).is_err() {
                    if let Err(e) = std::fs::copy(local, &dest) {
                        return emit_fail(format!("adopting generated file failed: {e}"));
                    }
                }
                dest
            } else {
                // Veo download needs the API key on the request as well.
                let mut get = http().get(&url);
                if req.provider == "gemini" {
                    if let Some(k) = super::keys::get("gemini") {
                        get = get.header("x-goog-api-key", k);
                    }
                }
                let resp = match get.send() {
                    Ok(r) if r.status().is_success() => r,
                    Ok(r) => return emit_fail(format!("download failed: HTTP {}", r.status())),
                    Err(e) => return emit_fail(format!("download failed: {e}")),
                };
                let bytes = match resp.bytes() {
                    Ok(b) => b,
                    Err(e) => return emit_fail(format!("download read failed: {e}")),
                };
                if let Err(e) = std::fs::write(&dest, &bytes) {
                    return emit_fail(format!("saving download failed: {e}"));
                }
                dest
            };
            log::info!("videogen: done → {}", path.display());
            let _ = app.emit(
                "videogen:done",
                json!({
                    "path": path.to_string_lossy(),
                    "prompt": req.prompt,
                    "placeAt": req.place_at,
                }),
            );
        })
        .expect("spawn videogen");
}

// ---------------------------------------------------------------------------
pub struct Seedance;

impl GenBackend for Seedance {
    fn start(&self, req: &GenRequest) -> Result<String, String> {
        let key = super::keys::get("seedance").ok_or("No API key saved for Seedance")?;
        let resp = http()
            .post("https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks")
            .bearer_auth(key)
            .json(&json!({
                "model": "dreamina-seedance-2-0-260128",
                "content": [{ "type": "text", "text": req.prompt }],
                "ratio": req.aspect,
                "resolution": "720p",
                "duration": req.duration_secs,
            }))
            .send()
            .map_err(|e| format!("No network: {e}"))?;
        if !resp.status().is_success() {
            return Err(super::chat::explain_status(resp));
        }
        let v: Value = resp.json().map_err(|e| e.to_string())?;
        v["id"]
            .as_str()
            .map(String::from)
            .ok_or_else(|| format!("no task id in response: {v}"))
    }
    fn poll(&self, handle: &str) -> Result<PollState, String> {
        let key = super::keys::get("seedance").ok_or("key vanished mid-job")?;
        let resp = http()
            .get(format!(
                "https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks/{handle}"
            ))
            .bearer_auth(key)
            .send()
            .map_err(|e| format!("No network: {e}"))?;
        if !resp.status().is_success() {
            return Err(super::chat::explain_status(resp));
        }
        let v: Value = resp.json().map_err(|e| e.to_string())?;
        match v["status"].as_str().unwrap_or("") {
            "succeeded" => v["content"]["video_url"]
                .as_str()
                .map(|u| PollState::Done(u.into()))
                .ok_or_else(|| format!("succeeded but no video_url: {v}")),
            "failed" | "expired" | "cancelled" => Ok(PollState::Failed(
                v["error"]["message"]
                    .as_str()
                    .unwrap_or("generation failed (content policy or internal error)")
                    .to_string(),
            )),
            other => Ok(PollState::Working(other.to_string())),
        }
    }
}

impl VideoGenProvider for Seedance {
    fn id(&self) -> &'static str {
        "seedance"
    }
    fn test_connection(&self) -> Result<String, String> {
        let key = super::keys::get("seedance").ok_or("No API key saved for Seedance")?;
        let resp = http()
            .get("https://ark.ap-southeast.bytepluses.com/api/v3/models")
            .bearer_auth(key)
            .send()
            .map_err(|e| format!("No network: {e}"))?;
        if resp.status().is_success() {
            Ok("Connected — Seedance key accepted".into())
        } else {
            Err(super::chat::explain_status(resp))
        }
    }
}

// ---------------------------------------------------------------------------
pub struct Veo;

impl GenBackend for Veo {
    fn start(&self, req: &GenRequest) -> Result<String, String> {
        let key = super::keys::get("gemini").ok_or("No API key saved for Google")?;
        // Veo accepts 4/6/8s; clamp to the nearest allowed.
        let dur = if req.duration_secs <= 4 {
            4
        } else if req.duration_secs <= 6 {
            6
        } else {
            8
        };
        let resp = http()
            .post("https://generativelanguage.googleapis.com/v1beta/models/veo-3.1-generate-preview:predictLongRunning")
            .header("x-goog-api-key", key)
            .json(&json!({
                "instances": [{ "prompt": req.prompt }],
                "parameters": {
                    "aspectRatio": if req.aspect == "9:16" { "9:16" } else { "16:9" },
                    "durationSeconds": dur.to_string(),
                    "resolution": "720p"
                }
            }))
            .send()
            .map_err(|e| format!("No network: {e}"))?;
        if !resp.status().is_success() {
            return Err(super::chat::explain_status(resp));
        }
        let v: Value = resp.json().map_err(|e| e.to_string())?;
        v["name"]
            .as_str()
            .map(String::from)
            .ok_or_else(|| format!("no operation name in response: {v}"))
    }
    fn poll(&self, handle: &str) -> Result<PollState, String> {
        let key = super::keys::get("gemini").ok_or("key vanished mid-job")?;
        let resp = http()
            .get(format!(
                "https://generativelanguage.googleapis.com/v1beta/{handle}"
            ))
            .header("x-goog-api-key", key)
            .send()
            .map_err(|e| format!("No network: {e}"))?;
        if !resp.status().is_success() {
            return Err(super::chat::explain_status(resp));
        }
        let v: Value = resp.json().map_err(|e| e.to_string())?;
        if v["done"].as_bool() != Some(true) {
            return Ok(PollState::Working("generating".into()));
        }
        if let Some(err) = v.get("error") {
            return Ok(PollState::Failed(
                err["message"]
                    .as_str()
                    .unwrap_or("Veo operation failed")
                    .to_string(),
            ));
        }
        v.pointer("/response/generateVideoResponse/generatedSamples/0/video/uri")
            .and_then(|u| u.as_str())
            .map(|u| PollState::Done(u.into()))
            .ok_or_else(|| format!("done but no video uri: {v}"))
    }
}

impl VideoGenProvider for Veo {
    fn id(&self) -> &'static str {
        "gemini"
    }
    fn test_connection(&self) -> Result<String, String> {
        let key = super::keys::get("gemini").ok_or("No API key saved for Google")?;
        let resp = http()
            .get(format!(
                "https://generativelanguage.googleapis.com/v1beta/models?key={key}"
            ))
            .send()
            .map_err(|e| format!("No network: {e}"))?;
        if resp.status().is_success() {
            Ok("Connected — Google key accepted".into())
        } else {
            Err(super::chat::explain_status(resp))
        }
    }
}

// ---------------------------------------------------------------------------
// MockGen: local ffmpeg render of the prompt as burned-in text over a moving
// background. Offline, deterministic-enough, exercises the whole pipeline.
pub struct MockGen;

impl GenBackend for MockGen {
    fn start(&self, req: &GenRequest) -> Result<String, String> {
        let dir = crate::compositor::demo::spike_dir();
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let out = dir.join(format!("mockgen-{stamp}.mp4"));
        let (w, h) = match req.aspect.as_str() {
            "9:16" => (720, 1280),
            "1:1" => (960, 960),
            _ => (1280, 720),
        };
        // testsrc2 only: `gradients` and drawtext (fontconfig) are not
        // present in every ffmpeg build — the first run on this machine
        // failed with "Filter not found". The mock's job is pipeline
        // plumbing, not pixels.
        let filter = format!("testsrc2=size={w}x{h}:rate=30");
        let status = std::process::Command::new(crate::compositor::decoder::ffmpeg_bin())
            .args([
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                &filter,
                "-t",
                &req.duration_secs.to_string(),
                "-pix_fmt",
                "yuv420p",
                "-an",
                out.to_str().ok_or("bad path")?,
            ])
            .status()
            .map_err(|e| e.to_string())?;
        if !status.success() {
            return Err("mock generation render failed".into());
        }
        Ok(format!("file://{}", out.display()))
    }
    fn poll(&self, handle: &str) -> Result<PollState, String> {
        Ok(PollState::Done(handle.to_string()))
    }
}

impl VideoGenProvider for MockGen {
    fn id(&self) -> &'static str {
        "mockgen"
    }
    fn test_connection(&self) -> Result<String, String> {
        Ok("Connected — mock generator (offline, ffmpeg-local)".into())
    }
}
