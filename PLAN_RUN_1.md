# Motionaire — PLAN RUN 1

**Objective:** get Motionaire to a **demoable AI video editor** — clean monochrome UI, a working AI chat that edits the timeline from plain English, user-supplied API keys, and AI video generation plugged into the timeline.

**The demo is the goal.** Every phase either makes the app look like a premium product or makes the AI story real. Anything that serves neither is out of scope tonight.

**Read DECISIONS.md first and work from actual state.** Twelve sessions of decisions are in there. Respect them.

---

## What already exists (do not rebuild)

Motionaire is already a professional, fully test-gated editor:

- Rust + wgpu multi-pass compositor, FFmpeg decode, proxies (720p preview / originals on export)
- Effect **stack** (ordered, reorderable, toggleable, per-instance keyframes)
- Keyframe graph editor with real bezier handles
- Trim tools: ripple / roll / slip / slide, track targeting, sync lock
- Scopes (luma waveform, RGB parade, vectorscope, histogram), color wheels, curves, 3D LUT
- Pro audio: parametric EQ, compressor, gate, de-esser, LUFS normalize — all verified in the exported file
- 16 transitions, track mattes, motion blur, auto-reframe, guides
- Real FFmpeg export: H.264 / HEVC / ProRes / GIF / PNG sequence / M4A, range, presets, chapters
- Project bundles, autosave, recovery, media bin, compound clips, license activation
- **Test suite: 92 frontend unit + 27 cargo + 28 e2e + visual regression — `npm test` runs everything**

**The suite is the contract. It must be green at the end of every phase.**

---

## Part 1 — Design direction: monochrome

The current theme is Adobe-style charcoal with a blue accent. The new direction is **black, white, and grey** — monochrome, cleaner, less "Adobe clone," more like a modern premium tool.

**One technical constraint, stated once:** panel surfaces stay *near*-black rather than pure `#000`. In a video editor, pure-black chrome makes true black **inside the video frame** indistinguishable from the UI around it — you lose the frame edge and can't judge shadow detail. Near-black gives the same visual impression with none of that cost. The video frame's own letterboxing can be pure black.

### Token set

Replace the existing palette wholesale. No aliases, no leftovers.

```css
/* Surfaces — near-black to grey */
--bg-app:            #0a0a0a;   /* window chrome, deepest */
--bg-panel:          #121212;   /* panel backgrounds */
--bg-panel-alt:      #171717;   /* nested / alternating */
--bg-elevated:       #1f1f1f;   /* dropdowns, popovers, dialogs */
--bg-control:        #262626;   /* inputs, buttons at rest */
--bg-control-hover:  #333333;
--bg-control-active: #404040;

/* Seams — darker than the panel they divide */
--border-seam:       #000000;
--border-default:    #262626;
--border-strong:     #404040;

/* Text — white through grey */
--text-primary:      #fafafa;
--text-secondary:    #a3a3a3;
--text-tertiary:     #737373;
--text-disabled:     #525252;

/* Accent — monochrome. Selection and focus are WHITE, not blue. */
--accent:            #fafafa;
--accent-muted:      rgba(250,250,250,0.12);
--accent-border:     rgba(250,250,250,0.30);
--focus-ring:        rgba(250,250,250,0.55);

/* Clip / track types — greyscale steps, distinguished by VALUE not hue */
--clip-video:        #2e2e2e;
--clip-audio:        #242424;
--clip-text:         #383838;
--clip-image:        #303030;
--clip-adjust:       #1c1c1c;
--clip-selected-border: #fafafa;

/* Video frame */
--frame-letterbox:   #000000;   /* pure black is correct HERE */

/* Status — the ONLY places color survives, because meaning depends on it */
--danger:            #ef4444;
--warning:           #eab308;
--success:           #22c55e;
--playhead:          #ef4444;
--meter-green:       #22c55e;   /* audio meters must stay color-coded */
--meter-yellow:      #eab308;
--meter-red:         #ef4444;
```

**Rule:** every color in the app comes from a token. No hardcoded hex in components. Where a new value is needed, add a token.

**Where color survives, and why:** audio meter zones, the playhead, and error/warning/success states. These carry *meaning* through color — making them grey would remove information, not add polish. Everything else goes monochrome.

---

## Phase 0 — Monochrome design system

Everything downstream inherits this, so it goes first and it goes fast.

