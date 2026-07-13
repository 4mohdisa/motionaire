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
    // Effects (foundation session, Phase 4).
    #[serde(default)]
    pub key: Option<KeyCfg>,
    #[serde(default)]
    pub blend: Option<String>, // normal | multiply | screen | add
    #[serde(default)]
    pub mask: Option<MaskCfg>,
    #[serde(default)]
    pub blur: f64, // +blur / -sharpen, px
    #[serde(default)]
    pub vignette: f64, // 0..1
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyCfg {
    pub color: String, // #RRGGBB
    pub tolerance: f64,
    pub softness: f64,
    pub spill: f64,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaskCfg {
    pub kind: String, // rect | ellipse
    pub x: f64,       // center offset in layer-local px
    pub y: f64,
    pub w: f64, // full size in layer-local px
    pub h: f64,
    pub feather: f64,
    pub invert: bool,
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
    // Speed ramps (session 9, Phase 7): "speed" keyframes remap time within
    // the clip's fixed timeline window — piecewise-linear rate integrated
    // from the clip start, clamped to the source range. Mirrors the
    // frontend's engine/time.ts sourceTime exactly.
    pub fn source_time(&self, t: f64) -> f64 {
        let rel = t - self.start;
        let mut kfs: Vec<(f64, f64)> = self
            .keyframes
            .iter()
            .filter(|k| k.prop == "speed")
            .map(|k| (k.t, k.v))
            .collect();
        if kfs.is_empty() {
            return self.in_ + rel * self.speed;
        }
        kfs.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        let src = self.in_ + integrate_rate(&kfs, rel);
        src.clamp(self.in_.min(self.out), self.out.max(self.in_))
    }
}

fn integrate_rate(kfs: &[(f64, f64)], rel: f64) -> f64 {
    if rel <= 0.0 {
        return 0.0;
    }
    let mut acc = 0.0;
    let mut u = 0.0;
    let first = kfs[0];
    if u < first.0 {
        let span = rel.min(first.0);
        acc += span * first.1;
        u = span;
        if u >= rel {
            return acc;
        }
    }
    for w in kfs.windows(2) {
        let (a, b) = (w[0], w[1]);
        if u >= rel {
            return acc;
        }
        if rel <= a.0 || b.0 <= a.0 {
            continue;
        }
        let from = u.max(a.0);
        let to = rel.min(b.0);
        if to <= from {
            continue;
        }
        let rate_at = |x: f64| a.1 + (b.1 - a.1) * (x - a.0) / (b.0 - a.0);
        acc += (rate_at(from) + rate_at(to)) / 2.0 * (to - from);
        u = to;
    }
    if u < rel {
        acc += (rel - u) * kfs[kfs.len() - 1].1;
    }
    acc
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

    #[test]
    fn speed_ramp_integration() {
        // rate ramps 1→2 linearly over rel 0..4 → ∫ = (1+2)/2 * 4 = 6.
        let kfs = vec![(0.0, 1.0), (4.0, 2.0)];
        assert!((integrate_rate(&kfs, 4.0) - 6.0).abs() < 1e-9);
        // halfway: ∫₀² of (1 + u/4) = 2 + 4/8*... = (1 + 1.5)/2 * 2 = 2.5
        assert!((integrate_rate(&kfs, 2.0) - 2.5).abs() < 1e-9);
        // held before first kf / after last kf
        let kfs2 = vec![(1.0, 2.0), (2.0, 2.0)];
        assert!((integrate_rate(&kfs2, 0.5) - 1.0).abs() < 1e-9); // 0.5 * 2 (held first)
        assert!((integrate_rate(&kfs2, 3.0) - 6.0).abs() < 1e-9); // uniform 2 throughout
    }
}

// Frontend-rasterized text (session 9, Phase 4): the webview draws each text
// clip at 2x canvas resolution whenever content/style changes; Rust composites
// it as an ordinary texture layer (media_path "text:<clipId>", fit 0.5).
#[derive(Clone)]
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
    // Effects (foundation, Phase 4), resolved per frame.
    pub key_tolerance: f32,
    pub key_softness: f32,
    pub key_spill: f32,
    pub mask_x: f32,
    pub mask_y: f32,
    pub mask_w: f32,
    pub mask_h: f32,
    pub mask_feather: f32,
    pub mask_invert: bool,
    pub mask_ellipse: bool,
    pub blur: f32,
    pub vignette: f32,
}
