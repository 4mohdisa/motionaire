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
