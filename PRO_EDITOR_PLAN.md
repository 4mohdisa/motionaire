# Motionaire — Professional Editor Plan

**Goal:** close the gap between "a very good editor" and "a professional editor." Premiere-class capability, end to end.

**First, read DECISIONS.md and work from ACTUAL state.** An AI-layer session may or may not have run. Do not assume either way — read the log, see what exists, build from there. Nothing in this plan depends on the AI layer, and nothing here should touch it.

**The testing rule (Phase 0, and then forever):** the test suite is built first, and **every subsequent phase is gated on it.** A phase is not done until the full suite — frontend, backend, end-to-end, smoke — is green. No exceptions, no "I'll fix the test later."

---

## Part 1 — What's missing for "professional"

The base is genuinely strong. These are the gaps that still separate Motionaire from Premiere/Resolve.

### The three architectural gaps

**1. Effects are fixed properties, not a stack.** Today a clip has a fixed set of effect slots (grade, chroma key, blur, mask, vignette). Every professional editor treats effects as an ordered, mutable **stack**: add N effects, reorder them (order changes the result), toggle each on/off, remove any, and — critically — apply the *same* effect twice with different settings. This is architectural, it gates effect presets and paste-attributes, and it should be done before more effects are added on top of the wrong model.

**2. No keyframe graph editor.** Keyframes only have easing *presets*. Professional animation requires a **bezier curve editor** — draggable handles, per-keyframe in/out tangents, a visual value-over-time graph. Without it, motion always looks slightly canned.

**3. No scopes.** There is no waveform monitor, vectorscope, histogram, or RGB parade. **You cannot do professional color work by eye on an uncalibrated display** — scopes are how colorists actually work, and their absence means the color tools that exist can't be trusted.

### Timeline & editing
| Missing | Notes |
|---|---|
| **Ripple / Roll / Slip / Slide** trim tools | The four classic trim tools. Basic trim only today. |
| **Track targeting** | Which track receives insert/paste operations |
| **Sync lock** | Which tracks ripple together |
| **Compound clips / nesting** | Group clips into one editable unit |
| **Clip labels / colors** | Organization on a busy timeline |
| **Timecode entry** | Type a timecode, jump there |
| **Copy/paste attributes** | Copy effects+transform from one clip to many — huge workflow win |
| **Batch operations** | Apply to a whole selection at once |

### Audio
| Missing | Notes |
|---|---|
| **Pro meters** | Color-zoned (green/yellow/red), peak-hold, dB scale, per-channel |
| **Waveform quality** | Filled, high-resolution waveform rendering in clips |
| **Audio mixer panel** | Per-track faders, pan, meters, master — a real mixing desk view |
| **EQ** | Parametric, per-clip and per-track |
| **Compressor / limiter** | Essential for voice |
| **Noise reduction / gate** | Essential for screen-recording audio |
| **De-esser** | Voice polish |
| **LUFS loudness normalization** | YouTube targets ≈ −14 LUFS. Peak normalize ≠ loudness normalize. |

### Video & effects
| Missing | Notes |
|---|---|
| **Effect stack** | See above — architectural |
| **Effect presets** | Save/load a configured effect |
| **Color wheels** | Lift / gamma / gain |
| **RGB curves** | Per-channel curve control |
| **Scopes** | See above |
| **LUT support** | Deferred; implementation path already documented in DECISIONS.md |
| **Track mattes** | Use one layer's luma/alpha to mask another |
| **Motion blur** | On fast-moving keyframed layers |
| **Auto-reframe** | **In the original context.md §2.2 spec and never built** — keeps the subject in frame when cropping to vertical |
| **Overlay blend mode** | Logged as impossible in fixed-function blending; needs a different pipeline approach |

### Transitions
Only four exist (dissolve, fade, slide, wipe), with no customization. Professional editors ship a library plus per-transition settings (duration, direction, easing, softness).

### Other
| Missing | Notes |
|---|---|
| **Color matte / solid clip** | A solid-color or blank clip — for backgrounds, title cards, blank sections |
| **Media bin folders** | Real projects need organization |
| **Chapter markers → export** | Markers exist; exporting them as YouTube chapters does not |
| **Render cache / pre-render** | Bake complex sections for smooth playback |
| **Guides & rulers** in the preview | Alignment |

---

## Phase 0 — Test infrastructure (gates everything after)

**Build this first. Every phase after is gated on it.**

Today, verification is ad-hoc: dev-remote file triggers, a `window.__motionaire` handle, one-off spike binaries, and 15 Rust unit tests. It has worked remarkably well — but it is not a suite, it cannot be run in one command, and it cannot catch a regression in something you weren't already looking at.

