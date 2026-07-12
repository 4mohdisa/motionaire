// Headless proof of the compositor core: decode two real video files, composite
// with the flagship PiP keyframes, dump visual evidence PNGs, and measure a
// sustained simulated-playback frame rate. Run: cargo run --release --bin spike_check

use std::time::Instant;

use motionaire_lib::compositor::{demo, gpu::GpuCompositor};

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
            in_: Some(TransitionCfg { kind: "dissolve".into(), duration: 1.2 }),
            out: None,
        };
        let p = dir.join("check-transition-dissolve-t5.6.png");
        gpu.dump_png(&tp, 5.6, &p).expect("dissolve dump");
        println!("dumped {}", p.display());
        tp.layers[1].transitions.in_ = Some(TransitionCfg { kind: "wipe".into(), duration: 1.2 });
        let p = dir.join("check-transition-wipe-t5.6.png");
        gpu.dump_png(&tp, 5.6, &p).expect("wipe dump");
        println!("dumped {}", p.display());
    }

    // Color grade extremes (session 8, Phase 3): fully desaturated and
    // blown-out exposure must look like exactly that — plus a subtle warm mix.
    {
        use motionaire_lib::compositor::types::GradeCfg;
        let mut gp = demo::demo_project(&screen.path, &cam.path);
        gp.layers[1].keyframes.clear(); // fullscreen cam covers frame — grade it
        gp.layers[1].grade = Some(GradeCfg { saturation: -1.0, ..Default::default() });
        let p = dir.join("check-grade-desat-t2.png");
        gpu.dump_png(&gp, 2.0, &p).expect("desat dump");
        println!("dumped {}", p.display());
        gp.layers[1].grade = Some(GradeCfg { exposure: 2.0, ..Default::default() });
        let p = dir.join("check-grade-blown-t2.png");
        gpu.dump_png(&gp, 2.0, &p).expect("blown dump");
        println!("dumped {}", p.display());
        gp.layers[1].grade =
            Some(GradeCfg { temperature: 0.5, contrast: 0.2, ..Default::default() });
        let p = dir.join("check-grade-warm-t2.png");
        gpu.dump_png(&gp, 2.0, &p).expect("warm dump");
        println!("dumped {}", p.display());
    }

    // Adjustment layer (session 8, Phase 5): a source-less adjust layer above
    // BOTH demo layers desaturates the whole stack inside its span only.
    {
        use motionaire_lib::compositor::types::GradeCfg;
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
        adj.grade = Some(GradeCfg { saturation: -1.0, ..Default::default() });
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
