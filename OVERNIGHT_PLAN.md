# Motionaire — Overnight Completion Plan

**Purpose:** take Motionaire from "excellent editing engine" to "complete, shippable app," so AI-layer work can start on a finished foundation.

**How to use this doc:** it is the work order for one long autonomous session. Phases are ordered by dependency, not by importance — do them in order. If time runs out, it is far better to finish Phases 0–5 solidly than to rush all 8. Cut from the end, never the middle.

---

## Part 1 — Gap analysis

### What already exists (do not rebuild)

Timeline (drag/trim/split/ripple/snap/zoom/marquee/group-drag), Rust+wgpu compositor with real multi-clip keyframed compositing, FFmpeg-subprocess decode, transitions in-compositor, text clips (DOM), image clips, adjustment layers, freeze frame, markers, color grading, crop/shadow, keyframes with stopwatch semantics, audio detach + waveforms, font import (bundle-embedded), project save/load (atomic bundle + SQLite recents), native macOS menu bar, icon toolbars + density dropdowns, undo/redo, hover-scrub filmstrip, Draft/Full preview toggle, WKWebView self-capture verification tooling.

### The critical gaps (found by audit, ranked)

**1. There is no export.** The Export panel is a settings UI wired to an honest "not implemented" stub. No render pipeline exists. **The app cannot produce a video file.** This is the single biggest gap between Motionaire and a real editor.

**2. Text cannot be exported — and this blocks export.** Text clips are DOM overlays composited by the browser, not by Rust. FFmpeg encodes what the *compositor* renders, so DOM text is physically invisible to any export path. Sketched in DECISIONS.md (session 4) but never built. **Export cannot ship correctly until this is fixed.** These two gaps are one problem.

**3. There is no media bin.** Imported media has no browsable panel. It was dropped from a session-2 prompt by mistake and never noticed since. It is listed in context.md §4 as table stakes.

**4. No project management / home screen.** The app opens straight into an empty editor. No recents UI, no "new project," no onboarding, no activation.

**5. No project safety.** No dirty-tracking, no autosave, no unsaved-changes prompt. A crash or an accidental New Project loses work silently.

**6. No clip clipboard.** Edit ▸ Cut/Copy/Paste operates on text only, never on clips. Logged as a gap in session 5.

**7. VFR normalization was never done.** context.md §6 names this as a known trap: screen recorders (OBS/QuickTime/Loom) commonly output *variable* frame rate, which desyncs audio and breaks frame math. It was deferred to "the native session" and appears to have never landed. This directly threatens Motionaire's core use case.

**8. Smaller, logged-and-deferred:** track reordering, keyframeable speed ramps (speed is a flat per-clip value), typewriter text preset, audio ducking, shapes/graphics, project templates, proxies for 4K.

---

## Part 2 — Design system: charcoal, not black

**Principle:** never pure black (`#000`), never pure white (`#fff`). Adobe's pro tools sit in charcoal — soft on the eyes over long sessions, and it lets true black in the *video frame* read as actually black by contrast.

**A detail that matters:** Adobe uses **darker seams than the panels themselves** to separate panels — not lighter borders. Getting this backwards is what makes dark UIs read as amateur.

