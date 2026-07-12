pub mod decoder;
pub mod demo;
pub mod gpu;
pub mod keyframes;
pub mod server;
pub mod types;

use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use bytes::Bytes;
use tokio::sync::watch;
use types::SyncProject;

// The playhead clock: the frontend sends (t, playing, rate) samples; while
// playing, Rust free-runs at `rate` from the last sample so pacing never
// depends on webview rAF cadence. Negative rate = reverse shuttle.
#[derive(Clone, Copy)]
struct Clock {
    t: f64,
    playing: bool,
    rate: f64,
    anchored: Instant,
}

#[derive(Default)]
pub struct Stats {
    pub frames: AtomicU64,
    pub gpu_inits: AtomicU64,
    pub render_errors: AtomicU64,
    pub panics: AtomicU64,
    pub watchdog_trips: AtomicU64,
}

pub struct CompositorState {
    project: Mutex<Option<SyncProject>>,
    clock: Mutex<Clock>,
    dirty: AtomicBool,
    pub clients: Arc<AtomicUsize>,
    frame_tx: watch::Sender<Bytes>,
    // Watchdog heartbeat: epoch millis of the last render-loop iteration.
    heartbeat_ms: AtomicI64,
    last_status: Mutex<String>,
    pub stats: Arc<Stats>,
}

pub type Compositor = Arc<CompositorState>;

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

impl CompositorState {
    pub fn set_project(&self, p: SyncProject) {
        *self.project.lock().unwrap() = Some(p);
        self.dirty.store(true, Ordering::Relaxed);
    }

    pub fn set_playhead(&self, t: f64, playing: bool, rate: f64) {
        let rate = if rate.is_finite() && rate != 0.0 { rate.clamp(-8.0, 8.0) } else { 1.0 };
        *self.clock.lock().unwrap() = Clock { t, playing, rate, anchored: Instant::now() };
        self.dirty.store(true, Ordering::Relaxed);
    }

    pub fn current_t(&self) -> (f64, bool, f64) {
        let c = *self.clock.lock().unwrap();
        if c.playing {
            (c.t + c.anchored.elapsed().as_secs_f64() * c.rate, true, c.rate)
        } else {
            (c.t, false, c.rate)
        }
    }

    fn set_status(&self, s: String) {
        *self.last_status.lock().unwrap() = s;
    }
}

const TARGET_FPS: f64 = 60.0;
// Sleep overshoot on macOS is a few ms; sleep short of the deadline, then spin.
const SPIN_MARGIN: Duration = Duration::from_micros(2500);

pub fn start() -> Compositor {
    let (frame_tx, frame_rx) = watch::channel(Bytes::new());
    let state: Compositor = Arc::new(CompositorState {
        project: Mutex::new(None),
        clock: Mutex::new(Clock { t: 0.0, playing: false, rate: 1.0, anchored: Instant::now() }),
        dirty: AtomicBool::new(true),
        clients: Arc::new(AtomicUsize::new(0)),
        frame_tx,
        heartbeat_ms: AtomicI64::new(now_ms()),
        last_status: Mutex::new(String::from("startup")),
        stats: Arc::new(Stats::default()),
    });

    // WS transport on a dedicated thread with its own runtime — no dependency
    // on tauri's runtime so headless binaries (soak, spike_check) work the same.
    let clients = state.clients.clone();
    std::thread::Builder::new()
        .name("compositor-ws".into())
        .spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_io()
                .enable_time()
                .build()
                .expect("ws runtime");
            rt.block_on(server::run(frame_rx, clients));
        })
        .expect("spawn ws thread");

    // Render loop on a dedicated OS thread — wgpu readback and decoder reads block.
    let render_state = state.clone();
    std::thread::Builder::new()
        .name("compositor-render".into())
        .spawn(move || render_loop(render_state))
        .expect("spawn compositor thread");

    // Watchdog: a stalled or dead render loop must leave a trace, not silence.
    let watch_state = state.clone();
    std::thread::Builder::new()
        .name("compositor-watchdog".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_secs(2));
            let (_, playing, _) = watch_state.current_t();
            let age = now_ms() - watch_state.heartbeat_ms.load(Ordering::Relaxed);
            let limit = if playing { 2_000 } else { 15_000 };
            if age > limit {
                watch_state.stats.watchdog_trips.fetch_add(1, Ordering::Relaxed);
                log::error!(
                    "WATCHDOG: render loop silent for {age}ms (playing={playing}); last status: {}; frames={} gpu_inits={} errors={} panics={}",
                    watch_state.last_status.lock().unwrap(),
                    watch_state.stats.frames.load(Ordering::Relaxed),
                    watch_state.stats.gpu_inits.load(Ordering::Relaxed),
                    watch_state.stats.render_errors.load(Ordering::Relaxed),
                    watch_state.stats.panics.load(Ordering::Relaxed),
                );
            }
        })
        .expect("spawn watchdog thread");

    state
}

