# Motionaire — Technical Spec

**Positioning:** AI-native editor for screen recordings + talking-head content.
**Platform:** Desktop (Tauri v2). **License:** AGPL, copyright retained. **Model:** Open-core.
**AI/transcription:** Claude API (tool-use) + Whisper API. **v1 goal:** functional first, monetization later.

---

## 0. The one principle everything hangs off

> **The AI edits the timeline, not the pixels.**

The project is a JSON document. The UI mutates it. The AI mutates it *through the same API the UI uses*. A dumb, deterministic renderer turns it into frames.

```
prompt → LLM → tool calls → project JSON → compositor → preview + export
```

**Consequences (this is why it works):**
- AI can't hallucinate corrupt frames — it never produces frames.
- Every AI edit is a JSON patch → free undo, free diffing, free testing.
- AI edits are instant (no re-render to see them).
- AI edits appear on the timeline as normal, hand-editable clips/keyframes.

**Design rule: no second-class AI.** Every UI action maps to a tool call. If the UI can do it, the AI can do it, and vice versa. That is what "fully AI-assisted" actually means architecturally.

---

## 1. Document model

### 1.1 Project

```json
{
  "version": 1,
  "canvas": { "width": 1920, "height": 1080, "fps": 30, "background": "#000000" },
  "duration": 60.0,
  "media": [
    {
      "id": "m_cam",
      "path": "/abs/webcam.mp4",
      "kind": "video",
      "duration": 62.4,
      "width": 1280, "height": 720, "fps": 30,
      "hasAudio": true,
      "proxyPath": "/cache/m_cam_720p.mp4"
    }
  ],
  "tracks": [
    { "id": "t_screen", "kind": "video", "z": 0, "clips": [] },
    { "id": "t_cam",    "kind": "video", "z": 1, "clips": [] },
    { "id": "t_text",   "kind": "video", "z": 2, "clips": [] },
    { "id": "t_audio",  "kind": "audio", "z": 0, "clips": [] }
  ],
  "transcript": { "words": [] }
}
```

`z` = compositing order. Higher = drawn on top. Text tracks sit above video.

### 1.2 Clip

```json
{
  "id": "c_cam_1",
  "kind": "video",
  "mediaId": "m_cam",
  "start": 0.0,          // position on timeline (s)
  "in": 0.0,             // source in-point (s)
  "out": 60.0,           // source out-point (s)
  "speed": 1.0,
  "volume": 1.0,
  "transform": {
    "x": 0, "y": 0,          // offset from canvas center, px
    "scale": 1.0,
    "rotation": 0,
    "opacity": 1.0,
    "cornerRadius": 0,
    "crop": { "l": 0, "t": 0, "r": 0, "b": 0 },
    "shadow": null           // { blur, spread, color, x, y }
  },
  "keyframes": [
    { "prop": "transform.scale", "t": 0.0, "v": 1.0,  "ease": "easeInOut" },
    { "prop": "transform.scale", "t": 1.2, "v": 0.10, "ease": "easeInOut" }
  ],
  "transitions": { "in": null, "out": null },
  "effects": []
}
```

**Keyframe time is clip-relative in storage, timeline-absolute in the AI/UI API.**
The engine converts. Rationale: clip-relative survives moving a clip (keyframes travel with it, as they should); absolute is what a human or an LLM naturally says ("at 0:10"). Doing one without the other bites you — do both.

Keyframe resolution for any property at time `t`: find bracketing keyframes, interpolate with the easing of the *left* keyframe. No keyframes → static `transform` value.

Easings: `linear | easeIn | easeOut | easeInOut | spring`. `easeInOut` is the default and covers ~90% of prompts.

### 1.3 Text clip

Text is a clip with no `mediaId`. **It reuses the same transform + keyframe system**, so text gets scale/position/opacity animation for free from the existing engine. Don't build a second animation path for text.

```json
{
  "id": "c_txt_1",
  "kind": "text",
  "start": 5.0,
  "duration": 3.0,
  "text": {
    "content": "Hello world",
    "font": "Inter", "size": 64, "weight": 700,
    "color": "#FFFFFF", "align": "center",
    "stroke": { "color": "#000000", "width": 3 },
    "background": null,        // { color, padding, radius }
    "maxWidth": 1200
  },
  "transform": { "...": "same as video" },
  "keyframes": [],
  "animation": { "in": "fadeUp", "out": "fade", "duration": 0.3 }
}
```

