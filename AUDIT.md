# Release audit — exhaustive functional inventory

Release session (final). Every user-facing capability across thirteen build
sessions, exercised for real. Evidence column tells the truth about HOW each
item was verified tonight:

- `suite:<name>` — exercised by tonight's cold full-suite run (real app, real
  compositor, per-test webview isolation).
- `manual` — driven by hand tonight through the dev-remote (real UI events /
  real files / captures), because no suite test covers it.
- `inspect` — verified by code inspection only, with the reason (usually: the
  path ends in a native macOS dialog no automated run may touch).

Verdicts: **PASS** / **FAIL** (with a description) / **REMOVED** (broken and
removed rather than shipped half-working) / **LIMITATION** (works as designed
with a known, documented ceiling).

---

## 1. Project lifecycle

| Feature | Evidence | Verdict |
|---|---|---|
| Activation gate (validate/activate/deactivate) | suite:p1_shell_test | PASS |
| Onboarding (first-run flag persists) | suite:p1_shell_test | PASS |
| Launcher (recents grid, thumbnails, missing-bundle badge) | suite:p1_shell_test + suite:f8_restore_test | PASS |
| New project (name/preset/fps dialog) | suite:smoke (loadPipDemo path) + manual | PASS |
| Open / Save (bundle round-trip, atomic writes) | suite:p6_safety_test + suite:p2_migration_test (real disk bundle through the load path) | PASS |
| Save As | inspect — same saveProject with ask=true; ends in a native dialog | PASS (inspect) |
| Open Recent (menu → SQLite recents → load) | suite:rel_project_test (new tonight) | PASS |
| Autosave (interval honored, recovery.json) | suite:p6_safety_test + suite:f7_test (interval pref) | PASS |
| Recovery — bundle (newer-mtime offer) | suite:p6_safety_test | PASS |
| Recovery — untitled (launcher banner, restore click) | suite:f8_restore_test | PASS |
| Unsaved-changes 3-way prompt | inspect — native-modal path (house rule 5) | PASS (inspect) |
| Project settings (canvas/fps after creation) | suite:rel_project_test (new tonight) | PASS |
| Consolidate media | suite:f7_test | PASS |
| Preferences (autosave interval, auto-proxy, deactivate) | suite:f7_test + suite:r1p2_keys_test | PASS |
| Dirty tracking (“— Edited”, titlebar dot) | suite:p6_safety_test | PASS |

## 2. Media

| Feature | Evidence | Verdict |
|---|---|---|
| Import video/audio/image (probe, hasAudio) | suite:smoke + suite:p2_bin_test | PASS |
| VFR normalization on import | cargo unit (generated true-VFR file) | PASS |
| Proxy generation + preview-proxies/export-originals rule | suite:f5_proxy_test (real 4K) | PASS |
| Media bin (list, thumbs, offline badge, remove sweep) | suite:p2_bin_test | PASS |
| Bin search + folders | suite:p8_org_test | PASS |
| Relink | suite:rel_project_test (re-probe; the picker itself is a native dialog) | PASS |
| Source monitor (open, I/O range, add at playhead) | suite:f2_edit_test (range insert) + suite:rel_project_test / rel_ui_test (new tonight) | PASS |
| Drag media → timeline (real DnD) | suite:p2_bin_test | PASS |
| Hover-scrub filmstrip | suite:p5_thumb_test | PASS |
| Freeze frame | suite:p5_freeze_test | PASS |
| AI-generated media (badge, import pipeline) | suite:r1p6_gen_test | PASS |

## 3. Timeline

