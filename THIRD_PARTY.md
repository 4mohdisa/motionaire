# Third-party software

Motionaire is AGPL-3.0-only, © Mohammed Isa. It builds on the following
open-source software. Each project is © its respective authors; license
texts ship with the dependencies themselves (`node_modules/`, crates.io).

## Application framework

| Project | License | Role |
|---|---|---|
| [Tauri](https://tauri.app) (+ plugins: dialog, log) | MIT / Apache-2.0 | Desktop shell, IPC, native menus, bundling |
| [React](https://react.dev) / react-dom | MIT | UI |
| [TypeScript](https://www.typescriptlang.org) | Apache-2.0 | Language |
| [Vite](https://vite.dev) | MIT | Build tooling |

## Rendering & media

| Project | License | Role |
|---|---|---|
| [wgpu](https://wgpu.rs) | MIT / Apache-2.0 | GPU compositor (Metal backend) |
| [FFmpeg](https://ffmpeg.org) | LGPL-2.1+ / GPL-2+ (build-dependent) | Decode, normalize, proxies, encode — **not bundled**: Motionaire runs the `ffmpeg`/`ffprobe` binaries already installed on the user's machine (`brew install ffmpeg`). No FFmpeg code is linked or redistributed. |
| png | MIT / Apache-2.0 | PNG encode for captures/evidence |

## State & UI utilities

| Project | License | Role |
|---|---|---|
| [Zustand](https://zustand.docs.pmnd.rs) | MIT | Store |
| [Immer](https://immerjs.github.io/immer/) | MIT | Immutable mutations |
| [Lucide](https://lucide.dev) (lucide-react) | ISC | Icons |

## Rust libraries

| Project | License | Role |
|---|---|---|
| serde / serde_json | MIT / Apache-2.0 | Serialization |
| tokio / tokio-tungstenite / futures-util / bytes | MIT | Frame-stream WebSocket |
| reqwest | MIT / Apache-2.0 | AI-provider HTTP (Rust-only key handling) |
| rusqlite (bundled SQLite) | MIT (SQLite: public domain) | Recents / settings DB |
| keyring | MIT / Apache-2.0 | macOS Keychain storage for API keys |
| objc2 / block2 / objc2-app-kit / objc2-foundation | MIT | macOS niceties (titlebar dirty dot, snapshots) |
| bytemuck, pollster, log, env_logger, base64 | MIT / Apache-2.0 / Zlib | Utilities |

Dev-only tooling (ESLint, Prettier, Vitest, typescript-eslint) is listed in
`apps/frontend/package.json` and not distributed with the app.