`animation` is sugar that expands into keyframes on load. Presets: `fade | fadeUp | popIn | slideLeft | typewriter | none`.

**Captions are just text clips** auto-generated from the transcript, one per phrase, on a dedicated `t_captions` track. Same primitive → styling, animation, and manual fixes all work with zero extra code.

### 1.4 Transcript

```json
{ "words": [ { "w": "hello", "start": 1.02, "end": 1.31, "conf": 0.98, "clipId": "c_cam_1" } ] }
```

Word-level timestamps are **mandatory** — they're what make transcript editing, silence/filler removal, captions, and semantic time references ("when I say X") all possible. Whisper gives you these; don't lose them.

---

## 2. AI layer

### 2.1 Context given to the model

- Compact timeline summary (tracks, clips, ranges, current transforms — not the full JSON once projects get big)
- Transcript with timestamps
- Canvas/preset info
- Current playhead + selection (so "here" and "this clip" resolve)

### 2.2 Tools (the mutation API)

**Structure**
- `split_clip(clipId, at)`
- `trim_clip(clipId, in, out)`
- `move_clip(clipId, start, trackId?)`
- `delete_range(trackId, start, end, ripple: bool)`
- `duplicate_clip(clipId)`

**Properties + animation**
- `set_property(clipId, prop, value)`
- `add_keyframe(clipId, prop, t, value, ease)`
- `animate(clipId, prop, from, to, start, duration, ease)` ← sugar; emits 2 keyframes
- `clear_keyframes(clipId, prop, range?)`

**Layout macros ← the high-leverage abstraction**
- `set_layout(layout, at, duration, ease, params)`

  Layouts: `fullscreen(track) | pip(track, corner, scale, radius, margin) | side_by_side | top_bottom | grid | hidden(track)`

  One call emits coordinated keyframes across *all* affected tracks.

**Text**
- `add_text(content, start, duration, style, position, animation)`
- `edit_text(clipId, content?, style?)`
- `add_captions(style, track, mode: "word" | "phrase")`

**Transcript-driven**
- `remove_silences(threshold_db, min_duration, padding)`
- `remove_filler_words(words: ["um","uh","like"])`
- `cut_text_range(wordStartIdx, wordEndIdx)` — deleting transcript text deletes video
- `find_in_transcript(query) -> [{start, end}]` — powers "the part where I say X"

**Canvas**
- `set_canvas(preset)` — `tiktok_9x16 | youtube_16x9 | square_1x1 | portrait_4x5 | custom(w,h)`
- `auto_reframe(track, subject: "face" | "center")`

**Transitions**
- `add_transition(clipId, edge: "in"|"out", type, duration)`

### 2.3 The worked example

> *"From 0:10 to 0:45 shrink my face to 10%, rounded corners, bottom right, screen share fills the rest, then back."*

```
set_layout(layout="pip", track="t_cam", corner="bottom_right",
           scale=0.10, radius=12, margin=32,
           at=10.0, duration=1.2, ease="easeInOut")

set_layout(layout="fullscreen", track="t_cam",
           at=45.0, duration=1.2, ease="easeInOut")
```

Two calls. The macro expands to keyframes on `transform.scale`, `transform.x`, `transform.y`, `transform.cornerRadius` for `t_cam`, and brings `t_screen` to full-frame underneath. Reversal at 45.0 is the same macro with the original layout.

### 2.4 Execution rules

1. **One prompt = one undo step.** Wrap all tool calls from a single turn in one transaction. Non-negotiable for trust.
2. **Auto-apply, then show a diff in chat** ("Added 4 keyframes to Webcam, 0:10–0:11.2"). Faster and more magical than an approve/reject gate, and undo makes it safe.
3. Every tool returns `{ ok, diff, warnings }` so the model can self-correct.
4. Validate on write: clamp times to media bounds, reject overlapping keyframes at identical `t`, snap to frame boundaries.
5. **Frame-snap everything.** All times quantize to `round(t * fps) / fps`. Prevents an entire class of off-by-one-frame bugs.

---

## 3. Render pipeline

### 3.1 The rule that saves you weeks

> **Preview and export share the exact same compositor.**

Literally the same drawing function — same transform math, same color handling — just called two different ways: live during playback, and once per frame during export. If you write two compositors they *will* diverge, and "the export doesn't look like the preview" is a bug you will never fully kill.

### 3.2 Preview (real-time)

Runs entirely inside the webview — no FFmpeg involved in preview at all.