1. Replace the token set with the above.
2. Audit **every** component for hardcoded colors — route all of them through tokens.
3. Replace blue selection/focus/active states with the white accent throughout: selected clips, focused inputs, active tool chips, toggle states, dropdown highlights, tab indicators.
4. Apply the darker-seam rule to every panel boundary.
5. Verify contrast is genuinely readable — secondary and tertiary text on panel backgrounds is where monochrome palettes usually fail.
6. Take a native capture of every major screen before and after.
7. Refresh the visual-regression baselines — but only after confirming each diff is your intentional retheme.

---

## Phase 1 — UI layout overhaul

Reference screenshots are in `design-reference/`. **View them directly before starting.**

**Copy the LOOK, not the FEATURES.** The reference shows things that are features, not styling. Do NOT build: user accounts / avatar (Motionaire uses license-key activation by design), "smart search," or multiple timeline tabs (Motionaire has compound clips instead).

### 1a. Properties panel — tabbed

Currently one long stacked scroll. Restructure into three tabs:

- **Video** — transform, crop, flip, blend, corner radius, shadow, playback speed
- **Adjust** — color grading, wheels, curves, LUT, the full effect stack
- **Audio** — volume, pan, fades, audio effect chain

Keep **everything** that exists. If something has no obvious home, place it sensibly and log where.

### 1b. Property row primitive

One component every numeric property uses:

```
[ Label ]              [ value input ]  [ ‹ ◆ › ]  [ ↺ ]
```

- Label left, muted
- Value in a rounded input, right-aligned, drag-to-scrub on the label
- Keyframe prev / toggle / next
- Reset to default
- Columns align across every row in the panel
- Section headers get a keyframes toggle and a section-level reset

### 1c. Timeline clips

- **Persistent filmstrip thumbnails inside video clip blocks.** The hover-scrub strip cache already exists — render it inline at all times, not only on hover. Never decode live.
- Waveform inside audio blocks — compare density and contrast against the reference and tune.
- **Clip header strip** at the top of each block: filename + duration, slightly lighter than the body.
- Rounded corners, subtle border, white border when selected.
- Effect badge stays, restyled monochrome.

### 1d. Track headers — compact

Drag handle, short name (V1 / A1), link icon, eye or speaker toggle, lock. Icon-first, minimal, matching the reference's density. Everything currently there stays — it just gets tighter.

### 1e. Timeline toolbar

Undo / redo, then a tight tool group (select, razor, split, mark in, mark out, text) left-aligned. Zoom control right-aligned. Lower-frequency items into the existing overflow menu.

### 1f. Left panel and icon rail

- A thin vertical icon rail on the far-left edge for switching panels: media, effects, **AI chat**, audio mixer.
- Library grid: thumbnails with a duration badge overlaid, name beneath, item count in the header.
- Grid/list toggle, sort, filter in the panel header.

### 1g. Transport bar

Current timecode / total duration left-aligned in monospace. Transport buttons centered. Snapshot and fit controls right-aligned.

### 1h. Reserve the AI chat panel slot

Design and build the panel **container** now — a right-side or left-rail-toggled panel sized for conversation, with header, scrollable message area, and composer at the bottom. It can be empty this phase. Phase 4 fills it. Doing this now means the chat UI isn't restyled twice.

### 1i. Global density pass

Consistent spacing scale, control heights, border radii, and hover / active / focus / disabled states on everything interactive.

---

## Phase 2 — API keys and provider settings

### 2a. Key storage — architecture first

**Keys live in the OS keychain and are read only by Rust. They never enter the webview.** All provider API calls are made from Rust; the frontend sends intent and receives streamed results. This is the same rule the license key already follows, and it means a compromised webview never sees a key.

### 2b. Settings UI

Extend the existing Preferences panel with an **AI** section:

- **Chat provider:** Anthropic (Claude) or OpenAI — radio/segmented selection
- **API key field** per provider, masked, with a "Test connection" action that makes a minimal real call and reports success or the actual error
- **Model selection** per provider, with a sensible default
- **Video generation provider:** Seedance, Google (Gemini/Veo), or none — with its own key field and test action
- Clear "not configured" states everywhere a key is missing, with a direct link into this panel

### 2c. Error states

Every failure path visible through the existing toast system, with the *real* error surfaced: invalid key, rate limited, no network, insufficient quota, model not available. Never fail silently, never show a generic "something went wrong."

---

## Phase 3 — AI provider abstraction and the tool layer

### 3a. Provider abstraction

A Rust trait — same seam pattern as `LicenseValidator`:

```
trait ChatProvider
  ├── AnthropicProvider  — Claude, tool use
  └── OpenAIProvider     — GPT, function calling
```

