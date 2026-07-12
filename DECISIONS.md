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