```
one hidden <video> element per active clip, seeked to its current source time
requestAnimationFrame loop:
    for each visible clip, back-to-front by z:
        ctx.save()
        apply transform (translate, rotate, scale)
        ctx.roundRect(...); ctx.clip()      // rounded corners — native Canvas2D
        ctx.shadowBlur / shadowColor         // drop shadow — native
        ctx.drawImage(videoElement, ...)     // current decoded frame
        ctx.restore()
    → canvas presents
Audio: Web Audio API graph (gain node per clip); preview clock slaved to audio.
```

- Browser's own video decoder does the decoding — hardware-accelerated, zero custom code.
- **Proxies:** on import, transcode to 720p proxies (one FFmpeg pass) for scrubbing; touch originals only on export. This is what makes 4K screen recordings feel smooth. Skip it and hobby editors feel broken.
- **Seeking:** set `video.currentTime`, wait for the `seeked` event before drawing.

### 3.3 Export (offline)

Same draw function as preview — just driven frame-by-frame instead of by playback:

```
for n in 0..totalFrames:
    t = n / fps
    seek every active video element to its source time for t, await `seeked`
    composite(t) onto canvas          // identical function to preview
    read the canvas (toBlob / pixel readback)
    → pipe raw frame to FFmpeg stdin
FFmpeg encodes with hwaccel:
    NVENC (Windows/Linux NVIDIA) | VideoToolbox (macOS) | QSV (Intel) | x264 (fallback)
Audio mixed separately (offline audio context), muxed at the end.
```

Slower than real-time (per-frame seeking has overhead) but deterministic — no dropped frames, no sync drift. Fine for an MVP; optimize later if export speed matters.

### 3.4 Stack

