# Decisions Log

Append-only. Every non-trivial choice made during autonomous scaffolding work goes here,
in chronological order, newest at the bottom. Never edit or delete past entries — if a
decision is later reversed, add a new entry that supersedes it and say so.

---

## 2026-07-12 — Session start: scaffold-only pass

**Scope for this session:** monorepo skeleton, Tauri v2 + React/TS wiring, dark-themed
placeholder shell (top bar / canvas / timeline strip), tooling, README. Explicitly
NOT touching: compositor, FFmpeg pipeline, transcript pipeline, AI tool layer. Those
are later work per CONTEXT.md §5 (build order) and the task brief for this session.

**Repo has no git history yet** — this is a fresh scaffold, no prior work to preserve.

## Monorepo layout

Decision: `apps/frontend/` (Vite + React + TypeScript) and `apps/backend/` (the Tauri
Rust project — Cargo.toml, `src/`, `tauri.conf.json`, icons, capabilities live directly
here) as the two top-level app packages, per the task brief. This replaces Tauri's
default convention of a `src-tauri/` folder sitting next to the frontend at the repo
root — instead `src-tauri`'s contents move one level down to live at `apps/backend/`,
symmetric with `apps/frontend/`.

Why: task brief explicitly asked for this symmetric layout and for tauri.conf.json's
paths to be repointed. No conflicting guidance in CONTEXT.md (CONTEXT.md doesn't
specify a folder layout at all — it's silent on this, so this is a gap-fill, not a
deviation).

## Toolchain versions found on this machine

- node v24.16.0, npm 11.13.0
- rustc/cargo 1.96.1 (Homebrew)
- `@tauri-apps/cli` 2.11.4 (resolved via npx, not globally installed) — this is the
  Tauri v2 CLI, confirmed via `npx @tauri-apps/cli@latest --version`.
- No global `cargo-tauri` binary; using the npm-distributed CLI (`@tauri-apps/cli`)
  instead of `cargo install tauri-cli`, since the npm package ships prebuilt and is
  the more common workflow for JS-first Tauri projects (matches `apps/frontend`
  owning `package.json`/`node_modules` as the natural home for `npm run tauri ...`
  scripts). Rationale, not left implicit: avoids a slow from-source cargo install
  when the npm binary does the same job.

## Scaffolding approach

Decision: use official generators (`npm create vite@latest ... --template react-ts`
and `@tauri-apps/cli init`) rather than hand-writing Tauri v2 Rust boilerplate from
memory. Tauri v2's permissions/capabilities system changed substantially from v1;
generating it via the real CLI and then relocating/editing avoids introducing subtly
wrong hand-rolled config.

`tauri init` always creates a `src-tauri/` folder relative to whatever `--directory`
it's given — there's no flag to name the output folder directly. So the plan is:
run `init` at the repo root (creates `<root>/src-tauri/`), then move that folder's
contents to `apps/backend/`, then fix the now-relative paths inside `tauri.conf.json`
(`frontendDist`, `beforeDevCommand`/`beforeBuildCommand`) since the folder's depth
relative to `apps/frontend` changes after the move.

`beforeDevCommand`/`beforeBuildCommand` will use the Tauri v2 `HookCommand` object
form (`{ "script": "...", "cwd": "../frontend" }`) rather than a bare string with an
implicit `npm --workspace=...` flag — confirmed via the CLI's own
`config.schema.json` that `cwd` is a supported field on hook commands. This is more
robust than relying on npm's upward package.json resolution from a non-workspace
directory.

## Rust workspace shape

Decision: `apps/backend/Cargo.toml` is a Cargo workspace with the Tauri app itself as
the workspace root package (`[workspace] members = ["."]` alongside `[package]` in
the same manifest — a "root package" workspace, which is valid Cargo). This satisfies
the brief's ask for "Rust workspace Cargo.toml in apps/backend/" without inventing
placeholder crates that don't exist yet (no compositor/FFmpeg/AI crates this session —
out of scope). Future crates (e.g. a separate compositor crate per CONTEXT.md §3) can
be added as siblings under `apps/backend/` and appended to `members` later.

## Theme

Decision: dark theme is the only theme — no light/dark toggle, no theme system, since
the task brief calls it "permanent, not a placeholder." CONTEXT.md doesn't specify
exact colors, so picking a conventional near-black editor palette (similar register
to DaVinci Resolve / Premiere / VS Code dark) rather than pure `#000`/`#fff`, since
that's the standard convention for video-editor-style dark UIs and easiest on the eyes
for long sessions. Exact hex values recorded inline in the theme file itself, not
duplicated here.

## TypeScript strict mode

The current `create-vite` react-ts template (Vite 8 / TS ~6.0 era, npm dist-tag
`latest` as of 2026-07-12) ships `tsconfig.app.json`/`tsconfig.node.json` **without**
`"strict": true` — confirmed via `tsc --showConfig`, which showed no strict-family
flags enabled at all. That's a change from older Vite templates, which always
defaulted to strict. Since a project with a nontrivial domain model (project JSON,
keyframes, transforms per CONTEXT.md §1) benefits a lot from strict null-checking,
and strict-by-default remains the overwhelming community convention for new TS
projects, added `"strict": true` explicitly to both tsconfig files rather than
inheriting the template's laxer default.

Also swapped the template's default linter from `oxlint` (the new create-vite
default) to ESLint + Prettier, since the task brief explicitly named "ESLint +
Prettier" as the tooling to use. Used the pre-oxlint conventional ESLint flat-config
setup (`@eslint/js` + `typescript-eslint` + `eslint-plugin-react-hooks` +
`eslint-plugin-react-refresh`, `eslint-config-prettier` to defer style rules to
Prettier) — this is what `create-vite`'s react-ts template shipped before switching
its default to oxlint, so it's a well-worn, conventional combination rather than a
novel one.

## End-of-session verification

Ran the full chain: `npm install` (root, npm workspaces), `npm run lint` / `npm run
build` for the frontend (ESLint clean, `tsc -b` clean under strict mode, Vite
production build succeeds), `cargo check` for the Rust crate (clean), and finally
`npm run tauri dev` end to end — Rust backend compiled with zero errors/warnings,
the Vite dev server came up on `http://localhost:5173`, and the Tauri process
(`target/debug/motionaire`) launched and stayed alive with no panics in the log.

Could not get a native OS screenshot of the actual Tauri window: `cargo run`-launched
dev binaries aren't registered as a normal macOS application (no bundle/Info.plist),
so the computer-use `request_access` tool couldn't find "motionaire" as an
installed/running app to grant, and a raw `screencapture` came back solid black —
the standard symptom of the terminal/agent process lacking macOS Screen Recording
permission, which can't be granted non-interactively. Confirmed correctness instead
by (a) build/run logs showing no errors and the process staying resident, and (b)
loading the exact same dev URL the Tauri webview points at
(`http://localhost:5173`) in the sandboxed browser preview and screenshotting it
there — same HTML/CSS the native webview renders, and it showed the dark shell
exactly as intended (top bar, centered blank 16:9 canvas, empty timeline strip
pinned to the bottom). Good enough for "does it build and run"; a real visual check
of the native window is a one-time manual thing for whoever picks this up next.

Cargo normalized two `Cargo.toml` dependency lines during the build (added explicit
`features = []` to `tauri` and `tauri-build`) — cosmetic, left as-is.

**Scaffold session complete.** All 7 planned tasks done: monorepo init, frontend
scaffold, backend scaffold, UI shell, tooling, README, build/run verification.
Next session picks up real feature work per CONTEXT.md §5's build order, starting
with the compositor spike — explicitly out of scope here.

---

## 2026-07-12 — Session 2: NLE feature build (phases A–G, webview-only)

Scope per the session brief: preview player, timeline, detach audio, properties +
keyframes, transitions + text, export settings + presets, chrome/shortcuts/undo.
No Rust, no compositor, no FFmpeg. Multi-clip composited preview explicitly out —
preview shows the topmost active video clip only.

## State management: Zustand + Immer

Zustand chosen — CONTEXT.md §3.4 names it directly ("Zustand or similar"). Immer
added (via zustand/middleware/immer) because the document model is deeply nested
(tracks → clips → keyframes/transform) and ~30 mutation actions written as hand-rolled
spread chains are exactly where subtle state bugs breed. Two runtime deps total this
session; nothing else added.

Undo/redo: JSON-snapshot stack (past/future arrays, `structuredClone` of the project,
cap 100) exactly as CONTEXT.md §8.1 prescribes for early stage ("snapshotting the
whole JSON is fine early; move to patches only if it gets slow"). Only project
mutations push history; playhead/selection/zoom are UI state and don't. Drag/trim
gestures push ONE history entry at gesture start (`beginGesture`), then mutate
transiently — undo reverts the whole gesture, not each pointermove.

## Document model deviations from CONTEXT.md §1 (logged, deliberate)

- **Text clips use in/out** (in=0, out=duration) instead of the spec's separate
  `duration` field, so every clip shares one time system and all trim/split/move
  code paths work on text clips unchanged. A storage adapter can translate when
  save/load lands.
- **`linkId` field added to Clip** — spec is silent on how detach-audio links the
  resulting pair; a shared opaque id is the minimal representation.
- **`name` on Track, `name` on MediaAsset** — UI needs display labels; spec examples
  imply but don't declare them.
- **`path` on MediaAsset holds an object URL this session** (media import is
  `<input type="file">` + `URL.createObjectURL` — no Rust file dialogs yet). Object
  URLs die with the document, so projects aren't persistable across reloads until
  native import lands. Acceptable: save/load is not in this session's phase list.

## Media import & probing without the native side

Import via file input; duration/dimensions probed from a metadata-preloaded video
element. MediaRecorder-produced webm (i.e. real screen recordings) report
`duration: Infinity` until seeked far past the end — the known Chromium quirk — so
the prober does the `currentTime = 1e101` workaround. fps is not detectable from a
media element; the project canvas default (30) governs frame math until FFprobe
arrives with the native session (CONTEXT.md §6 VFR normalization lands there too).

`hasAudio` is determined by attempting the waveform decode (fetch → OfflineAudioContext
.decodeAudioData): decode success = has audio, failure = silent. One decode serves
both purposes and is cached per media id (decode-once rule from the brief).

Imported clips append to the end of the bottom-most track of matching kind. No media
bin this session — it's §4 table stakes but not in any phase of this brief.

## Playback engine design

One hidden/visible `<video>` element per active-or-imminent clip (mount window:
active now or starting within 1s — pre-decodes upcoming cuts). Topmost-z active
video clip is visible; everything else plays hidden (real multi-track audio without
a mixing graph: media elements ARE the mixer this session; per-clip Web Audio gain
graph arrives with the compositor). The master clock is the visible video element
when healthy; the wall clock covers gaps between clips, reverse shuttle, and
elements mid-seek. Sanity rule: if the element-derived playhead disagrees with the
store playhead by >0.5s the element is treated as stale (external seek) and gets
corrected, not trusted — this makes scrub-during-playback race-free with zero extra
state.

Reverse playback (J shuttle): `<video>` cannot play backwards; reverse is throttled
seek-stepping (10 Hz), muted. Choppy by design; smooth reverse belongs to the native
compositor. Elements' audio is muted during reverse.

rAF drives the loop when visible; a 250ms interval takes over when rAF is starved
(hidden/occluded window) so playback lifecycle — clip boundary handoffs, element
start/stop — keeps working while backgrounded. Found the hard way: the sandboxed
test browser suspends rAF entirely, and the same applies to a minimized Tauri window
mid-playback.

Keyframed `volume` is applied live per tick (`resolveProp`); visual transform
keyframes are data-only until the compositor renders them (per the session brief).

## Testing approach for this session

No test framework added (nothing in the brief asks for one; the app's logic is
exercised end-to-end instead). Dev-only `window.__motionaire = { store, importFile }`
handle lets scripted browser automation drive the real store and import real
generated Files — test clips are synthesized in-page via canvas.captureStream +
AudioContext oscillator + MediaRecorder (no ffmpeg on this machine, and no binary
fixtures in the repo). Verified for Phase A: import + probe of two 4s clips,
sequential append, playback advance, A→B boundary handoff mid-play, end-of-project
auto-pause, scrub-while-playing.

## Phase B–G decisions (one entry per non-obvious call)

**Keyframe time base:** `Keyframe.t` is clip-relative in TIMELINE seconds
(t − clip.start), not source seconds. CONTEXT.md §1.2 says "clip-relative" without
naming the unit; timeline seconds means keyframes keep their wall-clock rhythm when
clip speed changes, and split/trim math stays linear. The engine converts to/from
absolute at the edges exactly as the spec requires.

**No overlaps within a track.** The document model could express overlapping clips,
but every placement path (move, duplicate, detach, text add) clamps to the nearest
free gap. Transitions don't need timeline overlap: they're stored on clip edges
(spec §1.2 shape) and the preview reads the outgoing clip's media handle past its
`out` point for the cross window. This matches how the final compositor will treat
edge-attached transitions.

**Cross-transition canon: the incoming clip's `in` edge.** Dissolve/slide/wipe on
clip B's in-edge renders as a real dual-element cross (A keeps playing into its
handle underneath, B animates in on top). `fade` is to/from black on either edge and
needs no partner. An `out`-edge dissolve without an adjacent next clip renders as a
fade-to-black tail — logged as the honest approximation until the compositor.

