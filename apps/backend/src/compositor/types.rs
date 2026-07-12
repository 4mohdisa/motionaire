use serde::{Deserialize, Serialize};

// Trimmed mirror of the frontend document model — only what compositing needs.
// Field names are camelCase to match the store's JSON directly.

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncProject {
    pub canvas: CanvasCfg,
    pub layers: Vec<Layer>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CanvasCfg {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
    pub background: String,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Layer {
    pub id: String,
    pub z: i32,
    pub media_path: String,
    pub start: f64,
    #[serde(rename = "in")]
    pub in_: f64,
    pub out: f64,
    pub speed: f64,
    pub transform: TransformCfg,
    pub keyframes: Vec<Kf>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TransformCfg {
    pub x: f64,
    pub y: f64,
    pub scale: f64,
    pub rotation: f64,
    pub opacity: f64,
    pub corner_radius: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Kf {
    pub prop: String,
    pub t: f64,
    pub v: f64,
    pub ease: String,
}

impl Layer {
    pub fn end(&self) -> f64 {
        self.start + (self.out - self.in_) / self.speed
    }
    pub fn active_at(&self, t: f64) -> bool {
        self.start <= t && t < self.end()
    }
    pub fn source_time(&self, t: f64) -> f64 {
        self.in_ + (t - self.start) * self.speed
    }
}

// Resolved per-layer draw parameters at one instant, all in canvas pixels.
#[derive(Debug, Clone, Copy)]
pub struct ResolvedLayer {
    pub x: f32,
    pub y: f32,
    pub scale: f32,
    pub rotation_deg: f32,
    pub opacity: f32,
    pub corner_radius: f32,
}
