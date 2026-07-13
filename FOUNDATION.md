# Motionaire — Foundation Plan

**Goal:** make the base genuinely strong. Fix what's broken, finish what's half-done, and close the gaps between Motionaire and a professional editor — *before* the AI layer goes on top.

**No AI work in this plan.** Not transcription, not the tool layer. That's deliberate: the AI layer mutates the same store every feature here touches. A weak base means the AI inherits every weakness.

**Ordering:** phases are dependency- and risk-ordered. Do them in order. If time runs out, finish the phase you're in, log where you stopped, and stop cleanly. Cut from the **end**, never the middle.

---

## Part 1 — Known bugs and unfinished work

### Bugs

**1. Popover overflow — a bug CLASS, not one bug.** The "+" Add menu opens downward from a toolbar near the window's bottom edge and clips off-screen; Ellipse/Line are unreachable. There is no collision detection and no portal rendering, which means **every** dropdown, menu, popover, and context menu in the app has this latent: zoom control, View Options, overflow (⋯) menu, track-header menus, media-bin right-click, timeline right-click. Fix the class, not the instance.

**2. Double title bar.** A native macOS title bar ("Motionaire") sits above an in-app header row ("Motionaire — shell-e2e — Edited"). Two title bars, wasted vertical space, and it doesn't read as a pro app.

**3. "Compositor paused" badge** sits on top of the video content. Honest, but intrusive — it should be unobtrusive chrome, not an overlay on the frame.

### Unfinished / deferred, carried across sessions

- **Typewriter text preset** — skipped since session 2 as incompatible with the keyframe-sugar model. It has been deferred five times. **Decide it this session:** build it as a real per-character renderer, or remove it from the UI. A permanently dead option is worse than either.
- **Group drag is horizontal-only** — multi-selected clips can't be dragged between tracks.
- **Untitled projects have no autosave home** — an unsaved project isn't crash-protected.
- **Adjustment layer stacking** is an additive approximation, not mathematically exact.
- **Speed-ramped clips are video-only for audio** — audio doesn't time-stretch with the ramp.
- **Reverse playback** ring is ~0.9s at 720p; sustained reverse hitches ~100ms per refill.
- **Text rasterization** has extreme-width line-break edge cases.

### Technical debt — growing, name it now

**Keyframe resolution math AND speed-ramp time-remapping are both duplicated across Rust and TypeScript.** Flagged in session 3 as "don't let it drift silently." It has since grown. Every new keyframeable property (and Phase 4 adds several) doubles the duplication again. **Fix it before adding more, not after.**

---

## Part 2 — Gap analysis: what a professional editor has

A feature taxonomy, with honest status. This is the research deliverable — it's what the plan below is built from.

### Timeline & editing
| Feature | Status |
|---|---|
| Drag / trim / split / ripple delete / snap / zoom | ✅ |
| Marquee + group select | ✅ (horizontal drag only) |
| Markers | ✅ |
| Undo/redo, clip clipboard | ✅ |
| Track add/remove/reorder, mute/solo/lock/hide | ✅ |
| **Source monitor** (preview + set in/out on a clip *before* placing it) | ❌ **Major gap** |
| **Timeline in/out points** (mark in/out) | ❌ |
| **Insert vs Overwrite** edit modes | ❌ |
| **Clip enable/disable** (toggle off without deleting) | ❌ |
| **Nudge by frame** (arrow keys) | ❌ |
| Ripple / roll / slip / slide trim tools | ❌ |
| Track targeting | ❌ |

**The source monitor is the biggest workflow gap in the app.** Without it, pulling a 3-minute segment out of a 1-hour screen recording means dragging the entire hour onto the timeline and trimming it there. That is not how anyone edits long-form footage — and long-form screen recordings are Motionaire's *core* use case.

### Audio
| Feature | Status |
|---|---|
| Waveforms, detach, volume + keyframes, fades, ducking | ✅ |
| Mute / solo | ✅ |
| **Audio meters** (live peak/VU during playback) | ❌ — you cannot tell if you're clipping |
| **Master volume** | ❌ |
| **Pan / balance** | ❌ |
| **Normalize** | ❌ |
| Audio scrubbing (hear audio while dragging the playhead) | ❌ |

### Video & effects
| Feature | Status |
|---|---|
| Transform, crop, corner radius, shadow, opacity | ✅ |
| Color grading (exposure/contrast/saturation/temp/tint) | ✅ |
| Transitions (dissolve/fade/slide/wipe) | ✅ |
| Adjustment layers | ✅ |
| Speed (with ramps) | ✅ |
| **Chroma key / green screen** | ❌ — table stakes for talking-head content |
| **Blend modes** (multiply, screen, overlay…) | ❌ |
| **Masks** (shape mask on a clip) | ❌ |
| **Blur / sharpen** | ❌ |
| **LUT support** | ❌ |
| Vignette | ❌ |

