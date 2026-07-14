use super::types::{Kf, Layer, ResolvedLayer};

// THE single source of truth for property resolution (foundation session,
// Phase 1): every rendered and exported pixel resolves through this file and
// types.rs source_time. The TypeScript engine/keyframes.ts is a display-only
// mirror for DOM-side consumers (panel readouts, audio-element gain, element
// pre-seek, browser fallback); the f1-parity self-test compares both against
// a torture fixture via resolve_parity_probe and fails loudly on drift.
// Keyframe times are clip-relative in TIMELINE seconds (DECISIONS.md session 2).

fn ease(kind: &str, t: f64) -> f64 {
    let t = t.clamp(0.0, 1.0);
    match kind {
        "easeIn" => t * t * t,
        "easeOut" => 1.0 - (1.0 - t).powi(3),
        "easeInOut" => {
            if t < 0.5 {
                4.0 * t * t * t
            } else {
                1.0 - (-2.0 * t + 2.0).powi(3) / 2.0
            }
        }
        "spring" => 1.0 - (-6.0 * t).exp() * (12.0 * t).cos(),
        _ => t, // linear
    }
}

fn resolve(kfs: &[Kf], prop: &str, static_v: f64, t_rel: f64) -> f64 {
    let mut of_prop: Vec<&Kf> = kfs.iter().filter(|k| k.prop == prop).collect();
    if of_prop.is_empty() {
        return static_v;
    }
    of_prop.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap());
    if t_rel <= of_prop[0].t {
        return of_prop[0].v;
    }
    let last = of_prop[of_prop.len() - 1];
    if t_rel >= last.t {
        return last.v;
    }
    for w in of_prop.windows(2) {
        let (l, r) = (w[0], w[1]);
        if l.t <= t_rel && t_rel <= r.t {
            let span = r.t - l.t;
            let p = if span <= 0.0 { 1.0 } else { (t_rel - l.t) / span };
            return l.v + (r.v - l.v) * ease(&l.ease, p);
        }
    }
    last.v
}