| Feature | Evidence | Verdict |
|---|---|---|
| Drag / move (clamp semantics) | vitest + suite:p5_select_test | PASS |
| Trim (media-bound + neighbor clamps) | vitest + suite:p4_trim_test | PASS |
| Split (keyframe distribution, selection-aware) | vitest | PASS |
| Ripple delete | vitest | PASS |
| Snapping (+ toggle) | vitest + suite:rel_ui_test (menu path) | PASS |
| Zoom (slider/presets/fit, ctrl-wheel) | suite:rel_ui_test (menu path) | PASS |
| Marquee + group drag (horiz + vert atomic) | suite:p5_select_test + vitest (moveClipsTo) | PASS |
| Markers (add/label/seek/delete) | suite:p5_marker_test | PASS |
| In/out marks (I/O keys, invalid-order guard) | suite:f2_edit_test | PASS |
| Insert vs overwrite (carve/ripple) | suite:f2_edit_test + vitest | PASS |
| Clip enable/disable | suite:f2_edit_test | PASS |
| Frame nudge (,/. ±1, shift ±5) | suite:f2_edit_test | PASS |
| Clip labels + select-by-label | suite:p8_org_test | PASS |
| Timecode entry (click-to-edit transport counter) | vitest (parseTimecode) + suite:rel_project_test / rel_ui_test (new tonight) | PASS |
| Track add/remove/rename/reorder | suite:p3_tracks_test | PASS |
| Mute/solo/lock/hide | suite:p3_tracks_test (lock bounces all edits) | PASS |
| Track targeting | vitest + suite:p4_trim_test | PASS |
| Sync lock (default-true ripple participation) | vitest | PASS |
| Compound clips (group/ungroup/trim window) | suite:p8_org_test + vitest | PASS |

## 4. Trim tools

| Feature | Evidence | Verdict |
|---|---|---|
| Ripple (wall clamp, sync-locked shift, anchored start) | vitest (exact-output pins) + suite:p4_trim_test (real drags) | PASS |
| Roll (cut moves, total duration provably unchanged) | vitest + suite:p4_trim_test | PASS |
| Slip (source window only, nothing else) | vitest + suite:p4_trim_test | PASS |
| Slide (neighbor extend/trim, gap absorb) | vitest + suite:p4_trim_test | PASS |
| V/B/N/Y/U tool switching | suite:p4_trim_test (real keydowns) | PASS |

## 5. Properties & keyframes

| Feature | Evidence | Verdict |
|---|---|---|
| Transform x/y/scale/rotation/opacity | suite:smoke + suite:f1_parity_test | PASS |
| Crop, shadow, corner radius | suite:f1_parity_test + spike PNGs | PASS |
| Speed (flat + ramps) | suite:p7_test (∫=8 pin) + vitest | PASS |
| Volume (+ keyframes) | suite:p5_export_test (measured fade in file) | PASS |
| Blend modes | suite:smoke (multiply) | PASS |
| Keyframes: add/move/delete/easing on any prop | vitest + suite:p3_graph_test | PASS |
| Stopwatch semantics (arm, upsert at playhead) | vitest (toggleKeyframe) | PASS |
| Bezier handles + graph editor (drag kf, drag handle, marquee) | suite:p3_graph_test (real pointer drags) | PASS |
| Property rows (scrub-drag, reset, ease slot) | suite:rel_ui_test (real pointer gesture = ONE undo step) | PASS |
| Rust↔TS resolution parity | suite:f1_parity_test (68 samples, tol 2e-3) | PASS |

## 6. Effects

| Feature | Evidence | Verdict |
|---|---|---|
| Stack: add/remove/reorder/toggle/duplicate/same-type-twice | suite:p2_fx_test + vitest | PASS |
| Order genuinely changes output | cargo/spike (PNG pair asserted different) | PASS |
| Chroma key | spike PNG + suite:smoke scene | PASS |
| Grade | suite:p2_migration_test + spike | PASS |
| Blur/sharpen | spike + suite:f1_parity_test (kf blur) | PASS |
| Mask (rect/ellipse, feather, invert) | spike + suite:f1_parity_test | PASS |
| Vignette | spike | PASS |
| Wheels (lift/gamma/gain pads) | suite:p5_color_test | PASS |
| Curves (per-channel, Catmull-Rom bake) | suite:p5_color_test + cargo (bake pin) | PASS |
| 3D LUT (.cube) | cargo (strip layout) + spike (invert.cube PNG) — no e2e (no webview fixture-write path, logged) | PASS |
| Presets (save/apply fresh ids) | vitest + suite:p2_fx_test | PASS |
| Copy/paste attributes | vitest | PASS |
| Adjustment layers | spike PNG pair + suite scene | PASS |
| Legacy-bundle migration | suite:p2_migration_test (real pre-change bundle from disk) | PASS |

## 7. Text & graphics