Starting tokens (refine against the reference screenshots; these approximate Adobe Spectrum's darkest theme):

```css
/* Surfaces */
--bg-app:            #1a1a1a;  /* window chrome, darkest surface */
--bg-panel:          #232323;  /* panel backgrounds */
--bg-panel-alt:      #2b2b2b;  /* nested / alternating panels */
--bg-elevated:       #333333;  /* dropdowns, popovers, menus */
--bg-control:        #3a3a3a;  /* buttons, inputs at rest */
--bg-control-hover:  #454545;
--bg-control-active: #4f4f4f;

/* Borders — note the seam is DARKER than the panel */
--border-seam:       #141414;  /* between panels */
--border-default:    #3a3a3a;  /* around controls */
--border-strong:     #4f4f4f;

/* Text */
--text-primary:      #e4e4e4;
--text-secondary:    #9c9c9c;
--text-disabled:     #5a5a5a;

/* Accent / selection */
--accent:            #2680eb;
--accent-hover:      #3d92f5;
--accent-muted:      rgba(38,128,235,0.18);

/* Clip / track type colors */
--clip-video:        #2f4a6d;
--clip-audio:        #2f5c42;
--clip-text:         #5c3f6b;
--clip-image:        #6b5230;
--clip-adjust:       #6b3f3f;

/* Status */
--danger:            #d64545;
--warning:           #e0a030;
--success:           #3fa860;
```

Every color in the app must come from a token. No hardcoded hex anywhere in components — if a value is needed that isn't in the system, add a token for it.

---

## Phase 0 — Retheme to charcoal

Everything downstream inherits this, so it goes first.

- Replace the existing palette with the token set above.
- Audit **every** component for hardcoded colors; route all of them through tokens.
- Apply the darker-seam rule between panels.
- Verify contrast is genuinely readable (secondary text on panel backgrounds is the usual failure).
- Native-capture the retheme before moving on.

---

## Phase 1 — App shell: activation, onboarding, launcher

The app currently boots straight into an empty editor. It needs a real front door.

### 1a. Activation gate

The eventual model: user downloads the app, signs up on the web, receives an activation key, enters it once in the app. The web side does not exist yet — **build the app side against a local test key.**

**Architecture (this is the important part):** put validation behind a Rust trait so swapping in real server validation later is a config change, not a rewrite — the same pattern context.md §7 already prescribes for the AI provider.

```
trait LicenseValidator
  ├── TestValidator    — accepts a hardcoded test key (e.g. MOTIONAIRE-TEST-0000-0000)
  └── RemoteValidator  — stubbed; will POST to the web API later
```

- On launch: not activated → activation screen; activated → straight through.
- **Store the activation state in the OS keychain, not SQLite plaintext** — same rule context.md §8.2 sets for API keys.
- Include a "Deactivate" action in settings so this is testable.
- Handle the invalid-key path with a real, clear error state — not a silent failure.

### 1b. Onboarding

First run only, after activation. Short and skippable — three or four screens at most: what Motionaire is, how prompt-driven editing will work, import your first clip (or open the PiP demo). Persist an `onboarding_completed` flag in settings.

### 1c. Project launcher / home screen

Shown when no project is open.

- Recent projects, as a grid with thumbnails. The SQLite recents table already exists (path, name, last_opened) — add a thumbnail column and generate a thumbnail on save.
- **New Project** → a real dialog: name, location, canvas preset (reuse the existing social presets), fps.
- **Open Project** → native file dialog.
- Missing/moved project bundles must be handled gracefully — flag them, don't crash.

Implement the launcher as a full-window view that the editor replaces, rather than a second native window — simpler, and avoids multi-window state synchronization. Log this decision.

---

## Phase 2 — Media bin

Never built. Table stakes per context.md §4.

- A real panel listing all imported media in the project: thumbnail, filename, duration, resolution, kind.
- Drag from the bin onto the timeline to place a clip.
- Show offline/missing media clearly (the "flag it, don't crash" behavior already built for project load).
- Right-click → reveal in Finder, remove from project, relink.
- Media in the bin is project-scoped and persists in the project bundle.

---

## Phase 3 — Add-layer UX

Track creation exists (session 7) but isn't discoverable, and there's no single obvious way to add content.

- A clear **"+" / Add** control in the timeline header area.
- One menu covering: Add Video Track, Add Audio Track, Add Text, Add Image, Add Adjustment Layer, Add Shape (see Phase 7 — if shapes aren't built yet, omit the item rather than shipping a dead one).
- Track headers get: name (renameable), mute, solo, lock, visibility toggle — the standard NLE control set visible in the reference screenshots.
- **Track reordering** (drag a track header to move it) — closes a gap deferred since session 2.

---

## Phase 4 — Text into the compositor

**This is the prerequisite for export.** Text is currently a DOM overlay; FFmpeg cannot capture it. Nothing exported will contain text until this is done.

Per the approach sketched in session 4's DECISIONS.md: the frontend rasterizes each text clip to a bitmap whenever its content/style changes (not per frame), hands the bitmap to Rust, and Rust composites it as an ordinary texture layer — reusing the exact transform/keyframe/z-order machinery every other layer already uses.

- Rasterize on change, cache by content+style revision. Never rasterize per frame.
- Text layers must respect the existing transform, keyframes, opacity, and z-order like any other layer.
- The DOM overlay can remain for editing responsiveness, but **the compositor's render must be the source of truth for what will export** — if the two ever disagree, that's a bug, and it's exactly the class of bug context.md §3.1 warns about ("preview and export share one compositor").
- Verify: a text clip renders identically in the compositor and in the DOM overlay, and animates correctly through its keyframes.

---

## Phase 5 — Real export

The biggest missing feature in the app. Per context.md §3.3 the offline path is *structurally ready* — the compositor already exposes a deterministic `render_at(t)`. The work is the surrounding pipeline.

### 5a. Video

- Loop frames deterministically: for frame `n` at `t = n/fps`, `render_at(t)` → readback → pipe raw RGBA to FFmpeg stdin (`-f rawvideo`).
- Render at **full project resolution**, not the Draft preview resolution.
- Hardware encode via **VideoToolbox** on macOS; fall back to x264.

### 5b. Audio — the hard part, do not underestimate it

Audio currently lives entirely in the frontend's Web Audio graph. Rust has no audio pipeline at all. Export needs one.

Decide and log the approach: either mix in Rust (respecting per-clip volume, volume keyframes, and fades), or construct an FFmpeg filter graph that performs the mix. Either is defensible; the filter-graph route is likely less code, the Rust route gives more control later. **Whichever you pick, per-clip volume keyframes must be honored** — they're real data in the document model already.

Then mux the mixed audio with the encoded video.

### 5c. UI

- Wire the existing export settings panel to the real pipeline.
- Real progress reporting (frames rendered / total, time remaining).
- A working cancel that cleans up the partial file and any child processes.
- Handle the export-failed path honestly and visibly.

### 5d. Verify properly

Export a project containing: two video layers with a keyframed PiP, a transition, a text clip, an image overlay, a color grade, and audio. Then **open the exported file and confirm every one of those elements is actually present and correct**. An export that silently drops text or audio is worse than no export.

---

## Phase 6 — Project safety

Unglamorous, and the difference between a demo and a tool people trust with real work.

- **Dirty tracking:** know when the project has unsaved changes; reflect it in the title bar (the standard macOS convention).
- **Unsaved-changes prompt** on New Project, Open Project, and window close.
- **Autosave** on a timer to a recovery file inside the project bundle; offer recovery on next launch after an unclean exit.
- **Clip clipboard:** real Cut/Copy/Paste for clips (currently text-only — a session-5 gap). Paste lands at the playhead on the active track. Copy must carry the clip's full state: transform, keyframes, grade, transitions.

---

## Phase 7 — Remaining basics

In priority order. Cut from the **end** of this list if time runs short.

1. **VFR normalization on import** — context.md §6's own named trap, still unlanded, and it specifically threatens screen-recording footage, which is Motionaire's core use case. Detect variable frame rate on import and normalize to CFR (`ffmpeg -vsync cfr`). **Treat this as the highest-value item in this phase.**
2. **Speed ramps** — make `speed` keyframeable rather than a flat per-clip value, so it animates through the existing keyframe engine like everything else.
3. **Audio fades + ducking** — fade in/out handles on audio clips; auto-duck music under speech (a simple envelope follower is enough; this does not need ML).
4. **Shapes** — rectangle, ellipse, line as a clip kind. Reuses the same transform/keyframe/compositor path as image clips. If this lands, add it to Phase 3's Add menu.
5. **Project templates** — "YouTube 16:9," "Reel 9:16," "Square," with canvas/fps preconfigured, offered in the New Project dialog.

---

## Rules for this session

- **Never stop to ask.** Every ambiguity: pick the standard, conventional choice, log it in DECISIONS.md, keep moving.
- **Order matters.** Phases are dependency-ordered. Phase 4 gates Phase 5. Phase 0 gates everything visual.
- **Break what you build.** Every session so far has caught real bugs this way; the most valuable finds have come from trying to break things beyond what was literally asked.
- **Use the native capture tooling** (WKWebView self-capture, built session 6) as primary visual evidence. Don't fall back to logs-only where a real screenshot is possible.
- **Commit incrementally** — per phase, and per sub-item within the large phases.
- **Append to DECISIONS.md as you go**, not in a rush at the end.
- **If you run out of time,** finish the phase you're in, log exactly where you stopped and what remains, and stop cleanly. A clean stop with an honest handoff beats eight half-finished phases.

## Explicitly out of scope

- The AI prompt-driven tool layer (next session — that's the point of finishing all this)
- Transcript / Whisper integration
- Object extraction / subject masking
- The web landing page and real server-side key validation (app-side only tonight, against the test key)
- Proxies (until 4K performance is an actual measured problem)