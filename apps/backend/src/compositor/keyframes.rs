use super::types::{ChainOp, Kf, Layer, ResolvedLayer};

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
            if l.ease == "bezier" {
                return bezier_value(l, r, t_rel);
            }
            let span = r.t - l.t;
            let p = if span <= 0.0 { 1.0 } else { (t_rel - l.t) / span };
            return l.v + (r.v - l.v) * ease(&l.ease, p);
        }
    }
    last.v
}

// Cubic bezier segment in (t, v) space (Phase 3). MIRROR CONTRACT: identical
// to engine/keyframes.ts bezierValue — thirds defaults, dt clamped inside the
// segment (x(u) monotone), 24-step bisection.
fn bezier_value(k1: &Kf, k2: &Kf, t_abs: f64) -> f64 {
    let span = k2.t - k1.t;
    if span <= 0.0 {
        return k2.v;
    }
    let ho = k1.ho.unwrap_or([span / 3.0, 0.0]);
    let hi = k2.hi.unwrap_or([-span / 3.0, 0.0]);
    let x0 = k1.t;
    let x1 = k1.t + ho[0].clamp(0.0, span);
    let x2 = k2.t + hi[0].clamp(-span, 0.0);
    let x3 = k2.t;
    let (y0, y1, y2, y3) = (k1.v, k1.v + ho[1], k2.v + hi[1], k2.v);
    let (mut lo, mut hi_u) = (0.0f64, 1.0f64);
    for _ in 0..24 {
        let mid = (lo + hi_u) / 2.0;
        let m = 1.0 - mid;
        let x = m * m * m * x0 + 3.0 * m * m * mid * x1 + 3.0 * m * mid * mid * x2
            + mid * mid * mid * x3;
        if x < t_abs {
            lo = mid;
        } else {
            hi_u = mid;
        }
    }
    let u = (lo + hi_u) / 2.0;
    let m = 1.0 - u;
    m * m * m * y0 + 3.0 * m * m * u * y1 + 3.0 * m * u * u * y2 + u * u * u * y3
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
            // Adjustment layers fold their stack GRADES onto lower layers via
            // the composite pass; a normal layer's grade rides its chain.
            let mut g = [0.0f32; 5];
            if layer.adjust {
                for fx in layer.stack.iter().filter(|f| f.enabled && f.kind == "grade") {
                    for (i, name) in ["exposure", "contrast", "saturation", "temperature", "tint"]
                        .iter()
                        .enumerate()
                    {
                        let prop = format!("fx.{}.{}", fx.id, name);
                        g[i] += resolve(kf, &prop, fx.num(name), t_rel) as f32;
                    }
                }
            }
            g
        },
        chain: layer
            .stack
            .iter()
            .filter(|fx| fx.enabled)
            .filter_map(|fx| {
                let rp = |name: &str| {
                    resolve(kf, &format!("fx.{}.{}", fx.id, name), fx.num(name), t_rel) as f32
                };
                let mut op = ChainOp { op: 0, p: [0.0; 8], color: [0.0; 3] };
                match fx.kind.as_str() {
                    "chromaKey" => {
                        op.op = 1;
                        op.p[0] = rp("tolerance");
                        op.p[1] = rp("softness");
                        op.p[2] = rp("spill");
                        op.color = parse_rgb(fx.text("color"));
                    }
                    "grade" => {
                        op.op = 2;
                        op.p[0] = rp("exposure");
                        op.p[1] = rp("contrast");
                        op.p[2] = rp("saturation");
                        op.p[3] = rp("temperature");
                        op.p[4] = rp("tint");
                    }
                    "blur" => {
                        op.op = 3;
                        op.p[0] = rp("amount");
                        if op.p[0].abs() < 0.01 {
                            return None; // identity — skip the pass entirely
                        }
                    }
                    "mask" => {
                        op.op = 4;
                        op.p[0] = rp("x");
                        op.p[1] = rp("y");
                        op.p[2] = (rp("w") / 2.0).max(1.0);
                        op.p[3] = (rp("h") / 2.0).max(1.0);
                        op.p[4] = rp("feather");
                        op.p[5] = if fx.flag("invert") { 1.0 } else { 0.0 };
                        op.p[6] = if fx.text("kind") == "ellipse" { 1.0 } else { 0.0 };
                    }
                    "vignette" => {
                        op.op = 5;
                        op.p[0] = rp("amount");
                        if op.p[0] <= 0.001 {
                            return None;
                        }
                    }
                    _ => return None,
                }
                Some(op)
            })
            .collect(),
    }
}

