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
