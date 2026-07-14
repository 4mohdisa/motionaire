# Testing Motionaire

One command runs everything:

```sh
npm test            # = scripts/test-all.sh: unit (TS+Rust) → e2e → visual
```

Individually:

```sh
npm run test:unit    # vitest (apps/frontend) + cargo test (apps/backend)
npm run test:e2e     # scripts/e2e.sh — real app, dev-remote runner
npm run test:visual  # scripts/visual.sh — self-capture vs committed baselines
```

**The gate rule (pro-editor session, Phase 0):** a phase of work is not
finished until `npm test` is green. When a test fails, decide honestly
whether the bug is in the feature or in the test — both have happened
repeatedly in this project — and fix the correct one. Never weaken a test to
make a broken feature pass; never "fix" working code to satisfy a broken
test.

## The four layers

| Layer | Tool | Where | What it covers |
|---|---|---|---|
| Frontend unit | vitest, node env | `apps/frontend/src/**/*.test.ts` | store mutations, time/frame math, keyframe display mirror, undo/redo |
| Backend unit | cargo test | `apps/backend/src` `#[cfg(test)]` | property resolution, speed remap, export filter graph, proxy keys, bundle I/O, license |
| e2e | `scripts/e2e.sh` | dev cases in `menuBridge.ts` | real app + real compositor: parity, editing, audio, proxies, export, plus `dev:smoke` — the full critical path ending in an ffprobe-verified file |
| Visual | `scripts/visual.sh` | baselines in `tests/visual/` | WKWebView self-captures compared by ffmpeg SSIM (≥ 0.97) |

**Why not tauri-driver:** the official Tauri v2 WebDriver path does not
support macOS (WKWebView exposes no WebDriver endpoint). The dev-remote
pattern — file trigger → real app → `WEBVIEW-TEST PASS/FAIL` log lines — has
verified five sessions of work against the real compositor, so Phase 0
formalized that into the runner instead. Logged in DECISIONS.md.

## Adding tests

- **Pure logic** (store/engine/Rust): unit test. The store's whole import
  graph is deliberately tauri-free and DOM-free — keep it that way.
- **Anything needing the webview or compositor**: add a `dev:*` case in
  `menuBridge.ts` that reports via `report_test`, then list it in
  `scripts/e2e.sh` DEFAULT_TESTS.
- **New screens**: add a `shoot` line in `scripts/visual.sh` plus a settling
  dev case; run with `--update` once to write the baseline, commit it.

## House rules (each learned the hard way; violations have burned real hours)

1. **Never assert on a playhead you set.** `setPlayhead` clamps to project
   duration. Assert on where clips actually landed. (Pinned by a unit test.)
2. **Poll for effects; never sleep-and-hope.** rAF throttles to ~1Hz when
   the window is occluded — fixed sleeps pass at your desk and fail
   overnight. `scripts/e2e.sh` polls; do the same inside dev cases.
3. **Dead-flag async listeners.** StrictMode resolves tauri `listen()` after
   cleanup; without `let dead = false` handling, every mount leaks one
   listener (seen as doubled toasts).
4. **Unit-test fixtures live outside `*.test.ts`** (`engine/testUtils.ts`) —
   importing a test file re-registers its tests in the importer.
5. **e2e scenes derive positions from actual state** — placement helpers
   clamp/snap/shift (`clampStartToGaps`, lane fallbacks), so a hardcoded
   expected position is usually fiction.