Normalize across them: message format, tool/function schemas (both are JSON Schema underneath), streaming deltas, tool-call results, and errors. The rest of the app talks to the trait and never knows which provider is behind it.

Stream responses to the frontend via Tauri events so the chat renders progressively.

**Check each provider's current API docs before implementing.** Do not assume request/response shapes from memory — read the live documentation, and log which API version you built against.

### 3b. The tool layer — context.md §2

**THE GOVERNING PRINCIPLE:**

> **THE AI EDITS THE TIMELINE, NOT THE PIXELS.**

The AI emits tool calls against the project document. The deterministic compositor turns that into frames. The AI never produces pixels and never generates video frames directly. This is why it cannot hallucinate corrupt output, why every edit is instantly undoable, and why edits appear immediately instead of after a render.

**NO SECOND-CLASS AI.** The AI mutates state through the **same store mutations the UI uses**. Locks, dirty-tracking, undo, and validation are all centrally enforced there — the AI inherits every one of them for free. Do **not** build a parallel mutation path.

**Context given to the model** (§2.1): a compact timeline summary (not raw JSON once projects grow), canvas info, current playhead, and current selection — so "here" and "this clip" resolve correctly.

**Tools** (§2.2, extended to what the editor can actually do now):

- *Structure:* split, trim, move, delete range, duplicate
- *Properties & animation:* set property, add keyframe, animate (from → to over a window), clear keyframes
- *Effects:* add effect, set effect param, remove, reorder, toggle
- *Text:* add text, edit text, style
- *Canvas:* set canvas preset, auto-reframe
- *Transitions:* add transition with type, duration, easing
- *Audio:* set volume, add fade, normalize
- *Layout macros:* see Phase 5

**Execution rules (§2.4) — all of them:**

1. **ONE PROMPT = ONE UNDO STEP.** Wrap every tool call from a single turn in one transaction. Non-negotiable — it is the entire trust model.
2. **Auto-apply, then show a diff in chat.** Undo makes that safe. An approve/reject gate makes it slow and kills the magic.
3. Every tool returns `{ ok, diff, warnings }` so the model can self-correct.
4. **Validate on write:** clamp to media bounds, reject invalid keyframes, refuse operations on locked tracks.
5. **FRAME-SNAP EVERYTHING:** `round(t * fps) / fps`. Kills an entire class of off-by-one-frame bugs.

---

## Phase 4 — Chat UI

Fill the panel slot built in Phase 1h.

- **Message list:** user and assistant turns, streaming assistant output rendered progressively.
- **Composer:** multiline input, send on ⌘↵, disabled with a clear reason when no key is configured.
- **Diff display:** after each edit, show plainly what changed — "Added 4 keyframes to Webcam, 0:10–0:11.2" — as a compact card, not raw JSON.
- **Tool-call visibility:** show which tools ran, collapsed by default, expandable for the curious.
- **Undo affordance:** an inline "undo this" on each assistant turn that performed edits, wired to the same single-transaction undo.
- **Persistence:** `history.jsonl` in the project bundle (§8.1) — append one line per turn, replay sequentially on load. No query engine needed for a log read in order.
- **Empty state:** a few concrete example prompts the user can click to run, showing what the AI can actually do. This is what makes the feature discoverable in a demo.
- **Error states:** rate limits, invalid keys, and refusals rendered as normal messages, not crashes.

---

## Phase 5 — Layout macros and the flagship demo

### 5a. Layout macros

`set_layout(layout, at, duration, easing, params)` — one call emits coordinated keyframes across every affected track:

- `fullscreen(track)`
- `pip(track, corner, scale, radius, margin)`
- `side_by_side`
- `top_bottom`
- `grid`
- `hidden(track)`

This is the abstraction that turns a paragraph of intent into two tool calls.

### 5b. THE FLAGSHIP DEMO

This is the demo the project exists for. It must work end to end, typed as plain English into the chat:

> *"From 0:10 to 0:45 shrink my face to 10%, rounded corners, bottom right, screen share fills the rest, then back to fullscreen."*

Load a webcam clip and a screen recording, type that, and it must produce the real keyframed edit — visible on the timeline, rendering live in the preview, and surviving an export to file.

**Capture this working.** It is the single most important piece of evidence in the project.

### 5c. A demo script

Write `DEMO.md`: five to eight prompts that reliably work, in an order that tells a story, with the footage setup required. This is what gets shown to anyone — it needs to be repeatable, not improvised.

---

## Phase 6 — AI video generation