| Feature | Evidence | Verdict |
|---|---|---|
| Text clips (compositor-rendered, DOM parity) | suite:p4_text_test | PASS |
| Fonts built-in | suite:p4_text_test | PASS |
| Font import (bundle-embedded, cross-machine) | suite:rel_project_test (real Arial.ttf, back after reload) | PASS |
| Styling: spacing/line-height/shadow/gradient/stroke/background | suite:f8_test (raster padding/widening) | PASS |
| Animation presets (fade/fadeUp/popIn/slideLeft) | suite:p4_text_test (mid-flight capture pin) | PASS |
| Shapes (rect/ellipse/line) | suite:p7_test | PASS |
| Title templates (lower third / centered / caption bar) | suite:f8_test | PASS |
| Color matte | suite:p1_mixer_test | PASS |

## 8. Audio

| Feature | Evidence | Verdict |
|---|---|---|
| Waveforms (peak envelope + RMS) | vitest (columnReduce) + visual | PASS |
| Detach audio (link, volume-kf handover) | vitest | PASS |
| Volume, fades (in/out sugar) | suite:p7_test | PASS |
| Pan (preview + export matrix) | suite:f3_audio_test + cargo (graph pin) | PASS |
| Ducking (envelope windows) | suite:p7_test | PASS |
| Normalize peak / LUFS −14 | suite:f3_audio_test / suite:p6_audio_test (measured in export) | PASS |
| Meters (dBFS zones, peak hold, clip lamp) | suite:f3_audio_test | PASS |
| Mixer (faders>1 audible, per-track bus, master) | suite:p1_mixer_test | PASS |
| Master volume (persist + export parity) | suite:p1_mixer_test (volumedetect Δ14dB) | PASS |
| EQ / compressor / gate / de-esser | suite:p6_audio_test (each measured in exported file) | PASS |
| Track effects (engine + export) | suite:p6_audio_test — **no mixer UI, store is the front door (logged limitation)** | PASS / LIMITATION (no mixer UI) |

## 9. Transitions

| Feature | Evidence | Verdict |
|---|---|---|
| Core four (dissolve/fade/slide/wipe) live | suite:smoke scene + session pins | PASS |
| Full 16 library renders | spike pins (push, iris, dissolve, wipe) + suite:rel_ui_test (zoom live across a cut) | PASS |
| Per-transition settings (easing, softness) | inspect — params ride the same Transition object the probes set | PASS (inspect) |

## 10. Playback

| Feature | Evidence | Verdict |
|---|---|---|
| Play/pause/scrub (compositor clock authority) | suite:smoke (fps>5 while playing) | PASS |
| Frame step / J-K-L shuttle / reverse | suite:rel_ui_test (real keydowns) | PASS |
| Audio scrub | inspect — scrubbing flag path unchanged since f2 | PASS (inspect) |
| Proxy vs original toggle | suite:f5_proxy_test | PASS |
| Draft vs Full preview | suite:rel_ui_test (menu path) | PASS |
| End-of-timeline / occlusion repaint (the session-7 bug) | suite:smoke + keepalive path | PASS |

## 11. Export

| Feature | Evidence | Verdict |
|---|---|---|
| H.264 (range, audio, chapters) | suite:f6_export_test + suite:p5_export_test | PASS |
| HEVC | suite:f6_export_test | PASS |
| ProRes | suite:rel_export_test (probed 3.00s .mov) | PASS |
| GIF | suite:f6_export_test | PASS |
| PNG sequence | suite:rel_export_test (frames 1 and 60 probed) | PASS |
| M4A audio-only | suite:f6_export_test | PASS |
| Range via in/out marks | suite:f6_export_test (3.00s pin) | PASS |
| Presets (one-click chips) | inspect — chips set the same setExportSettings the probes drive | PASS (inspect) |
| Chapters embed + YouTube copy | suite:p8_org_test | PASS |
| Progress / cancel (partial removed) | suite:p5_cancel_test | PASS |
| Background export + queue | suite:rel_export_test (export:queued observed, both complete) | PASS |
| Export == preview (same compositor) | suite:p5_export_test (frame extraction) + suite:r1p5_flagship_test | PASS |

## 12. AI

