# Motionaire

AI-native editor for screen recordings and talking-head content. Desktop app built on
Tauri v2 (Rust) + React/TypeScript.

- [CONTEXT.md](CONTEXT.md) — technical spec: document model, render pipeline, known traps
- [TESTING.md](TESTING.md) — how to run and extend the test suite
- [DECISIONS.md](DECISIONS.md) — append-only log of every non-obvious call, with rationale

Multi-track timeline with ripple/roll/slip/slide trimming, a wgpu compositor shared by
preview and export, an ordered effect stack (grades, keys, masks, wheels, curves, LUTs,
audio EQ/compressor/gate), a bezier keyframe graph editor, scopes, an audio mixer,
proxies for 4K footage, and hardware-accelerated export.

**And it edits from plain English.** The AI chat (left rail) turns
"From 0:10 to 0:45 shrink my face to 10%, rounded corners, bottom right…" into real,
undoable keyframes on the timeline — the AI calls the same mutations the UI uses, every
prompt lands as ONE undo step, and it never touches pixels (the deterministic compositor
renders). AI video generation (Seedance / Google Veo) drops generated clips straight
into the media bin. See [DEMO.md](DEMO.md) for the presenter script.

## AI setup

⌘, → **AI — chat provider**: pick Anthropic or OpenAI, paste your API key, Test
connection. Keys go to the **macOS keychain and are only ever read by Rust** — the UI
learns booleans, never key material. No key? The **Mock (offline)** provider runs the
demo-family prompts deterministically, free. Video generation configures the same way
(Seedance or Google) and always says so before spending your credits.

## Layout

```
apps/
  frontend/   React + TypeScript (Vite) — the Tauri webview UI
  backend/    Rust core — the Tauri project (Cargo.toml, tauri.conf.json, src/)
scripts/      test runners (see TESTING.md)
tests/visual/ committed visual-regression baselines
```

`apps/backend/` replaces Tauri's default `src-tauri/` location so the two halves of
the app sit symmetrically under `apps/`.

## Prerequisites

- [Node.js](https://nodejs.org/) 20+ and npm
- [Rust](https://www.rust-lang.org/tools/install) (stable toolchain, via rustup or Homebrew)
- `ffmpeg` / `ffprobe` on PATH (`brew install ffmpeg`) — decode, proxies, export
- Tauri's platform-specific system dependencies — see the
  [Tauri v2 prerequisites guide](https://v2.tauri.app/start/prerequisites/) (on macOS
  this is just Xcode Command Line Tools; Linux/Windows need a few extra packages)

## Install and run

```sh
npm install         # JS deps (npm workspaces) + Tauri CLI; Rust deps fetch on first build
npm run tauri dev   # dev window, hot reload on the frontend
npm run tauri build # release binary/installer under apps/backend/target/release/
```

## Test

```sh
npm test            # everything: frontend unit + backend unit + e2e + visual regression
```

Individual layers (`test:unit`, `test:e2e`, `test:visual`) and the house rules that keep
these tests honest are documented in [TESTING.md](TESTING.md).

## Projects

Projects save as `Name.motionaire/` bundles (project.json + transcript.json +
history.jsonl + cache/), written crash-safely (temp + atomic rename). Recent projects
live in an app-level SQLite DB. Media is referenced by absolute path and never copied in
by default — File ▸ Consolidate Media does that explicitly; sources missing on disk are
flagged offline in the timeline instead of failing the load. Unsaved work gets a
crash-recovery home, offered back at the next launch.

## Dev tooling

The app captures its own webview — including the GPU compositor canvas — with **no
permissions needed**. This is how autonomous sessions verify real native rendering. In
debug builds a file trigger drives it:

```sh
echo "capture:/tmp/shot.png"  > "$TMPDIR/motionaire-dev-trigger"   # native capture
echo "menu:view:pip_demo"     > "$TMPDIR/motionaire-dev-trigger"   # any menu action
echo "minimize"               > "$TMPDIR/motionaire-dev-trigger"   # window control
cat "$TMPDIR/motionaire-dev-done"                                   # result
```

Capturing the app from the **outside** (full window with title bar) additionally needs
macOS Screen Recording permission for the capturing tool — a one-time, human-only grant
in System Settings → Privacy & Security → Screen & System Audio Recording, applied on
that tool's next launch. Motionaire's own self-captures never need it.

Compositor spike demo — keyframed picture-in-picture, two generated clips composited in
Rust via wgpu and streamed into the preview:

```sh
SPIKE_DEMO=1 npm run tauri dev          # or the "Load PiP Demo (dev)" menu item
cd apps/backend && cargo run --release --bin spike_check   # headless PNG evidence + timing
cd apps/backend && MOTIONAIRE_WS_PORT=43118 cargo run --release --bin soak  # chaos soak
```

Frontend-only iteration, without the native shell:

```sh
npm run dev      # Vite dev server only, http://localhost:5173
npm run build    # Type-check + production build of apps/frontend
npm run lint     # ESLint
npm run format   # Prettier --write
```

## License

AGPL-3.0-only. Copyright retained by the author.
