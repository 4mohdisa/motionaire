# Motionaire — Release Plan (final)

**Objective:** close this project off properly. Verify every feature actually works, clean the code, make it safe to publish, build a downloadable app, write a real README, and push it public under one author.

**This is the last build session.** Nothing new gets added. Every phase either proves what exists works, removes what shouldn't be there, or gets it shipped.

**Read DECISIONS.md first and work from actual state.** Thirteen sessions are in there. Respect them.

**Repo:** `git@github.com:4mohdisa/motionaire.git` · **Author:** Mohammed Isa (sole contributor)

---

## What exists

A professional, test-gated macOS video editor with a working AI layer:

- Rust + wgpu multi-pass compositor, FFmpeg decode, proxies
- Effect stack, keyframe graph editor with bezier handles, ripple/roll/slip/slide trim tools
- Scopes, color wheels, curves, 3D LUT; pro audio (EQ, compressor, gate, de-esser, LUFS) verified in exported files
- 16 transitions, track mattes, motion blur, auto-reframe
- Real export: H.264 / HEVC / ProRes / GIF / PNG sequence / M4A, with range, presets, chapters
- Project bundles, autosave, recovery, media bin, compound clips
- **AI chat that edits the timeline from plain English** (18 tools, one prompt = one undo step)
- **AI video generation** (Seedance, Veo) importing straight to the timeline
- Suite: 95 frontend unit + 33 cargo + 38 e2e + visual regression

---

## Phase 0 — Exhaustive functional audit

**This is the heart of the session.** The suite covers what it covers; the question tonight is different: **does every single feature actually work, right now, with no errors?**

Build a complete feature inventory from context.md, DECISIONS.md, and the code itself — every user-facing capability across thirteen sessions. Then **exercise each one for real**, through the actual UI where possible, and record pass/fail. Not "is there a test for it" — *does it work*.

Cover at minimum:

**Project lifecycle** — activation, onboarding, launcher, new project, open, save, save as, autosave, recovery (bundle + untitled), recents, missing-bundle handling, project settings, consolidate media, preferences.

**Media** — import video/audio/image, VFR normalization, proxy generation, media bin (search, folders, relink, offline, remove), source monitor with in/out, drag to timeline.

**Timeline** — drag, trim, split, ripple delete, snap, zoom, marquee, group drag (horizontal + vertical), markers, in/out marks, insert vs overwrite, clip enable/disable, frame nudge, labels, timecode entry, track add/remove/reorder/rename, mute/solo/lock/hide, targeting, sync lock, compound clips (group, ungroup, trim).

**Trim tools** — ripple, roll, slip, slide. Each with exact semantics.

**Properties** — every transform, crop, shadow, corner radius, speed, opacity, blend. Keyframes on each: add, move, delete, easing, bezier handles, graph editor.

**Effects** — full stack behaviour (add, remove, reorder, toggle, duplicate, same type twice), every effect type (chroma key, grade, blur, mask, vignette, wheels, curves, LUT), presets, copy/paste attributes, adjustment layers.

**Text & graphics** — text clips, fonts (built-in + imported), styling (spacing, line height, shadow, gradient, stroke, background), animation presets, shapes, title templates, color matte.

**Audio** — waveforms, detach, volume, keyframes, fades, pan, ducking, normalize, LUFS, meters, mixer, master, EQ, compressor, gate, de-esser, track effects.

**Transitions** — all 16, plus per-transition settings.

**Playback** — play, pause, scrub, frame step, J/K/L, reverse, audio scrub, proxy vs original, Draft vs Full.

**Export** — every format, range, presets, chapters, progress, cancel, queue, background.

**AI** — key storage, provider selection, test connection, chat turn, each of the 18 tools, streaming, diff cards, undo, history persistence, `set_layout` macros, the flagship demo, video generation lifecycle.

**Deliverable:** `AUDIT.md` — every feature, pass/fail, and for each failure a short description of what's wrong.

---

## Phase 1 — Fix everything the audit found

Work `AUDIT.md` top to bottom. Fix real bugs. For anything that can't be fixed cleanly tonight, either **remove the feature** (a broken feature is worse than a missing one) or document the limitation honestly in the README's "known limitations."

**Add regression coverage for every bug you fix**, so the suite is stronger for it.

Suite green before moving on.

---

## Phase 2 — State management audit

Verify state is genuinely sound, not just working by luck:

- Every mutation goes through the store; no component holds authoritative state it shouldn't.
- Undo/redo covers every mutating action; nothing silently escapes history. Gestures coalesce into one entry.
- No stale-snapshot reads (the `re-getState after a store write` house rule) anywhere.
- No leaked listeners, timers, `AudioContext`s, or Rust threads on unmount, project close, or app quit.
- Rust↔TS sync is correct in both directions; the Rust resolver remains the sole authority for property resolution.
- Dirty tracking is accurate — no false clean, no false dirty.
- Loading, error, and empty states exist on every async surface.
- Project bundle round-trips exactly: save → quit → reopen → byte-identical state, with every feature intact (effects stack, keyframes, compounds, AI history).

