# Motionaire — frontend

The editor's UI: React + TypeScript in a Tauri webview. One Zustand store
owns the project document — every mutation, whether it comes from the mouse
or from the AI's tool calls, goes through the same store actions. That's the
rule the whole app hangs off.

## Where things live

| Path | What it is |
|---|---|
| `src/state/store.ts` | The project document + every mutation, undo/redo, AI transactions |
| `src/engine/` | Time/keyframe math (display mirror — Rust is the render authority), audio graph |
| `src/compositor/` | Bridge to the Rust compositor: project sync, frame stream client, export runner |
| `src/ai/` | Tool registry, chat session/turn loop, layout macros |
| `src/components/` | The UI — timeline, preview, properties, chat, bin, mixer, dialogs |
| `src/persistence/` | Project bundles, fonts, proxies, AI settings, generation jobs |
| `src/menu/` | Native-menu dispatch (+ `devCases.ts`, the e2e suite, debug builds only) |

## Working on it

```bash
npm run dev        # Vite only, http://localhost:5173 (no native shell)
npm run tauri dev  # the real app, from the repo root
npx vitest run     # unit tests
npm run lint       # ESLint; `npm run format` for Prettier
```

Design tokens are in `src/index.css` — monochrome, charcoal-not-black, seams
darker than panels. Every color routes through a token; if you're writing a
hex value in a component, stop.

Part of [Motionaire](../../README.md) · AGPL-3.0-only · © Mohammed Isa
