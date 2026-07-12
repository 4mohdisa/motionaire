pub mod decoder;
pub mod demo;
pub mod gpu;
pub mod keyframes;
pub mod server;
pub mod types;

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use tokio::sync::watch;
use types::SyncProject;

// The playhead clock: the frontend sends (t, playing) samples; while playing,
// Rust free-runs from the last sample so frame pacing never depends on the
// webview's rAF cadence. Each new sample re-anchors (drift stays < one sample).
#[derive(Clone, Copy)]
struct Clock {
    t: f64,
    playing: bool,
    anchored: Instant,
}

pub struct CompositorState {
    project: Mutex<Option<SyncProject>>,
    clock: Mutex<Clock>,
    dirty: AtomicBool,
    pub clients: Arc<AtomicUsize>,
    frame_tx: watch::Sender<Bytes>,
}

pub type Compositor = Arc<CompositorState>;

impl CompositorState {
    pub fn set_project(&self, p: SyncProject) {
        *self.project.lock().unwrap() = Some(p);
        self.dirty.store(true, Ordering::Relaxed);
    }

    pub fn set_playhead(&self, t: f64, playing: bool) {
        *self.clock.lock().unwrap() = Clock { t, playing, anchored: Instant::now() };
        self.dirty.store(true, Ordering::Relaxed);
    }

    fn current_t(&self) -> (f64, bool) {
        let c = *self.clock.lock().unwrap();
        if c.playing {
            (c.t + c.anchored.elapsed().as_secs_f64(), true)
        } else {
            (c.t, false)
        }
    }
}

const TARGET_FPS: f64 = 60.0;

pub fn start() -> Compositor {
    let (frame_tx, frame_rx) = watch::channel(Bytes::new());
    let state: Compositor = Arc::new(CompositorState {
        project: Mutex::new(None),
        clock: Mutex::new(Clock { t: 0.0, playing: false, anchored: Instant::now() }),
        dirty: AtomicBool::new(true),
        clients: Arc::new(AtomicUsize::new(0)),
        frame_tx,
    });

    // WS transport on the tauri (tokio) runtime.
    let clients = state.clients.clone();
    tauri::async_runtime::spawn(server::run(frame_rx, clients));

    // Render loop on a dedicated OS thread — wgpu readback and decoder reads block.
    let render_state = state.clone();
    std::thread::Builder::new()
        .name("compositor-render".into())
        .spawn(move || render_loop(render_state))
        .expect("spawn compositor thread");

    state
}

fn render_loop(state: Compositor) {
    // Self-demo mode: SPIKE_DEMO=1 loads the PiP demo project in Rust and plays
    // it on a loop, so the compositor is verifiable without UI interaction.
    let spike_demo = std::env::var("SPIKE_DEMO").is_ok_and(|v| v == "1");
    if spike_demo {
        match demo::spike_media_info() {
            Ok((screen, cam)) => {
                state.set_project(demo::demo_project(&screen.path, &cam.path));
                state.set_playhead(0.0, true);
                log::info!("spike demo: project loaded, playing");
            }
            Err(e) => log::error!("spike demo setup failed: {e}"),
        }
    }

    let mut gpu: Option<gpu::GpuCompositor> = None;
    let mut gpu_canvas = (0u32, 0u32);
    let mut ema_ms = 33.3f64;
    let mut frames: u64 = 0;
    let mut dumped = false;

    loop {
        let started = Instant::now();
        let project = state.project.lock().unwrap().clone();
        let Some(project) = project else {
            std::thread::sleep(Duration::from_millis(50));
            continue;
        };
        let (mut t, playing) = state.current_t();

        // Self-demo loops forever over the 10s timeline.
        if spike_demo && playing && t > 9.5 {
            state.set_playhead(0.0, true);
            t = 0.0;
        }

        // Idle when paused and nothing changed — render once per dirty mark.
        if !playing && !state.dirty.swap(false, Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(15));
            continue;
        }

        // (Re)create the GPU compositor when canvas dims change.
        let dims = (project.canvas.width, project.canvas.height);
        if gpu.is_none() || gpu_canvas != dims {
            match gpu::GpuCompositor::new(dims.0, dims.1) {
                Ok(g) => {
                    gpu = Some(g);
                    gpu_canvas = dims;
                }
                Err(e) => {
                    log::error!("compositor: gpu init failed: {e}");
                    std::thread::sleep(Duration::from_secs(1));
                    continue;
                }
            }
        }
        let g = gpu.as_mut().unwrap();

        // One-time visual evidence in self-demo mode: PNG dumps at key moments.
        if spike_demo && !dumped {
            dumped = true;
            for (label, dt) in [("fullscreen", 0.5), ("mid-shrink", 1.6), ("pip-hold", 3.5), ("returning", 5.8)] {
                let p = demo::spike_dir().join(format!("composite-{label}-t{dt}.png"));
                match g.dump_png(&project, dt, &p) {
                    Ok(()) => log::info!("spike demo: dumped {}", p.display()),
                    Err(e) => log::error!("spike demo: dump failed: {e}"),
                }
            }
        }

        match g.render_at(&project, t) {
            Ok(rgba) => {
                let ms = started.elapsed().as_secs_f64() * 1000.0;
                ema_ms = ema_ms * 0.9 + ms * 0.1;
                let fps = (1000.0 / ema_ms) as f32;
                let msg = server::frame_message(g.out_w as u16, g.out_h as u16, t as f32, fps, &rgba);
                let _ = state.frame_tx.send(msg);
                frames += 1;
                if frames % 120 == 0 {
                    log::info!(
                        "compositor: {:.1} fps (frame {:.1}ms), {} client(s), t={:.2}",
                        1000.0 / ema_ms,
                        ema_ms,
                        state.clients.load(Ordering::Relaxed),
                        t
                    );
                }
            }
            Err(e) => {
                log::error!("compositor: render failed: {e}");
                std::thread::sleep(Duration::from_millis(250));
            }
        }

        // Pace to the target rate; never busy-spin.
        let budget = Duration::from_secs_f64(1.0 / TARGET_FPS);
        let spent = started.elapsed();
        if spent < budget {
            std::thread::sleep(budget - spent);
        }
    }
}