Build:

1. **Frontend unit tests** — Vitest. Cover the store mutations (every one), keyframe display math, time/frame conversion, insert/overwrite semantics, collision rules, undo/redo transactions.
2. **Backend unit tests** — expand `cargo test` beyond the current 15. Cover: property resolution, speed remapping, the export filter-graph builder, proxy cache keys, project bundle I/O, license validation.
3. **End-to-end harness** — the official Tauri v2 path is `tauri-driver` + WebdriverIO. Evaluate it; if the existing dev-remote pattern is more reliable in practice, formalize *that* into a real runner instead. Either is acceptable — but the result must be **one command that runs everything and reports pass/fail.** Log which you chose and why.
4. **Smoke suite** — the critical path, end to end, as one test: boot → activate → new project → import media → place clip → play → apply an effect → add text → export → **verify the output file with ffprobe.** If this passes, the app fundamentally works.
5. **Visual regression** — reuse the WKWebView self-capture tooling. Capture key screens, compare against committed baselines, fail on unexpected diffs (with a tolerance for antialiasing noise).
6. **Test-quality house rules** — encode the ones already learned the hard way, as lint rules or documented conventions:
   - Never assert on a playhead you set (`setPlayhead` clamps to duration).
   - Poll for effects; never `sleep` (rAF throttles to ~1Hz in occluded windows).
   - Use the dead-flag pattern for async listeners (StrictMode resolves `listen()` after cleanup).

**Then: run the full suite at the end of every phase below. A phase is not complete until it is green.** If a test fails, determine honestly whether the bug is in the feature or in the test — both have happened — and fix the right one.

---

## Phase 1 — Audio visualization + UI fixes

The user's explicit asks.

1. **Professional audio meters.** Not a generic bar — a real meter: color zones (green → yellow → red as it approaches 0dBFS), peak-hold indicators, a proper dB scale with tick marks, per-channel (L/R), and a clip indicator that latches until reset. This is how you can actually *see* whether audio is clipping.
2. **Waveform rendering quality.** Filled, high-resolution waveforms in audio clips — properly peak-detected per pixel column at the current zoom, not downsampled and blocky. Should stay crisp when zooming in.
3. **Audio mixer panel.** A real mixing-desk view: per-track fader, pan, meter, mute/solo, and a master strip. This is where the meters from (1) belong.
4. **Color matte / solid clip.** A solid-color clip type for backgrounds, title cards, and blank sections. Reuses the existing shape/raster path — no new render code.
5. **UI audit.** Sweep the app for remaining rough edges: inconsistent spacing, misaligned controls, missing hover/active/disabled states, panels that don't hold up at small sizes, anything that reads as unfinished. Fix what you find; log what you deliberately leave.

---

## Phase 2 — Effect stack (architectural)

Convert effects from fixed properties into a real, ordered stack.

- A clip owns an **ordered list of effects**. Each has a type, its own parameters (all keyframeable through the existing Rust resolver), and an enabled flag.
- **Order matters** and is user-controllable — drag to reorder in the properties panel. Blur-then-grade ≠ grade-then-blur, and the user must be able to choose.
- The **same effect can appear twice** with different settings (two blurs, two grades).
- Add / remove / toggle / reorder / duplicate, all from the properties panel.
- The compositor's per-layer pass applies the stack in order. Keep it in the single WGSL pass where possible; if a genuine multi-pass is required for correctness, do it properly and log the cost.
- **Migrate existing projects** — old projects with fixed-property effects must load and convert cleanly into stack form. Test this explicitly with a project saved before the change.
- **Effect presets** — save a configured effect (or a whole stack) and apply it elsewhere.
- **Copy/paste attributes** — copy a clip's effects + transform, paste onto one or many selected clips. One of the highest-leverage workflow features in any pro editor.

---

## Phase 3 — Keyframe graph editor

- A **graph view** of keyframed properties: value on the Y axis, time on the X, one curve per property.
- **Bezier handles** on each keyframe — draggable in/out tangents for real ease control, not just presets.
- Multiple properties visible simultaneously, individually toggleable.
- Box-select, move, and delete keyframes directly in the graph.
- The existing easing presets become **starting points** that produce real curves the user can then adjust.
- **Speed ramp curve editing** in the same view — the speed remapping built earlier is exactly the kind of thing this should expose visually.
- Rust remains the resolution authority — the graph editor edits the *data*; Rust still resolves it.

---

## Phase 4 — Professional trim tools