fn render_loop(state: Compositor) {
    let spike_demo = std::env::var("SPIKE_DEMO").is_ok_and(|v| v == "1");
    if spike_demo {
        match demo::spike_media_info() {
            Ok((screen, cam)) => {
                state.set_project(demo::demo_project(&screen.path, &cam.path));
                state.set_playhead(0.0, true, 1.0);
                log::info!("spike demo: project loaded, playing");
            }
            Err(e) => log::error!("spike demo setup failed: {e}"),
        }
    }

    let mut gpu: Option<gpu::GpuCompositor> = None;
    let mut gpu_canvas = (0u32, 0u32);
    let mut ema_ms = 16.6f64;
    let mut consecutive_errors = 0u32;
    let mut dumped = false;
    // Keepalive cache: paused-idle re-sends the last frame ~1Hz so purged or
    // late-connecting clients always have valid pixels within a second
    // (session 7: the idle loop's total silence left a dead canvas on screen).
    let mut last_msg: Option<Bytes> = None;
    let mut last_send = Instant::now();

    loop {
        // A panic in one iteration is logged and recovered (GPU rebuilt),
        // never a silent thread death.
        let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
            render_iteration(
                &state,
                &mut gpu,
                &mut gpu_canvas,
                &mut ema_ms,
                &mut consecutive_errors,
                &mut dumped,
                spike_demo,
                &mut last_msg,
                &mut last_send,
            )
        }));
        if let Err(payload) = result {
            let msg = payload
                .downcast_ref::<&str>()
                .map(|s| s.to_string())
                .or_else(|| payload.downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "non-string panic".into());
            state.stats.panics.fetch_add(1, Ordering::Relaxed);
            log::error!("render loop PANIC (recovered): {msg}; dropping GPU state for re-init");
            state.set_status(format!("panic: {msg}"));
            gpu = None;
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn render_iteration(
    state: &Compositor,
    gpu: &mut Option<gpu::GpuCompositor>,
    gpu_canvas: &mut (u32, u32),
    ema_ms: &mut f64,
    consecutive_errors: &mut u32,
    dumped: &mut bool,
    spike_demo: bool,
    last_msg: &mut Option<Bytes>,
    last_send: &mut Instant,
) {
    let started = Instant::now();
    state.heartbeat_ms.store(now_ms(), Ordering::Relaxed);

    let project = state.project.lock().unwrap().clone();
    let Some(project) = project else {
        state.set_status("idle: no project".into());
        std::thread::sleep(Duration::from_millis(50));
        return;
    };
    let (mut t, playing, _rate) = state.current_t();

    if spike_demo && t > 9.5 {
        state.set_playhead(0.0, true, 1.0);
        t = 0.0;
    }
    if spike_demo && t < -0.5 {
        state.set_playhead(9.4, true, -1.0); // reverse soak wraps at the front
        t = 9.4;
    }

    if !playing && !state.dirty.swap(false, Ordering::Relaxed) {
        state.set_status(format!("idle: paused at t={t:.2}"));
        // Keepalive: total silence while idle left clients with a dead canvas
        // (purged backing = black or worse, uninitialized surface remnants).
        if last_send.elapsed() > Duration::from_secs(1) {
            if let Some(msg) = last_msg.as_ref() {
                let _ = state.frame_tx.send(msg.clone());
                *last_send = Instant::now();
            }
        }
        std::thread::sleep(Duration::from_millis(15));
        return;
    }

    let dims = (project.canvas.width, project.canvas.height);
    if gpu.is_none() || *gpu_canvas != dims {
        let reason = if gpu.is_none() { "no device (startup, post-error, or post-panic)" } else { "canvas dims changed" };
        let n = state.stats.gpu_inits.fetch_add(1, Ordering::Relaxed) + 1;
        log::info!(
            "compositor: GPU init #{n} ({reason}); canvas {}x{} → {}x{}",
            gpu_canvas.0,
            gpu_canvas.1,
            dims.0,
            dims.1
        );
        match gpu::GpuCompositor::new(dims.0, dims.1) {
            Ok(g) => {
                *gpu = Some(g);
                *gpu_canvas = dims;
            }
            Err(e) => {
                log::error!("compositor: GPU init FAILED: {e}");
                state.set_status(format!("gpu init failed: {e}"));
                std::thread::sleep(Duration::from_secs(1));
                return;
            }
        }
    }
    let g = gpu.as_mut().unwrap();

    if spike_demo && !*dumped {
        *dumped = true;
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
            *consecutive_errors = 0;
            let ms = started.elapsed().as_secs_f64() * 1000.0;
            *ema_ms = *ema_ms * 0.9 + ms * 0.1;
            let capacity_fps = (1000.0 / *ema_ms) as f32;
            let msg = server::frame_message(g.out_w as u16, g.out_h as u16, t as f32, capacity_fps, &rgba);
            let _ = state.frame_tx.send(msg.clone());
            *last_msg = Some(msg);
            *last_send = Instant::now();
            let frames = state.stats.frames.fetch_add(1, Ordering::Relaxed) + 1;
            state.set_status(format!("ok: frame {frames} t={t:.2} work={ms:.1}ms"));
            if frames % 600 == 0 {
                log::info!(
                    "compositor: frame {frames}, work {:.1}ms ({}fps capacity), {} client(s), t={:.2}",
                    *ema_ms,
                    capacity_fps as u32,
                    state.clients.load(Ordering::Relaxed),
                    t
                );
            }
        }
        Err(e) => {
            *consecutive_errors += 1;
            state.stats.render_errors.fetch_add(1, Ordering::Relaxed);
            log::error!("compositor: render failed ({} in a row): {e}", *consecutive_errors);
            state.set_status(format!("render error x{}: {e}", *consecutive_errors));
            if *consecutive_errors >= 3 {
                log::warn!("compositor: 3 consecutive render failures — dropping GPU for re-init");
                *gpu = None;
                *consecutive_errors = 0;
            }
            std::thread::sleep(Duration::from_millis(100));
            return;
        }
    }

    // Display-rate pacing: sleep short of the deadline, spin the rest. The
    // plain-sleep version overshot by 3-5ms and delivered ~52fps (session 3).
    let deadline = started + Duration::from_secs_f64(1.0 / TARGET_FPS);
    let now = Instant::now();
    if deadline > now + SPIN_MARGIN {
        std::thread::sleep(deadline - now - SPIN_MARGIN);
    }
    while Instant::now() < deadline {
        std::hint::spin_loop();
    }
}