pub fn resolve_layer(layer: &Layer, playhead: f64) -> ResolvedLayer {
    let t_rel = playhead - layer.start;
    let tr = &layer.transform;
    let kf = &layer.keyframes;
    ResolvedLayer {
        x: resolve(kf, "transform.x", tr.x, t_rel) as f32,
        y: resolve(kf, "transform.y", tr.y, t_rel) as f32,
        scale: resolve(kf, "transform.scale", tr.scale, t_rel) as f32,
        rotation_deg: resolve(kf, "transform.rotation", tr.rotation, t_rel) as f32,
        opacity: resolve(kf, "transform.opacity", tr.opacity, t_rel) as f32,
        corner_radius: resolve(kf, "transform.cornerRadius", tr.corner_radius, t_rel) as f32,
        // Crop and shadow are static (non-scalar) properties — no keyframes.
        crop: tr.crop,
        shadow: tr.shadow.clone(),
        grade: {
            let g = layer.grade.unwrap_or_default();
            [
                resolve(kf, "grade.exposure", g.exposure, t_rel) as f32,
                resolve(kf, "grade.contrast", g.contrast, t_rel) as f32,
                resolve(kf, "grade.saturation", g.saturation, t_rel) as f32,
                resolve(kf, "grade.temperature", g.temperature, t_rel) as f32,
                resolve(kf, "grade.tint", g.tint, t_rel) as f32,
            ]
        },
        key_tolerance: layer
            .key
            .as_ref()
            .map(|k| resolve(kf, "key.tolerance", k.tolerance, t_rel) as f32)
            .unwrap_or(0.0),
        key_softness: layer
            .key
            .as_ref()
            .map(|k| resolve(kf, "key.softness", k.softness, t_rel) as f32)
            .unwrap_or(0.0),
        key_spill: layer
            .key
            .as_ref()
            .map(|k| resolve(kf, "key.spill", k.spill, t_rel) as f32)
            .unwrap_or(0.0),
        mask_x: layer
            .mask
            .as_ref()
            .map(|m| resolve(kf, "mask.x", m.x, t_rel) as f32)
            .unwrap_or(0.0),
        mask_y: layer
            .mask
            .as_ref()
            .map(|m| resolve(kf, "mask.y", m.y, t_rel) as f32)
            .unwrap_or(0.0),
        mask_w: layer
            .mask
            .as_ref()
            .map(|m| resolve(kf, "mask.w", m.w, t_rel) as f32)
            .unwrap_or(0.0),
        mask_h: layer
            .mask
            .as_ref()
            .map(|m| resolve(kf, "mask.h", m.h, t_rel) as f32)
            .unwrap_or(0.0),
        mask_feather: layer
            .mask
            .as_ref()
            .map(|m| resolve(kf, "mask.feather", m.feather, t_rel) as f32)
            .unwrap_or(0.0),
        mask_invert: layer.mask.as_ref().map(|m| m.invert).unwrap_or(false),
        mask_ellipse: layer.mask.as_ref().map(|m| m.kind == "ellipse").unwrap_or(false),
        blur: resolve(kf, "blur", layer.blur, t_rel) as f32,
        vignette: resolve(kf, "vignette", layer.vignette, t_rel) as f32,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kf(prop: &str, t: f64, v: f64, ease: &str) -> Kf {
        Kf { prop: prop.into(), t, v, ease: ease.into() }
    }

    #[test]
    fn matches_frontend_resolution_rules() {
        let kfs = vec![
            kf("transform.scale", 0.0, 1.0, "easeInOut"),
            kf("transform.scale", 1.2, 0.1, "easeInOut"),
        ];
        // Same checks the frontend passed in session 2's browser test.
        assert_eq!(resolve(&kfs, "transform.scale", 1.0, -0.5), 1.0);
        assert_eq!(resolve(&kfs, "transform.scale", 1.0, 2.0), 0.1);
        let mid = resolve(&kfs, "transform.scale", 1.0, 0.6);
        assert!((mid - 0.55).abs() < 1e-9, "easeInOut midpoint, got {mid}");
        let quarter = resolve(&kfs, "transform.scale", 1.0, 0.3);
        assert!((quarter - 0.944).abs() < 5e-4, "easeInOut quarter, got {quarter}");
        // No keyframes → static value.
        assert_eq!(resolve(&[], "transform.scale", 0.7, 0.5), 0.7);
    }

    // Drift alarm for the TS mirror (engine/keyframes.ts): the two easing
    // tables must stay formula-identical. The e2e parity probe compares live
    // resolution; this pins the raw curves so a unit run catches it first.
    #[test]
    fn easing_table_matches_ts_mirror() {
        let curve = |ease: &str, x: f64| {
            let kfs = vec![
                Kf { prop: "v".into(), t: 0.0, v: 0.0, ease: ease.into() },
                Kf { prop: "v".into(), t: 1.0, v: 1.0, ease: "linear".into() },
            ];
            resolve(&kfs, "v", 0.0, x)
        };
        assert!((curve("linear", 0.5) - 0.5).abs() < 1e-12);
        assert!((curve("easeIn", 0.5) - 0.125).abs() < 1e-12); // t³
        assert!((curve("easeOut", 0.5) - 0.875).abs() < 1e-12); // 1-(1-t)³
        assert!((curve("easeInOut", 0.25) - 0.0625).abs() < 1e-12); // 4t³ below ½
        // spring: damped cosine approximation, 1 - e^{-6t}·cos(12t)
        let s = curve("spring", 0.5);
        let expect = 1.0 - (-3.0f64).exp() * (6.0f64).cos();
        assert!((s - expect).abs() < 1e-9, "spring(0.5) = {s}, want {expect}");
    }

    #[test]
    fn left_keyframe_easing_wins() {
        let kfs = vec![
            Kf { prop: "v".into(), t: 0.0, v: 0.0, ease: "linear".into() },
            Kf { prop: "v".into(), t: 1.0, v: 1.0, ease: "easeIn".into() }, // must be ignored
        ];
        assert!((resolve(&kfs, "v", 0.0, 0.5) - 0.5).abs() < 1e-12);
    }

    #[test]
    fn resolve_layer_covers_effect_scalars() {
        let layer: Layer = serde_json::from_str(
            r##"{
              "id":"c1","z":0,"mediaPath":"/x.mp4","start":0,"in":0,"out":10,"speed":1,
              "transform":{"x":0,"y":0,"scale":1,"rotation":0,"opacity":1,"cornerRadius":0},
              "keyframes":[
                {"prop":"blur","t":0,"v":0,"ease":"linear"},
                {"prop":"blur","t":2,"v":8,"ease":"linear"},
                {"prop":"mask.x","t":0,"v":-100,"ease":"linear"},
                {"prop":"mask.x","t":2,"v":100,"ease":"linear"}
              ],
              "mask":{"kind":"ellipse","x":0,"y":0,"w":400,"h":300,"feather":20,"invert":false},
              "blur":0,"vignette":0.4
            }"##,
        )
        .unwrap();
        let mid = resolve_layer(&layer, 1.0);
        assert!((mid.blur - 4.0).abs() < 1e-9, "blur mid {}", mid.blur);
        assert!((mid.vignette - 0.4).abs() < 1e-9); // static, no keyframes
        assert!((mid.mask_x - 0.0).abs() < 1e-9, "mask.x mid {}", mid.mask_x);
        assert!((mid.mask_w - 400.0).abs() < 1e-9);
        assert!(mid.mask_ellipse);
    }
}
