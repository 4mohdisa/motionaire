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
    #[serde(default)]
    pub transitions: TransitionsCfg,
    #[serde(default)]
    pub grade: Option<GradeCfg>,
    // Adjustment layer (session 8, Phase 5): no source; its grade is folded
    // onto every lower-z layer for its span.
    #[serde(default)]
    pub adjust: bool,
}

// Color grade (session 8, Phase 3). All zero = identity.
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
pub struct GradeCfg {
    pub exposure: f64,
    pub contrast: f64,
    pub saturation: f64,
    pub temperature: f64,
    pub tint: f64,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
pub struct TransitionsCfg {
    #[serde(rename = "in", default)]
    pub in_: Option<TransitionCfg>,
    #[serde(default)]
    pub out: Option<TransitionCfg>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct TransitionCfg {
    #[serde(rename = "type")]
    pub kind: String, // dissolve | fade | slide | wipe (cut = None)
    pub duration: f64,
}

// Cross transitions (need the outgoing partner drawn underneath) vs fades
// (self-contained against background). Canon per DECISIONS session 3/5:
// cross types live canonically on the INCOMING clip's in-edge.
pub fn is_cross(kind: &str) -> bool {
    matches!(kind, "dissolve" | "slide" | "wipe")
}

// How long this layer must keep drawing PAST its end because the adjacent
// next layer on the same track opens with a cross transition.
pub fn transition_tail(layers: &[Layer], layer: &Layer, fps: f64) -> f64 {
    let end = layer.end();
    let half_frame = 1.0 / fps / 2.0;
    layers
        .iter()
        .filter(|o| o.id != layer.id && o.z == layer.z && (o.start - end).abs() < half_frame)
        .filter_map(|o| o.transitions.in_.as_ref())
        .filter(|tr| is_cross(&tr.kind))
        .map(|tr| tr.duration)
        .fold(0.0, f64::max)
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
    #[serde(default)]
    pub crop: CropCfg,
    #[serde(default)]
    pub shadow: Option<ShadowCfg>,
}

// Crop as fractions of the source frame (0..1 per edge), CONTEXT.md §1.2 shape.
#[derive(Debug, Clone, Copy, Default, Deserialize, Serialize)]
pub struct CropCfg {
    pub l: f64,
    pub t: f64,
    pub r: f64,
    pub b: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ShadowCfg {
    pub blur: f64,
    pub spread: f64,
    pub color: String,
    pub x: f64,
    pub y: f64,
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

#[cfg(test)]
mod tests {
    use super::*;

    // Wire-format guard: the frontend's flatten() JSON must deserialize with
    // nonzero crop/shadow AND without them (older payload shape).
    #[test]
    fn transform_wire_format() {
        let with: TransformCfg = serde_json::from_str(
            r##"{"x":1,"y":2,"scale":0.5,"rotation":10,"opacity":0.9,"cornerRadius":12,
                 "crop":{"l":0.05,"t":0.1,"r":0.05,"b":0.1},
                 "shadow":{"blur":24,"spread":4,"color":"#000000CC","x":8,"y":12}}"##,
        )
        .unwrap();
        assert_eq!(with.crop.t, 0.1);
        assert_eq!(with.shadow.as_ref().unwrap().blur, 24.0);

        let without: TransformCfg = serde_json::from_str(
            r#"{"x":0,"y":0,"scale":1,"rotation":0,"opacity":1,"cornerRadius":0}"#,
        )
        .unwrap();
        assert_eq!(without.crop.l, 0.0);
        assert!(without.shadow.is_none());

        // shadow: null (what JSON.stringify produces for transform.shadow=null)
        let null_shadow: TransformCfg = serde_json::from_str(
            r#"{"x":0,"y":0,"scale":1,"rotation":0,"opacity":1,"cornerRadius":0,"shadow":null}"#,
        )
        .unwrap();
        assert!(null_shadow.shadow.is_none());
    }
}

// Frontend-rasterized text (session 9, Phase 4): the webview draws each text
// clip at 2x canvas resolution whenever content/style changes; Rust composites
// it as an ordinary texture layer (media_path "text:<clipId>", fit 0.5).
pub struct TextRaster {
    pub hash: String,
    pub w: u32,
    pub h: u32,
    pub rgba: Vec<u8>,
}

// Resolved per-layer draw parameters at one instant, all in canvas pixels.
#[derive(Debug, Clone)]
pub struct ResolvedLayer {
    pub x: f32,
    pub y: f32,
    pub scale: f32,
    pub rotation_deg: f32,
    pub opacity: f32,
    pub corner_radius: f32,
    pub crop: CropCfg,
    pub shadow: Option<ShadowCfg>,
    // exposure, contrast, saturation, temperature, tint — all-zero = identity.
    pub grade: [f32; 5],
}