1. **Ripple trim** — trim a clip's edge and shift everything downstream.
2. **Roll trim** — move the cut point between two adjacent clips (one grows, one shrinks; total duration unchanged).
3. **Slip** — change a clip's source in/out without moving it on the timeline.
4. **Slide** — move a clip along the timeline, adjusting its neighbors to absorb the change.
5. **Track targeting** — which track receives insert/paste operations.
6. **Sync lock** — which tracks participate in ripple operations.
7. **Tool selection UI** + keyboard shortcuts (the standard V/A/B/N/R/Y/U mapping is worth matching for muscle memory).

Each of these has precise, well-defined semantics. Get them exactly right — an "almost correct" slip tool is worse than none, because it silently corrupts an edit.

---

## Phase 5 — Professional color

1. **Scopes** — waveform monitor (luma), RGB parade, vectorscope, histogram. Real-time, fed from the compositor's actual output frames. Without these the color tools that already exist are guesswork.
2. **Color wheels** — lift / gamma / gain, the standard three-way corrector.
3. **RGB curves** — per-channel and composite curve control.
4. **LUT support** — the implementation path is already documented in DECISIONS.md (2D-strip bake, dedicated binding, identity fallback). Finish it.
5. All of the above must be keyframeable, and all must go through the Phase 2 effect stack — they are effects, not special cases.

---

## Phase 6 — Professional audio

1. **Parametric EQ** — multi-band, with a visual response curve.
2. **Compressor / limiter** — threshold, ratio, attack, release, makeup gain. Essential for voice.
3. **Noise reduction / gate** — essential for screen-recording audio, which is usually recorded in a bad room on a mediocre mic.
4. **De-esser.**
5. **LUFS loudness normalization** — target −14 LUFS for YouTube. This is *not* the same as the peak normalization already built; peak-normalizing a quiet-but-spiky recording still leaves it quiet. Measure integrated loudness and apply the correct gain.
6. Audio effects must work as **clip effects and track effects** (a track-level EQ applies to everything on that track).
7. **All of it must survive export**, not just preview. The FFmpeg filter-graph export path already handles volume/pan; extend it, and verify each effect in the *exported file*, not just in playback.

---

## Phase 7 — Transitions, motion, and the original spec's leftovers

1. **Transition library** — expand well beyond the current four: push, slide variants, zoom, spin, glitch, film burn, luma wipe, iris, and directional wipes.
2. **Transition settings** — duration, direction, easing, softness/feather, per transition.
3. **Track mattes** — use one layer's luma or alpha to mask another. Combined with the effect stack, this unlocks a large amount of real motion-graphics capability.
4. **Motion blur** — on fast keyframed movement.
5. **Auto-reframe** — **specced in context.md §2.2 and never built.** Keeps the subject in frame when the canvas is cropped to a different aspect (e.g. 16:9 → 9:16). Face/subject detection driving a keyframed crop. Directly serves the platform-preset workflow that already exists.
6. **Guides & rulers** in the preview, with snapping.

---

## Phase 8 — Organization & workflow

1. **Media bin folders** — real nesting, drag to organize, plus search/filter.
2. **Clip labels & colors** — assign colors to clips; filter and select by label.
3. **Timecode entry** — type a timecode, jump to it. Display timecode everywhere (not just seconds).
4. **Compound clips / nesting** — group a selection into a single editable unit, and open it to edit inside.
5. **Chapter markers → export** — markers already exist; export them as YouTube chapter text and as embedded chapters.
6. **Render cache / pre-render** — bake complex sections so playback stays real-time even where the compositor can't keep up.
7. **Batch operations** — apply an effect, grade, or transform to an entire selection at once.

---

## Rules for this session

- **Read DECISIONS.md first.** Work from actual state, not assumed state.
- **Phase 0 is built first, and every phase after is gated on the full suite passing.** This is the user's explicit requirement. A phase with a red test is not a finished phase.
- **Never stop to ask.** Every ambiguity: standard choice, log it, continue.
- **Break what you build.** The best finds in every session have come from going beyond what was literally asked.
- When a test fails, work out honestly whether the bug is in the **feature** or the **test** — both have happened repeatedly — and fix the correct one.
- Use the WKWebView native self-capture tooling as primary visual evidence.
- Commit incrementally per phase.
- Append to DECISIONS.md as you go.
- If you run out of time: finish the phase you're in, run the suite, log exactly where you stopped, stop cleanly. **Cut from the END, never the middle.**

## Out of scope

- The AI tool layer and Whisper transcription (whether or not they already exist — do not extend them here).
- Object extraction / subject masking.
- The web activation server.
- Multicam, stabilization, and interlaced-media support — genuinely beyond scope for now.