| Layer | Choice | Why |
|---|---|---|
| Shell | Tauri v2 | small footprint, embeds a real webview |
| UI + compositor | React + TypeScript + Canvas2D | **reuses your existing stack almost entirely** — no shaders, no GPU API to learn |
| Video decode (preview) | native `<video>` elements | browser's built-in decoder, hardware accelerated, free |
| Encode / normalize | FFmpeg CLI, run as a subprocess | called directly from Tauri's Rust side — a few lines, not systems programming |
| Transcription | whisper.cpp CLI (local) or Whisper API to start | same subprocess pattern as FFmpeg |
| AI | Claude API, tool use | drives the same tool layer the UI uses |
| Native Rust code | thin glue only (Tauri's own scaffolding) | you are not writing a GPU compositor in it |
| State | Project JSON, held in the frontend (Zustand or similar) | undo = snapshot stack; Rust layer only handles file I/O |

**Changed from the first draft:** originally specced Rust + wgpu for compositing. Correcting that — Canvas2D in the webview covers every transform/corner-radius/shadow need on this list, using tech you already know. wgpu is a real upgrade path later (custom shader effects, faster export) but isn't needed to ship, and it would've meant learning Rust graphics work and this whole project at the same time.

---

## 4. Feature list

### Table stakes
- Media bin; import video/audio/image
- Multi-track timeline: drag, trim, split/razor, ripple delete, snapping, zoom, scrub
- Clip properties: position, scale, rotation, opacity, crop, corner radius, shadow, speed, volume
- **Keyframes + easing on any property** ← load-bearing; most "AI magic" is just this
- Playback: play/pause, frame-step, J/K/L, in/out points
- Audio: waveforms, gain, fades, detach audio
- Text/titles + basic shapes
- Transitions: cut, dissolve, fade, slide, wipe
- Undo/redo
- Save/load project, autosave, crash recovery
- Export: resolution, codec, bitrate, fps, hardware encode

### Yours
- Platform presets: 9:16 TikTok/Reels, 16:9 YouTube, 1:1, 4:5, custom — canvas size + safe-zone guides
- Auto-reframe (keep face/subject in frame when cropping to vertical)
- Whisper transcript, word-level
- **Transcript editing** — delete the words, the video cuts
- **Silence removal + filler-word removal** ← for screen recordings this is the single highest-value feature; nearly free once you have word timestamps
- Auto-captions (styled, burned in, karaoke/word-highlight mode)
- Screen-recording specials: cursor smoothing, click zoom, auto-zoom to activity
- AI chat over all of the above

---

## 5. Build order (risky-first)

1. **SPIKE — do this before anything else.** Decode two videos, composite them with a keyframed scale/position/corner-radius, play back at 60fps. *This is the make-or-break. If it doesn't work, nothing else matters.* Time-box it.
2. Project JSON schema + FFmpeg export path. **No UI** — render to file, watch it. Proves the model and WYSIWYG.
3. Real-time preview + timeline UI.
4. Transcript (whisper.cpp) → transcript editing → silence/filler removal.
5. Text + captions.
6. AI chat + tool layer + layout macros. ← *the easiest part, deliberately last*
7. Presets, auto-reframe, transitions, polish.

The AI chat feels like the hard part. It isn't — it's tool calls against a JSON doc, roughly a weekend once the model exists. **The preview engine is where solo video editors die.** Sequence accordingly.

---

## 6. Known traps

- **VFR footage.** Screen recorders (OBS, QuickTime, Loom) very often output *variable* frame rate. It desyncs audio and breaks frame math. **Normalize to CFR on import** (`ffmpeg -vsync cfr`). This bites screen-recording editors specifically, and it will bite you.
- **A/V sync drift** on long timelines — always slave the video clock to the audio clock, never the reverse.
- **Color/gamma mismatch** between preview and export — pin one color pipeline (BT.709, no implicit conversions) and use it in both.
- **FFmpeg licensing:** GPL vs LGPL builds matter for distribution. AGPL app + GPL FFmpeg is coherent; check before shipping binaries.
- **Frame-accurate seeking** on long-GOP codecs is slow — proxies fix this too.
- **Undo granularity** — snapshotting the whole JSON is fine early (projects are small); move to patches only if it gets slow.

---

## 7. Open-core seam

Draw the line **now**, in the code, even if monetization is switched on later.

| Free (open source) | Paid |
|---|---|
| Entire editor, timeline, keyframes, text | Managed AI (no API key needed) |
| Local whisper.cpp transcription | Cloud transcription (faster, no local GPU) |
| Local render/export | Cloud render |
| **BYOK** — bring your own Anthropic/OpenAI key | Project sync + backup |
| All platform presets | Premium transition/effect/caption packs |
|  | One-click publish to TikTok/YouTube/IG |

Free users cost you ~nothing (their machine does the compute) — that's the desktop advantage compounding, and it makes a genuinely generous free tier sustainable.

**Implementation:** put the AI provider behind a Rust trait (`AiProvider`) with `LocalKeyProvider` and `ManagedProvider` implementations. Flipping monetization on becomes a config change, not a rewrite.

---

## 8. Storage & data architecture

**No cloud database for v1.** This is a desktop app — the project *is* a file, the same way Premiere/Final Cut/Resolve projects are files, not database rows. Two local pieces only.

### 8.1 Project bundle (per project, on disk)

```
MyClip.motionaire/
├── project.json      ← timeline: tracks, clips, keyframes (schema in §1)
├── transcript.json    ← word-level Whisper output
├── history.jsonl      ← append-only log: one AI prompt + tool calls + diff per line
└── cache/              ← thumbnails, waveforms, proxy media — regenerable, gitignore-able
```

- **Media stays where it is.** Reference source files by path; never copy into the bundle by default. Add an explicit "consolidate media" action later for portability.
- **history.jsonl doubles as your AI chat UI's data source** — append one line per turn, read sequentially to render history. No query engine needed for a log you only ever replay in order.
- **Crash-safe writes:** write to a temp file, then atomic-rename over `project.json`. Cheap insurance against corrupting a project mid-save.
- Undo/redo is a JSON-snapshot stack in memory (per §1); it doesn't need to touch disk until autosave fires.

### 8.2 App-level SQLite (one file, not per-project)

Standard desktop-app pattern (same thing VS Code, Chrome, etc. use for local structured state):

| Table | Purpose |
|---|---|
| `recent_projects` | path, name, last_opened_at, thumbnail — powers the "recent projects" screen |
| `settings` | key-value: theme, default export preset, UI prefs |
| `transcript_cache` | keyed by media file hash → cached Whisper JSON, so reopening/re-referencing the same footage doesn't re-pay for transcription |

**API keys never go here.** Use the OS keychain (macOS Keychain, via Tauri's secure storage / the `keyring` crate) — never plaintext in SQLite, never in the project JSON.

### 8.3 Where cloud comes in later (not now)

Only relevant once the paid "project sync" tier (§7) gets built: Postgres/Supabase for account + manifest data, object storage for compressed proxies. Even then, sync the JSON + proxies — not raw source footage. Nothing here needs building for a functional v1.