fn parse_rgb(hex: &str) -> [f32; 3] {
    let h = hex.trim_start_matches('#');
    if h.len() < 6 {
        return [0.0, 1.0, 0.0];
    }
    let c = |i: usize| u8::from_str_radix(&h[i..i + 2], 16).unwrap_or(0) as f32 / 255.0;
    [c(0), c(2), c(4)]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kf(prop: &str, t: f64, v: f64, ease: &str) -> Kf {
        Kf { prop: prop.into(), t, v, ease: ease.into(), ho: None, hi: None }
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
                Kf { prop: "v".into(), t: 0.0, v: 0.0, ease: ease.into(), ho: None, hi: None },
                Kf { prop: "v".into(), t: 1.0, v: 1.0, ease: "linear".into(), ho: None, hi: None },
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
    fn bezier_segments_resolve_and_match_thirds_linear() {
        // Thirds handles == exact linear; asymmetric handles bend the curve.
        let mk = |t: f64, v: f64, ease: &str, ho: Option<[f64; 2]>, hi: Option<[f64; 2]>| Kf {
            prop: "v".into(), t, v, ease: ease.into(), ho, hi,
        };
        let lin = vec![
            mk(0.0, 0.0, "bezier", Some([1.0 / 3.0, 1.0 / 3.0]), None),
            mk(1.0, 1.0, "linear", None, Some([-1.0 / 3.0, -1.0 / 3.0])),
        ];
        for i in 0..=10 {
            let x = i as f64 / 10.0;
            let v = resolve(&lin, "v", 0.0, x);
            assert!((v - x).abs() < 1e-5, "thirds linear at {x}: {v}");
        }
        // ease-in-shaped: flat out-handle → slow start (value below linear).
        let eased = vec![
            mk(0.0, 0.0, "bezier", Some([0.33, 0.0]), None),
            mk(1.0, 1.0, "linear", None, Some([-0.33, -1.0])),
        ];
        let mid = resolve(&eased, "v", 0.0, 0.5);
        assert!(mid < 0.35, "ease-in bezier mid {mid}");
        // exact t³ equivalence (Phase 3 conversion contract)
        let cubed = resolve(&eased, "v", 0.0, 0.5);
        assert!((cubed - 0.125).abs() < 1e-4, "t^3 via bezier: {cubed}");
        // dt clamps keep x monotone even with hostile handles
        let hostile = vec![
            mk(0.0, 0.0, "bezier", Some([99.0, 5.0]), None),
            mk(1.0, 1.0, "linear", None, Some([99.0, -5.0])),
        ];
        let v = resolve(&hostile, "v", 0.0, 0.9);
        assert!(v.is_finite());
    }

    #[test]
    fn left_keyframe_easing_wins() {
        let kfs = vec![
            Kf { prop: "v".into(), t: 0.0, v: 0.0, ease: "linear".into(), ho: None, hi: None },
            Kf { prop: "v".into(), t: 1.0, v: 1.0, ease: "easeIn".into(), ho: None, hi: None }, // must be ignored
        ];
        assert!((resolve(&kfs, "v", 0.0, 0.5) - 0.5).abs() < 1e-12);
    }

    #[test]
    fn resolve_layer_resolves_stack_instances_in_order() {
        // Two instances of the SAME type with different params + a keyframed
        // param addressed per instance (fx.<id>.<param>) — the Phase 2 model.
        let layer: Layer = serde_json::from_str(
            r##"{
              "id":"c1","z":0,"mediaPath":"/x.mp4","start":0,"in":0,"out":10,"speed":1,
              "transform":{"x":0,"y":0,"scale":1,"rotation":0,"opacity":1,"cornerRadius":0},
              "keyframes":[
                {"prop":"fx.b1.amount","t":0,"v":0,"ease":"linear"},
                {"prop":"fx.b1.amount","t":2,"v":8,"ease":"linear"}
              ],
              "stack":[
                {"id":"b1","type":"blur","enabled":true,"params":{"amount":0}},
                {"id":"g1","type":"grade","enabled":true,"params":{"exposure":0.5}},
                {"id":"b2","type":"blur","enabled":true,"params":{"amount":2}},
                {"id":"m1","type":"mask","enabled":true,
                 "params":{"kind":"ellipse","x":0,"y":0,"w":400,"h":300,"feather":20,"invert":false}},
                {"id":"dead","type":"vignette","enabled":false,"params":{"amount":0.9}}
              ]
            }"##,
        )
        .unwrap();
        let mid = resolve_layer(&layer, 1.0);
        // Order preserved; disabled instance dropped; identity blur kept
        // because its KEYFRAME makes it non-identity at t=1 (amount 4).
        assert_eq!(mid.chain.len(), 4, "chain {:?}", mid.chain);
        assert_eq!(mid.chain[0].op, 3);
        assert!((mid.chain[0].p[0] - 4.0).abs() < 1e-6, "kf blur {}", mid.chain[0].p[0]);
        assert_eq!(mid.chain[1].op, 2);
        assert!((mid.chain[1].p[0] - 0.5).abs() < 1e-9);
        assert_eq!(mid.chain[2].op, 3);
        assert!((mid.chain[2].p[0] - 2.0).abs() < 1e-9);
        assert_eq!(mid.chain[3].op, 4);
        assert!((mid.chain[3].p[2] - 200.0).abs() < 1e-9); // half-w
        assert!((mid.chain[3].p[6] - 1.0).abs() < 1e-9); // ellipse flag
        // Normal layer: no adjust grade fold.
        assert_eq!(mid.grade, [0.0; 5]);
    }

    #[test]
    fn adjust_layer_folds_stack_grades() {
        let layer: Layer = serde_json::from_str(
            r##"{
              "id":"a1","z":9,"mediaPath":"","start":0,"in":0,"out":10,"speed":1,"adjust":true,
              "transform":{"x":0,"y":0,"scale":1,"rotation":0,"opacity":1,"cornerRadius":0},
              "keyframes":[],
              "stack":[{"id":"g1","type":"grade","enabled":true,"params":{"saturation":-1.0}}]
            }"##,
        )
        .unwrap();
        let r = resolve_layer(&layer, 1.0);
        assert!((r.grade[2] - (-1.0)).abs() < 1e-9);
    }
}
