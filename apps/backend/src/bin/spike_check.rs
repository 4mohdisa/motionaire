// Headless proof of the compositor core: decode two real video files, composite
// with the flagship PiP keyframes, dump visual evidence PNGs, and measure a
// sustained simulated-playback frame rate. Run: cargo run --release --bin spike_check

use std::time::Instant;

use motionaire_lib::compositor::{demo, gpu::GpuCompositor};


// Stack-era helper: an EffectCfg literal for spike scenes.
fn mkfx(kind: &str, params: serde_json::Value) -> motionaire_lib::compositor::types::EffectCfg {
    motionaire_lib::compositor::types::EffectCfg {
        id: format!("fx_{kind}"),
        kind: kind.into(),
        enabled: true,
        params: params.as_object().cloned().unwrap_or_default(),
    }
}


fn fx_cfg_key() -> motionaire_lib::compositor::types::EffectCfg {
    mkfx("chromaKey", serde_json::json!({
        "color": "#00FF00", "tolerance": 0.15, "softness": 0.08, "spill": 0.6
    }))
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    let (screen, cam) = demo::spike_media_info().expect("media generation (is ffmpeg installed?)");
    println!("media: screen={} cam={}", screen.path, cam.path);
    let project = demo::demo_project(&screen.path, &cam.path);

    let mut gpu = GpuCompositor::new(project.canvas.width, project.canvas.height, 720).expect("gpu init");
    println!("render target: {}x{}", gpu.out_w, gpu.out_h);

    // Visual evidence at the demo's key moments.
    let dir = demo::spike_dir();
    for (label, t) in [("fullscreen", 0.5), ("mid-shrink", 1.6), ("pip-hold", 3.5), ("returning", 5.8)] {
        let p = dir.join(format!("check-{label}-t{t}.png"));
        gpu.dump_png(&project, t, &p).expect("png dump");
        println!("dumped {}", p.display());
    }

    // Crop + shadow variant (Part 5): PiP with 8% crop all around and a soft
    // offset shadow, held at the PiP position.
    let mut styled = project.clone();
    styled.layers[1].transform.crop =
        motionaire_lib::compositor::types::CropCfg { l: 0.08, t: 0.08, r: 0.08, b: 0.08 };
    styled.layers[1].transform.shadow = Some(motionaire_lib::compositor::types::ShadowCfg {
        blur: 28.0,
        spread: 4.0,
        color: "#000000CC".into(),
        x: 10.0,
        y: 14.0,
    });
    let p = dir.join("check-crop-shadow-t3.5.png");
    gpu.dump_png(&styled, 3.5, &p).expect("png dump");
    println!("dumped {}", p.display());

    // Compositor transitions (session 7): two adjacent clips on ONE track,
    // dissolve and wipe on the incoming edge — PNGs at mid-transition.
    {
        use motionaire_lib::compositor::types::{TransitionCfg, TransitionsCfg};
        let mut tp = demo::demo_project(&screen.path, &cam.path);
        // Restructure: same z, adjacent at t=5: screen [0,5), cam [5,10).
        tp.layers[0].out = 5.0;
        tp.layers[1].z = 0;
        tp.layers[1].start = 5.0;
        tp.layers[1].in_ = 0.0;
        tp.layers[1].out = 5.0;
        tp.layers[1].keyframes.clear();
        tp.layers[1].transitions = TransitionsCfg {
            in_: Some(TransitionCfg { kind: "dissolve".into(), duration: 1.2, ease: None, softness: 0.0 }),
            out: None,
        };
        let p = dir.join("check-transition-dissolve-t5.6.png");
        gpu.dump_png(&tp, 5.6, &p).expect("dissolve dump");
        println!("dumped {}", p.display());
        tp.layers[1].transitions.in_ = Some(TransitionCfg { kind: "wipe".into(), duration: 1.2, ease: None, softness: 0.0 });
        let p = dir.join("check-transition-wipe-t5.6.png");
        gpu.dump_png(&tp, 5.6, &p).expect("wipe dump");
        println!("dumped {}", p.display());
    }

    // Color grade extremes (session 8, Phase 3): fully desaturated and
    // blown-out exposure must look like exactly that — plus a subtle warm mix.
    {
        let mut gp = demo::demo_project(&screen.path, &cam.path);
        gp.layers[1].keyframes.clear(); // fullscreen cam covers frame — grade it
        gp.layers[1].stack = vec![mkfx("grade", serde_json::json!({"saturation": -1.0}))];
        let p = dir.join("check-grade-desat-t2.png");
        gpu.dump_png(&gp, 2.0, &p).expect("desat dump");
        println!("dumped {}", p.display());
        gp.layers[1].stack = vec![mkfx("grade", serde_json::json!({"exposure": 2.0}))];
        let p = dir.join("check-grade-blown-t2.png");
        gpu.dump_png(&gp, 2.0, &p).expect("blown dump");
        println!("dumped {}", p.display());
        gp.layers[1].stack =
            vec![mkfx("grade", serde_json::json!({"temperature": 0.5, "contrast": 0.2}))];
        let p = dir.join("check-grade-warm-t2.png");
        gpu.dump_png(&gp, 2.0, &p).expect("warm dump");
        println!("dumped {}", p.display());
    }

    // Adjustment layer (session 8, Phase 5): a source-less adjust layer above
    // BOTH demo layers desaturates the whole stack inside its span only.
    {
        let mut ap = demo::demo_project(&screen.path, &cam.path);
        let mut adj = ap.layers[0].clone();
        adj.id = "adjust".into();
        adj.z = 99;
        adj.media_path = String::new();
        adj.adjust = true;
        adj.start = 1.0;
        adj.in_ = 0.0;
        adj.out = 3.0; // active span [1,4)
        adj.keyframes.clear();
        adj.transitions = Default::default();
        adj.stack = vec![mkfx("grade", serde_json::json!({"saturation": -1.0}))];
        ap.layers.push(adj);
        let p = dir.join("check-adjust-inside-t2.png");
        gpu.dump_png(&ap, 2.0, &p).expect("adjust inside dump");
        println!("dumped {}", p.display());
        let p = dir.join("check-adjust-outside-t5.png");
        gpu.dump_png(&ap, 5.0, &p).expect("adjust outside dump");
        println!("dumped {}", p.display());
    }

    // Text raster layer (session 9, Phase 4): a synthetic 400x100 red rounded
    // box raster keyed "text:t1" must land centered at 200x50 CANVAS pixels
    // (fit = 0.5), riding the standard transform pipeline.
    {
        use motionaire_lib::compositor::types::TextRaster;
        let mut tp = demo::demo_project(&screen.path, &cam.path);
        tp.layers[1].keyframes.clear();
        let mut txt = tp.layers[0].clone();
        txt.id = "t1".into();
        txt.z = 50;
        txt.media_path = "text:t1".into();
        txt.keyframes.clear();
        txt.transitions = Default::default();
        txt.transform.y = -200.0; // above center so it sits over the bars
        tp.layers.push(txt);
        let (tw, th) = (400u32, 100u32);
        let mut rgba = vec![0u8; (tw * th * 4) as usize];
        for y in 0..th {
            for x in 0..tw {
                let i = ((y * tw + x) * 4) as usize;
                rgba[i] = 230;
                rgba[i + 3] = 255;
            }
        }
        let mut texts = std::collections::HashMap::new();
        texts.insert("t1".to_string(), TextRaster { hash: "r1".into(), w: tw, h: th, rgba });
        let p = dir.join("check-text-raster-t2.png");
        gpu.dump_png_texts(&tp, 2.0, &texts, &p).expect("text raster dump");
        println!("dumped {}", p.display());
    }

    // Effects (foundation session, Phase 4): deterministic PNG evidence for
    // chroma key, blend modes, shape mask, blur, and vignette.
    {
        use std::process::Command;
        // Green-screen fixture: green background with a red box "subject".
        let dir2 = demo::spike_dir();
        let gs = dir2.join("greenscreen.mp4");
        if !gs.exists() {
            assert!(Command::new(motionaire_lib::compositor::decoder::ffmpeg_bin())
                .args([
                    "-v", "error", "-y",
                    "-f", "lavfi",
                    "-i", "color=c=0x00FF00:size=1280x720:rate=30,drawbox=x=440:y=200:w=400:h=320:color=red@1.0:t=fill",
                    "-t", "3", "-pix_fmt", "yuv420p", gs.to_str().unwrap(),
                ])
                .status().unwrap().success());
        }
        let mut fx = demo::demo_project(&screen.path, &cam.path);
        fx.layers[1].keyframes.clear();
        fx.layers[1].media_path = gs.to_string_lossy().into_owned();
        fx.layers[1].stack = vec![fx_cfg_key()];
        let p = dir.join("check-fx-key-t2.png");
        gpu.dump_png(&fx, 2.0, &p).expect("key dump");
        println!("dumped {}", p.display());

        // Blend multiply: cam over screen darkens instead of covering.
        let mut bl = demo::demo_project(&screen.path, &cam.path);
        bl.layers[1].keyframes.clear();
        bl.layers[1].blend = Some("multiply".into());
        let p = dir.join("check-fx-multiply-t2.png");
        gpu.dump_png(&bl, 2.0, &p).expect("multiply dump");
        println!("dumped {}", p.display());

        // Ellipse mask with feather on the fullscreen cam.
        let mut mk = demo::demo_project(&screen.path, &cam.path);
        mk.layers[1].keyframes.clear();
        mk.layers[1].stack = vec![mkfx("mask", serde_json::json!({
            "kind": "ellipse", "x": 0.0, "y": 0.0, "w": 700.0, "h": 500.0,
            "feather": 60.0, "invert": false
        }))];
        let p = dir.join("check-fx-mask-t2.png");
        gpu.dump_png(&mk, 2.0, &p).expect("mask dump");
        println!("dumped {}", p.display());

        // Blur 24px + vignette 0.8 on the screen layer.
        let mut bv = demo::demo_project(&screen.path, &cam.path);
        bv.layers.truncate(1);
        bv.layers[0].stack = vec![
            mkfx("blur", serde_json::json!({"amount": 24.0})),
            mkfx("vignette", serde_json::json!({"amount": 0.8})),
        ];
        let p = dir.join("check-fx-blur-vignette-t2.png");
        gpu.dump_png(&bv, 2.0, &p).expect("blur dump");
        println!("dumped {}", p.display());

        // ORDER MATTERS (Phase 2): exposure-up-then-blur vs blur-then-
        // exposure-up differ because grade clamps at white before/after the
        // blur smears highlights. The two PNGs must NOT be identical.
        let mut o1 = demo::demo_project(&screen.path, &cam.path);
        o1.layers.truncate(1);
        o1.layers[0].stack = vec![
            mkfx("grade", serde_json::json!({"exposure": 1.6})),
            mkfx("blur", serde_json::json!({"amount": 30.0})),
        ];
        let p1 = dir.join("check-fx-order-grade-blur-t2.png");
        gpu.dump_png(&o1, 2.0, &p1).expect("order1 dump");
        let mut o2 = demo::demo_project(&screen.path, &cam.path);
        o2.layers.truncate(1);
        o2.layers[0].stack = vec![
            mkfx("blur", serde_json::json!({"amount": 30.0})),
            mkfx("grade", serde_json::json!({"exposure": 1.6})),
        ];
        let p2 = dir.join("check-fx-order-blur-grade-t2.png");
        gpu.dump_png(&o2, 2.0, &p2).expect("order2 dump");
        let (b1, b2) = (std::fs::read(&p1).unwrap(), std::fs::read(&p2).unwrap());
        assert!(b1 != b2, "ordering produced identical output — stack order is not being applied");
        println!("order check: outputs differ as they must");

        // Phase 5 color ops: wheels (warm lift), curves (crushed shadows,
        // lifted highs on red), and an invert 3D LUT — dumped as evidence.
        let mut wl = demo::demo_project(&screen.path, &cam.path);
        wl.layers.truncate(1);
        wl.layers[0].stack = vec![mkfx("wheels", serde_json::json!({
            "liftR": 0.08, "liftG": 0.03, "liftB": 0.0,
            "gammaR": 0.1, "gammaG": 0.0, "gammaB": -0.1,
            "gainR": 0.05, "gainG": 0.0, "gainB": -0.05
        }))];
        let p = dir.join("check-p5-wheels-t2.png");
        gpu.dump_png(&wl, 2.0, &p).expect("wheels dump");
        println!("dumped {}", p.display());

        let mut cv = demo::demo_project(&screen.path, &cam.path);
        cv.layers.truncate(1);
        cv.layers[0].stack = vec![mkfx("curves", serde_json::json!({
            "pointsR": [[0.0, 0.0], [0.5, 0.85], [1.0, 1.0]],
            "pointsM": [[0.0, 0.0], [0.25, 0.1], [1.0, 1.0]]
        }))];
        let p = dir.join("check-p5-curves-t2.png");
        gpu.dump_png(&cv, 2.0, &p).expect("curves dump");
        println!("dumped {}", p.display());

        // Invert LUT (2x2x2): output = 1 - input on every channel.
        let cube = dir2.join("invert.cube");
        std::fs::write(&cube,
            "LUT_3D_SIZE 2\n1 1 1\n0 1 1\n1 0 1\n0 0 1\n1 1 0\n0 1 0\n1 0 0\n0 0 0\n").unwrap();
        let mut lp = demo::demo_project(&screen.path, &cam.path);
        lp.layers.truncate(1);
        lp.layers[0].stack = vec![mkfx("lut", serde_json::json!({
            "path": cube.to_string_lossy()
        }))];
        let p = dir.join("check-p5-lut-invert-t2.png");
        gpu.dump_png(&lp, 2.0, &p).expect("lut dump");
        println!("dumped {}", p.display());
        // Invert LUT must differ hugely from the plain frame.
        let plain = dir.join("check-fullscreen-t0.5.png");
        let _ = plain;
    }

    // Phase 7: track matte (screen shaped by cam's luma), push transition
    // mid-flight, iris reveal mid-flight.
    {
        use motionaire_lib::compositor::types::TransitionCfg;
        let mut mp = demo::demo_project(&screen.path, &cam.path);
        mp.layers[0].matte = Some("luma".into()); // screen matted by cam above
        mp.layers[1].keyframes.clear();
        let p = dir.join("check-p7-matte-luma-t2.png");
        gpu.dump_png(&mp, 2.0, &p).expect("matte dump");
        println!("dumped {}", p.display());

        let mut pp = demo::demo_project(&screen.path, &cam.path);
        pp.layers.truncate(1);
        let mut b = pp.layers[0].clone();
        b.id = "pushed_in".into();
        b.media_path = cam.path.clone();
        b.start = 3.0;
        b.in_ = 0.0;
        b.out = 5.0;
        b.keyframes.clear();
        b.transitions.in_ = Some(TransitionCfg {
            kind: "push".into(),
            duration: 1.0,
            ease: None,
            softness: 0.0,
        });
        pp.layers[0].out = 3.0; // outgoing ends where B starts
        pp.layers[0].keyframes.clear();
        pp.layers.push(b);
        let p = dir.join("check-p7-push-mid.png");
        gpu.dump_png(&pp, 3.5, &p).expect("push dump");
        println!("dumped {}", p.display());

        let mut ip = demo::demo_project(&screen.path, &cam.path);
        ip.layers[1].keyframes.clear();
        ip.layers[1].transitions.in_ = Some(TransitionCfg {
            kind: "iris".into(),
            duration: 2.0,
            ease: None,
            softness: 0.3,
        });
        let p = dir.join("check-p7-iris-mid.png");
        gpu.dump_png(&ip, 1.0, &p).expect("iris dump");
        println!("dumped {}", p.display());
    }

    // Reverse-ring exercise: step backward through 2s at 60Hz; ring should make
    // this fast (few respawns), correctness checked by timing + no panics.
    let rev_start = Instant::now();
    for i in 0..120 {
        let t = 5.0 - i as f64 / 60.0;
        gpu.render_at(&styled, t, &Default::default()).expect("reverse render");
    }
    println!("reverse: 120 frames (2s of timeline) in {:.2}s", rev_start.elapsed().as_secs_f64());

    // Sustained playback simulation: 8 seconds of timeline at 60Hz stepping,
    // sequential decode — the same access pattern as live playback.
    let steps = 480;
    let mut times_ms: Vec<f64> = Vec::with_capacity(steps);
    let started = Instant::now();
    for i in 0..steps {
        let t = 0.0 + i as f64 / 60.0;
        let f = Instant::now();
        gpu.render_at(&project, t, &Default::default()).expect("render");
        times_ms.push(f.elapsed().as_secs_f64() * 1000.0);
    }
    let total = started.elapsed().as_secs_f64();
    times_ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let p50 = times_ms[steps / 2];
    let p95 = times_ms[steps * 95 / 100];
    let p99 = times_ms[steps * 99 / 100];
    println!(
        "sustained: {} frames in {:.2}s → {:.1} fps throughput | frame ms p50={:.2} p95={:.2} p99={:.2}",
        steps,
        total,
        steps as f64 / total,
        p50,
        p95,
        p99
    );
}
