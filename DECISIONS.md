# Decisions Log

Append-only. Every non-trivial choice made during autonomous scaffolding work goes here,
in chronological order, newest at the bottom. Never edit or delete past entries — if a
decision is later reversed, add a new entry that supersedes it and say so.

---

## 2026-07-12 — Session start: scaffold-only pass

**Scope for this session:** monorepo skeleton, Tauri v2 + React/TS wiring, dark-themed
placeholder shell (top bar / canvas / timeline strip), tooling, README. Explicitly
NOT touching: compositor, FFmpeg pipeline, transcript pipeline, AI tool layer. Those
are later work per CONTEXT.md §5 (build order) and the task brief for this session.

**Repo has no git history yet** — this is a fresh scaffold, no prior work to preserve.

## Monorepo layout

Decision: `apps/frontend/` (Vite + React + TypeScript) and `apps/backend/` (the Tauri
Rust project — Cargo.toml, `src/`, `tauri.conf.json`, icons, capabilities live directly
here) as the two top-level app packages, per the task brief. This replaces Tauri's
default convention of a `src-tauri/` folder sitting next to the frontend at the repo
root — instead `src-tauri`'s contents move one level down to live at `apps/backend/`,
symmetric with `apps/frontend/`.

Why: task brief explicitly asked for this symmetric layout and for tauri.conf.json's
paths to be repointed. No conflicting guidance in CONTEXT.md (CONTEXT.md doesn't
specify a folder layout at all — it's silent on this, so this is a gap-fill, not a
deviation).

## Toolchain versions found on this machine

- node v24.16.0, npm 11.13.0
- rustc/cargo 1.96.1 (Homebrew)
- `@tauri-apps/cli` 2.11.4 (resolved via npx, not globally installed) — this is the
  Tauri v2 CLI, confirmed via `npx @tauri-apps/cli@latest --version`.
- No global `cargo-tauri` binary; using the npm-distributed CLI (`@tauri-apps/cli`)
  instead of `cargo install tauri-cli`, since the npm package ships prebuilt and is
  the more common workflow for JS-first Tauri projects (matches `apps/frontend`
  owning `package.json`/`node_modules` as the natural home for `npm run tauri ...`
  scripts). Rationale, not left implicit: avoids a slow from-source cargo install
  when the npm binary does the same job.

## Scaffolding approach

Decision: use official generators (`npm create vite@latest ... --template react-ts`
and `@tauri-apps/cli init`) rather than hand-writing Tauri v2 Rust boilerplate from
memory. Tauri v2's permissions/capabilities system changed substantially from v1;
generating it via the real CLI and then relocating/editing avoids introducing subtly
wrong hand-rolled config.

`tauri init` always creates a `src-tauri/` folder relative to whatever `--directory`
it's given — there's no flag to name the output folder directly. So the plan is:
run `init` at the repo root (creates `<root>/src-tauri/`), then move that folder's
contents to `apps/backend/`, then fix the now-relative paths inside `tauri.conf.json`
(`frontendDist`, `beforeDevCommand`/`beforeBuildCommand`) since the folder's depth
relative to `apps/frontend` changes after the move.

`beforeDevCommand`/`beforeBuildCommand` will use the Tauri v2 `HookCommand` object
form (`{ "script": "...", "cwd": "../frontend" }`) rather than a bare string with an
implicit `npm --workspace=...` flag — confirmed via the CLI's own
`config.schema.json` that `cwd` is a supported field on hook commands. This is more
robust than relying on npm's upward package.json resolution from a non-workspace
directory.

## Rust workspace shape

Decision: `apps/backend/Cargo.toml` is a Cargo workspace with the Tauri app itself as
the workspace root package (`[workspace] members = ["."]` alongside `[package]` in
the same manifest — a "root package" workspace, which is valid Cargo). This satisfies
the brief's ask for "Rust workspace Cargo.toml in apps/backend/" without inventing
placeholder crates that don't exist yet (no compositor/FFmpeg/AI crates this session —
out of scope). Future crates (e.g. a separate compositor crate per CONTEXT.md §3) can
be added as siblings under `apps/backend/` and appended to `members` later.

## Theme

Decision: dark theme is the only theme — no light/dark toggle, no theme system, since
the task brief calls it "permanent, not a placeholder." CONTEXT.md doesn't specify
exact colors, so picking a conventional near-black editor palette (similar register
to DaVinci Resolve / Premiere / VS Code dark) rather than pure `#000`/`#fff`, since
that's the standard convention for video-editor-style dark UIs and easiest on the eyes
for long sessions. Exact hex values recorded inline in the theme file itself, not
duplicated here.

## TypeScript strict mode

The current `create-vite` react-ts template (Vite 8 / TS ~6.0 era, npm dist-tag
`latest` as of 2026-07-12) ships `tsconfig.app.json`/`tsconfig.node.json` **without**
`"strict": true` — confirmed via `tsc --showConfig`, which showed no strict-family
flags enabled at all. That's a change from older Vite templates, which always
defaulted to strict. Since a project with a nontrivial domain model (project JSON,
keyframes, transforms per CONTEXT.md §1) benefits a lot from strict null-checking,
and strict-by-default remains the overwhelming community convention for new TS
projects, added `"strict": true` explicitly to both tsconfig files rather than
inheriting the template's laxer default.

Also swapped the template's default linter from `oxlint` (the new create-vite
default) to ESLint + Prettier, since the task brief explicitly named "ESLint +
Prettier" as the tooling to use. Used the pre-oxlint conventional ESLint flat-config
setup (`@eslint/js` + `typescript-eslint` + `eslint-plugin-react-hooks` +
`eslint-plugin-react-refresh`, `eslint-config-prettier` to defer style rules to
Prettier) — this is what `create-vite`'s react-ts template shipped before switching
its default to oxlint, so it's a well-worn, conventional combination rather than a
novel one.