---

## Phase 3 — Code cleanup

- **Remove dead code**: unused components, unreferenced modules, commented-out blocks, abandoned experiments, obsolete spike binaries not used by the suite.
- **Remove unused dependencies** — npm and cargo both. Verify with a real dependency check, then confirm the build and full suite still pass.
- **Gate dev-only code to debug builds**: the `window.__motionaire` handle, the dev remote / file-trigger system, `dev:*` test cases, `SPIKE_DEMO`, and any debug commands must be `#[cfg(debug_assertions)]` / dev-mode only. **None of it may exist in a release build.** Verify by building release and confirming the surfaces are gone.
- **Delete stale work orders and scratch files** from the repo root: completed plan documents, `/tmp` fixtures, generated captures, `.DS_Store`, editor cruft.
- **`.gitignore` audit** — `node_modules/`, `target/`, `dist/`, build output, `.env*`, test artifacts, captures, local databases, proxy/transcript caches. Nothing generated should be tracked.
- **Consistent formatting** across the codebase; lint clean with no suppressions added to hide real problems.

---

## Phase 4 — Security and secrets audit

**Do this before anything is pushed. Once it's public, it's public — including every past commit.**

1. **Scan the working tree** for API keys, tokens, passwords, personal paths, personal identifiers, and machine-specific values.
2. **Scan the entire git history** — thirteen sessions of commits. A secret committed once and deleted later is still in history and still exposed by the push. Check every commit, not just `HEAD`.
3. **If history contains a secret:** either scrub it (`git filter-repo`) or, if that proves messy, start a fresh single-commit history. Losing the commit story is a real cost but a leaked key is worse. **Decide, log the decision, and never push a known-exposed secret.**
4. **Verify key handling in code**: keys live in the OS keychain only, are read only by Rust, never enter the webview, never appear in logs or error messages, and are never written to the project bundle or SQLite.
5. **Check the project bundle format** — a shared `.motionaire` project must not contain keys or personal paths.
6. **Confirm no telemetry or network calls** exist beyond the explicit provider APIs the user configures.

---

## Phase 5 — Licensing and legal

1. **`LICENSE` file — AGPL-3.0**, copyright **Mohammed Isa**, current year. This was the decision made early in the project: it keeps the work open while preventing someone from taking it closed-source and reselling it, and it leaves you free to sell commercial licenses later since you hold the copyright.
2. **FFmpeg licensing — a real distribution question, flagged in context.md §6 and never resolved.** Determine whether the app bundles an FFmpeg binary or relies on the user's own install:
   - **Simplest and safest: do not bundle it.** Detect FFmpeg at runtime, and if it's missing show a clear message with install instructions (`brew install ffmpeg`). No redistribution, no licensing question. **Recommended.**
   - If you do bundle it, you must comply with the licence of that specific build (GPL vs LGPL differ) and include the required notices.
   Whichever you choose: **implement it, document it in the README, and log the decision.**
3. **`THIRD_PARTY.md`** — attributions for major dependencies and their licences (Tauri, wgpu, React, FFmpeg, and anything else with an attribution requirement).
4. **Author metadata** — `package.json`, `Cargo.toml`, `tauri.conf.json`: author is **Mohammed Isa**, sole contributor. No other names, no placeholder org, no generated-by attributions anywhere in the repo.

---

## Phase 6 — Build and distribution

Goal: someone lands on the GitHub page and downloads a working app. They do not clone, they do not build.

1. **Release build** — `tauri build`, producing a `.app` and a `.dmg`. Confirm the release build actually runs (release differs from dev: dev-only paths are gone, the keychain profile differs, asset paths change). **Launch it and exercise the critical path: activate → new project → import → edit → export.**

2. **The activation gate — decide it.** The app currently requires a licence key, and `TestValidator` accepts a hardcoded key that will be visible in public source. On a free, open-source release this is friction with zero benefit.
   **Recommendation: the open-source build ships unlocked.** Keep the `LicenseValidator` seam intact for any future commercial build, but do not gate the public app. Log the decision.

3. **Code signing and notarization — the honest situation.** macOS Gatekeeper blocks unsigned downloaded apps. Proper notarization requires an **Apple Developer Program membership ($99/year)** and a Developer ID certificate — credentials no autonomous agent can obtain. So:
   - **Configure Tauri's signing/notarization setup** and document exactly which environment variables and certificates are needed, so it's a switch to flip once the account exists.
   - **Ship ad-hoc signed for now**, and put the unblock instructions in the README prominently: right-click → Open, or `xattr -cr /Applications/Motionaire.app`.
   - **Say plainly in the README that the app is not yet notarized** and why the warning appears. Users trust honesty far more than a mysterious scary dialog.

