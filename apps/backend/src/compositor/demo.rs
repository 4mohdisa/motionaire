use std::path::PathBuf;
use std::process::Command;

use super::decoder::{ffmpeg_bin, probe};
use super::types::{CanvasCfg, Kf, Layer, SyncProject, TransformCfg};

// The flagship PiP demo (CONTEXT.md §2.3): screen share fullscreen underneath,
// webcam shrinking from fullscreen to 10% bottom-right with rounded corners,
// holding, then returning. Test media is generated with ffmpeg lavfi sources —
// two visibly distinct, moving, really-decoded video files.

pub fn spike_dir() -> PathBuf {
    std::env::temp_dir().join("motionaire-spike")
}

pub fn generate_media() -> Result<(PathBuf, PathBuf), String> {
    let dir = spike_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let screen = dir.join("screen.mp4");
    let cam = dir.join("cam.mp4");
    let gen = |path: &PathBuf, filter: &str| -> Result<(), String> {
        if path.exists() {
            return Ok(());
        }
        let out = Command::new(ffmpeg_bin())
            .args([
                "-v", "error", "-y",
                "-f", "lavfi", "-i", filter,
                "-t", "10",
                "-pix_fmt", "yuv420p",
                "-an",
                path.to_str().unwrap(),
            ])
            .output()
            .map_err(|e| format!("ffmpeg spawn: {e}"))?;
        if !out.status.success() {
            return Err(format!("ffmpeg gen failed: {}", String::from_utf8_lossy(&out.stderr)));
        }
        Ok(())
    };
    // Screen stand-in: testsrc2 has moving bars/text — reads clearly as "screen".
    gen(&screen, "testsrc2=size=1280x720:rate=30")?;
    // Webcam stand-in: mandelbrot zoom — organic, continuously moving.
    gen(&cam, "mandelbrot=size=640x360:rate=30")?;
    Ok((screen, cam))
}

#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SpikeMedia {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub duration: f64,
}

pub fn spike_media_info() -> Result<(SpikeMedia, SpikeMedia), String> {
    let (screen, cam) = generate_media()?;
    let mk = |p: PathBuf| -> Result<SpikeMedia, String> {
        let info = probe(p.to_str().unwrap())?;
        Ok(SpikeMedia {
            path: p.to_string_lossy().into_owned(),
            width: info.width,
            height: info.height,
            fps: info.fps,
            duration: info.duration,
        })
    };
    Ok((mk(screen)?, mk(cam)?))
}

// Rust-built demo project for self-demo mode (SPIKE_DEMO=1) and spike_check —
// keyframe numbers identical to the frontend's loadPipDemo action.
pub fn demo_project(screen_path: &str, cam_path: &str) -> SyncProject {
    let kf = |prop: &str, t: f64, v: f64| Kf {
        prop: prop.into(),
        t,
        v,
        ease: "easeInOut".into(),
    };
    let base_transform = TransformCfg {
        x: 0.0,
        y: 0.0,
        scale: 1.0,
        rotation: 0.0,
        opacity: 1.0,
        corner_radius: 0.0,
        crop: Default::default(),
        shadow: None,
    };
    // 1920x1080 canvas; PiP target: 10% scale, bottom-right, 32px margin, r=12.
    let px = 0.45 * 1920.0 - 32.0; // 832
    let py = 0.45 * 1080.0 - 32.0; // 454
    SyncProject {
        canvas: CanvasCfg {
            width: 1920,
            height: 1080,
            fps: 30.0,
            background: "#000000".into(),
        },
        layers: vec![
            Layer {
                id: "spike_screen".into(),
                z: 0,
                media_path: screen_path.into(),
                start: 0.0,
                in_: 0.0,
                out: 10.0,
                speed: 1.0,
                transform: base_transform.clone(),
                keyframes: vec![],
                transitions: Default::default(),
                grade: None,
                adjust: false,
                key: None,
                blend: None,
                mask: None,
                blur: 0.0,
                vignette: 0.0,
            },
            Layer {
                id: "spike_cam".into(),
                z: 1,
                media_path: cam_path.into(),
                start: 0.0,
                in_: 0.0,
                out: 10.0,
                speed: 1.0,
                transform: base_transform,
                keyframes: vec![
                    kf("transform.scale", 1.0, 1.0),
                    kf("transform.scale", 2.2, 0.10),
                    kf("transform.scale", 5.0, 0.10),
                    kf("transform.scale", 6.2, 1.0),
                    kf("transform.x", 1.0, 0.0),
                    kf("transform.x", 2.2, px),
                    kf("transform.x", 5.0, px),
                    kf("transform.x", 6.2, 0.0),
                    kf("transform.y", 1.0, 0.0),
                    kf("transform.y", 2.2, py),
                    kf("transform.y", 5.0, py),
                    kf("transform.y", 6.2, 0.0),
                    kf("transform.cornerRadius", 1.0, 0.0),
                    kf("transform.cornerRadius", 2.2, 12.0),
                    kf("transform.cornerRadius", 5.0, 12.0),
                    kf("transform.cornerRadius", 6.2, 0.0),
                ],
                transitions: Default::default(),
                grade: None,
                adjust: false,
                key: None,
                blend: None,
                mask: None,
                blur: 0.0,
                vignette: 0.0,
            },
        ],
    }
}