### Text & graphics
| Feature | Status |
|---|---|
| Text clips, font import, stroke, background, animation presets | ✅ |
| Shapes (rect / ellipse / line) | ✅ |
| **Letter spacing, line height, alignment** | ❌ |
| **Text drop shadow, gradient fill** | ❌ |
| **Lower-third / title templates** | ❌ |
| Typewriter preset | ❌ (deferred 5×) |

### Export
| Feature | Status |
|---|---|
| H.264 + AAC, VideoToolbox hwaccel, progress, cancel | ✅ |
| **Export range** (export only between in/out points) | ❌ |
| **Export presets** (YouTube 1080p/4K, Reel, TikTok…) | ❌ |
| **Format options** (H.265, ProRes, GIF, audio-only, image sequence) | ❌ |
| Background / queued export | ❌ |

### Performance
| Feature | Status |
|---|---|
| Real-time compositor (~58fps, 720p draft) | ✅ |
| Draft/Full preview toggle | ✅ |
| VFR normalization on import | ✅ |
| **PROXIES** | ❌ **Critical** |
| Render cache (pre-render complex sections) | ❌ |
| Zero-copy hardware decode (VideoToolbox → Metal) | ❌ (noted as the upgrade path) |

**Proxies are the most important missing item in this entire document.** Mac screen recordings are Retina: a 14" MacBook Pro records at 3024×1964; external 4K/5K displays go higher. Motionaire currently decodes full-resolution frames through an FFmpeg subprocess and uploads them to the GPU. Two 3–5K streams will choke. **The app's core use case is the exact footage most likely to break it.** context.md §3.2 named proxies as the fix and they were never built.

### Project & workflow
| Feature | Status |
|---|---|
| Save/load bundle, autosave, recovery, recents, launcher | ✅ |
| Media bin, relink, offline handling | ✅ |
| Activation, onboarding | ✅ |
| **Project settings dialog** (change canvas/fps *after* creation) | ❌ |
| **Consolidate media** (copy sources into the bundle for portability) | ❌ |
| **Preferences panel** (app-level settings) | ❌ |
| **Keyboard shortcut cheat sheet** | ❌ |
| Empty states, toast/error system, loading states | ❌ |

---

## Phase 0 — UI finishing & bug fixes

The user's explicit complaint. Visible, fast, high-impact.