4. **GitHub Release** — tag `v0.1.0`, attach the `.dmg`, and write real release notes describing what the app does and its known limitations.

5. **A build script** (`scripts/release.sh`) that produces the DMG in one command, so future releases are trivial.

6. *(Optional, only if it doesn't complicate things)* a GitHub Actions workflow for builds. Note honestly in the plan that signing in CI requires certificates in repository secrets, and is not worth setting up until the Developer account exists.

---

## Phase 7 — README and repo presentation

The README is the entire first impression. Make it genuinely good.

**Screenshots — capture these for real using the WKWebView self-capture tooling**, at a clean window size, with the sample project loaded so nothing looks empty:

1. **Hero: the AI chat editing the timeline** — the flagship prompt visible, diff cards showing, the PiP live in the preview, keyframes on the timeline. This is the single most compelling image the project has. It leads.
2. The full editor with real footage — timeline with filmstrips, properties panel, monochrome UI.
3. The colour tools with scopes reading live output.
4. The keyframe graph editor with bezier curves.

Save them to `docs/screenshots/` and embed them in the README.

**README structure:**

- Project name, one-line description, hero screenshot
- What it is, and honestly who it's for (AI-native editor for screen recordings and talking-head content)
- Features, grouped and concise — do not pad; the real list is impressive without inflation
- **Download** — link to the release DMG, macOS requirements, and the Gatekeeper unblock instructions
- **AI setup** — how to add an Anthropic/OpenAI key, and a video-generation key; be explicit that keys are stored in the macOS keychain and never leave the machine except to the provider the user chose
- **Build from source** — prerequisites (Node, Rust, FFmpeg), exact commands
- **Architecture** — a short, genuinely interesting section: the AI edits the timeline (not pixels), Rust/wgpu compositor, tool-call layer, one prompt = one undo step. This is the part that impresses engineers.
- **Testing** — what the suite covers and how to run it
- **Known limitations** — honest. Not notarized yet; macOS only; whatever Phase 0 turned up and Phase 1 didn't fix.
- **License** — AGPL-3.0, © Mohammed Isa
- **Author** — Mohammed Isa, sole author

Also: repo description and topics, and delete `CONTRIBUTING`-style files if any exist — this is a solo project.

---

## Phase 8 — Publish

**The repo already has thirteen sessions of git history. Preserve it — it is part of the story and it is worth showing.**

**Do NOT run `git init`** (unnecessary here) and never delete `.git`.

After Phases 0–7 are complete, the suite is green, and the secrets audit is clean:

```bash
git add -A
git commit -m "Motionaire v0.1.0 — AI-native video editor for macOS"
git branch -M main
git remote add origin git@github.com:4mohdisa/motionaire.git
git push -u origin main
```

Then create the `v0.1.0` release and attach the DMG.

**If the push fails**, it is almost certainly SSH auth (the remote uses `git@github.com`, which needs an SSH key registered with GitHub). Report the exact error and the fix rather than switching to an HTTPS remote without saying so.

**Verify the author on every commit is Mohammed Isa.** No co-author trailers, no generated-by attributions, no other contributors anywhere in the repo or its history.

---

## Rules

**Autonomy**
- **Never stop to ask.** Every ambiguity: pick the standard, conventional choice, log it in DECISIONS.md, continue.
- Where this plan conflicts with context.md or DECISIONS.md, follow the prior decision and log the conflict.

**Quality gate**
- **`npm test` green at the end of every phase.** A phase with a red suite is not finished.
- When a test fails, determine honestly whether the bug is in the **feature** or the **test** — both have happened repeatedly here. Fix the correct one. **Never weaken a test to force green.**
- **The release build must actually run and export a video.** Dev-build success does not prove release-build success.

**This session specifically**
- **No new features.** Verify, fix, clean, ship. If something is broken and can't be fixed cleanly, remove it or document it — do not leave it half-working.
- **Never push a secret.** Audit history, not just the working tree. If in doubt, do not push — log the concern and stop.
- **Honesty in the README over marketing.** Known limitations get stated plainly. Do not claim notarization, cross-platform support, or anything else that isn't true.
- **Sole author: Mohammed Isa.** No other contributors, no AI attribution, anywhere.

**Process**
- **Break what you build** — especially in Phase 0. Going beyond the literal ask is where every real bug in this project was found.
- Use the WKWebView self-capture tooling for the README screenshots.
- **Commit incrementally per phase.** Append to DECISIONS.md as you go.
- **If you run out of time:** finish the phase you're in, run the suite, log exactly where you stopped and what remains, stop cleanly. **Cut from the middle (Phases 2–3 can be trimmed) before cutting Phase 4 (secrets) or Phase 8 (publish)** — but never push if the secrets audit is incomplete.

---

## Out of scope

- Whisper / transcription
- Object extraction / subject masking
- The web activation server
- Render cache
- Windows or Linux builds
- Any new feature work whatsoever