| Feature | Evidence | Verdict |
|---|---|---|
| Key storage (keychain, Rust-only, webview booleans) | suite:r1p2_keys_test (asserts nothing key-shaped in state) | PASS |
| Provider selection + models + test connection | suite:r1p2_keys_test + suite:rel_project_test / rel_ui_test (new tonight) | PASS |
| Chat turn (stream, tools, one undo step) | suite:r1p3_tools_test | PASS |
| All 18 tools + set_layout + generate_video | suite:r1p3/r1p5/r1p6 + vitest | PASS |
| Streaming UI, diff cards, honest per-turn undo | suite:r1p4_chat_test | PASS |
| history.jsonl persist + replay | suite:r1p4_chat_test | PASS |
| THE FLAGSHIP (typed prompt → 30 kf → export-verified) | suite:r1p5_flagship_test | PASS |
| Video generation lifecycle (submit/poll/import/place) | suite:r1p6_gen_test (mock backend, full plumbing) | PASS |
| Real-provider paths (Anthropic/OpenAI/Seedance/Veo) | inspect — built against live docs 2026-07-18; **no API key exists on this machine, so real-network turns are unverified (documented limitation)** | LIMITATION |
| Onboarding toast + empty states + sample project | suite:r1p7_ready_test | PASS |

## 13. Chrome & shell

| Feature | Evidence | Verdict |
|---|---|---|
| Native menu bar (both-ways check sync) | suite (menu-driven dev cases use the real handler) | PASS |
| Shortcut sheet (⌘/) | suite:f7_test | PASS |
| Popovers/context menus (viewport collision) | suite:f0_popover_test + suite:f0_ctx_test | PASS |
| Toasts (info/progress/action) | suite:r1p6_gen_test (action toast) | PASS |
| Icon rail panels (media/effects/chat/mixer) | suite:r1p4 + suite:p1_mixer | PASS |
| Scopes (read actual output) | suite:p5_color_test | PASS |
| Guides + safe zones overlay | suite:rel_ui_test + visual baseline | PASS |
| Undo/redo (transactions, gesture coalescing) | vitest + suite:r1p3_tools_test | PASS |
| Window min-size / panel clamps | inspect — unchanged since session 6 native break-test | PASS (inspect) |
| Visual regression (editor + sheet) | suite:visual (SSIM) | PASS |

---

## Manual probe results

The gaps the suite didn't cover got three NEW permanent e2e tests tonight
(registered in `scripts/e2e.sh`, so this coverage doesn't rot):

- **rel_export_test** — `prores=true/3.00s png=true f1=true f60=true
  queued=true dones=2 ok=true q2dur=10.00`. ProRes 422 probed at exactly
  3.00s; PNG sequence frames 00001 and 00060 both probe as real images; a
  second export submitted mid-run emitted `export:queued`, both completed,
  and the queued file probes at the full 10.00s.
- **rel_ui_test** — `L=true K=true J=true space=true step=true tc=true
  zoom=true snap=true full=true guides=true trans=true scrub=true/true
  reset=true`. J/K/L shuttle (including reverse), space toggle, arrow
  frame-step exact to 1/fps, timecode typed into the real transport counter,
  menu-path zoom/snap/full-preview toggles, guides overlay, a library
  transition (zoom) rendering live across a cut at >5 fps, and the
  property-row scrub gesture landing as exactly ONE undo step + reset.
- **rel_project_test** — `saved=true launcher=true reopen=true/true
  font=true dlg=true fps=true relink=true->true srcmon=true range=true`.
  Save → close → Open Recent through the real menu path with clip count
  intact; Arial.ttf imported via the real `import_font` command, embedded in
  the bundle, and back after a full close/reopen; project settings dialog
  opens via the menu and fps is editable after creation; a missing asset
  relinked (re-probe path); source monitor opens with a working I/O range.

## Failures found

1. **Visual-regression layer: scale-dependent captures (test infra, FIXED).**
   The cold suite failed both visual screens with `ssim n/a`: WKWebView
   snapshots follow the display's backing scale, and with the display
   asleep (the state of every unattended overnight run) captures came out
   1280×800 against 2560×1600 Retina baselines — ffmpeg SSIM emits nothing
   on mismatched dimensions. Content was verified identical (0.991/0.989
   after normalization). Fix: `scripts/visual.sh` now scales the baseline
   onto the candidate's pixel grid (`scale2ref`) before SSIM, so the layer
   tests pixel content, not tonight's DPI. The app was never broken.

**No feature failures.** Every category above passed through the running
suite or tonight's new probes. The honest gaps that remain are labeled
inline: real-provider network calls are unverified on this machine (no API
key exists here — the mock provider carries those code paths), track audio
effects have no mixer UI (store/AI is the front door), and native-dialog
endpoints (Save As picker, unsaved-changes prompt, relink picker) are
inspect-only because no automated run may touch a native modal.