1. **Popover system — fix the bug class.** Build (or adopt) one popover primitive with: portal rendering at document root (so no ancestor `overflow` can clip it), collision detection with automatic flip (open upward when there's no room below), viewport-edge shifting, and a `max-height` with internal scroll as the final fallback. Then **migrate every single menu/dropdown/popover/context-menu in the app onto it.** Audit exhaustively — the Add menu is just the one that got noticed.
2. **Unified title bar.** Collapse the native title bar and the in-app header into one. Use Tauri's overlay/transparent title-bar style so the app's own header occupies the title-bar region (traffic-light-aware, as already specced in the design direction). Recovers vertical space and reads as a pro app.
3. **Move the compositor status badge** out of the video frame into unobtrusive chrome.
4. **Empty states** — timeline with no clips, media bin with no media, properties with nothing selected. Each should tell the user what to do next, not sit blank.
5. **Toast / notification system.** There is currently no general way to surface a failure, a warning, or a completed background job. Build one; route existing error paths through it.
6. **Loading & progress states** for anything slow (export exists; proxies and background jobs are coming).
7. **Polish audit:** disabled states on unavailable actions, resize cursors on panel dividers, consistent spacing/alignment, native-style overlay scrollbars, focus rings.

---

## Phase 1 — Kill the Rust/TypeScript duplication

Do this **before** Phase 4 adds more keyframeable properties and doubles the problem again.

- **Rust becomes the single source of truth** for property resolution: keyframe interpolation, easing, and speed-ramp time remapping.
- TypeScript keeps at most a thin, clearly-marked **display-only** mirror for panel readouts — it must never be the authority for anything that renders or exports.
- Add a test that asserts the two agree, so any future drift fails loudly instead of silently.
- This is the seam context.md §3.1 already demands ("preview and export share one compositor"). Honour it for property math too.

---

## Phase 2 — Editing essentials

The features that make it feel like a real editor rather than a demo.

1. **Source monitor.** Double-click a clip in the media bin → it opens in a source view. Scrub it, set **in** and **out** points, then drag or insert only that range onto the timeline. This is the single biggest workflow gap in the app.
2. **Timeline in/out points.** Mark in (I) / mark out (O) on the timeline. Drives export range (Phase 6) and range operations.
3. **Insert vs Overwrite.** Dropping a clip onto occupied timeline space should have a defined, user-selectable behaviour: push everything right (insert) or replace what's underneath (overwrite).
4. **Clip enable/disable** — toggle a clip's visibility without deleting it.
5. **Nudge by frame** — arrow keys move the selection by one frame; shift+arrow by a larger step.
6. **Audio scrubbing** — hear audio while dragging the playhead.

---

## Phase 3 — Audio completeness

1. **Audio meters** — live peak meters during playback, with a clipping indicator. Without this the user is mixing blind.
2. **Master volume** — a project-level output gain.
3. **Pan / balance** per clip.
4. **Normalize** — analyse a clip's peak and apply gain to hit a target level.
5. All of the above must be honoured in **export**, not just preview — the filter-graph export path already handles per-clip volume keyframes; extend it.

---

## Phase 4 — Effects

All of these extend the existing per-layer shader pass, exactly like crop, shadow, and colour grading already do. **Do not build a separate effects pipeline.** All parameters must be keyframeable through the existing engine.

1. **Chroma key / green screen.** Key colour, tolerance, edge softness, spill suppression. This is table stakes for talking-head content and one of the highest-value items in this document.
2. **Blend modes** — normal, multiply, screen, overlay, add. Per-layer, applied at composite time.
3. **Masks** — a shape mask (rect/ellipse) on a clip, with feather and invert. The rounded-rect SDF machinery already in the shader is the natural foundation.
4. **Blur / sharpen.**
5. **Vignette.**
6. **LUT support** — load a `.cube` LUT and apply it as a colour transform.

---

## Phase 5 — Proxies

**The most important performance work in the project.** Named in context.md §3.2, never built, and the app's core use case (Retina screen recordings, 3–5K) is precisely the footage that will break without it.

- On import, generate a low-resolution proxy (720p-class) in the background — non-blocking, with visible progress via Phase 0's toast/progress system.
- **Preview decodes proxies; export decodes originals.** Never the reverse.
- Show proxy status per asset in the media bin (generating / ready / none).
- A toggle to force original-media preview when the user wants to inspect true quality (this pairs naturally with the existing Draft/Full toggle).
- Cache proxies in the app cache dir, keyed by source file hash, so re-importing the same footage doesn't regenerate them.
- **Verify with genuinely large footage** — synthesize a 4K test file if none is available. Testing this with 720p clips proves nothing.

---

## Phase 6 — Export completeness

1. **Export range** — export only between the timeline in/out points from Phase 2.
2. **Export presets** — YouTube 1080p, YouTube 4K, Instagram Reel 9:16, TikTok 9:16, Square 1:1, plus Custom. Preset sets resolution, bitrate, codec, fps.
3. **Format options** — H.265/HEVC, ProRes (VideoToolbox supports both natively on Apple Silicon), audio-only (M4A), GIF, and image sequence (PNG).
4. **Background export** — export shouldn't lock the UI; let the user keep working. A simple queue is enough.

---

## Phase 7 — Project & workflow

1. **Project settings dialog** — change canvas size, preset, and fps *after* project creation. Currently these are locked at creation, which is a trap.
2. **Consolidate media** — copy all referenced source files into the project bundle, making it fully portable. The counterpart to the existing offline/relink handling.
3. **Preferences panel** — app-level settings: default export location, autosave interval, proxy behaviour, API keys (keychain-backed), theme, license/deactivate.
4. **Keyboard shortcut cheat sheet** — a ⌘/ overlay listing every shortcut. The app has a lot of them now and zero discoverability.

---

## Phase 8 — Deferred cleanup

Close the items that have been carried across multiple sessions. Cut from here first if time runs short.

1. **Typewriter text preset — decide it.** Build a real per-character renderer, or remove it from the UI. It has been deferred five times; a permanently dead menu option is worse than either outcome.
2. **Vertical group drag** — multi-selected clips should drag across tracks, not just horizontally.
3. **Untitled-project autosave** — give unsaved projects a crash-recovery home.
4. **Text polish** — letter spacing, line height, alignment, drop shadow, gradient fill.
5. **Lower-third / title templates** — a few preset title layouts, since text + shapes + keyframes already exist to build them from.

---

## Rules for this session

- **Never stop to ask.** Every ambiguity: standard choice, log it in DECISIONS.md, continue.
- **Break what you build.** Every session so far has caught real bugs this way, and the best finds came from going beyond what was literally asked. Keep doing that.
- **Use the WKWebView native self-capture tooling** as primary visual evidence. Don't fall back to logs-only where a real screenshot is possible.
- **Phase 0's popover fix must be verified against every menu in the app**, not just the Add menu. It's a class fix.
- **Phase 5 must be verified with genuinely large (4K+) footage.** Synthesize it if needed.
- Commit incrementally per phase, and per sub-item within the big ones.
- Append to DECISIONS.md as you go.
- If you run out of time: finish the phase you're in, log exactly where you stopped and what remains, stop cleanly.

## Explicitly out of scope

- The AI prompt-driven tool layer
- Whisper / transcription
- Object extraction / subject masking
- The web activation server (the app side already waits behind the `LicenseValidator` seam)
- Multicam, nested sequences, stabilization — genuinely beyond a v1 editor