# Motionaire

AI-native editor for screen recordings and talking-head content. Desktop app built on
Tauri v2 (Rust) + React/TypeScript. See [CONTEXT.md](CONTEXT.md) for the full technical
spec and [DECISIONS.md](DECISIONS.md) for the log of scaffolding decisions.

This is currently a **scaffold**: the app shell (dark theme, top bar, canvas area,
timeline strip) runs, but no editing features are wired up yet.

## Layout

```
apps/
  frontend/   React + TypeScript (Vite) — the Tauri webview UI
  backend/    Rust core — the Tauri project (Cargo.toml, tauri.conf.json, src/)
```

`apps/backend/` replaces Tauri's default `src-tauri/` location so the two halves of
the app sit symmetrically under `apps/`.

## Prerequisites

- [Node.js](https://nodejs.org/) 20+ and npm
- [Rust](https://www.rust-lang.org/tools/install) (stable toolchain, via rustup or Homebrew)
- Tauri's platform-specific system dependencies — see the
  [Tauri v2 prerequisites guide](https://v2.tauri.app/start/prerequisites/) (on macOS
  this is just Xcode Command Line Tools; Linux/Windows need a few extra packages)

## Install

```sh
npm install
```

Installs JS dependencies for `apps/frontend` (npm workspaces) and the Tauri CLI.
Rust dependencies are fetched automatically the first time you build/run.

## Run in development

```sh
npm run tauri dev
```

Opens the Tauri window with the Vite dev server behind it (hot reload on the
frontend). Equivalent to `cd apps/backend && npx tauri dev` if you prefer to run it
from that directory directly.

## Build

```sh
npm run tauri build
```

Produces a release binary/installer under `apps/backend/target/release/`.

## Projects

Projects save as `Name.motionaire/` bundles (project.json + transcript.json +
history.jsonl + cache/), written crash-safely (temp + fsync + atomic rename).
Recent projects live in an app-level SQLite DB. Media is imported through the
native file dialog and referenced by absolute path; sources missing on disk are
flagged offline in the timeline instead of failing the load.

## Self-tests

Rust: `cd apps/backend && cargo test --lib` (keyframe parity, persistence
crash-safety, decoder back-off, sync wire format). End-to-end inside the real
webview, reported into the Rust log as `WEBVIEW-TEST PASS/FAIL`:

```sh
SPIKE_DEMO=1 SPIKE_PERSIST_TEST=1 SPIKE_CLOCK_TEST=1 npm run tauri dev
SPIKE_REOPEN_TEST=1 npm run tauri dev   # run afterwards: cross-process reopen
```

Compositor chaos soak (scrub storms, ffmpeg kills, GPU re-inits, WS churn):

```sh
cd apps/backend && MOTIONAIRE_WS_PORT=43118 cargo run --release --bin soak
```

## Native screenshots & self-verification

The app can capture its own webview (including the GPU compositor canvas) with
**no permissions needed** — this is how autonomous sessions verify the real
native rendering. In debug builds a dev-remote file trigger drives it:

```sh
echo "capture:/tmp/shot.png"  > "$TMPDIR/motionaire-dev-trigger"   # native capture
echo "menu:view:pip_demo"     > "$TMPDIR/motionaire-dev-trigger"   # any menu action
echo "minimize"               > "$TMPDIR/motionaire-dev-trigger"   # window control
cat "$TMPDIR/motionaire-dev-done"                                   # result
```

To capture the app from the **outside** (full window with title bar, or any
other app), macOS requires the capturing tool to have Screen Recording
permission. That is a one-time, human-only grant — there is no automatic path:

1. Build the bundled app once: `npm run tauri build -- --debug --bundles app`
   (output: `apps/backend/target/debug/bundle/macos/motionaire.app` with a real
   Info.plist / `com.motionaire.app` identifier).
2. Open System Settings → Privacy & Security → Screen & System Audio Recording.
3. Enable the tool that takes the screenshots — e.g. your terminal (for
   `screencapture`) or whatever agent host runs these sessions. Motionaire
   itself does NOT need this permission for its own self-captures.
4. Quit and reopen that tool; macOS applies the grant on next launch.

## Compositor spike demo

```sh
SPIKE_DEMO=1 npm run tauri dev
```

Auto-loads the keyframed picture-in-picture demo (two generated test clips,
composited in Rust via wgpu, streamed into the preview). Without the env var, use
the "PiP Demo" toolbar button inside the app. Requires `ffmpeg`/`ffprobe` on PATH
(`brew install ffmpeg`). Headless check with PNG evidence + frame timing:

```sh
cd apps/backend && cargo run --release --bin spike_check
```

## Frontend-only commands

Useful when iterating on UI without launching the native shell:

```sh
npm run dev      # Vite dev server only, http://localhost:5173
npm run build    # Type-check + production build of apps/frontend
npm run lint     # ESLint
npm run format   # Prettier --write
```

## License

AGPL-3.0-only. Copyright retained by the author.