Generate video from a text prompt inside the app and drop it straight onto the timeline.

### 6a. Provider abstraction

Same trait pattern:

```
trait VideoGenProvider
  ├── SeedanceProvider  — ByteDance Seedance
  └── GeminiProvider    — Google Gemini / Veo
```

**Read the current API documentation for both before implementing.** These are fast-moving APIs and the shapes may have changed. Log which API version you built against, and structure the code so a version bump is a small change.

### 6b. Generation flow

1. **Generate panel:** prompt text, duration, aspect ratio (defaulting to the project canvas), model/quality selection.
2. **Submit → job queue.** Generation takes minutes, not seconds — this is asynchronous by nature. Reuse the background-job pattern the proxy system already established.
3. **Progress** through the existing toast/progress system. The user keeps editing while it runs.
4. **On completion:** download the result, run it through the existing import pipeline (VFR normalization, proxy generation, thumbnail), and add it to the media bin flagged as AI-generated.
5. **Place on timeline** — one click from the completion toast or the bin.
6. **Failure:** surface the real error (content policy, quota, timeout) and keep the prompt so the user can retry or edit it.

### 6c. From the chat

The AI should be able to call generation as a tool — *"generate a 5-second clip of a sunrise over mountains and put it at the start"* should generate, import, and place it. This is the moment the two AI features compound into something neither does alone.

### 6d. Cost honesty

Video generation costs the user real money per call. Show an estimated cost or at minimum a clear "this will use your API credits" confirmation before submitting. Never fire an expensive call silently.

---

## Phase 7 — Demo readiness

1. **Onboarding for AI features** — a short first-run flow pointing at the API key settings, since nothing AI works without a key.
2. **Empty states everywhere** — chat with no key, chat with no clips, generation with no provider configured. Each says exactly what to do next.
3. **Sample project** — a bundled demo project with footage, so the app is impressive within ten seconds of opening rather than showing an empty timeline.
4. **Full polish pass** on everything the demo touches: the chat panel, generation panel, properties tabs, timeline clips.
5. **Final suite run.** Green, cold.
6. **Update README** — what the app is, screenshots, how to set up API keys, how to run the demo.

---

## Rules

**Autonomy**
- **Never stop to ask.** Every ambiguity: pick the standard, conventional choice, log it in DECISIONS.md, continue.
- If something in this plan conflicts with context.md or DECISIONS.md, follow the prior decision and log the conflict.

**Quality gate**
- **`npm test` must be green at the end of every phase.** Frontend unit, cargo, e2e, visual regression. A phase with a red suite is not a finished phase.
- When a test fails, determine honestly whether the bug is in the **feature** or the **test** — both have happened repeatedly in this project. Fix the correct one. Never weaken a test to force green.
- Visual baselines will change in Phases 0 and 1. Refresh them — but only after confirming each diff is intentional redesign and nothing functional broke.
- Add e2e coverage for every new surface: key storage, provider calls (mocked at the boundary), tool execution, chat persistence, generation job lifecycle.

**Engineering**
- **The AI edits the timeline, not the pixels.** Tool calls against the document, never direct frame manipulation.
- **No second-class AI** — the AI uses the same store mutations the UI does. No parallel mutation path.
- **One prompt = one undo step.** Always.
- **Frame-snap every time value.**
- **API keys: OS keychain, read by Rust only, never in the webview, never in plaintext, never in logs.**
- **No hardcoded colors.** Every color from a token.
- **Read current API docs** for Anthropic, OpenAI, Seedance, and Gemini before implementing against them. Do not assume shapes from memory. Log the API version you built against.
- Don't remove existing functionality. If something loses its place in a redesign, relocate it and log where.

**Process**
- **Break what you build.** Every session in this project has caught real bugs this way, and the best finds came from going beyond what was literally asked.
- Use the WKWebView native self-capture tooling as primary visual evidence. Before/after captures for Phases 0 and 1; a working capture of the flagship demo for Phase 5.
- **Commit incrementally per phase**, and per sub-item within the large ones.
- **Append to DECISIONS.md as you go**, not in a rush at the end.
- **If you run out of time:** finish the phase you're in, run the suite, log exactly where you stopped and what remains, stop cleanly. **Cut from the END, never the middle.**

---

## Out of scope

- Whisper / transcription and transcript-driven editing — the natural next step, but not tonight
- Object extraction / subject masking
- The web activation server (the app side already waits behind the `LicenseValidator` seam)
- Render cache (deferred with a design sketch in DECISIONS.md)
- Multicam, stabilization, nested sequences