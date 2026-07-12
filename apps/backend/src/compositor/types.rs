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
}
