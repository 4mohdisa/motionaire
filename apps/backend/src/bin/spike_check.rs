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

    let mut gpu = GpuCompositor::new(project.canvas.width, project.canvas.height).expect("gpu init");
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

    // Reverse-ring exercise: step backward through 2s at 60Hz; ring should make
    // this fast (few respawns), correctness checked by timing + no panics.
    let rev_start = Instant::now();
    for i in 0..120 {
        let t = 5.0 - i as f64 / 60.0;
        gpu.render_at(&styled, t).expect("reverse render");
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
        gpu.render_at(&project, t).expect("render");
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
