# Motionaire — backend

The Rust core, and the reason the app feels like a native editor: a
multi-pass wgpu compositor renders the preview in real time and the export
frame-by-frame with the same code, FFmpeg subprocesses handle decode and
encode, and everything secret (API keys) stays on this side of the IPC
boundary.

## Where things live

| Path | What it is |
|---|---|
| `src/compositor/` | wgpu compositor: decode, keyframe resolution (the render authority), effect chains, frame streaming |
| `src/export.rs` | Export engine — full-res render into FFmpeg, audio filter graphs, queue |
| `src/ai/` | AI providers (Anthropic/OpenAI/Seedance/Veo + offline mocks), keychain keys, streamed turn loop |
| `src/persistence.rs` | Project bundles (atomic writes), SQLite recents/settings |
| `src/license.rs` | License seam — the open-source build ships unlocked; the validator stays for a future commercial build |
| `src/menu.rs`, `src/capture.rs` | Native menu bar; WKWebView self-capture (debug tooling) |

Two hard rules: **API keys live in the macOS Keychain and are read only
here** — the webview only ever learns booleans. And the compositor is the
single source of truth for rendered pixels; the TypeScript math is a display
mirror, pinned by a parity test.

## Working on it

```bash
cargo test                    # unit tests
cargo run --release --bin spike_check   # headless compositor check with PNG evidence
npm run tauri dev             # the real app, from the repo root
```

Dev/test commands are `#[cfg(debug_assertions)]` — the release binary ships
44 commands, the product API and nothing else.

Part of [Motionaire](../../README.md) · AGPL-3.0-only · © Mohammed Isa
