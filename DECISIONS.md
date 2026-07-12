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
