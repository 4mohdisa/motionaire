// Chaos soak for the compositor: continuous playback with aggressive scrubbing,
// rate flips, project re-syncs, canvas-dim flips (forces GPU re-init), WS client
// churn, and periodic SIGKILL of the ffmpeg decode children. Run:
//   MOTIONAIRE_WS_PORT=43118 cargo run --release --bin soak
// Env: SOAK_SECS (default 2100 = 35 min).
//
// What this deliberately can't cover: true machine sleep/wake and native window
// minimize/restore — those need a human at the machine. The reconnect-shaped
// paths they exercise (client drop/reconnect, render stall, device re-init) are
// all driven here directly.

use std::process::Command;
use std::sync::atomic::Ordering;
use std::time::{Duration, Instant};

use motionaire_lib::compositor::{self, demo, server};

fn pseudo_rand(state: &mut u64) -> f64 {
    // xorshift — deterministic chaos, no rand crate needed.
    *state ^= *state << 13;
    *state ^= *state >> 7;
    *state ^= *state << 17;
    (*state % 10_000) as f64 / 10_000.0
}

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();
    let secs: u64 = std::env::var("SOAK_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(2100);

    let (screen, cam) = demo::spike_media_info().expect("media generation");
    let base_project = demo::demo_project(&screen.path, &cam.path);
    // Soak with shadow + crop on the PiP layer so the full shader runs.
    let mut project = base_project.clone();
    project.layers[1].transform.shadow = Some(compositor::types::ShadowCfg {
        blur: 24.0,
        spread: 4.0,
        color: "#000000CC".into(),
        x: 8.0,
        y: 12.0,
    });
    project.layers[1].transform.crop = compositor::types::CropCfg {
        l: 0.05,
        t: 0.05,
        r: 0.05,
        b: 0.05,
    };

    let state = compositor::start();
    state.set_project(project.clone());
    state.set_playhead(0.0, true, 1.0);

    // SOAK_STEADY=1: no chaos — continuous forward playback only, for clean
    // paced-delivery measurements.
    let steady = std::env::var("SOAK_STEADY").is_ok_and(|v| v == "1");
    if steady {
        let started = Instant::now();
        while started.elapsed().as_secs() < secs {
            let (t, _, _) = state.current_t();
            if t > 9.4 {
                state.set_playhead(0.0, true, 1.0);
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let s = &state.stats;
        let frames = s.frames.load(Ordering::Relaxed);
        println!(
            "=== STEADY REPORT === {}s, {} frames → {:.1} fps average",
            started.elapsed().as_secs(),
            frames,
            frames as f64 / started.elapsed().as_secs_f64()
        );
        std::process::exit(0);
    }

    // WS churn + validation client on a small runtime.
    let churn = std::thread::spawn({
        let port = server::port();
        move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_io()
                .enable_time()
                .build()
                .unwrap();
            rt.block_on(async move {
                use futures_util::StreamExt;
                let url = format!("ws://127.0.0.1:{port}");
                let mut received: u64 = 0;
                let mut churned: u64 = 0;
                let started = Instant::now();
                while started.elapsed().as_secs() < secs {
                    // Persistent-ish client: read frames for ~10s, then drop and
                    // reconnect (webview-reload shape).
                    match tokio_tungstenite::connect_async(&url).await {
                        Ok((mut ws, _)) => {
                            churned += 1;
                            let stint = Instant::now();
                            while stint.elapsed().as_secs() < 10 {
                                match tokio::time::timeout(Duration::from_secs(3), ws.next()).await
                                {
                                    Ok(Some(Ok(msg))) => {
                                        if msg.is_binary() {
                                            received += 1;
                                        }
                                    }
                                    Ok(_) => break,
                                    Err(_) => {
                                        log::warn!("soak-client: >3s without a frame");
                                        break;
                                    }
                                }
                            }
                        }
                        Err(e) => {
                            log::warn!("soak-client: connect failed: {e}");
                            tokio::time::sleep(Duration::from_secs(1)).await;
                        }
                    }
                }
                (received, churned)
            })
        }
    });

    let started = Instant::now();
    let mut rng: u64 = 0x5EED_CAFE_F00D;
    let mut actions: u64 = 0;
    let mut ffmpeg_kills: u64 = 0;
    let mut canvas_flips: u64 = 0;
    let mut last_kill = Instant::now();
    let mut last_flip = Instant::now();

    while started.elapsed().as_secs() < secs {
        let r = pseudo_rand(&mut rng);
        actions += 1;
        match (r * 100.0) as u32 {
            // 40%: aggressive scrub while paused (decoder reseeks, both directions)
            0..=39 => {
                let t = pseudo_rand(&mut rng) * 9.4;
                state.set_playhead(t, false, 1.0);
            }
            // 25%: play forward from a random point
            40..=64 => {
                let t = pseudo_rand(&mut rng) * 8.0;
                state.set_playhead(t, true, 1.0);
            }
            // 15%: reverse shuttle (ring buffer path)
            65..=79 => {
                let t = 1.0 + pseudo_rand(&mut rng) * 8.0;
                state.set_playhead(t, true, if r > 0.72 { -2.0 } else { -1.0 });
            }
            // 10%: fast-forward shuttle
            80..=89 => {
                let t = pseudo_rand(&mut rng) * 5.0;
                state.set_playhead(t, true, 2.0);
            }
            // 10%: full project re-sync (webview-reload shape)
            _ => {
                state.set_project(project.clone());
            }
        }

        // Every ~2 min: kill the decode children mid-read; decoders must recover.
        if last_kill.elapsed().as_secs() > 120 {
            last_kill = Instant::now();
            ffmpeg_kills += 1;
            let _ = Command::new("pkill")
                .args(["-9", "-f", "motionaire-spike"])
                .status();
            log::info!("soak: killed ffmpeg children (#{ffmpeg_kills})");
        }
        // Every ~3 min: flip canvas dims to force a full GPU re-init, then back.
        if last_flip.elapsed().as_secs() > 180 {
            last_flip = Instant::now();
            canvas_flips += 1;
            let mut flipped = project.clone();
            flipped.canvas.width = 1080;
            flipped.canvas.height = 1920;
            state.set_project(flipped);
            std::thread::sleep(Duration::from_millis(1500));
            state.set_project(project.clone());
            log::info!("soak: canvas dim flip #{canvas_flips} (GPU re-init x2)");
        }

        std::thread::sleep(Duration::from_millis(
            50 + (pseudo_rand(&mut rng) * 450.0) as u64,
        ));
    }

    // Let the loop settle, then report.
    state.set_playhead(0.0, false, 1.0);
    std::thread::sleep(Duration::from_secs(1));
    let (received, churned) = churn.join().unwrap();
    let s = &state.stats;
    println!("=== SOAK REPORT ({}s) ===", started.elapsed().as_secs());
    println!("chaos actions:        {actions}");
    println!("frames rendered:      {}", s.frames.load(Ordering::Relaxed));
    println!(
        "gpu re-inits:         {}",
        s.gpu_inits.load(Ordering::Relaxed)
    );
    println!(
        "render errors:        {}",
        s.render_errors.load(Ordering::Relaxed)
    );
    println!("panics (recovered):   {}", s.panics.load(Ordering::Relaxed));
    println!(
        "watchdog trips:       {}",
        s.watchdog_trips.load(Ordering::Relaxed)
    );
    println!("ffmpeg kill rounds:   {ffmpeg_kills}");
    println!("canvas dim flips:     {canvas_flips}");
    println!("ws frames received:   {received}");
    println!("ws client reconnects: {churned}");
    let ok = s.watchdog_trips.load(Ordering::Relaxed) == 0 && s.panics.load(Ordering::Relaxed) == 0;
    println!("verdict: {}", if ok { "PASS" } else { "ISSUES — see log" });
    std::process::exit(if ok { 0 } else { 1 });
}