**Overlap policy for trim/speed:** trims clamp against neighbors and media bounds
(can't reveal media before source 0 or past asset duration); speed changes shrink
`out` if the new duration would overlap the next clip.

**Split semantics:** selection-aware (selected clips under the playhead; all clips
under it when nothing selected). Keyframes are distributed to the halves and
re-based; in/out transitions stay with their respective halves. Linked (detached)
partners do NOT auto-split — logged as a niche follow-up.

**Detach audio placement:** exact same start time on the first audio track with a
free slot, else a new audio track is created. Position is never compromised to fit —
the link is positional. Volume + volume keyframes migrate to the audio clip; the
video half keeps `volume: 0` and the shared `linkId`.

**Stopwatch semantics for properties (Phase D):** a property with zero keyframes
edits statically; the diamond arms it (first keyframe at playhead, current value);
once armed, edits upsert a keyframe at the playhead. This is the standard NLE
convention and is how the brief's "setting a property while scrubbed adds or
updates a keyframe" is interpreted — unconditional keyframe creation on every edit
would surprise anyone who's used an NLE.

**Text animation presets expand into ordinary keyframes** (spec §1.3's "sugar"
rule) at creation and re-expand on trim or preset change, clobbering manual
keyframes only inside the preset's edge windows on the props the preset owns.
`typewriter` preset skipped — it needs per-character rendering, not a transform
curve; the other five presets are honest transform/opacity keyframes.

**Multi-select is shift/cmd-click; drag moves only the grabbed clip.** Marquee
selection and multi-clip drag are deferred — logged, not forgotten. Delete/ripple/
split operate on the whole selection.

**Reverse shuttle (J) is throttled seek-stepping** (~10Hz, muted): HTML video
cannot play backwards. Choppy is accepted and expected; smooth reverse belongs to
the compositor session.

**Export settings live in UI state, not project JSON** — spec §1.1's project shape
has no export block, and §8.2 puts app prefs in the app-level settings store later.
Canvas preset/fps ARE project state (spec §2.2 set_canvas) and are undoable.
Panel sizes (timeline height, properties width) are session-only, not persisted —
persistence belongs to the §8.2 settings table when SQLite lands.

**Pinch-to-zoom** = ctrl+wheel (how Chromium delivers trackpad pinch), zooming
around the cursor with scroll compensation; needs a non-passive native listener
because React's synthetic onWheel can't preventDefault. Two-finger pan is native
scroll on the timeline container.

**Session-wide HMR caveat found while testing:** editing store.ts under Vite HMR
can leave stale module instances holding a different store object than fresh
modules (verified: state reads fine, engine writes invisible). All browser
verification was therefore done after full reloads. Not an app bug — dev-server
artifact only.

## End of session 2

All phases A–G built, verified in-browser against the real store (scripted
`window.__motionaire` driving + real pointer/keyboard events + screenshots), with
`tsc -b`, ESLint, Prettier, and `vite build` all clean. One commit per phase.
Deliberately NOT touched, per the brief: Rust/wgpu compositor, FFmpeg export,
transcription, AI tool layer, multi-clip composited preview (topmost-clip-only
preview stands until the compositor session).

---

## 2026-07-12 — Session 3: compositor spike (CONTEXT.md §5 step 1)

Goal: prove real-time multi-clip compositing — two decoded videos, keyframed
scale/position/cornerRadius PiP, live in the actual preview. **Outcome: proven,
with large performance headroom.** Details and honest numbers below.

## Q1 — How wgpu pixels reach the screen: frame streaming over native surface

**Chose (b): Rust renders offscreen (headless wgpu → Metal), reads back RGBA, and
streams frames to the webview over a localhost WebSocket (binary, 16-byte header +
tight RGBA); the frontend paints them into a `<canvas>` in the preview stage.**

Why: the spike's actual risk was decode → GPU textures → keyframed composite at
real-time rates — identical under either presentation approach. Streaming keeps
zero platform-specific code (no AppKit/NSView layering, no transparent-webview
config, no preview-rect/DPI synchronization with the React layout), keeps all
existing DOM chrome (text overlays, safe zones, transport) stacking naturally, and
degrades gracefully: no Rust process → DOM preview from session 2 still works
(the browser-pane dev flow depends on that).

What approach (a) — native child surface via raw window handle — would have cost:
macOS view-hierarchy work through objc2 (position a CAMetalLayer under a
transparent WKWebView region), per-OS variants for Windows/Linux later,
scroll/resize/DPI rect-sync between React and the native layer, and input
passthrough handling. Its payoff (zero-copy present, no readback) is real but
irrelevant at current frame budgets — see measurements; it remains the upgrade
path if 4K preview or battery draw demands it. A middle option for later:
shared-surface (IOSurface/DMA-BUF) into the webview without the WS hop.

Transport numbers: 1280×720 RGBA = 3.69 MB/frame; at 60 fps ≈ 221 MB/s over
loopback — comfortably within WS + `putImageData` capacity (measured: 52 fps
delivered end-to-end, bottleneck is the render-loop pacing sleep, not transport).
Frame header carries (w, h, timeline_t, render_fps). The watch-channel transport
drops stale frames for slow clients instead of queueing (latest-wins semantics).

## Q2 — State sync: structure on change, playhead as a float pair

As the brief prescribed: `sync_project` sends a trimmed, flattened mirror of the
store (canvas + video layers with transform/keyframes; ~KB, debounced 60 ms);
`set_playhead(t, playing)` is a two-field message sent on every playhead change.
Rust free-runs its own clock from the last (t, playing, Instant) sample while
playing, so compositor pacing never depends on webview rAF cadence (the session-2
rAF-starvation lesson made this non-negotiable). Each new sample re-anchors; drift
bounded by sample interval. Rust does all per-frame interpolation from the last
synced structure — nothing project-sized crosses IPC per frame.

Keyframe math is ported to Rust formula-identical (same easings, same bracketing,
same left-keyframe-ease rule, timeline-relative times per session 2's decision), with
a Rust unit test asserting the same numeric checks the TS engine passed in browser
tests. This is deliberate duplication with a plan: when the compositor takes over
preview and export (CONTEXT.md §3.1 single-compositor rule), Rust becomes the only
pixel-truth and the TS copy serves only panel readouts.

## Q3 — Decode: FFmpeg CLI subprocess piping rawvideo, not C-API bindings

**Chose the `ffmpeg` binary as a subprocess with `-f rawvideo -pix_fmt rgba pipe:1`,
plus `ffprobe -of json` for metadata — over ffmpeg-next/rusty_ffmpeg C-API
bindings.** Reasons: (1) CONTEXT.md §3.4 already blesses exactly this pattern
("FFmpeg CLI, run as a subprocess — a few lines, not systems programming");
(2) no libav linking — this machine had no FFmpeg at session start (installed via
`brew install ffmpeg` during the session), and C-API crates inherit version-pin
hell; (3) pipe throughput is a non-issue at these sizes (~110 MB/s per 720p30
stream vs GB/s pipe capacity). Cost acknowledged: an extra RGBA copy through the
pipe and no zero-copy hardware-decode surface sharing (VideoToolbox → Metal). That
becomes the upgrade when decode is the measured bottleneck — it currently isn't
(GPU + decode + readback together: ~3 ms/frame).

Decoder model: sequential forward reads paced naturally by pipe backpressure;
backward or >2 s forward jumps respawn ffmpeg with `-ss` (~50–150 ms; acceptable
scrub behavior for a spike, and proxies/seek-optimization are explicitly later
work). No dependency crate for this — ~150 lines of std::process.

## Compositor structure

- Offscreen target at 720p-class resolution (width follows canvas AR) — enough to
  judge correctness, cheap to stream; full-res render is an export-path concern.
- Per-layer: RGBA texture (`queue.write_texture` per new frame), uniform buffer,
  bind group. One render pass, layers drawn back-to-front by track z.
- WGSL: vertex does fit-contain sizing + keyframed scale/rotate/translate in
  canvas coordinates → NDC; fragment applies rounded-rect SDF (radius in on-screen
  px, computed in scaled-local space so rotation is handled) with 1.5 px AA edge +
  opacity, standard alpha blending.
- Readback: `copy_texture_to_buffer` (256-aligned stride) → map → strip padding →
  WS. On Apple unified memory this is cheap; it shows in the 3 ms figure.

## Measured results (honest numbers)

Hardware: Apple M5 Pro (integrated GPU, Metal backend), macOS 26.5.

- **spike_check (release, headless)**: two decoded streams (1280×720\@30 +
  640×360\@30), flagship keyframed PiP, 480 frames stepped at 60 Hz playback
  pattern: **390 fps throughput; frame time p50 2.67 ms / p95 3.02 ms / p99
  3.07 ms** at 1280×720 output. ~6× headroom over the 16.6 ms 60 fps budget —
  in the spike's unoptimized form (no double-buffering, synchronous readback,
  frames re-uploaded even when unchanged).
- **Live end-to-end (debug build, real app)**: render work ~3–4 ms/frame;
  **delivered-to-canvas 52 fps measured client-side**. The 52-vs-60 gap is the
  render loop's `thread::sleep` pacing overshooting by a few ms — a mechanical
  fix (display-clocked pacing / sleep-with-spin-margin), not a capacity limit.
- Visual correctness: PNG dumps show the composite with the source's own embedded
  timecode matching the requested source time exactly (testsrc2 burn-in reads
  00:00:03.500 at t=3.5), PiP at 10 % bottom-right with visible rounded corners;
  live screenshots caught the PiP mid-interpolation between keyframes.

## End-to-end verification chain (no screen-recording permission available)

1. `cargo test`: Rust keyframe resolution matches the TS engine's verified numbers.
2. `spike_check` (headless): PNG evidence + perf measurements, viewed and confirmed.
3. `SPIKE_DEMO=1 npm run tauri dev`: Rust logs prove the webview connected to the
   frame stream AND synced its own store project (frontend-generated clip ids in
   `sync_project`, not the Rust demo's ids) with playhead flowing.
4. Browser pane on the same dev server: real WS frames painting into the real
   preview canvas inside the full editor UI — screenshotted, including delivered-fps
   badge and the keyframed clips on the timeline.

## Open items and honest caveats

- **Pacing**: loop sleeps to ~52 fps; switch to display-clocked pacing for 60.
- **One unexplained event**: the first dev run showed GPU re-inits correlated with
  a webview hot-reload and later terminated cleanly (no panic, no crash report)
  after ~3.5 min. A second identical run showed neither anomaly over a longer
  observation window with more sync traffic. Not reproduced; productionization
  should add a render-thread watchdog + structured exit logging before trusting
  long sessions.
- Audio stays on the session-2 DOM element path — correct for now; the compositor
  is video-only.
- Frontend↔Rust playhead can drift up to one sample while playing (frontend's
  element-master clock vs Rust's free-run) — imperceptible in practice, converges
  on every sample; unify when the compositor becomes the only preview clock.
- Object-URL (browser-import) media is invisible to the compositor — only
  file-backed paths sync. Native file import (Tauri dialog + asset protocol,
  already enabled and scoped) replaces the file-input path next.
- Render loop free-runs per client count 0 or 1 the same; skip-render-when-idle
  exists only for the paused state. Fine for a spike.

## What's still missing vs a finished compositor

Per the brief, deliberately unbuilt: full-resolution offline export path (render
loop → FFmpeg encode is structurally ready: same `render_at(t)` per frame, pipe to
`ffmpeg -f rawvideo` stdin per CONTEXT.md §3.3); proxies; frame-accurate seeking;
crop + shadow in the shader (spec'd in §1.2, straightforward SDF/blur additions);
text and transitions rendered by the compositor (still DOM overlays); >2 layer
stress testing; VFR normalization on import (§6); hardware-decode zero-copy; audio
in Rust. None of these carry spike-level risk — the risky unknown (real-time
multi-clip keyframed compositing reaching the actual preview) is retired.

---

## 2026-07-12 — Session 4: hardening, unified clock, persistence, 60fps, crop/shadow

## Part 1 — reconnect/robustness hardening

**Session 3's "silent termination" mystery is explained.** Root cause of the
missing traces: the compositor thread started via `.manage()` BEFORE
tauri-plugin-log attached, so all startup logs (GPU init, WS bind) were dropped;
only late re-inits ever appeared, which made normal-looking re-inits read as
anomalies. Fixed by starting the compositor inside `setup()` after the logger.
Additionally, every exit path now logs (`CloseRequested`/`Destroyed`/
`ExitRequested`/`Exit`), so a repeat of the silent termination would leave a
definitive trace. Retrospective judgment: the termination was almost certainly a
window close/process kill that had no logging; treated as observability debt, now
paid, rather than a compositor bug — the soak evidence below backs that.

Hardening added, all structured-logged: GPU init with reason (startup / canvas
change / post-error / post-panic), decoder respawn with reason (forward jump /
reverse refill / child death / no child), premature-EOF detection (a SIGKILLed
ffmpeg is detected and respawned, one recovery per frame call to avoid respawn
spins on truly broken files), 3 consecutive render failures → GPU teardown and
re-init, per-iteration `catch_unwind` (a panic logs, drops GPU state, continues),
and a watchdog thread (2s cadence; alerts if the render loop is silent >2s while
playing / >15s paused, with last-status + counters in the message).

**Soak methodology honesty:** true machine sleep/wake and native window
minimize/restore need a human present — sleeping the machine mid-session would
kill the autonomous session running it. What the 35-minute chaos soak DOES drive,
continuously and harder than a human would: scrub storms (both directions), rate
flips (±1/±2), full project re-syncs (the webview-reload shape), canvas dimension
flips (forced full GPU re-init cycles), WS client connect/drop every 10s, and
SIGKILL of all ffmpeg children every 2 minutes. Results in the soak report below.

## Part 2 — one clock

With the compositor active, the frontend stops using a hidden `<video>` element as
master clock: the frontend wall clock generates the (t, playing, rate) anchors,
Rust free-runs between them (now honoring rate — reverse shuttle propagates), and
every media element (audio duty only) drift-corrects against the same playhead via
the unchanged session-2 rule. Text overlays already read store playhead. So all
four surfaces — Rust video frames, audio elements, DOM text, timeline UI — hang
off one number. Measured in-webview (clock-sync self-test): ≤16ms drift between
store playhead and the Rust frame header during playback; exact (0.000s)
convergence after a 30-seek scrub storm and after pausing mid-transition.

**Sketch — rendering text INTO the composited frame (the export blocker):**
rasterize on the frontend, composite in Rust. When a text clip's content/style
changes (not per frame), the webview draws it to an OffscreenCanvas at canvas
resolution ×2 for quality, encodes PNG, and ships it over IPC keyed by
(clipId, contentHash). Rust caches it as an RGBA texture and treats it as one
more layer quad — the existing transform/keyframe/SDF pipeline applies unchanged,
so animation stays real-time (transforms are per-frame uniforms; the raster is
static per revision). Why this over Rust-side text (cosmic-text/glyphon): pixel
parity with the DOM editing overlay for free (same WebKit shaper renders both),
zero font licensing/fallback work in Rust, and typewriter-style presets are the
only thing it handles poorly (they'd re-raster per char step — acceptable, they're
already excluded). Export uses the same cached rasters, so WYSIWYG holds across
preview and FFmpeg export. Estimated as one focused session including cache
invalidation and export-resolution re-raster.

## Part 3 — persistence

- Bundle exactly per CONTEXT.md §8.1 (`project.json` + `transcript.json`
  placeholder + `history.jsonl` empty + `cache/`). Writes are temp-in-same-dir +
  fsync + atomic rename; save VALIDATES the JSON before touching disk so a bad
  serializer can never atomically install garbage.
- `history.jsonl` stays empty rather than logging save events — §8.1 defines it
  as the AI turn log; polluting it now would corrupt its later purpose.
- Load rejects wrong `version`, corrupt/truncated JSON, and missing bundles with
  clear errors (Rust tests cover each); missing source files come back as a list,
  the UI flags those assets offline (striped clips, non-blocking native warning),
  and the compositor already skips unprobeable layers gracefully.
- Transient fields (`playbackUrl`, `missing`) are stripped on save, rebuilt on
  load via the asset protocol. Asset scope widened to `$HOME/**` for arbitrary
  user media — acceptable for a dev-phase desktop editor; revisit with Tauri's
  dynamic-scope API before distribution.
- SQLite per §8.2 at app-data/motionaire.db: `recent_projects` live (upsert,
  prune to 20, vanished bundles filtered on read), `settings` +
  `transcript_cache` schema-only stubs.
- Native import replaces the file-input path in Tauri (dialog plugin + Rust
  ffprobe for metadata — including authoritative `hasAudio`); the browser path
  remains for non-Tauri dev.
- **Save-mid-anything is safe by construction:** zustand+immer state snapshots
  are immutable — a save serializes one consistent snapshot regardless of
  playback or an in-flight drag; a drag-moment save just persists that
  intermediate (valid) clip position. Kill-mid-save leaves either the old or the
  new project.json (rename atomicity on APFS), never a hybrid — verified at the
  unit level (tmp hygiene, replace-not-truncate) rather than by racing kill
  timing, which proves nothing when it passes.
- Verified end-to-end in the real webview, gated by env flags so it's repeatable:
  byte-identical save→wreck→load round-trip (keyframes/transition/text included),
  missing-media flow, and reopen ACROSS PROCESSES via the recents DB (bundle
  saved by one app process, restored by a freshly launched one). A StrictMode
  double-mount bug was found BY these tests — the bridge subscribed twice,
  doubling every IPC message — and fixed with an idempotency guard.

## Part 4 — pacing and reverse

- Pacing: sleep-to-(deadline − 2.5ms) then spin to the absolute deadline.
  Measured clean (release, steady 20s): 58.2fps average INCLUDING process
  startup/GPU init and loop-wrap gaps — i.e. effectively 60Hz steady-state,
  up from 52. Chaos-soak playing seconds peak at 60+.
- Reverse playback is now real, not seek-stepping: every decoded frame lands in
  a byte-capped trailing ring (default 96MB/decoder, `MOTIONAIRE_RING_MB`);
  backward targets serve from the ring at full frame rate, and a ring miss
  refills an entire chunk with ONE ffmpeg seek-respawn. Measured: 2s of timeline
  played backward at 60Hz in 0.42s wall (spike_check). Honest ceiling: at 720p
  the 96MB ring holds ~26 frames (~0.9s), so sustained reverse pays one ~100ms
  refill hitch per chunk; at 4K this needs proxies (already on the roadmap) —
  logged as the known ceiling, upgrade path unchanged.

## Part 5 — crop and shadow in the compositor

- Crop: fractions of the source frame per §1.2's `{l,t,r,b}` (UI edits percent),
  implemented as a uv-window + geometry shrink + rotation-aware center offset —
  Premiere semantics (crop cuts pixels; the box position holds). Sanitized to
  ≤45% per edge in the shader path so degenerate crops can't produce
  inside-out rects.
- Shadow: second quad pre-pass per layer using the same rounded-rect SDF with a
  smoothstep falloff across the blur width — an analytic approximation of a
  gaussian shadow, correct-looking for solid video rects, cheap, and honest
  (it is not a blur of content). Spread grows rect+radius; offset applied in
  canvas space (fixed light source — does not rotate with the layer; CSS
  box-shadow rotates, ours deliberately doesn't; logged as the chosen
  convention). `#RRGGBBAA` supported; bare `#RRGGBB` gets a conventional 0.5
  alpha. Crop/shadow are static (non-scalar) — not keyframeable; the PiP
  keyframed transform animates AROUND them, verified visually.
- Old sync payloads without crop/shadow deserialize via serde defaults — no
  frontend/backend lockstep required.

## Soak results (35 min, release build, Apple M5 Pro)

```
chaos actions:        7469     (scrubs both directions, rate flips, re-syncs)
frames rendered:      50355
gpu re-inits:         23       (11 deliberate canvas flips ×2 + startup — all logged with reasons)
render errors:        0
panics (recovered):   0
watchdog trips:       0
ffmpeg kill rounds:   17       (SIGKILL all decode children — 441 child deaths, all respawned)
ws client reconnects: 208
verdict: PASS
```

The soak binary ran the pre-back-off decoder (built before the delete-file
finding); its 441 kill-recoveries all succeeded because the files existed. The
back-off path for genuinely-gone files is covered by the deterministic unit test
plus the delete-mid-playback run (218 spawn-attempts/10s before the fix → 2
after, zero crashes either way).

## Break-testing ledger (what was tried, what happened)

- Webview hot-reload during streaming: dozens across the session, plus 208
  scripted client reconnects — zero anomalies; the session-3 "GPU re-init on
  reload" reading is now attributed to swallowed startup logs (fixed).
- ffmpeg SIGKILL mid-decode: detected as premature EOF, logged, respawned; 17
  rounds in the soak without a dropped session.
- Source file deleted mid-playback: found the respawn-storm flaw (fixed with
  back-off + stale-frame serving); after the fix, graceful degradation with two
  log lines. Deleted source at load: flagged offline in UI, everything else
  loads and plays.
- Save mid-playback / mid-drag: consistent by construction (immutable
  snapshots); load of truncated/garbage/wrong-version project.json rejected
  with clear errors (unit-tested); atomic-rename discipline unit-tested.
- Scrub storm (30 random seeks in 600ms) during playback with text + PiP:
  compositor settles on the exact target frame (0.000s residual).
- Zero-length clips can't be created through the UI (trim clamps at one frame,
  split refuses sub-half-frame cuts); a hand-edited zero-length clip in
  project.json is inert (active_at is start ≤ t < start+0 — never true).

## Honest limits, named

- **Sleep/wake and native window minimize/restore remain untested** — both need
  a human at the machine (sleeping the machine would kill the autonomous session
  driving the test). The code paths they stress (client reconnect, render-loop
  stall detection, device re-init) are each exercised directly and pass; the
  integration under real power events is not proven.
- **Audio sync is verified by architecture, not by ear this session**: the
  generated test media is video-only, so the clock-sync test proves playhead↔
  compositor-frame agreement, and audio elements follow that same playhead via
  the session-2 drift rule (verified then against real audio). No audible
  end-to-end run happened here.
- **Crop/shadow via the actual panel UI** wasn't visually confirmed (needs
  clicking the native window); verified instead: shader output pixels
  (spike_check PNG), the wire format both directions (unit test), and 35 min of
  soak rendering with nonzero crop+shadow on the animating PiP layer.
- The delivered-fps number in the app UI is measured client-side and honest;
  Rust's header fps remains work-capacity. Steady release pacing measured
  58.2fps including startup and wrap gaps — effectively 60Hz; the ~1.5%
  bookkeeping gap is real and noted rather than rounded away.

---

## 2026-07-12 — Session 6: layout hardening, icon toolbars, native menu bar

**Design reference caveat:** the brief pointed at `design-reference/` (4 Premiere
screenshots) but the folder does not exist in the repo. One real Premiere
screenshot WAS attached inline to the brief and covers everything this session
needed (dense icon toolbars, keyframe diamonds, panel layout, native menu chrome);
work proceeded from that single real reference, not from a paraphrase. The
object-mask compositing reference remains unseen — irrelevant here, flagged for
whoever scopes that later session.

## Part 1 — layout

- **Stage sizing moved from JS (ResizeObserver) to pure CSS** (`aspect-ratio` +
  container-query `cqh` units). Trigger: the layout audit found the stage
  rendered 2×2px in a render-starved (occluded) window — ResizeObserver
  callbacks are delivered on the rendering pipeline, same starvation class as
  session 3's rAF discovery. Frame geometry must not depend on JS callback
  delivery; now the layout engine guarantees it. RO remains only for the text/
  safe-zone overlay scale factor (worst case there: stale overlay scale while
  occluded, corrected on first visible frame).
- **Window minimum 960×620, enforced twice**: tauri.conf.json AND
  `set_min_size` in setup — because the native break-test proved programmatic
  `setSize` sails straight past the config minimum on macOS (AppKit minSize
  constrains user drags, not code). Below-minimum states are therefore
  user-unreachable but still layout-coherent (panels yield: props can shrink
  to 180px under overflow pressure; preview floors at 280×140).
- **Panel clamps are live**, not just static: drags and window resizes both
  re-clamp timeline height / props width against the current window, so sizes
  dragged on a big display can't crush the preview after moving to a laptop.
- Timeline lanes stay fixed-height by construction (56/44px) and scroll
  vertically — 12 tracks in a 200px-tall timeline: zero compression, scrolls.
- Break-testing found and fixed TWO self-inflicted regressions during the
  session: (1) the initial tooltip implementation used `opacity: 0`, which
  still contributes to scrollable overflow — edge-button tooltips poked past
  the viewport at every size (fixed with display:none + keyframe-delayed
  reveal); (2) the pre-existing overcrowded TopBar was the only remaining
  horizontal-overflow source at forced below-min sizes — structurally removed
  by Part 3, not band-aided.

## Part 2 — icons

- lucide-react; one `IconBtn` primitive (16px stroke icons, 28×26 buttons,
  CSS-only tooltips, ~350ms delay) used by every toolbar: top bar, transport,
  timeline toolbar, text-align buttons. Zero text buttons remain in toolbars;
  dialog buttons (Export modal) deliberately stay text — dialogs are text
  territory in the reference too.
- Keyframe diamonds keep the session-2 `◆` glyph treatment per the brief
  ("match its visual weight, don't reinvent it").
- Icon semantics logged where non-obvious: ripple delete = ArrowLeftToLine
  (pull left to close the gap), detach audio = AudioLines, fit = Maximize.

## Part 3 — native menu bar

- Real `tauri::menu` bar: app menu (About/Quit), File (New, Open, Open Recent
  submenu built from the SQLite recents table — rebuilt on every save/load),
  Edit, View (CheckMenuItems for Safe Zones/Snapping kept in sync BOTH ways —
  menu clicks update the store, in-app toggles call `sync_view_menu`).
- All menu events funnel through one Rust handler → a single `menu` emit →
  focus-aware dispatch in the webview: Cmd+Z/Cmd+A while typing in a field
  applies to the text (execCommand), otherwise to the timeline. The JS Cmd+Z
  handler is disabled under Tauri — the menu accelerator owns it (double-undo
  otherwise). Delete/Backspace deliberately has NO menu accelerator so plain
  Backspace keeps working in text fields; it stays a JS shortcut.
- Edit▸Cut/Copy/Paste are the native predefined items (text editing only).
  Clip-level clipboard is new functionality, out of scope this session, logged
  as future work rather than half-shipped.
- New Project replaces state without a dirty-check prompt — there is no dirty
  tracking yet; logged as a known gap to pair with autosave later.
- Verification without clicking the native bar: a dev command synthesizes
  events through the real Rust menu handler; the self-test proved
  snap-toggle, select-all (2/2 clips), and new-project through the full
  native-event → emit → dispatch chain. The one thing this cannot prove is
  the OS rendering the bar itself — that's Tauri's contract; menu build
  errors would appear in the log (none do).

---

## 2026-07-12 — Session 7: verification gap closed, dead-canvas regression, compositor transitions

## Part 1 — real native pixels, finally

**The chosen mechanism is self-capture, not a permission grant.**
`WKWebView.takeSnapshotWithConfiguration` captures the app's own rendered
content — including the GPU-accelerated compositor canvas — with NO Screen
Recording permission, because macOS lets an app capture itself. Implemented as
`capture.rs` + a `capture_preview` command, plus a debug-only dev-remote
(trigger file → capture / minimize / restore / any menu action) that finally
lets the autonomous session DRIVE and SEE the native window. First real native
screenshots in the project's history were taken this session.

Honesty notes: (1) this captures the webview's content, not the window chrome —
exactly the surface where all rendering lives, so it's the right evidence for
compositor claims; (2) capturing the app from OUTSIDE (or capturing other
windows) still requires a one-time human grant of Screen Recording to the
capturing tool — steps documented in the README; there is no automatic path
and this log does not pretend otherwise; (3) the brief's suggested approach
(bundle the app so IT can be granted screen recording) rested on a mismatch —
the permission gates the CAPTURING process, not the captured one; the bundled
.app build (`tauri build --debug --bundles app`) was still produced and
documented since it's needed for the user-side grant flow and future
distribution.

## Part 2 — the regression: what was actually broken

Reproduced natively, exact chain:
1. Playback reaches timeline end → auto-pause. At t == duration no clip is
   active, so the LAST frame the compositor ever sent is empty background.
2. The paused-idle render loop (session 4 design) sent NOTHING further — the
   stale-timer in the client kept the canvas visible with an eternal
   "Compositor 0 fps" badge.
3. Any canvas-backing purge (macOS reclaims GPU backings of occluded windows)
   then displayed an UNINITIALIZED surface: black on the dev machine,
   another application's leftover surface on the user's — the reported
   "different app bled into the preview." The canvas was never repainted
   because repaints only happened on new frames, which never came.

Sessions 3–6 missed it because every check exercised the streaming path while
playing (browser-pane mirror, logs, fps counters) — the idle-after-end state
with a purged backing was invisible to all of them. That is precisely the gap
Part 1 closed.

Fixes (belt + suspenders):
- Rust: paused-idle now re-sends the last frame ~1Hz (keepalive) — purged,
  late, or reconnecting clients have valid pixels within a second.
- Client: caches the last decoded frame; repaints it on visibilitychange /
  focus / pageshow and via a 1s watchdog; black-fills any freshly reallocated
  canvas so an uninitialized backing can never be displayed.
- Badge tells the truth: "paused" instead of "0 fps".
- Verified natively: pause mid-clip → 8s minimized → restore → capture shows
  the correct frame (source burn-in timecode matches the playhead).

**Bonus defect found BY the new eyes:** with the window occluded, the
frontend's playhead crawled at ~0.4× (rAF starved; the 250ms fallback interval
caps dt at 0.1s) while Rust free-ran correctly — visible as transport time
disagreeing with rendered content by ~1s. Fix completes the session-4 clock
unification: while the compositor is active, the store playhead follows the
FRAME HEADER time (Rust is the clock authority); frontend wall-clock
integration remains only as the no-compositor fallback. The anchor echo this
creates (frontend re-sends Rust's own time back) re-anchors Rust to within IPC
latency of where it already is — measured harmless. Verified natively:
transport, timeline playhead, and rendered frame agree mid-playback.

## Part 3 — transitions in the compositor

- Wire: `Layer.transitions` {in, out} with serde defaults (old payloads fine);
  frontend flatten now sends clip transitions.
- Canon implemented as logged in sessions 3/5: cross types (dissolve/slide/
  wipe) act on the INCOMING clip's in-edge window [start, start+d); the
  outgoing same-track clip keeps drawing through its media handle for the
  window (transition_tail), decoder clamping to last frame when the handle
  runs out. Out-edge `fade` dims to background; a cross type placed on an
  out-edge without a partner degrades to a fade (logged, matches the DOM-era
  note).
- Shader-side cost ≈ zero: dissolve/fade modulate the existing opacity
  uniform; slide adds (1-p)·canvas_w to x; wipe reuses the CROP machinery
  (reveal = animated right-crop within the user crop). p50 frame time
  unchanged (2.75ms).
- DOM cross-fade path is dormant while the compositor is active (hidden video
  elements), so there is no double-rendering; it remains the no-compositor
  browser fallback.
- Verified: spike_check PNGs (dissolve = true 50/50 alpha blend with the
  outgoing clip's handle still decoding — its burn-in timecode reads past its
  out point; wipe = clean half-reveal) AND live native captures during real
  playback at 55–59 fps delivered, including the timeline's transition wedge
  UI on the cut.

## Session-7 verification inventory (all native captures)
- Playing composite w/ PiP animation: 57 fps delivered.
- Reproduced dead state pre-fix: black canvas + "0 fps" at end-of-timeline.
- Post-fix: pause → minimize → restore shows correct frame + keepalive.
- Dissolve mid-blend live at 59 fps; clock-authority capture: transport,
  playhead, and frame content in agreement.

---

## 2026-07-12 — Session 8: scrub fix, density, grading, fonts, feature batch

## Phase 1 — the scrub-time preview corruption

**Why this trigger differs from the session-7 bug (evidence, not assertion):**
the session-7 defect was *no frames at all* while idle (0 fps, silent loop) — a
dead canvas left displaying whatever backing macOS had. The scrub-time report
(11 fps) happens while frames ARE flowing. Forensics this session: a 60Hz scrub
storm with per-instant sampling showed the canvas's own pixel data valid at
every probe (testsrc2 colors, never garbage), and a native mid-storm capture on
this machine was clean — so the pipeline (decode → composite → WS → putImageData)
is correct under scrub load. What remains is the DISPLAY path: WebKit's
accelerated 2D canvas uses a pool of IOSurfaces for buffer rotation, and under
the memory pressure a scrub storm generates (3.7MB frames at churn + decoder
respawns), a purged/recycled surface can be composited between our draws —
cross-process surface remnants, exactly the user's "another app's UI". The
90ms gaps between 11fps scrub frames are far shorter than the session-7 1s
repaint watchdog, so that fix could not cover this window.

**Fix: remove the pool from the equation.** `getContext('2d',
{ willReadFrequently: true })` opts into a CPU canvas backing — no IOSurface
pool, nothing recyclable to display; WebKit uploads our buffer as-is. Plus one
reusable ImageData frame buffer instead of a fresh 3.7MB allocation per frame
(that churn fed the very pressure that triggers purges). Verified: storm
forensics pass, clean native capture mid-storm (3s storm @30Hz — a 60Hz storm
starves WKWebView's own takeSnapshot for longer than its timeout; the artifact
class is display-path, unaffected by storm frequency; logged honestly).

Also in Phase 1:
- Vertical track scrolling restructured: the lanes area scrolls both axes, the
  ruler stays pinned (sticky within the scroller), headers scroll in lockstep
  programmatically. Verified: 12 tracks at 200px timeline — scrolls, synced,
  ruler pinned.
- `user-select: none` on body; named exceptions only: `input`, `textarea`,
  `[contenteditable='true']`, `.selectable`. Verified computed styles.
- Draft/Full preview toggle: View ▸ Full Resolution Preview (CheckMenuItem,
  synced both ways). Draft = 720p-class (default, unchanged); Full = canvas
  height. Implemented as a GPU re-init on quality change (same path as canvas
  dim changes, same structured logging). Verified: GPU init #2 "preview quality
  changed" @out_h 1080 + native capture.
- Dev-remote grew `dev:reload`, parameterized scrub storms, and play/pause/seek
  passthroughs — the native-window driving toolkit keeps compounding.

## Phase 2 — density pass

Premiere-style consolidation, not more icons: timeline toolbar reduced to
Split + Delete always-visible; Ripple/Detach into a "More" (⋯) dropdown; Snap/
Safe Zones/Full-Res-Preview into one View Options dropdown (checks stay open on
toggle, actions close — deliberate); zoom in/out/fit replaced by ONE zoom
control with percentage readout (100% = the session-2 default 60px/s), slider
7–800%, preset chips, and Fit. New Dropdown primitive reuses menu styling.
Track headers get type color-coding (video steel-blue / audio green edge);
clips with any effect (keyframes, crop, shadow, grade) show the reference's
tiny italic "fx" badge. TopBar was already slim post-session-6 — unchanged.
Verified: native capture of consolidated toolbar + fx badge; pane capture of
the open zoom dropdown.

## Phase 3 — color grading

Five keyframeable props (`grade.exposure/contrast/saturation/temperature/tint`)
as a new optional `grade` object on Clip (undefined = identity, no schema
migration needed; serde default on the Rust side keeps old payloads valid).
Shader stage extends the existing per-layer fragment math (exactly the crop/
shadow pattern): exposure in stops (exp2), contrast about mid-gray, saturation
via Rec.709 luma mix (-1 = grayscale), temperature/tint as ±R/B and ±G channel
offsets (0.1 gain), clamped; identity when all zero so no branch needed. Ranges
exposed in the panel: ±2 stops, others ±1. Verified: PNG extremes (true
grayscale at sat -1, clipped whites at +2 stops, warm shift), and keyframed
exposure+saturation animating in the real preview via native captures at t=0.5
vs t=5.5. Static grade values on the clip serve as the keyframe base exactly
like transform statics.

## Phase 4 — font import (bundle-embedded)

Fonts are project assets, not machine state: "Import Font…" (File menu) copies
the TTF/OTF bytes INTO the bundle at `fonts/<name>` (atomic write, 10MB cap,
path components stripped server-side), and `project.fonts` stores only
metadata `{id, family, fileName}`. On load, Rust returns each font's bytes
(base64) with the bundle and the frontend registers them via the FontFace API
— so a project opened on a machine that never had the font still renders it.
Family name = file stem (ponytail: real name-table parsing needs a font parser
dep; stem is correct for well-named files and the family is only a CSS key).
Bytes are cached in a Map so save re-embeds without re-reading disk. Custom
families appear in the text font dropdown alongside built-ins.

Verified both legs: (1) SPIKE_FONT_TEST self-test — import Comic Sans MS.ttf
via the real `import_font` command, apply to a text clip, save bundle, wreck
state with a fresh empty project, reopen → PASS (registered/metaKept/
textUsesIt/loadableAfterReload all true); (2) the persistence-session
standard: killed the app, relaunched a FRESH process, opened the bundle from
the recents menu, native capture shows the text clip rendering in Comic Sans
from bundle bytes. Known limit: text is DOM-rendered (session-4 decision), so
fonts affect preview/export only insofar as text stays DOM-composited.

## Phase 5 — feature batch (all five landed)

1. **Marquee + group drag.** Marquee lives on empty lane space in content-local
coordinates (scroll-proof); shift adds to the selection. Dragging any clip of a
multi-selection moves the whole group through a new atomic `moveClipsTo` —
all-or-nothing collision check against clips outside the group, so offsets are
preserved exactly or nothing moves. Group drag is horizontal-only (cross-track
group moves deferred until a real need). Verified with real dispatched
PointerEvents through the lane/clip DOM (p5-select PASS).

2. **Markers.** `Marker {id,t,label}` on the project object — persistence and
undo come free. M adds at the playhead (frame-snapped, deduped half-frame),
flags+labels render on the ruler; click seeks, double-click renames inline,
right-click deletes. Real keydown/contextmenu events in p5-markers PASS.

3. **Freeze frame.** `extract_frame` (ffmpeg -frames:v 1) into the app cache;
the still is ordinary media. Deliberately zero decoder changes: a single-frame
source probes duration 0, so frame_at clamps every request to frame 0 and holds
it after EOF — the still pipeline already existed. Still assets carry
duration 3600 so trim limits need no special case. DOM-fallback preview shows
stills blank (video element can't play PNG) — compositor is authoritative in
the app; logged as a browser-mode-only gap. Verified by native capture at t=13
where only the frozen clip exists.

4. **Adjustment layers.** `adjust: true` clip, no source; Rust resolves its
(keyframeable) grade per frame and adds it component-wise onto every lower-z
layer inside the span. Exact when targets have no grade; stacked grade-on-grade
is an additive approximation (sequential shader passes don't commute — logged
ceiling; per-layer render-to-texture chain is the upgrade). Adding at an
occupied playhead grows a new topmost track, Premiere-style. Verified by
spike_check PNG pair (whole stack grayscale inside span only) + in-app captures.

5. **Hover-scrub filmstrip.** One 20-tile strip PNG per media (ffmpeg
fps=N/duration + tile), extracted once into the app cache; hover just moves a
background-position — no live decode ever. Thumb is position:fixed so it
escapes scroll clipping. Strip cache key is filename+size — a re-rendered
source at the same path serves a stale strip (logged). p5-thumb PASS: tile 16
at 80% hover, tile 2 at 10%, removed on leave.

# Session 9 (overnight) — completion plan

Work order: OVERNIGHT_PLAN.md. CONTEXT.md was deleted from the working tree
earlier today at the user's request, but tonight's brief names it ground
truth — restored it from git history (it was tracked; nothing lost).

## Phase 0 — charcoal retheme

Full token system from OVERNIGHT_PLAN Part 2 replaces the old 7-var palette
(names dropped, not aliased — two names for one color is permanent debt).
Additions the plan's set needed: --bg-monitor (program-monitor surround,
darker than panels so video black out-blacks it), --text-bright (on-accent
fills; never pure #fff per the plan's own rule), editor accents (--playhead,
--kf/--kf-bright keyframe gold, --marker/--marker-text), stripe partners
(--clip-adjust-alt, --clip-missing/-alt), and shadow/scrim tokens. Seam rule
applied: the ten structural panel boundaries (topbar, transport, timeline
top, toolbar, track headers, ruler, lanes, props edge) use --border-seam
(#141414, darker than panels); control borders keep --border-default.
Canvas-drawn colors (ruler ticks/labels, waveforms) read tokens via
getComputedStyle per draw — canvas can't resolve CSS vars. Clip type colors
now follow the plan: text purple, image amber (new clip--image class keyed
off still extensions), adjust red-brown stripes (was purple). Exemptions,
logged deliberately: project CONTENT colors stay literal — canvas background
#000000, default text fill #FFFFFF, default shadow #000000, and the
compositor client's black canvas fill; they are data rendered inside the
video frame, where true black is the point. Contrast: secondary #9c9c9c on
panel #232323 ≈ 5.9:1 (AA). Verified by native capture with the full demo
scene (clip colors, fx badges, keyframes, adjustment stripes, playhead).

## Phase 1 — app shell (activation, onboarding, launcher)

- **LicenseValidator trait** in license.rs (TestValidator accepting
  MOTIONAIRE-TEST-0000-0000; RemoteValidator stubbed) — the CONTEXT.md §7
  seam pattern. Swap = one line in validator().
- **Key storage:** keychain (keyring crate, apple-native) in RELEASE builds
  per §8.2. Debug builds use a temp marker file instead — deliberate: an
  ad-hoc-signed dev binary changes identity every rebuild, so keychain reads
  throw blocking permission dialogs that would hang every unattended test
  run overnight; the only key a debug build ever holds is the public test
  key. Release path compiles (cargo check --release) and unit tests cover
  the validate/activate/deactivate cycle.
- **Views:** boot → activate → onboard (first run; flag in SQLite settings)
  → launcher → editor, all full-window views replacing each other in ONE
  window (per plan — no multi-window state sync). File ▸ Close Project
  (Cmd+W) returns to the launcher. Editing shortcuts are gated to the
  editor view. loadPipDemo forces the editor view so every dev-remote
  self-test keeps working regardless of gate state.
- **Launcher:** recents grid from SQLite with thumbnails; a small JPEG of
  the composite canvas is written to bundle/cache/thumb.jpg on every save
  (COALESCE keeps it when opening without saving). Vanished bundles are now
  FLAGGED (missing badge, remove action) instead of silently dropped by
  list_recents. New Project dialog = name + canvas preset + fps; the native
  save dialog doubles as the location picker (more Mac-like than a separate
  location field — logged simplification).
- Verified: p1-shell PASS (deactivate → bad key rejected → activate →
  status flips → onboarding flag persists → programmatic save produces a
  real thumbnail in recents) + native captures of all three screens.

## Phase 2 — media bin

Left panel in the editor workspace (collapsible to a rail; no native menu
item — zero Rust surface for a per-session toggle). Rows: filmstrip-first-
tile thumbnails (reuses the Phase-5.5 strip cache — no new extraction path),
name, duration, resolution, kind; offline badge rides the existing missing
flag. Drag to timeline is native HTML5 DnD (custom text/motionaire-media
type); drop resolves time via xToTime and the lane's track, falling back to
the first kind-matching track on a wrong-kind lane. insertClipAt clamps to
gaps like every other placement; stills get 3s default. Right-click: add at
playhead, Reveal in Finder (open -R via Rust), Relink (re-probe + updateMedia
— compositor picks it up through the normal flatten sync), Remove (asset +
every clip using it, selection pruned). Found & fixed by the bin's own
listing: loadPipDemo accumulated duplicate media assets on repeat loads —
invisible for eight sessions because nothing ever showed the media array.
Verified: p2-bin PASS (real DnD DragEvents land a clip at exactly 12s;
removeMedia sweeps) + native capture of the populated bin.

## Phase 3 — add-layer UX, track controls, reordering

- **Add menu** ("+" dropdown, first slot in the timeline toolbar): video
  track, audio track, text at playhead, image (probe → still asset →
  insertClipAt), adjustment layer. "Add Shape" deliberately omitted until
  Phase 7 actually lands shapes — no dead menu items (per plan).
- **Track flags** as optional Track fields (muted/solo/locked/hidden) so old
  bundles load untouched. Video tracks expose eye+lock, audio expose
  mute+solo+lock (Premiere convention). Hidden excludes the track from
  flatten() (compositor) but leaves audio alone — the Premiere eye is
  video-only, logged. Solo is kind-scoped in the playback engine's gain
  math. Locked is enforced centrally in the STORE actions (move/trim/split/
  delete/ripple/duplicate/insert/property/keyframe) — one guard per mutation
  beats scattering checks through UI handlers; every input path (pointer,
  menu, shortcuts, future AI tools) inherits it for free.
- **Reordering:** drag a header vertically; crossing ~70% of a lane height
  swaps z with the display neighbor (kind-scoped). Each swap is one undo
  step — a 3-slot drag is 3 undos; acceptable, logged.
- Verified: p3-tracks PASS (add/rename-in-DOM/lock-bounces-all-edits/
  reorder round-trip) + native capture: V2 hidden via the eye → the cam PiP
  is absent from the composited frame while V2's clip stays on the timeline.

## Phase 4 — text into the compositor (the export blocker)

Built exactly as sketched in session 4: the webview rasterizes each text
clip at 2x canvas resolution when content/style changes (djb2 hash of the
style object; NEVER per frame), ships it as PNG over IPC
(set_text_rasters, batched upserts + live-list pruning), and Rust
composites it as an ordinary texture layer — media_path "text:<clipId>",
LayerSlot.decoder is now Option (None for rasters), and text layers draw
at fixed fit=0.5 (2x raster → 1:1 canvas pixels) instead of contain-fit.
Everything else — transform, keyframes, opacity, z, transitions, grade,
crop, shadow — applies unchanged because it's the same uniform pipeline.
Raster layout mirrors the DOM overlay (line-height 1.4, shrink-to-fit ≤
maxWidth, centered block anchor, stroke-under-fill at 2x lineWidth for
-webkit-text-stroke parity); the same WebKit shaper renders both, so glyph
parity is structural. While the compositor is ACTIVE the DOM text overlay
is hidden — the composited frame is the single on-screen source of truth
(the overlay remains as the browser-mode fallback). Missing raster at draw
time = skip that layer this frame; the raster IPC marks dirty so it pops
in on arrival (~1 frame).

Verified three ways: (1) deterministic spike_check PNG — a synthetic
400x100 raster lands exactly 200x50 canvas px above center through the
standard transform path; (2) live native capture — styled text (yellow,
5px black stroke, 110px) rendered INSIDE the composited frame with the
DOM overlay asserted hidden; (3) keyframed animation — capture at
t=start+0.12 shows the fadeUp preset mid-flight (partial alpha + y
offset), resolved per frame by the Rust keyframe engine. Known limits,
logged: typewriter preset stays excluded (re-rasters per char step), and
CSS↔canvas line-BREAK edge cases can differ at extreme widths (same
shaper, different wrap code) — acceptable, wrap happens at word
granularity in both.

## Phase 5 — real export

**Video:** export.rs spins a dedicated thread with its OWN GpuCompositor at
full resolution (width derived from canvas aspect at the requested height —
logged simplification) and drives the exact same render_at the preview uses
(§3.1: one compositor, two callers). Frames pipe as rawvideo RGBA into
FFmpeg stdin; encoder is h264_videotoolbox when present (probed via
-encoders) else libx264 (quality slider → VT bitrate scaled by pixel count,
or x264 CRF). Text rasters are snapshotted from compositor state so export
text is pixel-identical to preview.

**Audio — decision:** FFmpeg filter graph over a Rust mixer (materially
less code; the Rust mixer remains the upgrade path if per-sample control is
ever needed). Per clip: atrim → asetpts → atempo chain (speed) → volume
with eval=frame and a PIECEWISE-LINEAR expression built from the clip's
volume keyframes (kf storage is clip-relative timeline seconds, which is
exactly the post-asetpts t axis) → adelay to timeline position; all clips
amix normalize=0 → aac 192k. Easing on volume keyframes is approximated
linearly for audio (logged). Track mute/solo folded in frontend-side;
silent-forever clips skipped. -t caps duration.

**UI:** panel wired to start_export/cancel_export with export:progress /
export:done events — progress bar (frames), cancel, error notice, success
notice with Reveal in Finder. Format select locked to MP4/H.264 (the wired
pipeline; other containers when someone actually asks — logged). Cancel
kills ffmpeg and removes the partial file; failures also remove it.

**Verification (the plan's element-by-element standard):** built the full
scene — keyframed PiP, split+dissolve at 5s, text with stroke, freeze-frame
image card, saturation grade on the first half, 440Hz tone with a keyframed
fade 6→9.5s — exported 300 frames @1080p30 (VideoToolbox, ~3s wall) and
verified the FILE: ffprobe h264 1920x1080@30 + aac, duration exactly
10.000s; extracted frames show text+stroke over a desaturated first half
with the PiP mid-shrink (t=1.5) and the image card + dissolve mid-blend
(t=5.6); volumedetect measures the fade (mean −21.1dB at 0–2s → −50.0dB at
9.2–10s). Break-test: cancel at 500ms → export:done{cancelled}, partial
file removed, exporter reusable (p5-cancel PASS).

## Phase 6 — project safety

- **Dirty tracking:** one line in mutateProject (every history-pushing edit
  marks dirty); saveProject/replaceProject clear it. Surfaced as "— Edited"
  in the TopBar AND the native macOS titlebar dot (NSWindow.documentEdited
  via one objc2 msg_send on the main thread — tauri v2 has no API for it).
- **Unsaved prompt:** a real 3-way modal (Save / Don't Save / Cancel) —
  plugin-dialog only does 2-button asks, and losing "Don't Save" or
  blocking discard entirely were both unacceptable. Gates file:new/open/
  open_recent/close AND window close (onCloseRequested → preventDefault →
  prompt → destroy).
- **Autosave:** every 30s, dirty + bundle-backed projects write
  bundle/recovery.json (atomic, validated) — project.json is never touched
  except by explicit save, which also CLEARS recovery. Load offers restore
  when recovery is newer than the last save (mtime), and restored state
  loads as dirty so the user decides whether it becomes real. Untitled
  (never-saved) projects have no autosave home — logged limitation.
- **Clip clipboard:** internal store clipboard (deep clones), not the
  system pasteboard. Copy carries full state (transform/keyframes/grade/
  transitions); paste lands at the playhead preserving multi-clip offsets,
  gap-clamped, linkId dropped. The native Edit-menu items stay Predefined
  so TEXT fields keep true system clipboard; outside text WebKit forwards
  menu cut/copy/paste to the DOM as ClipboardEvents, which we claim for
  clips — context-menu Cut/Copy/Paste cover the same ops unconditionally.
- Verified: p6-safety PASS (dirty lifecycle, recovery round-trip newer-
  mtime + content + cleared-on-save, ClipboardEvent copy, paste preserving
  a grade, cut) + capture showing "— safety-e2e — Edited".

## Phase 7 — remaining basics

1. **VFR normalization (the §6 trap, finally landed).** Detection: container
   r_frame_rate vs avg_frame_rate disagreeing >2% (the standard signal — a
   full frame-duration scan would cost a decode pass for marginal gain).
   Normalization: transcode to CFR at the rounded average fps (VideoToolbox
   when present) into app-cache/normalized, keyed by stem+size; import uses
   the normalized copy transparently. Unit-tested against a GENERATED true-
   VFR file (random frame drops, vfr fps_mode): detected → normalized → CFR
   → decodable; CFR input passes through untouched.
2. **Speed ramps.** "speed" keyframes remap time WITHIN the clip's fixed
   timeline window: piecewise-linear rate integrated from clip start
   (trapezoid rule), clamped to the source range — implemented identically
   in engine/time.ts and Rust Layer::source_time (unit test: 1→3 over 4s
   integrates to src 8.0; verified live — playhead 4 renders source ~8, and
   the flat-speed duration-trim path still applies when unarmed; arming
   flips the same property row to ramp keyframes). DECIDED + logged: ramped
   clips are VIDEO-ONLY — time-varying audio tempo isn't representable in
   the export filter graph, so ramped clips are excluded from the audio mix
   and muted in preview. Fixed-window remap (not Premiere's duration-
   changing remap) is the logged ceiling; upgrade path is solving the
   integral for T at trim time.
3. **Audio fades + ducking.** Fades are sugar writing ordinary volume
   keyframes (0→base over 0.5s, base→0 at the tail) — preview and export
   honored them before the feature existed. Ducking is a plain envelope
   follower over the waveform peaks we already decode: 100ms buckets, 0.06
   peak threshold, windows merged under 0.6s, 0.25 gain with 0.25s ramps,
   applied as a volume-keyframe envelope (clears previous volume kfs —
   logged). Verified with a generated 1s-on/1s-off tone: exactly 5 duck
   windows against a constant-tone music clip.
4. **Shapes.** rect/ellipse/line as source-less clips riding the EXACT text
   raster path (same IPC channel, same GPU slots, same transform/keyframe/
   grade pipeline) — a line is a thin filled rect (rotate via
   transform.rotation, logged). Fill/stroke/size editable in a Shape panel
   section; Add menu gained all three (closing Phase 3's deliberate
   omission). Verified: red ellipse composited in the captured frame.
5. **Project templates.** Satisfied by construction: the Phase 1 New
   Project dialog already offers exactly the plan's named template list
   (YouTube 16:9 / Reel 9:16 / Square / Portrait 4:5) with fps
   preconfiguration. No separate template system built — logged as folded
   in rather than duplicated.

## Session 9 wrap

All 8 phases (0–7) shipped with per-phase commits and evidence. Nothing was
cut. Next session per the plan: the AI prompt-driven tool layer (CONTEXT.md
§2), Whisper transcription, and the web/activation server — the app side of
activation is already waiting behind the LicenseValidator seam.

# Foundation session (session 10)

Work order: FOUNDATION.md. Strong base, no AI surface.

## Phase 0 — UI finishing & bug fixes

- **Popover: the class fix.** One primitive (components/Popover.tsx):
  portal at document.body (no ancestor overflow can clip, ever), vertical
  collision flip choosing the roomier side, horizontal viewport shifting,
  max-height + internal scroll as the last resort. BOTH floating-UI
  primitives migrated onto it — Dropdown (Add / More / View Options / zoom)
  and ContextMenu (timeline clips, lanes, media bin) — so every menu in the
  app inherits the fix; nothing floats via ad-hoc absolute positioning
  anymore. Audit notes: iconbtn tooltips are 1-line CSS anchored away from
  their own edge (left as-is), native <select>s position themselves,
  modals are centered overlays — none are members of the bug class.
  Verified with REAL events: Add menu at the bottom toolbar flips upward
  fully in-view with 'Line' reachable (the reported bug); a context menu
  invoked 12px from the bottom-right corner lands entirely inside the
  viewport.
- **Unified title bar:** titleBarStyle Overlay + hiddenTitle; the app's
  header row IS the title bar (drag region + 84px traffic-light inset), the
  launcher header and gate screens get drag regions too. One title bar.
- **Compositor badge** moved out of the frame into the transport row
  ("ready" / "N fps" / "DOM preview"). The frame shows frames, not chrome.
- **Toasts:** store-backed stack (info/success/error/progress with bar),
  bottom-right, auto-dismiss except progress. Routed: export done/cancel/
  fail (globally, so future background exports surface without the panel
  open) and VFR-normalization notice on import.
- **Empty states:** timeline and media bin now offer an Import action
  instead of sitting inert.
- **Break-test find:** the global export listener DOUBLED its toasts —
  StrictMode's immediate cleanup runs before tauri's async listen()
  resolves, leaking one listener per mount; the window-close handler had
  the same latent bug (double unsaved prompts). Fixed with a dead-flag in
  the effect. This pattern is now the house rule for async listener
  registration in effects.
- Polish: :focus-visible rings; resizer cursors verified pre-existing.

## Phase 1 — Rust/TS property-resolution dedup

The honest architecture, made explicit and ENFORCED rather than papered
over: TypeScript cannot be deleted from resolution entirely — audio-element
gain, element pre-seek, panel readouts, and the browser-mode fallback all
live in the DOM and tick at rAF rates where per-frame IPC is nonsense. So:

- **Rust is the single source of truth** for everything rendered/exported
  (was already structurally true; now stated in both file headers as the
  contract, with the "temporary duplication" language removed).
- **TS is a display-only mirror** with an explicit header contract listing
  its four legitimate consumers.
- **Drift now fails loudly:** new `resolve_parity_probe` command runs the
  PRODUCTION resolver (resolve_layer + source_time) over any payload;
  dev:f1_parity_test feeds both sides a byte-identical torture fixture (all
  five easings, uneven spacing, 3-keyframe curves, statics, grade, clamped
  out-of-range times, and a 3-point speed ramp) at 68 sample times.
  Result: worst |Δ| = 8.1e-6 — pure f32 rounding. Tolerance 2e-3.
- **Real divergence found & fixed by the audit:** the export audio path
  built its piecewise-linear volume expression from RAW keyframes, so eased
  volume curves (incl. every fade written by session 9's addFade at ease
  'linear' — those were fine — but eased user keyframes and ducking ramps)
  played differently in export than preview. exportRunner now samples any
  non-linear segment at 10Hz through the parity-locked mirror, so the
  FFmpeg expression approximates the eased curve within the sample step.

## Phase 2 — editing essentials

- **Source monitor** (the flagged biggest workflow gap): double-click a bin
  item (or its context entry) swaps the program monitor for a source view —
  plain <video> playback with frame-step transport, a scrub bar showing the
  I/O range, I/O set buttons, a drag chip carrying (mediaId + range) through
  the existing DnD channel, and "Add at playhead". Insertion honors the
  range via insertClipAt's new optional {in,out}. Full-view swap, not a
  second monitor pane — one window, one visible monitor (logged; Premiere's
  side-by-side twin monitors need horizontal space this layout doesn't
  have). I/O KEYBOARD keys stay timeline-scoped; the source monitor uses
  its buttons — predictability over mode-dependent keys (logged).
- **Timeline in/out:** I / O at the playhead, ⌥ clears, shaded range +
  edge ticks on the ruler; out ≤ in clears the other mark rather than
  silently reordering. Feeds Phase 6's export range.
- **Insert vs Overwrite:** a toolbar chip toggles the drop mode; ALL
  placements route through one prepareSpan(): overwrite carves the landing
  range Premiere-style (straddling clip → head + tail split with keyframe
  redistribution and transition-edge trimming), insert splits at the point
  and ripples the TARGET track right (multi-track ripple deferred with
  sync-lock semantics — logged). Placement now lands EXACTLY where dropped
  instead of nearest-gap nudging.
- **Clip enable/disable:** context-menu toggle; excluded from flatten
  (compositor), export audio, playback gain, and DOM fallback; drawn dim.
- **Nudge:** , / . one frame, shift = 5 (the classic NLE keys; arrows stay
  on the playhead — logged). Collision rule holds: packed neighbors refuse.
- **Audio scrubbing:** dragging the ruler or playhead sets a scrubbing
  flag; paused-but-scrubbing elements keep playing while the constant
  re-seeks produce the classic scrub chatter. Zero new audio machinery.
- Verified: f2-edit PASS (overwrite carve produced exactly [0..4][new
  2s][6..10], insert grew the project to 12s, disable dropped a flatten
  layer, one-frame nudge exact, marks set via real keydowns + invalid-order
  guard) + source monitor capture with a live I/O range.

## Phase 3 — audio completeness

- **Architecture:** media elements stay the decoders (session-2 decision
  intact); each now routes element → StereoPanner → master Gain →
  destination with per-channel analysers on the master bus. Element
  .volume (clip volume × track gates) still applies upstream — the graph
  adds pan, master, metering. One AudioContext, elements attached lazily
  (createMediaElementSource is once-per-element-for-life).
- **Meters:** live stereo peaks in the transport row (decay 0.88/frame,
  hot color >0.92, red clip dot latched 1.5s at ≥0.985). In chrome, not on
  the frame.
- **Master volume:** project.masterVolume (persists with the project;
  slider drags skip undo history — logged); applied per tick in preview
  and as a post-amix volume node in export.
- **Pan:** clip.pan (-1..1, not keyframed — logged), StereoPanner in
  preview; in export a stereo pan matrix with a simple balance law, with
  aformat=stereo inserted per chain so mono sources pan correctly and amix
  sees uniform layouts. Unit test pins the generated graph strings.
- **Normalize:** peak-based (-1 dBFS target, gain capped ×4) from the
  ALREADY-CACHED waveform peaks — instant, no new decode. Logged: peak,
  not LUFS.
- **Break-test finds (2):** (1) one bad tick could kill the playback rAF
  loop silently — now try/caught with the error surfaced for diagnostics;
  (2) the real cause of the flaky test: WebKit throttles rAF to ~1Hz when
  the window is OCCLUDED (exactly the state of an unattended overnight
  run), so fixed-sleep tests race the slow tick — the self-test now polls
  for effects. House rule for future audio/visual assertions.
- Verified: f3-audio PASS (meters read signal, hard-left pan collapses R
  to 0.00, master 0.15 measured on the bus at 0.02 with gain=0.150
  confirmed in-graph, normalize gain exactly matches the waveform-derived
  expectation) + Rust unit test pinning pan/master/aformat in the export
  graph + capture of meters/master in the transport row.

## Phase 4 — effects (in the per-layer shader, as ordered)

All effects extend the ONE per-layer pass exactly like crop/shadow/grade —
no second pipeline. Uniform grew by five vec4s; every scalar param resolves
through the (parity-locked) keyframe engine, so all of it keyframes.

- **Chroma key:** distance in the CbCr plane (stable against luma, unlike
  RGB distance), smoothstep tolerance→tolerance+softness alpha, spill
  suppression pulling near-key chroma toward luma. Keyframeable:
  key.tolerance/softness/spill.
- **Blend modes:** normal/multiply/screen/add as four pipeline variants of
  the same shader — the shader premultiplies per mode (multiply lerps
  toward white by alpha; screen/add premultiply) and fixed-function factors
  complete the math. OVERLAY OMITTED, logged: not expressible in
  fixed-function blending; would need dual-source blending or a
  render-to-texture chain. Shadows always composite normally.
- **Masks:** rect/ellipse SDF in LAYER-LOCAL space (mask travels with the
  clip), feathered smoothstep, invertible. Keyframeable x/y/w/h/feather.
- **Blur/sharpen:** one signed param; 9-tap premultiplied-accumulation blur
  (keyed per tap so keyed edges blur correctly), negative = unsharp against
  the same blurred estimate. Honest ceiling logged: 9 taps is a soft
  approximation at large radii, not a true gaussian.
- **Vignette:** radial darkening in layer space (≈frame vignette for
  fullscreen clips).
- **LUT — DEFERRED, logged with intent.** It is the last item of this
  phase and the only one needing new GPU plumbing (a second texture
  binding → bind-group-layout change at every creation site, an identity
  fallback texture, a .cube parser, and import UI). With proxies —
  FOUNDATION's own top-priority item — still ahead tonight, spending the
  next block there is the better trade. Implementation path documented:
  bake N³ cube → N²×N 2D strip texture, two lookups + lerp in the shader,
  binding 3 with a 1×1 identity default.
- Verified: four deterministic spike PNGs (green fully keyed leaving the
  red subject; multiply darkening; feathered ellipse; blur+vignette) + an
  in-app capture proving the store→flatten→compositor round trip (ellipse
  mask + vignette applied via updateClipFx/setClipProperty on the live
  preview).

## Phase 5 — proxies (verified on real 4K, as the plan demands)

- **Pipeline:** request_proxy → Rust worker thread (ONE transcode at a time
  — a mutex is the whole queue) → scale=-2:720 VideoToolbox (x264 fallback)
  with aac audio, ffmpeg -progress parsed into proxy:progress events →
  Phase 0 progress toasts → proxy:done lands proxyPath on the asset
  (persisted in the bundle; MediaAsset.proxyPath existed in the schema
  since CONTEXT §1.1). Cache keyed stem+size in app-cache/proxies —
  re-import of known footage is instant (content hashing multi-GB files
  costs a full read; logged tradeoff). Eligibility: video taller than
  1080px, not stills.
- **THE RULE**, enforced at the single chokepoint (flatten): preview
  decodes proxies, export decodes originals — exportRunner passes
  {originals:true}; nothing else can. Hidden preview <video> elements
  (audio duty) also switch to proxies — a hidden 4K element is the same
  cost class. View Options gained "Use original media (bypass proxies)".
- **4K verification** (3840×2160×20s synthesized fixture, TWO streams
  stacked fullscreen+PiP): proxy generated at 1280×720; flatten paths
  asserted both directions; measured compositor capacity: RAW ≈5fps
  (23fps on a warmed run — either way unusable), PROXIES = 60fps, locked
  to target. The core-use-case footage that would break the app now plays
  at full rate.
- **Two real engine bugs found by this phase's break-testing:**
  1. Forward-playback "reverse chunk refill" respawn storms: clock-anchor
     jitter stepped decode targets 1-2 frames BEHIND the pipe, and at 4K
     the byte-capped ring holds ~2 frames, so every wiggle became a
     ~300ms ffmpeg respawn. Fixed with 2-frame forward hysteresis in
     frame_at (hold the current frame rather than respawn).
  2. The per-tick playhead anchor is LOAD-BEARING as a capacity governor:
     removing it (first fix attempt) let Rust's clock free-run ahead of
     what 2×4K can decode and spiralled 23fps→1fps (each render forced
     multi-frame catch-up decodes). Final design: keep per-tick anchors
     while playing, but clamp them MONOTONIC (backward jitter filtered,
     genuine seeks >0.35s reset). Logged as the clock contract.
- Bin rows show "· proxy"; progress/success/failure all ride toasts.

## Phase 6 — export completeness

- **Range:** exports honor the timeline in/out marks (both set, out > in);
  the RANGE math lives entirely frontend-side — audio specs are clamped to
  the window and re-expressed range-relative (in/out shifted through the
  clip's speed mapping, volume keyframes shifted, start rebased), so the
  Rust graph stayed range-ignorant; video just starts its frame loop at
  settings.start. Verified: a 2s..5s marked range produced exactly 3.00s
  files with audio.
- **Presets:** one-click chips (YouTube 1080p / 4K HEVC / Reel / Square /
  GIF clip) setting height+fps+quality+format. Export dimensions still
  follow the CANVAS aspect at the preset height — cross-aspect export is
  a canvas concern (Phase 7's project settings), logged.
- **Formats:** H.264 mp4 (existing), H.265 (hevc_videotoolbox, hvc1 tag,
  x265 fallback), ProRes 422 .mov (prores_videotoolbox / prores_ks, PCM
  audio per convention), M4A audio-only (skips GPU + frame loop entirely —
  the graph runs against a dummy anullsrc input to keep the 1-based input
  indexing), GIF (single-pass palettegen/paletteuse at 15fps; break-test
  found the filter output must be labeled+mapped, not raw 0:v), PNG
  sequence (image2, name-%05d.png). WebM dropped from the format enum —
  it was never wired, and a dead option violates the session's own rule.
- **Background export:** already thread-based; now the panel closes while
  running (progress continues as a global progress toast), a second export
  QUEUES in Rust (VecDeque drained by the worker; export:queued toast),
  and cancel kills only the current job.
- Verified: f6-export PASS — mp4 3.00s+audio, hevc, gif, m4a 3.00s
  audio-only, all from a real marked range.

## Phase 7 — project & workflow

- **Project settings dialog** (File ▸ Project Settings…): canvas preset /
  size / fps editable AFTER creation — the existing setCanvasPreset/
  setCanvasFps actions finally got a front door; the creation-time lock
  trap is gone.
- **Consolidate media** (File ▸ Consolidate Media…): consolidate_media
  copies outside sources into bundle/media/ (same-name-different-file gets
  a numeric suffix; already-copied files detected by size and skipped),
  paths+playbackUrls rewritten, project saved. Offline media stays offline
  for relink. Flow extracted to projectIO so the menu and the self-test
  run the same code. Proxies survive (cache key is stem+size — unchanged
  by the copy).
- **Preferences** (⌘, — app menu Settings…): autosave interval (the Phase 6
  timer now honors it), auto-proxy toggle (proxyManager checks it), and
  license deactivation (returns to the activation gate). Stored as one
  JSON blob in the SQLite settings table, loaded at boot.
- **Shortcut cheat sheet** (⌘/): two-column overlay of every real binding.
- Verified: f7-workflow PASS (consolidate moved 2 files, all asset paths
  inside the bundle, files re-probe as real media, project clean after
  the auto-save; prefs JSON round-trips; ⌘/ keydown opens the sheet) +
  captures of the Settings dialog (driven via the real ⌘, menu event) and
  the cheat sheet.

## Phase 8 — deferred cleanup

- **Typewriter text preset: REMOVED, formally.** FOUNDATION.md demanded a
  decision after five deferrals: build it as a real per-character renderer
  or remove it. Removed. Rationale: the Phase 4 text contract is
  "rasterize on change, never per frame" — a typewriter effect re-rasters
  every frame by definition, which either breaks that contract or needs
  compositor-side text rendering (glyph atlas in Rust). It was already
  absent from TEXT_PRESETS/TextAnimationPreset, so removal = keeping it
  out + this log entry. Revisit ONLY if/when text moves into the
  compositor as real geometry; do not fake it with raster churn.
- **Vertical group drag**: moveClipsTo entries accept an optional trackId;
  the whole move is atomic — any locked/missing target, kind mismatch, or
  collision (checked per TARGET track against outsiders + co-arriving
  group members) rejects everything. ClipBlock computes one display-lane
  delta from the pointer and applies it to every member; any invalid
  target keeps that frame horizontal. Cross-kind selections work: each
  member shifts within its own kind's lanes (kind re-checked per member).
- **Untitled-project autosave**: unsaved projects now have a crash-recovery
  home — app_data/untitled/recovery.json (existence IS the signal; no
  project.json to mtime-compare against, unlike bundle recovery). App
  timer branch saves it when dirty && !projectPath; the launcher shows a
  Restore/Discard banner at boot. Restore lands in the editor dirty and
  path-less so the guard + autosave keep protecting it (recovery file is
  deliberately NOT cleared on restore — only a real save clears it).
  Clearing points: first real save, file:new / file:close of an untitled
  project after passing the dirty guard (deliberate abandonment), Discard.
- **Text polish**: TextStyle grew letterSpacing, lineHeight, shadow
  {color,blur,x,y}, gradient {from,to} — all optional so old projects
  load. Raster: letterSpacing set before measuring (affects metrics),
  shadow pads the canvas margin (blur + max offset), shadow rides the
  first paint op only (stroke if present — shadowing both passes would
  double-darken), gradient spans the whole text block vertically. DOM
  overlay mirrors all four; gradient uses background-clip:text, which
  collides with a real background box — when both are set the DOM shows
  the solid color and the compositor raster (the authority) shows truth.
- **Title templates** (Add menu): lower third (accent bar + two-line name
  block on separate tracks — clips can't overlap on one track), centered
  title (dogfoods shadow + letterSpacing), caption bar (dogfoods the
  background box). Pure composition of existing text/shape/keyframe
  primitives — zero new render paths. Sizes/positions derive from canvas
  dimensions, not hardcoded 1080p pixels.
- Break-testing: first f8 run FAILED (rejected/lowerThird/centered/caption
  all false) — the test assumed absolute playhead positions, but
  setPlayhead clamps to project duration, so every position past the pip
  demo's end was fiction. Feature code was fine; the test now derives
  positions from actual state. House rule: never assert on a playhead you
  set — assert on where clips actually landed. Final: f8-cleanup PASS
  (atomic move both ways, collision + kind rejection, recovery round-trip,
  all three templates, raster padding/widening) + f8-restore PASS (real
  DOM click on the banner → editor, dirty, path-less) + captures of the
  three templates compositing over video and the launcher banner after a
  simulated crash-restart.

# Pro-editor session (session 11)

Work order: PRO_EDITOR_PLAN.md. Read-first check: git log ends at Foundation
Phase 8 — NO AI-layer session ran between sessions 10 and 11; built from that
actual state. Also found DECISIONS.md/CONTEXT.md deleted from the working
tree (present in HEAD) — restored both (they are ground truth and this log),
committed removal of the two COMPLETED work orders (FOUNDATION.md,
OVERNIGHT_PLAN.md) as deliberate cleanup.

## Phase 0 — test infrastructure (the gate for everything after)

- **Frontend unit: vitest, node environment.** The store and its entire
  import graph (types, engine/time, engine/keyframes, engine/textPresets)
  were already tauri-free and DOM-free, so no jsdom, no mocks — 55 tests run
  in ~130ms. One feature-side change earned its keep: the dev-only
  `window.__motionaire` handle in store.ts needed a `typeof window` guard to
  load under node. Covered: split/trim source math + keyframe ownership,
  move clamp-vs-atomic-reject semantics (moveClip clamps like a drag;
  moveClipsTo refuses whole), insert/overwrite carve + ripple, ripple delete
  per-track shift, detach-audio linkage + volume-keyframe handover,
  undo/redo transactions + gesture coalescing, marks, clipboard, fades,
  toggleKeyframe, tracks/lock, templates, canvas, markers, fx patch — plus
  the resolveProp mirror contract and easing monotonicity, and sourceTime
  ramp integration. View-state setters (dialogs, toasts, panel sizes)
  deliberately untested: no semantics.
- **Test-quality traps hit immediately, both mine:** (a) importing a
  *.test.ts for its fixture helper re-registers that file's tests in every
  importer — fixtures now live in engine/testUtils.ts (house rule #4);
  (b) snapToFrame(1.016, 30) = 1.0, not 1.033 — 30.48 rounds DOWN; my
  expectation was wrong, the code was right.
- **Backend unit: 15 → 22.** Added: proxy cache-key contract (stem+size
  dedupes copies, size change re-keys, no panic on missing file), an easing
  parity table pinning the Rust curves to the exact TS formulas (unit-level
  drift alarm in front of the e2e parity probe), left-keyframe-easing-wins,
  resolve_layer effect-scalar resolution (blur keyframes, mask fields,
  static vignette), volume_expr input-order independence, multi-clip graph
  1-based input indexing + adelay ms, atempo boundary/clamp cases, license
  validation edges (case/trim/reject) — found and fixed a splice bug of my
  own that had silently detached #[test] from test_key_round_trip (a test
  that stops RUNNING is worse than one that fails).
- **e2e: formalized dev-remote, NOT tauri-driver.** Decisive fact: the
  official Tauri v2 WebDriver path does not support macOS (WKWebView has no
  WebDriver endpoint), so the plan's "evaluate it" resolves to no. The
  proven file-trigger pattern became scripts/e2e.sh: boots (or reuses) the
  real app, fires each dev:* case, polls the log for WEBVIEW-TEST lines
  (never sleeps blind), per-test 240s ceiling, summary + nonzero exit on any
  failure. 19 cases: the new smoke plus the p2..p7 and f0..f8 regression
  tests from sessions 9-10.
- **Smoke (dev:smoke): the critical path as one test** — real import via
  loadPipDemo → clips placed → play with compositorActive && fps>5 asserted
  by polling → blend+vignette applied → text added → 2s range export →
  ffprobe duration within ±0.2s. If this passes, the app fundamentally
  works.
- **Visual regression: self-capture + ffmpeg SSIM.** scripts/visual.sh
  drives dev:vr_scene (fixed 1280×800 window, deterministic fixtures, fixed
  playhead, toasts force-dismissed — transient chrome is nondeterminism) and
  dev:vr_sheet, captures via the WKWebView snapshot, compares against
  committed baselines in tests/visual/ with SSIM ≥ 0.97 (ffmpeg is already a
  hard dependency; no new tooling). --update re-baselines. Launcher screen
  deliberately excluded: the recents grid reflects machine SQLite state.
- **TESTING.md** documents the four layers, the gate rule, and five house
  rules (playhead clamp, poll-don't-sleep, dead-flag listeners, fixtures
  outside test files, derive-positions-from-state).
- npm wiring: `npm test` = the whole suite; test:unit / test:e2e /
  test:visual for the layers.

### Phase 0 gate: what the suite caught on its first day

The first full run was RED (13/19 e2e) — and everything it caught was real:

1. **Cross-test contamination.** The dev cases were written against fresh
   boot state; run in sequence they saw each other's media (f7's consolidate
   moved 4 files, not its own 2). Fix: the runner reloads the webview before
   EVERY test (~5s/test, buys honest results). This immediately exposed the
   opposite class too — f0_popover/f0_ctx only ever passed because SOMEONE
   ELSE had mounted the editor first; they now build their own scene.
2. **A real product bug in the clock contract** (the session's best find,
   would never have surfaced without suite sequencing): compositorClock's
   600ms freshness check uses RECEIPT time, but the paused 1Hz keepalive
   rebroadcasts the LAST frame — so after a webview reload (or around a big
   seek) a fresh `at` carries an ancient `t`. First rAF step after play()
   adopted the stale end-of-media t → enginePlayhead(duration) → instant
   auto-pause. Symptom chain diagnosed via graphDebug element forensics
   (elements paused at t=10.0 = media end; then attached=3 with els[] empty
   = engine never saw an active clip). For a user: open project → press
   play → nothing happens (racy; deterministic under test sequencing). Fix
   at the same seam as the element-master guard: a compositor tick wildly
   off the store playhead (>1s) is stale, not authoritative — skip it and
   free-run; the store push re-anchors Rust and real frames converge.
3. **The first visual baselines were contaminated** (captured post-sequence:
   six media entries, wrong title, Insert mode). visual.sh now reloads
   before the scene shot (vr_sheet deliberately stacks on the settled scene),
   re-baselined clean. Stability: two cold boots → SSIM 1.000000 on both
   screens — the scenes are fully deterministic, so the 0.97 threshold has
   real headroom.

Final gate: full cold `npm test` → 55 vitest + 22 cargo + 19/19 e2e + 2/2
visual = SUITE GREEN.
