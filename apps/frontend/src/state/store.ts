import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { current } from 'immer'
import type {
  Clip,
  Ease,
  Effect,
  Keyframe,
  EffectType,
  Transform,
  Shape,
  Track,
  MediaAsset,
  Project,
  ProjectFont,
  TextAnimation,
  TextStyle,
  Transition,
} from '../types/project'
import { createProject, defaultTransform, uid } from '../types/project'
import { mkEffect } from '../engine/effectStack'
import { isAudioFx } from '../engine/audioFx'
import {
  clampStartToGaps,
  clipDuration,
  clipEnd,
  computeDuration,
  findClip,
  snapToFrame,
} from '../engine/time'
import { presetHandles, resolveProp } from '../engine/keyframes'
import { expandTextAnimation } from '../engine/textPresets'

const HISTORY_LIMIT = 100

// AI transaction state (module-level: consulted by mutateProject).
let aiTxDepth = 0
let aiTxSnapshotTaken = false

/// Run a block of store mutations as ONE undo step. Re-entrant; the
/// snapshot is taken lazily by the first history-bearing mutation, so a
/// turn that only READS pushes nothing.
export function withAiTransaction<T>(fn: () => T): T {
  aiTxDepth++
  if (aiTxDepth === 1) aiTxSnapshotTaken = false
  try {
    return fn()
  } finally {
    aiTxDepth--
  }
}

/// Async variant for tool loops that span awaits (the streamed turn).
export function beginAiTransaction(): void {
  aiTxDepth++
  if (aiTxDepth === 1) aiTxSnapshotTaken = false
}

export function endAiTransaction(): boolean {
  aiTxDepth = Math.max(0, aiTxDepth - 1)
  return aiTxSnapshotTaken // true = the turn actually edited something
}

export type LeftPanel = 'media' | 'effects' | 'chat' | 'mixer' | null

export interface ChatEntry {
  id: string
  role: 'user' | 'assistant'
  text: string
  streaming?: boolean
  diffs?: string[]
  toolCalls?: { name: string; ok: boolean; detail?: string }[]
  error?: string
  edited?: boolean
  // past.length right after the turn: "Undo this" is honest only while
  // nothing else has edited since (then it IS plain undo).
  undoDepth?: number
}

// App preferences (SQLite settings blob). AI additions (Run 1, Phase 2):
// provider CHOICES and model names only — never key material.
export interface Prefs {
  autosaveSecs: number
  autoProxy: boolean
  aiChatProvider: 'anthropic' | 'openai' | 'mock'
  aiChatModel: string
  aiVideoProvider: 'none' | 'seedance' | 'gemini'
}

export interface ExportSettings {
  width: number
  height: number
  fps: number
  format: 'mp4' | 'hevc' | 'prores' | 'm4a' | 'gif' | 'png'
  quality: number // 1..100
}

// CONTEXT.md §2.2 set_canvas presets.
export const CANVAS_PRESETS = {
  tiktok_9x16: { label: 'TikTok / Reels 9:16', width: 1080, height: 1920 },
  youtube_16x9: { label: 'YouTube 16:9', width: 1920, height: 1080 },
  square_1x1: { label: 'Square 1:1', width: 1080, height: 1080 },
  portrait_4x5: { label: 'Portrait 4:5', width: 1080, height: 1350 },
} as const

export type CanvasPresetId = keyof typeof CANVAS_PRESETS

export interface StoreState {
  project: Project
  past: Project[]
  future: Project[]

  playhead: number
  playing: boolean
  shuttle: number // playback rate multiplier; negative = reverse (J/K/L)
  selection: string[]
  pxPerSec: number
  snap: boolean
  safeZones: boolean
  exportOpen: boolean
  exportSettings: ExportSettings
  // App shell view (session 9, Phase 1). The launcher/editor are full-window
  // views that replace each other — one window, no multi-window state sync.
  appView: 'boot' | 'activate' | 'onboard' | 'launcher' | 'editor'
  setAppView: (v: 'boot' | 'activate' | 'onboard' | 'launcher' | 'editor') => void

  // Toasts (foundation session, Phase 0): the app-wide non-blocking notice
  // channel — errors, completions, and background-job progress.
  toasts: { id: string; kind: 'info' | 'success' | 'error' | 'progress'; text: string; progress?: number; action?: { label: string; onClick: () => void } }[]
  pushToast: (
    kind: 'info' | 'success' | 'error' | 'progress',
    text: string,
    id?: string,
    action?: { label: string; onClick: () => void },
  ) => string
  updateToast: (id: string, patch: { text?: string; progress?: number }) => void
  dismissToast: (id: string) => void

  // Project safety (session 9, Phase 6)
  dirty: boolean
  markSaved: () => void
  markDirty: () => void
  unsavedOpen: boolean
  setUnsavedOpen: (v: boolean) => void

  // Clip clipboard (session 9, Phase 6): internal, not the system clipboard.
  clipboard: Clip[]
  copyClips: (ids: string[]) => void
  cutClips: (ids: string[]) => void
  pasteAtPlayhead: () => void

  timelineHeight: number
  propsWidth: number
  compositorActive: boolean
  // Proxies (foundation, Phase 5): force original media in preview.
  previewOriginal: boolean
  setPreviewOriginal: (v: boolean) => void
  // Workflow dialogs + app prefs (foundation, Phase 7)
  dialog: 'projectSettings' | 'preferences' | 'shortcuts' | 'generate' | null
  setDialog: (d: 'projectSettings' | 'preferences' | 'shortcuts' | 'generate' | null) => void
  lastGenPrompt: string | null
  setLastGenPrompt: (p: string) => void
  prefs: Prefs
  setPrefs: (patch: Partial<Prefs>) => void
  setAiConfigured: (v: boolean) => void
  compositorFps: number
  projectPath: string | null
  previewFull: boolean

  // --- history ---
  undo: () => void
  redo: () => void
  // Push one history entry for a drag/trim gesture; subsequent transient
  // mutations during the gesture skip history so undo reverts the whole gesture.
  beginGesture: () => void

  // --- media ---
  addMedia: (asset: MediaAsset) => void
  updateMedia: (id: string, patch: Partial<MediaAsset>) => void
  appendMediaClip: (mediaId: string) => void
  // Media bin (session 9, Phase 2)
  // Left panel host (Run 1, Phase 1f): the rail switches between these.
  leftPanel: LeftPanel
  setLeftPanel: (p: LeftPanel) => void
  // Back-compat aliases (menu items + e2e drive these):
  binOpen: boolean
  setBinOpen: (v: boolean) => void
  aiConfigured: boolean // set at boot once a chat API key exists (Phase 2+)
  // Chat log (Run 1, Phase 4). Persisted to the bundle's history.jsonl.
  chatLog: ChatEntry[]
  chatBusy: boolean
  pushChatEntry: (e: ChatEntry) => void
  updateChatEntry: (id: string, patch: Partial<ChatEntry>) => void
  setChatBusy: (v: boolean) => void
  setChatLog: (log: ChatEntry[]) => void
  insertClipAt: (
    mediaId: string,
    trackId: string | null,
    at: number,
    range?: { in: number; out: number },
  ) => void
  removeMedia: (mediaId: string) => void
  // Freeze frame: add a still asset + a clip on the topmost video track at
  // `at` (nearest gap; end of track if nothing fits).
  addStillClip: (asset: MediaAsset, at: number) => void

  // --- clip editing ---
  moveClip: (clipId: string, start: number, trackId?: string, transient?: boolean) => void
  // Group drag: set several clips' starts (and optionally tracks) atomically;
  // the whole move is rejected if any clip would overlap a clip outside the
  // group, land on a locked/missing track, or cross kinds.
  moveClipsTo: (
    entries: { id: string; start: number; trackId?: string }[],
    transient?: boolean,
  ) => void
  trimClip: (clipId: string, edge: 'in' | 'out', timelineTime: number, transient?: boolean) => void
  // Professional trim tools (pro-editor session, Phase 4). Exact semantics:
  // ripple = trim an edge and shift EVERYTHING downstream on sync-locked
  // tracks (no gap); roll = move the cut between two adjacent clips (total
  // duration unchanged); slip = shift a clip's source window without moving
  // it on the timeline; slide = move a clip while adjacent neighbors absorb.
  rippleTrim: (clipId: string, edge: 'in' | 'out', timelineTime: number, transient?: boolean) => void
  rollEdit: (leftClipId: string, timelineTime: number, transient?: boolean) => void
  slipClip: (clipId: string, deltaSrc: number, transient?: boolean) => void
  slideClip: (clipId: string, deltaT: number, transient?: boolean) => void
  tool: 'select' | 'ripple' | 'roll' | 'slip' | 'slide'
  setTool: (t: 'select' | 'ripple' | 'roll' | 'slip' | 'slide') => void
  splitClip: (clipId: string, at: number) => void
  splitAtPlayhead: () => void
  deleteClips: (ids: string[]) => void
  rippleDeleteClips: (ids: string[]) => void
  duplicateClip: (clipId: string) => void
  detachAudio: (clipId: string) => void

  // --- properties & keyframes ---
  // Static set; if the prop already has keyframes, upserts a keyframe at the
  // playhead instead (NLE stopwatch semantics).
  setClipProperty: (clipId: string, prop: string, value: unknown, transient?: boolean) => void
  // Stopwatch/diamond click: arm with first keyframe, or add/remove at playhead.
  toggleKeyframe: (clipId: string, prop: string) => void
  // Direct keyframe upsert at a clip-relative time (Run 1, Phase 5): the
  // layout macro writes coordinated pairs without touching the playhead.
  writeKeyframe: (clipId: string, prop: string, relT: number, v: number, ease?: Ease) => void
  clearKeyframes: (clipId: string, prop: string) => void
  setKeyframeEase: (clipId: string, prop: string, t: number, ease: Ease | 'bezier') => void
  // Graph editor (pro-editor session, Phase 3).
  graphOpen: boolean
  setGraphOpen: (v: boolean) => void
  moveKeyframes: (
    clipId: string,
    moves: { prop: string; fromT: number; toT: number; toV: number }[],
    transient?: boolean,
  ) => void
  deleteKeyframes: (clipId: string, keys: { prop: string; t: number }[]) => void
  setKeyframeHandle: (
    clipId: string,
    prop: string,
    t: number,
    which: 'ho' | 'hi',
    h: [number, number],
    transient?: boolean,
  ) => void
  // Convert a keyframe's outgoing segment to editable bezier (preset eases
  // become their curve equivalents; spring falls back to thirds-linear).
  convertToBezier: (clipId: string, prop: string, t: number) => void

  // --- transitions & text ---
  setTransition: (clipId: string, edge: 'in' | 'out', transition: Transition | null) => void
  addTextClip: (content?: string) => void
  addAdjustmentLayer: () => void
  addShapeClip: (kind: 'rect' | 'ellipse' | 'line') => void
  // Title templates (foundation, Phase 8): composed from existing text/shape
  // primitives — no new render paths.
  addTitleTemplate: (kind: 'lowerThird' | 'centered' | 'caption') => void
  // Effect stack (pro-editor session, Phase 2): ordered, mutable.
  addEffect: (clipId: string, type: EffectType) => void
  removeEffect: (clipId: string, effectId: string) => void
  toggleEffect: (clipId: string, effectId: string) => void
  moveEffect: (clipId: string, effectId: string, dir: 1 | -1) => void
  duplicateEffect: (clipId: string, effectId: string) => void
  updateEffectParams: (
    clipId: string,
    effectId: string,
    patch: Record<string, import('../types/project').EffectParam>,
  ) => void
  setClipBlend: (clipId: string, blend: Clip['blend']) => void
  setClipMatte: (clipId: string, matte: Clip['matte']) => void
  setClipMotionBlur: (clipId: string, v: boolean) => void
  // Organization (Phase 8).
  setClipLabel: (ids: string[], label: string | null) => void
  selectByLabel: (label: string) => void
  setMediaFolder: (mediaId: string, folder: string | null) => void
  // Compound clips (Phase 8): group a selection into a nested timeline.
  makeCompound: (ids: string[]) => void
  ungroupCompound: (clipId: string) => void
  openCompound: (compoundId: string | null) => void
  editingCompound: string | null
  // Auto-reframe (Phase 7, context.md §2.2): 'center' = cover-fit for the
  // current canvas; 'activity' = luma-change centroids drive x/y keyframes.
  autoReframe: (clipId: string, mode: 'center' | 'activity') => Promise<void>
  // Copy/paste attributes (transform + stack + blend) across clips.
  attrClipboard: { transform: Transform; effects: Effect[]; blend?: Clip['blend'] } | null
  copyAttributes: (clipId: string) => void
  pasteAttributes: (targetIds: string[]) => void
  updateShape: (clipId: string, patch: Partial<Shape>) => void
  updateTextClip: (
    clipId: string,
    patch: { content?: string; style?: Partial<TextStyle>; animation?: Partial<TextAnimation> },
  ) => void

  // --- transport / ui ---
  setPlayhead: (t: number) => void
  enginePlayhead: (t: number) => void // raw, from playback loop; no frame snap
  play: () => void
  pause: () => void
  togglePlay: () => void
  setShuttle: (rate: number) => void
  frameStep: (frames: number) => void
  select: (ids: string[], mode?: 'set' | 'add' | 'toggle') => void

  // --- editing essentials (foundation session, Phase 2) ---
  // Timeline mark in/out (drives range operations + export range).
  markIn: number | null
  markOut: number | null
  setMarkIn: (t: number | null) => void
  setMarkOut: (t: number | null) => void
  // Insert pushes the target track right; overwrite carves out what's under.
  editMode: 'insert' | 'overwrite'
  setEditMode: (m: 'insert' | 'overwrite') => void
  // Source monitor: preview + set in/out on a bin asset BEFORE placing it.
  sourcePreview: { mediaId: string; in: number | null; out: number | null } | null
  openSource: (mediaId: string | null) => void
  setSourceRange: (edge: 'in' | 'out', t: number | null) => void
  setClipDisabled: (ids: string[], disabled: boolean) => void
  nudgeSelection: (frames: number) => void
  scrubbing: boolean
  setScrubbing: (v: boolean) => void

  // --- audio completeness (foundation session, Phase 3) ---
  setMasterVolume: (v: number) => void
  // Peak-normalize a clip to -1 dBFS using the cached waveform (logged: peak,
  // not LUFS).
  normalizeClip: (clipId: string) => Promise<void>

  // --- audio sugar (session 9, Phase 7) ---
  // Fades write ordinary volume keyframes — preview and export already honor them.
  addFade: (clipId: string, edge: 'in' | 'out', dur?: number) => void
  // Replace the clip's volume keyframes with a ducking envelope (computed
  // externally from sibling waveforms).
  applyDuckingEnvelope: (clipId: string, points: { t: number; v: number }[]) => void

  // --- tracks (session 9, Phase 3) ---
  addTrack: (kind: 'video' | 'audio') => void
  renameTrack: (trackId: string, name: string) => void
  setTrackFlag: (
    trackId: string,
    flag: 'muted' | 'solo' | 'locked' | 'hidden' | 'targeted' | 'syncLocked',
    v: boolean,
  ) => void
  setTrackGain: (trackId: string, v: number) => void
  // Track-level audio effects (Phase 6).
  setTrackEffects: (trackId: string, effects: Effect[]) => void
  // LUFS loudness normalize (Phase 6): measure integrated loudness, gain to
  // −14 LUFS. Peak normalize can't fix quiet-but-spiky; this can.
  normalizeLoudness: (clipId: string) => Promise<void>
  // Color matte (pro-editor session, Phase 1): a canvas-sized solid — title
  // cards, backgrounds. Rides the existing shape/raster path.
  addSolidClip: (color?: string) => void
  // Move a track one slot up/down in DISPLAY order (swaps z with the neighbor).
  reorderTrack: (trackId: string, dir: 1 | -1) => void

  // --- markers ---
  addMarkerAtPlayhead: () => void
  renameMarker: (id: string, label: string) => void
  deleteMarker: (id: string) => void
  setPxPerSec: (v: number) => void
  setSnap: (v: boolean) => void

  // --- canvas & export ---
  setCanvasPreset: (preset: CanvasPresetId | { width: number; height: number }) => void
  setCanvasFps: (fps: number) => void
  setSafeZones: (v: boolean) => void
  guides: boolean
  setGuides: (v: boolean) => void
  setExportOpen: (v: boolean) => void
  mixerOpen: boolean
  setMixerOpen: (v: boolean) => void
  scopesOpen: boolean
  setScopesOpen: (v: boolean) => void
  setExportSettings: (patch: Partial<ExportSettings>) => void
  setTimelineHeight: (h: number) => void
  setPropsWidth: (w: number) => void
  setCompositorStatus: (active: boolean, fps: number) => void
  setPreviewFull: (v: boolean) => void
  setProjectPath: (path: string | null) => void
  // Load a project bundle (or New Project): wholesale replacement, fresh history.
  replaceProject: (project: Project, path: string | null) => void
  selectAllClips: () => void
  addProjectFont: (font: ProjectFont) => void

  // Spike scaffolding: loads the flagship PiP demo (CONTEXT.md §2.3) as real,
  // editable clips + keyframes. Wipes existing timeline clips (single undo step).
  loadPipDemo: (screen: SpikeMediaInput, cam: SpikeMediaInput) => void
}

export interface SpikeMediaInput {
  path: string
  playbackUrl: string
  width: number
  height: number
  duration: number
}

function clampPlayhead(t: number, p: Project): number {
  return Math.min(Math.max(0, t), Math.max(p.duration, 0))
}

// Make room for a clip landing on [start, start+dur) (foundation, Phase 2).
// insert: split anything straddling `start`, ripple the track right.
// overwrite: carve the range out of whatever occupies it (Premiere semantics).
function prepareSpan(
  track: Track,
  start: number,
  dur: number,
  mode: 'insert' | 'overwrite',
  fps: number,
  mkId: () => string,
) {
  const end = start + dur
  const eps = 1e-9
  const trimRight = (c: Clip, at: number) => {
    // keep [c.start, at)
    if (c.mediaId) c.out = c.in + (at - c.start) * c.speed
    else c.out = (at - c.start) * c.speed
    c.keyframes = c.keyframes.filter((k) => k.t <= at - c.start + eps)
    c.transitions = { in: c.transitions.in, out: null }
  }
  const trimLeft = (c: Clip, at: number) => {
    // keep [at, clipEnd)
    const delta = at - c.start
    if (c.mediaId) c.in += delta * c.speed
    else c.out -= delta * c.speed
    c.start = snapToFrame(at, fps)
    c.keyframes = c.keyframes.map((k) => ({ ...k, t: k.t - delta })).filter((k) => k.t >= 0)
    c.transitions = { in: null, out: c.transitions.out }
  }

  if (mode === 'insert') {
    for (const c of [...track.clips]) {
      if (c.start < start - eps && clipEnd(c) > start + eps) {
        // straddles the insert point: split into head + tail
        const tail = structuredClone(current(c)) as Clip
        tail.id = mkId()
        trimLeft(tail, start)
        trimRight(c, start)
        track.clips.push(tail)
      }
    }
    for (const c of track.clips)
      if (c.start >= start - eps) c.start = snapToFrame(c.start + dur, fps)
    return
  }

  // overwrite
  const survivors: Clip[] = []
  for (const c of [...track.clips]) {
    const cs = c.start
    const ce = clipEnd(c)
    if (ce <= start + eps || cs >= end - eps) {
      survivors.push(c)
      continue
    }
    const keepsLeft = cs < start - eps
    const keepsRight = ce > end + eps
    if (keepsLeft && keepsRight) {
      const tail = structuredClone(current(c)) as Clip
      tail.id = mkId()
      trimLeft(tail, end)
      trimRight(c, start)
      survivors.push(c, tail)
    } else if (keepsLeft) {
      trimRight(c, start)
      survivors.push(c)
    } else if (keepsRight) {
      trimLeft(c, end)
      survivors.push(c)
    }
    // fully covered → dropped
  }
  track.clips = survivors
}

export const useStore = create<StoreState>()(
  immer((set, get) => {
    // Every project mutation goes through here; history unless opted out.
    const mutateProject = (fn: (p: Project) => void, opts?: { history?: boolean }) =>
      set((s) => {
        // ONE PROMPT = ONE UNDO STEP (Run 1, Phase 3 — the AI trust model):
        // inside an AI transaction the FIRST mutation snapshots history and
        // every further mutation coalesces into it. The AI calls the same
        // store actions the UI does; this flag is the only difference.
        if (aiTxDepth > 0) {
          if (!aiTxSnapshotTaken && opts?.history !== false) {
            s.past.push(structuredClone(current(s.project)))
            if (s.past.length > HISTORY_LIMIT) s.past.shift()
            s.future = []
            aiTxSnapshotTaken = true
          }
        } else if (opts?.history !== false) {
          s.past.push(structuredClone(current(s.project)))
          if (s.past.length > HISTORY_LIMIT) s.past.shift()
          s.future = []
        }
        fn(s.project as Project)
        s.project.duration = computeDuration(s.project as Project)
        s.dirty = true // any mutation = unsaved changes (session 9, Phase 6)
      })

    return {
      project: createProject(),
      past: [],
      future: [],

      playhead: 0,
      playing: false,
      shuttle: 1,
      selection: [],
      pxPerSec: 60,
      snap: true,
      safeZones: false,
      exportOpen: false,
      exportSettings: { width: 1920, height: 1080, fps: 30, format: 'mp4', quality: 80 },
      appView: 'boot',
      setAppView: (v) =>
        set((s) => {
          s.appView = v
        }),

      toasts: [],
      pushToast: (kind, text, id, action) => {
        const tid = id ?? uid('toast')
        set((s) => {
          const existing = s.toasts.find((t) => t.id === tid)
          if (existing) {
            existing.kind = kind
            existing.text = text
            existing.action = action
          } else {
            s.toasts.push({ id: tid, kind, text, action })
          }
        })
        return tid
      },
      updateToast: (id, patch) =>
        set((s) => {
          const t = s.toasts.find((x) => x.id === id)
          if (t) Object.assign(t, patch)
        }),
      dismissToast: (id) =>
        set((s) => {
          s.toasts = s.toasts.filter((t) => t.id !== id)
        }),

      dirty: false,
      markSaved: () =>
        set((s) => {
          s.dirty = false
        }),
      markDirty: () =>
        set((s) => {
          s.dirty = true
        }),
      unsavedOpen: false,
      setUnsavedOpen: (v) =>
        set((s) => {
          s.unsavedOpen = v
        }),

      clipboard: [],
      copyClips: (ids) =>
        set((s) => {
          const clips = s.project.tracks
            .flatMap((t) => t.clips)
            .filter((c) => ids.includes(c.id))
            .map((c) => structuredClone(current(c)) as Clip)
          if (clips.length) s.clipboard = clips
        }),
      cutClips: (ids) => {
        get().copyClips(ids)
        if (get().clipboard.length) get().deleteClips(ids)
      },
      pasteAtPlayhead: () =>
        mutateProject((p) => {
          const s = useStore.getState()
          if (!s.clipboard.length) return
          const minStart = Math.min(...s.clipboard.map((c) => c.start))
          const at = snapToFrame(s.playhead, p.canvas.fps)
          for (const src of s.clipboard) {
            const copy: Clip = structuredClone(src)
            copy.id = uid('c')
            delete copy.linkId // pasted halves aren't linked to originals
            const kind: 'video' | 'audio' = copy.kind === 'audio' ? 'audio' : 'video'
            const track =
              p.tracks.find((t) => t.kind === kind && t.targeted && !t.locked) ??
              p.tracks.find((t) => t.kind === kind && !t.locked) ??
              undefined
            if (!track) continue
            const dur = clipDuration(copy)
            const desired = at + (src.start - minStart)
            const siblings = track.clips.map((c) => ({ start: c.start, end: clipEnd(c) }))
            const placed = clampStartToGaps(siblings, dur, desired)
            if (placed === null) continue
            copy.start = snapToFrame(placed, p.canvas.fps)
            track.clips.push(copy)
          }
        }),

      timelineHeight: 220,
      propsWidth: 264,
      compositorActive: false,
      previewOriginal: false,
      setPreviewOriginal: (v) =>
        set((s) => {
          s.previewOriginal = v
        }),
      dialog: null,
      setDialog: (d) =>
        set((s) => {
          s.dialog = d
        }),
      prefs: {
        autosaveSecs: 30,
        autoProxy: true,
        aiChatProvider: 'anthropic',
        aiChatModel: 'claude-sonnet-4-5',
        aiVideoProvider: 'none',
      },
      setPrefs: (patch) =>
        set((s) => {
          Object.assign(s.prefs, patch)
        }),
      compositorFps: 0,
      projectPath: null,
      previewFull: false,

      undo: () =>
        set((s) => {
          const prev = s.past.pop()
          if (!prev) return
          s.future.push(structuredClone(current(s.project)))
          s.project = prev
          s.playhead = clampPlayhead(s.playhead, s.project as Project)
          s.selection = s.selection.filter((id) => findClip(s.project as Project, id))
        }),

      redo: () =>
        set((s) => {
          const next = s.future.pop()
          if (!next) return
          s.past.push(structuredClone(current(s.project)))
          s.project = next
          s.playhead = clampPlayhead(s.playhead, s.project as Project)
          s.selection = s.selection.filter((id) => findClip(s.project as Project, id))
        }),

      beginGesture: () =>
        set((s) => {
          s.past.push(structuredClone(current(s.project)))
          if (s.past.length > HISTORY_LIMIT) s.past.shift()
          s.future = []
        }),

      addMedia: (asset) => mutateProject((p) => void p.media.push(asset)),

      updateMedia: (id, patch) =>
        mutateProject(
          (p) => {
            const m = p.media.find((a) => a.id === id)
            if (m) Object.assign(m, patch)
          },
          { history: false }, // metadata refinement, not a user edit
        ),

      appendMediaClip: (mediaId) =>
        mutateProject((p) => {
          const asset = p.media.find((a) => a.id === mediaId)
          if (!asset) return
          const kind = asset.kind
          // Append at the end of the last (bottom) track of matching kind.
          const tracks = p.tracks.filter((t) => t.kind === kind)
          const track = tracks[tracks.length - 1]
          if (!track) return
          const end = track.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0)
          track.clips.push({
            id: uid('c'),
            kind,
            mediaId,
            start: snapToFrame(end, p.canvas.fps),
            in: 0,
            out: asset.duration,
            speed: 1,
            volume: 1,
            transform: defaultTransform(),
            keyframes: [],
            transitions: { in: null, out: null },
            effects: [],
          })
        }),

      leftPanel: 'media' as LeftPanel,
      setLeftPanel: (p) =>
        set((s) => {
          s.leftPanel = p
          s.binOpen = p === 'media'
        }),
      aiConfigured: false,
      lastGenPrompt: null,
      setLastGenPrompt: (p) =>
        set((s) => {
          s.lastGenPrompt = p
        }),
      chatLog: [],
      chatBusy: false,
      pushChatEntry: (e) =>
        set((s) => {
          s.chatLog.push(e)
        }),
      updateChatEntry: (id, patch) =>
        set((s) => {
          const e = s.chatLog.find((x) => x.id === id)
          if (e) Object.assign(e, patch)
        }),
      setChatBusy: (v) =>
        set((s) => {
          s.chatBusy = v
        }),
      setChatLog: (log) =>
        set((s) => {
          s.chatLog = log
        }),
      setAiConfigured: (v) =>
        set((s) => {
          s.aiConfigured = v
        }),
      binOpen: true,
      setBinOpen: (v) =>
        set((s) => {
          s.binOpen = v
          s.leftPanel = v ? 'media' : null
        }),

      insertClipAt: (mediaId, trackId, at, range) =>
        mutateProject((p) => {
          const asset = p.media.find((a) => a.id === mediaId)
          if (!asset) return
          // Wrong-kind lane (or no lane): fall back to the first matching track.
          let track = trackId ? p.tracks.find((t) => t.id === trackId) : undefined
          if (!track || track.kind !== asset.kind || track.locked)
            track =
              // Track targeting (Phase 4): targeted lane wins when no
              // explicit lane was given.
              p.tracks.find((t) => t.kind === asset.kind && t.targeted && !t.locked) ??
              p.tracks.find((t) => t.kind === asset.kind && !t.locked)
          if (!track) return
          const still = /\.(png|jpe?g)$/i.test(asset.path)
          const inPt = range ? Math.max(0, range.in) : 0
          const outPt = range ? range.out : still ? 3 : asset.duration
          const dur = outPt - inPt
          if (dur <= 0) return
          const start = snapToFrame(Math.max(0, at), p.canvas.fps)
          // Insert/overwrite semantics (foundation, Phase 2): the clip lands
          // exactly where dropped; prepareSpan makes the room.
          prepareSpan(track, start, dur, useStore.getState().editMode, p.canvas.fps, () =>
            uid('c'),
          )
          track.clips.push({
            id: uid('c'),
            kind: asset.kind,
            mediaId,
            start,
            in: inPt,
            out: outPt,
            speed: 1,
            volume: 1,
            transform: defaultTransform(),
            keyframes: [],
            transitions: { in: null, out: null },
            effects: [],
          })
        }),

      removeMedia: (mediaId) => {
        mutateProject((p) => {
          p.media = p.media.filter((m) => m.id !== mediaId)
          for (const t of p.tracks) t.clips = t.clips.filter((c) => c.mediaId !== mediaId)
        })
        set((s) => {
          s.selection = s.selection.filter((id) => findClip(s.project as Project, id))
        })
      },

      addStillClip: (asset, at) =>
        mutateProject((p) => {
          p.media.push(asset)
          const track = p.tracks
            .filter((t) => t.kind === 'video')
            .sort((a, b) => b.z - a.z)[0]
          if (!track) return
          const dur = 3
          const siblings = track.clips.map((c) => ({ start: c.start, end: clipEnd(c) }))
          const start =
            clampStartToGaps(siblings, dur, snapToFrame(at, p.canvas.fps)) ??
            track.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0)
          track.clips.push({
            id: uid('c'),
            kind: 'video',
            mediaId: asset.id,
            start,
            in: 0,
            out: dur,
            speed: 1,
            volume: 1,
            transform: defaultTransform(),
            keyframes: [],
            transitions: { in: null, out: null },
            effects: [],
          })
        }),

      moveClip: (clipId, start, trackId, transient) =>
        mutateProject(
          (p) => {
            const found = findClip(p, clipId)
            if (!found || found.track.locked) return
            const { track, clip, index } = found
            const target = trackId ? p.tracks.find((t) => t.id === trackId) : track
            if (!target || target.kind !== track.kind) return
            const dur = clipDuration(clip)
            const siblings = target.clips
              .filter((c) => c.id !== clipId)
              .map((c) => ({ start: c.start, end: clipEnd(c) }))
            const placed = clampStartToGaps(siblings, dur, snapToFrame(start, p.canvas.fps))
            if (placed === null) return
            clip.start = snapToFrame(placed, p.canvas.fps)
            if (target !== track) {
              track.clips.splice(index, 1)
              target.clips.push(clip)
            }
          },
          { history: transient ? false : true },
        ),

      moveClipsTo: (entries, transient) =>
        mutateProject(
          (p) => {
            const ids = new Set(entries.map((e) => e.id))
            const moves: { clip: Clip; from: Track; to: Track; start: number }[] = []
            for (const e of entries) {
              const found = findClip(p, e.id)
              if (!found || found.track.locked) return
              const to = e.trackId ? p.tracks.find((t) => t.id === e.trackId) : found.track
              if (!to || to.locked) return
              const kind = found.clip.kind === 'audio' ? 'audio' : 'video'
              if (to.kind !== kind) return
              moves.push({
                clip: found.clip,
                from: found.track,
                to,
                start: snapToFrame(Math.max(0, e.start), p.canvas.fps),
              })
            }
            // All-or-nothing: collisions are checked on each clip's TARGET
            // track against outsiders + group members landing there too.
            for (const m of moves) {
              const end = m.start + clipDuration(m.clip)
              const occupants = [
                ...m.to.clips
                  .filter((c) => !ids.has(c.id))
                  .map((c) => ({ s: c.start, e: clipEnd(c) })),
                ...moves
                  .filter((o) => o.clip.id !== m.clip.id && o.to.id === m.to.id)
                  .map((o) => ({ s: o.start, e: o.start + clipDuration(o.clip) })),
              ]
              if (occupants.some((o) => m.start < o.e - 1e-6 && end > o.s + 1e-6)) return
            }
            for (const m of moves) {
              m.clip.start = m.start
              if (m.to.id !== m.from.id) {
                const i = m.from.clips.indexOf(m.clip)
                if (i >= 0) m.from.clips.splice(i, 1)
                m.to.clips.push(m.clip)
              }
            }
          },
          { history: transient ? false : true },
        ),

      trimClip: (clipId, edge, timelineTime, transient) =>
        mutateProject(
          (p) => {
            const found = findClip(p, clipId)
            if (!found || found.track.locked) return
            const { track, clip } = found
            const fps = p.canvas.fps
            const minDur = 1 / fps
            const asset = clip.mediaId ? p.media.find((m) => m.id === clip.mediaId) : null
            const t = snapToFrame(timelineTime, fps)
            const end = clipEnd(clip)
            const siblings = track.clips.filter((c) => c.id !== clipId)

            if (edge === 'in') {
              // Left edge: end stays fixed. Media clips shift `in`; text shrinks duration.
              const prevEnd = siblings
                .filter((c) => clipEnd(c) <= clip.start + 1e-6)
                .reduce((m, c) => Math.max(m, clipEnd(c)), 0)
              let newStart = Math.max(prevEnd, Math.min(t, end - minDur))
              if (clip.mediaId) {
                // Can't reveal media before source 0.
                const earliest = clip.start - clip.in / clip.speed
                newStart = Math.max(newStart, earliest)
              }
              newStart = snapToFrame(newStart, fps)
              const delta = newStart - clip.start
              if (clip.mediaId) clip.in += delta * clip.speed
              else clip.out = (end - newStart) * clip.speed
              clip.start = newStart
              // Keyframes are clip-relative: shift by -delta so they hold their
              // absolute timeline positions; drop any now before the clip.
              if (delta !== 0)
                clip.keyframes = clip.keyframes
                  .map((k) => ({ ...k, t: k.t - delta }))
                  .filter((k) => k.t >= 0)
            } else {
              // Right edge: start stays fixed.
              const nextStart = siblings
                .filter((c) => c.start >= end - 1e-6)
                .reduce((m, c) => Math.min(m, c.start), Infinity)
              let newEnd = Math.min(nextStart, Math.max(t, clip.start + minDur))
              if (asset) {
                const latest = clip.start + (asset.duration - clip.in) / clip.speed
                newEnd = Math.min(newEnd, latest)
              }
              newEnd = snapToFrame(newEnd, fps)
              clip.out = clip.in + (newEnd - clip.start) * clip.speed
              const dur = clipDuration(clip)
              clip.keyframes = clip.keyframes.filter((k) => k.t <= dur)
            }
            // Text animations anchor to the clip edges; re-derive after resize.
            if (clip.kind === 'text') expandTextAnimation(clip)
          },
          { history: transient ? false : true },
        ),

      // ---- Phase 4 trim tools ----

      rippleTrim: (clipId, edge, timelineTime, transient) =>
        mutateProject(
          (p) => {
            const found = findClip(p, clipId)
            if (!found || found.track.locked) return
            const { clip, track } = found
            const fps = p.canvas.fps
            const minDur = 1 / fps
            const oldStart = clip.start
            const oldEnd = clipEnd(clip)
            const t = snapToFrame(timelineTime, fps)
            // The edit point everything downstream is measured from.
            const point = edge === 'out' ? oldEnd : oldStart

            // 1. Desired delta from the edge trim, clamped by media/minDur.
            let delta: number
            if (edge === 'out') {
              let newEnd = Math.max(oldStart + minDur, t)
              if (clip.mediaId) {
                const asset = p.media.find((m) => m.id === clip.mediaId)
                const maxEnd = asset
                  ? oldStart + (asset.duration - clip.in) / clip.speed
                  : newEnd
                newEnd = Math.min(newEnd, maxEnd)
              }
              delta = snapToFrame(newEnd, fps) - oldEnd
            } else {
              let newStart = Math.min(t, oldEnd - minDur)
              if (clip.mediaId) newStart = Math.max(newStart, oldStart - clip.in / clip.speed)
              newStart = Math.max(0, snapToFrame(newStart, fps))
              // ripple-in: downstream shifts by -(newStart - oldStart)
              delta = -(newStart - oldStart)
            }
            if (Math.abs(delta) < 1e-9) return

            // 2. Downstream = clips starting at/after the edit point on this
            // track and every sync-locked unlocked track. Left-shifts clamp
            // against straddlers so the ripple hits a wall instead of
            // overlapping (all tracks share ONE clamped delta — sync).
            const participates = (tr: Track) =>
              tr === track || ((tr.syncLocked ?? true) && !tr.locked)
            if (delta < 0) {
              let maxShift = -delta
              // Per participating track: the first downstream clip may shift
              // left until it touches the latest non-downstream clip end
              // (straddlers/predecessors form the wall); the edited track's
              // wall includes the freshly trimmed edge. One shared clamped
              // delta keeps every track in sync.
              for (const tr of p.tracks) {
                if (!participates(tr)) continue
                const downstream = tr.clips
                  .filter((c) => c.id !== clip.id && c.start >= point - 1e-6)
                  .sort((a, b) => a.start - b.start)
                if (!downstream.length) continue
                const firstStart = downstream[0].start
                let wall = 0
                for (const c of tr.clips) {
                  if (c.id === clip.id || c.start >= point - 1e-6) continue
                  wall = Math.max(wall, clipEnd(c))
                }
                if (tr === track && edge === 'out') wall = Math.max(wall, oldEnd + delta)
                if (tr === track && edge === 'in') wall = Math.max(wall, 0)
                maxShift = Math.min(maxShift, Math.max(0, firstStart - wall))
              }
              delta = -maxShift
              if (maxShift < 1e-9) return
            }

            // 3. Apply the edge trim with the FINAL clamped delta.
            if (edge === 'out') {
              if (clip.mediaId) clip.out = clip.in + (oldEnd + delta - oldStart) * clip.speed
              else clip.out = (oldEnd + delta - oldStart) * clip.speed
              clip.keyframes = clip.keyframes.filter((k) => k.t <= oldEnd + delta - oldStart + 1e-6)
            } else {
              // Ripple-in: the head is trimmed AND the gap closes into the
              // clip — its start stays anchored; only the source window and
              // keyframes shift (content moves left on the timeline).
              const shift = -delta
              if (clip.mediaId) clip.in += shift * clip.speed
              else clip.out -= shift * clip.speed
              clip.keyframes = clip.keyframes
                .map((k) => ({ ...k, t: k.t - shift }))
                .filter((k) => k.t >= -1e-6)
            }

            // 4. Shift downstream.
            for (const tr of p.tracks) {
              if (!participates(tr)) continue
              for (const c of tr.clips) {
                if (c.id === clip.id) continue
                if (c.start >= point - 1e-6) c.start = snapToFrame(c.start + delta, fps)
              }
            }
          },
          { history: transient ? false : true },
        ),

      rollEdit: (leftClipId, timelineTime, transient) =>
        mutateProject(
          (p) => {
            const found = findClip(p, leftClipId)
            if (!found || found.track.locked) return
            const { clip: left, track } = found
            const fps = p.canvas.fps
            const minDur = 1 / fps
            const boundary = clipEnd(left)
            const right = track.clips.find(
              (c) => c.id !== left.id && Math.abs(c.start - boundary) < 1 / fps / 2,
            )
            if (!right) return // roll needs an adjacent cut

            let b = snapToFrame(timelineTime, fps)
            // Clamps: min durations + both media bounds.
            b = Math.max(b, left.start + minDur)
            b = Math.min(b, clipEnd(right) - minDur)
            if (left.mediaId) {
              const asset = p.media.find((m) => m.id === left.mediaId)
              if (asset) b = Math.min(b, left.start + (asset.duration - left.in) / left.speed)
            }
            if (right.mediaId) b = Math.max(b, right.start - right.in / right.speed)
            b = snapToFrame(b, fps)
            const delta = b - boundary
            if (Math.abs(delta) < 1e-9) return

            // Left keeps its start; its out point moves.
            if (left.mediaId) left.out += delta * left.speed
            else left.out = (b - left.start) * left.speed
            left.keyframes = left.keyframes.filter((k) => k.t <= b - left.start + 1e-6)
            // Right's in-edge moves; keyframes hold absolute positions.
            if (right.mediaId) right.in += delta * right.speed
            else right.out -= delta * right.speed
            right.start = b
            right.keyframes = right.keyframes
              .map((k) => ({ ...k, t: k.t - delta }))
              .filter((k) => k.t >= -1e-6)
          },
          { history: transient ? false : true },
        ),

      slipClip: (clipId, deltaSrc, transient) =>
        mutateProject(
          (p) => {
            const found = findClip(p, clipId)
            if (!found || found.track.locked) return
            const { clip } = found
            if (!clip.mediaId) return // only source-backed clips can slip
            const asset = p.media.find((m) => m.id === clip.mediaId)
            if (!asset) return
            // Shift the source window; timeline position/duration UNCHANGED.
            const d = Math.max(-clip.in, Math.min(deltaSrc, asset.duration - clip.out))
            if (Math.abs(d) < 1e-9) return
            clip.in += d
            clip.out += d
            // Keyframes are clip-relative → untouched, exactly as slip demands.
          },
          { history: transient ? false : true },
        ),

      slideClip: (clipId, deltaT, transient) =>
        mutateProject(
          (p) => {
            const found = findClip(p, clipId)
            if (!found || found.track.locked) return
            const { clip, track } = found
            const fps = p.canvas.fps
            const minDur = 1 / fps
            const half = 1 / fps / 2
            const start = clip.start
            const end = clipEnd(clip)
            const leftN = track.clips
              .filter((c) => c.id !== clip.id && clipEnd(c) <= start + half)
              .sort((a, b) => clipEnd(b) - clipEnd(a))[0]
            const rightN = track.clips
              .filter((c) => c.id !== clip.id && c.start >= end - half)
              .sort((a, b) => a.start - b.start)[0]
            const leftAdj = !!leftN && Math.abs(clipEnd(leftN) - start) < half
            const rightAdj = !!rightN && Math.abs(rightN.start - end) < half

            let d = deltaT
            // Left side: adjacent neighbor's out-edge absorbs (media + minDur
            // limits); with a gap, sliding left stops at the neighbor's end.
            if (d > 0) {
              if (leftAdj && leftN.mediaId) {
                const asset = p.media.find((m) => m.id === leftN.mediaId)
                if (asset)
                  d = Math.min(d, (asset.duration - leftN.out) / leftN.speed)
              }
              if (rightAdj) d = Math.min(d, clipDuration(rightN) - minDur)
              else if (rightN) d = Math.min(d, rightN.start - end)
            } else {
              if (leftAdj) d = Math.max(d, -(clipDuration(leftN) - minDur))
              else if (leftN) d = Math.max(d, clipEnd(leftN) - start)
              else d = Math.max(d, -start)
              if (rightAdj && rightN.mediaId) {
                d = Math.max(d, -(rightN.in / rightN.speed))
              }
            }
            d = snapToFrame(clip.start + d, fps) - clip.start
            if (Math.abs(d) < 1e-9) return

            clip.start = snapToFrame(clip.start + d, fps)
            if (leftAdj) {
              if (leftN.mediaId) leftN.out += d * leftN.speed
              else leftN.out = (clip.start - leftN.start) * leftN.speed
              leftN.keyframes = leftN.keyframes.filter(
                (k) => k.t <= clip.start - leftN.start + 1e-6,
              )
            }
            if (rightAdj) {
              const shift = d
              if (rightN.mediaId) rightN.in += shift * rightN.speed
              else rightN.out -= shift * rightN.speed
              rightN.start = snapToFrame(rightN.start + shift, fps)
              rightN.keyframes = rightN.keyframes
                .map((k) => ({ ...k, t: k.t - shift }))
                .filter((k) => k.t >= -1e-6)
            }
          },
          { history: transient ? false : true },
        ),

      tool: 'select',
      setTool: (t) =>
        set((s) => {
          s.tool = t
        }),

      splitClip: (clipId, at) =>
        mutateProject((p) => {
          const found = findClip(p, clipId)
          if (!found || found.track.locked) return
          const { track, clip, index } = found
          const fps = p.canvas.fps
          const t = snapToFrame(at, fps)
          if (t <= clip.start + 1 / fps / 2 || t >= clipEnd(clip) - 1 / fps / 2) return
          const rel = t - clip.start
          const second: Clip = structuredClone(current(clip)) as Clip
          second.id = uid('c')
          second.start = t
          if (clip.mediaId) {
            second.in = clip.in + rel * clip.speed
            clip.out = second.in
          } else {
            second.out = clip.out - rel * clip.speed
            clip.out = rel * clip.speed
          }
          clip.keyframes = clip.keyframes.filter((k) => k.t <= rel)
          second.keyframes = second.keyframes
            .filter((k) => k.t > rel)
            .map((k) => ({ ...k, t: k.t - rel }))
          second.transitions = { in: null, out: clip.transitions.out }
          clip.transitions = { in: clip.transitions.in, out: null }
          track.clips.splice(index + 1, 0, second)
        }),

      splitAtPlayhead: () => {
        const s = get()
        const t = s.playhead
        const p = s.project
        // Split selected clips under the playhead; if none selected, all under it.
        const candidates = p.tracks
          .flatMap((tr) => tr.clips)
          .filter((c) => c.start < t && t < clipEnd(c))
          .filter((c) => (s.selection.length ? s.selection.includes(c.id) : true))
        for (const c of candidates) get().splitClip(c.id, t)
      },

      deleteClips: (ids) =>
        mutateProject((p) => {
          for (const tr of p.tracks) {
            if (tr.locked) continue
            tr.clips = tr.clips.filter((c) => !ids.includes(c.id))
          }
        }),

      rippleDeleteClips: (ids) =>
        mutateProject((p) => {
          for (const tr of p.tracks) {
            if (tr.locked) continue
            const removed = tr.clips
              .filter((c) => ids.includes(c.id))
              .map((c) => ({ start: c.start, span: clipDuration(c) }))
              .sort((a, b) => a.start - b.start)
            if (!removed.length) continue
            tr.clips = tr.clips.filter((c) => !ids.includes(c.id))
            for (const c of tr.clips) {
              const shift = removed
                .filter((r) => r.start <= c.start)
                .reduce((sum, r) => sum + r.span, 0)
              if (shift > 0) c.start = snapToFrame(c.start - shift, p.canvas.fps)
            }
          }
        }),

      duplicateClip: (clipId) =>
        mutateProject((p) => {
          const found = findClip(p, clipId)
          if (!found || found.track.locked) return
          const { track, clip } = found
          const copy: Clip = structuredClone(current(clip)) as Clip
          copy.id = uid('c')
          const dur = clipDuration(clip)
          const siblings = track.clips.map((c) => ({ start: c.start, end: clipEnd(c) }))
          const placed = clampStartToGaps(siblings, dur, clipEnd(clip))
          if (placed === null) return
          copy.start = snapToFrame(placed, p.canvas.fps)
          track.clips.push(copy)
        }),

      detachAudio: (clipId) =>
        mutateProject((p) => {
          const found = findClip(p, clipId)
          if (!found) return
          const { clip } = found
          if (clip.kind !== 'video' || !clip.mediaId) return
          const asset = p.media.find((m) => m.id === clip.mediaId)
          if (!asset?.hasAudio) return
          // Already detached: the clip is silent and linked to an audio partner.
          if (
            clip.linkId &&
            p.tracks.some((t) =>
              t.clips.some((c) => c.linkId === clip.linkId && c.kind === 'audio'),
            )
          )
            return

          const linkId = clip.linkId ?? uid('link')
          const audioClip: Clip = {
            id: uid('c'),
            kind: 'audio',
            mediaId: clip.mediaId,
            start: clip.start,
            in: clip.in,
            out: clip.out,
            speed: clip.speed,
            volume: clip.volume,
            transform: defaultTransform(),
            // Volume keyframes belong to the audio half now.
            keyframes: clip.keyframes.filter((k) => k.prop === 'volume'),
            transitions: { in: null, out: null },
            effects: [],
            linkId,
          }

          // Place at the same timeline position: first audio track with a free
          // slot there; otherwise add a new audio track.
          const dur = clipDuration(audioClip)
          let target = p.tracks.find(
            (t) =>
              t.kind === 'audio' &&
              !t.clips.some((c) => audioClip.start < clipEnd(c) && c.start < audioClip.start + dur),
          )
          if (!target) {
            const z = p.tracks.filter((t) => t.kind === 'audio').length
            target = { id: uid('t'), kind: 'audio', z, name: `A${z + 1}`, clips: [] }
            p.tracks.push(target)
          }
          target.clips.push(audioClip)

          clip.linkId = linkId
          clip.volume = 0
          clip.keyframes = clip.keyframes.filter((k) => k.prop !== 'volume')
        }),

      setClipProperty: (clipId, prop, value, transient) =>
        mutateProject(
          (p) => {
          const found = findClip(p, clipId)
          if (!found || found.track.locked) return
          const { track, clip } = found
          const fps = p.canvas.fps

          const speedRamped = clip.keyframes.some((k) => k.prop === 'speed')
          if (prop === 'speed' && typeof value === 'number' && !speedRamped) {
            // Flat speed: duration-preserving trim below. Once 'speed' is
            // ARMED (keyframes exist) the generic stopwatch path below writes
            // ramp keyframes instead — the clip window stays fixed (ramps
            // remap time within it; session 9, Phase 7 decision).
            const speed = Math.min(16, Math.max(0.0625, value))
            clip.speed = speed
            // Speed changes duration; shrink `out` if we'd overlap the next clip.
            const nextStart = track.clips
              .filter((c) => c.id !== clipId && c.start >= clip.start + 1e-6)
              .reduce((m, c) => Math.min(m, c.start), Infinity)
            if (clipEnd(clip) > nextStart)
              clip.out = clip.in + (nextStart - clip.start) * clip.speed
            return
          }

          const playheadRel = useStore.getState().playhead - clip.start
          const isNumeric = typeof value === 'number'
          const hasKfs = clip.keyframes.some((k) => k.prop === prop)

          if (isNumeric && hasKfs) {
            // Armed: writing the value creates/updates a keyframe at the playhead.
            const t = snapToFrame(Math.min(Math.max(0, playheadRel), clipDuration(clip)), fps)
            const existing = clip.keyframes.find(
              (k) => k.prop === prop && Math.abs(k.t - t) < 1 / fps / 2,
            )
            if (existing) existing.v = value
            else clip.keyframes.push({ prop, t, v: value, ease: 'easeInOut' })
            return
          }

          if (prop === 'volume' && isNumeric) clip.volume = value
          else if (prop === 'pan' && isNumeric) clip.pan = Math.min(1, Math.max(-1, value))
          else if (prop.startsWith('fx.') && isNumeric) {
            // Effect-stack param (Phase 2): fx.<effectId>.<param>.
            const [, id, param] = prop.split('.')
            const fx = clip.effects.find((e) => e.id === id)
            if (fx) fx.params[param] = value
          } else if (prop.startsWith('transform.')) {
            const key = prop.slice('transform.'.length)
            ;(clip.transform as unknown as Record<string, unknown>)[key] = value
          }
          },
          { history: transient ? false : true }, // label scrubs coalesce via beginGesture
        ),

      writeKeyframe: (clipId, prop, relT, v, ease = 'easeInOut') =>
        mutateProject((p) => {
          const found = findClip(p, clipId)
          if (!found || found.track.locked) return
          const { clip } = found
          const fps = p.canvas.fps
          const t = snapToFrame(Math.min(Math.max(0, relT), clipDuration(clip)), fps)
          const existing = clip.keyframes.find(
            (k) => k.prop === prop && Math.abs(k.t - t) < 1 / fps / 2,
          )
          if (existing) {
            existing.v = v
            existing.ease = ease
          } else {
            clip.keyframes.push({ prop, t, v, ease })
          }
        }),

      toggleKeyframe: (clipId, prop) =>
        mutateProject((p) => {
          const found = findClip(p, clipId)
          if (!found || found.track.locked) return
          const { clip } = found
          const fps = p.canvas.fps
          const rel = snapToFrame(
            Math.min(Math.max(0, useStore.getState().playhead - clip.start), clipDuration(clip)),
            fps,
          )
          const idx = clip.keyframes.findIndex(
            (k) => k.prop === prop && Math.abs(k.t - rel) < 1 / fps / 2,
          )
          if (idx >= 0) clip.keyframes.splice(idx, 1)
          else
            clip.keyframes.push({
              prop,
              t: rel,
              v: resolveProp(current(clip) as Clip, prop, rel),
              ease: 'easeInOut',
            })
        }),

      clearKeyframes: (clipId, prop) =>
        mutateProject((p) => {
          const found = findClip(p, clipId)
          if (!found) return
          found.clip.keyframes = found.clip.keyframes.filter((k) => k.prop !== prop)
        }),

      setKeyframeEase: (clipId, prop, t, ease) =>
        mutateProject((p) => {
          const found = findClip(p, clipId)
          if (!found) return
          const kf = found.clip.keyframes.find(
            (k) => k.prop === prop && Math.abs(k.t - t) < 1 / p.canvas.fps / 2,
          )
          if (kf) kf.ease = ease
        }),

      graphOpen: false,
      setGraphOpen: (v) =>
        set((s) => {
          s.graphOpen = v
        }),

      moveKeyframes: (clipId, moves, transient) =>
        mutateProject(
          (p) => {
            const found = findClip(p, clipId)
            if (!found || found.track.locked) return
            const { clip } = found
            const fps = p.canvas.fps
            const dur = clipDuration(clip)
            const half = 1 / fps / 2
            // Two-phase: pull the moving keyframes out, then reinsert at
            // their targets (replacing any non-moving occupant — standard
            // graph-editor overwrite semantics).
            const moving: { kf: Keyframe; toT: number; toV: number }[] = []
            for (const m of moves) {
              const kf = clip.keyframes.find(
                (k) => k.prop === m.prop && Math.abs(k.t - m.fromT) < half,
              )
              if (!kf) continue
              moving.push({
                kf,
                toT: snapToFrame(Math.min(Math.max(0, m.toT), dur), fps),
                toV: m.toV,
              })
            }
            const movingSet = new Set(moving.map((m) => m.kf))
            for (const m of moving) {
              clip.keyframes = clip.keyframes.filter(
                (k) =>
                  movingSet.has(k) ||
                  k.prop !== m.kf.prop ||
                  Math.abs(k.t - m.toT) >= half,
              )
              m.kf.t = m.toT
              m.kf.v = m.toV
            }
          },
          { history: transient ? false : true },
        ),

      deleteKeyframes: (clipId, keys) =>
        mutateProject((p) => {
          const found = findClip(p, clipId)
          if (!found || found.track.locked) return
          const fps = p.canvas.fps
          found.clip.keyframes = found.clip.keyframes.filter(
            (k) =>
              !keys.some((d) => d.prop === k.prop && Math.abs(d.t - k.t) < 1 / fps / 2),
          )
        }),

      setKeyframeHandle: (clipId, prop, t, which, h, transient) =>
        mutateProject(
          (p) => {
            const found = findClip(p, clipId)
            if (!found || found.track.locked) return
            const kf = found.clip.keyframes.find(
              (k) => k.prop === prop && Math.abs(k.t - t) < 1 / p.canvas.fps / 2,
            )
            if (!kf) return
            if (which === 'ho') kf.ho = [Math.max(0, h[0]), h[1]]
            else kf.hi = [Math.min(0, h[0]), h[1]]
          },
          { history: transient ? false : true },
        ),

      convertToBezier: (clipId, prop, t) =>
        mutateProject((p) => {
          const found = findClip(p, clipId)
          if (!found || found.track.locked) return
          const kfs = found.clip.keyframes
            .filter((k) => k.prop === prop)
            .sort((a, b) => a.t - b.t)
          const i = kfs.findIndex((k) => Math.abs(k.t - t) < 1 / p.canvas.fps / 2)
          if (i < 0 || i >= kfs.length - 1) return // needs an outgoing segment
          const k1 = kfs[i]
          const k2 = kfs[i + 1]
          if (k1.ease === 'bezier') return
          const conv = presetHandles(k1.ease, k1, k2) ?? {
            ho: [(k2.t - k1.t) / 3, (k2.v - k1.v) / 3] as [number, number],
            hi: [-(k2.t - k1.t) / 3, -(k2.v - k1.v) / 3] as [number, number],
          }
          k1.ease = 'bezier'
          k1.ho = conv.ho
          k2.hi = conv.hi
        }),

      setTransition: (clipId, edge, transition) =>
        mutateProject((p) => {
          const found = findClip(p, clipId)
          if (!found) return
          // 'cut' is the absence of a transition.
          found.clip.transitions[edge] = transition && transition.type !== 'cut' ? transition : null
        }),

      addTextClip: (content = 'Title') =>
        mutateProject((p) => {
          // Text lives on the topmost video track (CONTEXT.md: text above video).
          const track = p.tracks.filter((t) => t.kind === 'video').sort((a, b) => b.z - a.z)[0]
          if (!track) return
          const start = snapToFrame(useStore.getState().playhead, p.canvas.fps)
          const duration = 3
          const siblings = track.clips.map((c) => ({ start: c.start, end: clipEnd(c) }))
          const placed = clampStartToGaps(siblings, duration, start)
          if (placed === null) return
          const clip: Clip = {
            id: uid('c'),
            kind: 'text',
            start: snapToFrame(placed, p.canvas.fps),
            in: 0,
            out: duration,
            speed: 1,
            volume: 0,
            transform: defaultTransform(),
            keyframes: [],
            transitions: { in: null, out: null },
            effects: [],
            text: {
              content,
              font: 'Inter',
              size: 64,
              weight: 700,
              color: '#FFFFFF',
              align: 'center',
              stroke: null,
              background: null,
              maxWidth: 1200,
            },
            animation: { in: 'fadeUp', out: 'fade', duration: 0.3 },
          }
          expandTextAnimation(clip)
          track.clips.push(clip)
        }),

      addAdjustmentLayer: () =>
        mutateProject((p) => {
          // Topmost video track so the grade reaches every video track below;
          // if the playhead spot is taken there, grow a new track on top
          // (Premiere semantics — adjustment layers ride above the stack).
          const vids = p.tracks.filter((t) => t.kind === 'video').sort((a, b) => b.z - a.z)
          if (!vids.length) return
          const start = snapToFrame(useStore.getState().playhead, p.canvas.fps)
          const duration = 4
          let track = vids[0]
          const fits = !track.clips.some(
            (c) => start < clipEnd(c) && start + duration > c.start,
          )
          if (!fits) {
            track = {
              id: uid('t'),
              kind: 'video',
              z: vids[0].z + 1,
              name: `V${vids.length + 1}`,
              clips: [],
            }
            p.tracks.unshift(track)
          }
          track.clips.push({
            id: uid('c'),
            kind: 'video',
            adjust: true,
            start,
            in: 0,
            out: duration,
            speed: 1,
            volume: 0,
            transform: defaultTransform(),
            keyframes: [],
            transitions: { in: null, out: null },
            // The adjust layer's whole point is a grade over everything below.
            effects: [mkEffect('grade')],
          })
        }),

      addShapeClip: (kind) =>
        mutateProject((p) => {
          // Same placement policy as adjustment layers: topmost video track,
          // growing a new track when the playhead spot is occupied.
          const vids = p.tracks.filter((t) => t.kind === 'video').sort((a, b) => b.z - a.z)
          if (!vids.length) return
          const start = snapToFrame(useStore.getState().playhead, p.canvas.fps)
          const duration = 4
          let track = vids[0]
          const fits = !track.clips.some((c) => start < clipEnd(c) && start + duration > c.start)
          if (!fits) {
            track = {
              id: uid('t'),
              kind: 'video',
              z: vids[0].z + 1,
              name: `V${vids.length + 1}`,
              clips: [],
            }
            p.tracks.unshift(track)
          }
          track.clips.push({
            id: uid('c'),
            kind: 'video',
            shape: {
              kind,
              fill: '#e4e4e4',
              stroke: null,
              strokeWidth: 8,
              width: kind === 'line' ? 640 : 480,
              height: kind === 'line' ? 8 : 320,
            },
            start,
            in: 0,
            out: duration,
            speed: 1,
            volume: 0,
            transform: defaultTransform(),
            keyframes: [],
            transitions: { in: null, out: null },
            effects: [],
          })
        }),

      addSolidClip: (color = '#1a1a1a') =>
        mutateProject((p) => {
          const vids = p.tracks.filter((t) => t.kind === 'video').sort((a, b) => b.z - a.z)
          if (!vids.length) return
          const start = snapToFrame(useStore.getState().playhead, p.canvas.fps)
          const duration = 4
          let track = vids[0]
          const fits = !track.clips.some((c) => start < clipEnd(c) && start + duration > c.start)
          if (!fits) {
            track = {
              id: uid('t'),
              kind: 'video',
              z: vids[0].z + 1,
              name: `V${vids.length + 1}`,
              clips: [],
            }
            p.tracks.unshift(track)
          }
          track.clips.push({
            id: uid('c'),
            kind: 'video',
            shape: {
              kind: 'rect',
              fill: color,
              stroke: null,
              strokeWidth: 0,
              width: p.canvas.width,
              height: p.canvas.height,
            },
            start,
            in: 0,
            out: duration,
            speed: 1,
            volume: 0,
            transform: defaultTransform(),
            keyframes: [],
            transitions: { in: null, out: null },
            effects: [],
          })
        }),

      addTitleTemplate: (kind) =>
        mutateProject((p) => {
          const fps = p.canvas.fps
          const W = p.canvas.width
          const H = p.canvas.height
          const start = snapToFrame(useStore.getState().playhead, fps)
          const duration = 4
          const free = (t: Track) =>
            !t.clips.some((c) => start < clipEnd(c) && start + duration > c.start)
          const newTop = (): Track => {
            const vids = p.tracks.filter((t) => t.kind === 'video')
            const track: Track = {
              id: uid('t'),
              kind: 'video',
              z: Math.max(...vids.map((t) => t.z)) + 1,
              name: `V${vids.length + 1}`,
              clips: [],
            }
            p.tracks.unshift(track)
            return track
          }
          const vids = () => p.tracks.filter((t) => t.kind === 'video').sort((a, b) => b.z - a.z)
          if (!vids().length) return

          const baseClip = () => ({
            id: uid('c'),
            start,
            in: 0,
            out: duration,
            speed: 1,
            volume: 0,
            transform: defaultTransform(),
            keyframes: [],
            transitions: { in: null as Transition | null, out: null as Transition | null },
            effects: [],
          })
          const baseText = {
            font: 'Inter',
            weight: 700,
            color: '#FFFFFF',
            stroke: null,
            background: null,
            maxWidth: Math.round(W * 0.8),
          }

          if (kind === 'lowerThird') {
            // Accent bar + two-line name block, anchored lower-left. The bar
            // and text overlap in time, so they need separate tracks.
            const barTrack = free(vids()[0]) ? vids()[0] : newTop()
            const bar: Clip = {
              ...baseClip(),
              kind: 'video',
              shape: {
                kind: 'rect',
                fill: '#1f6feb',
                stroke: null,
                strokeWidth: 0,
                width: Math.round(W * 0.34),
                height: Math.round(H * 0.115),
              },
            }
            bar.transform.x = Math.round(-W * 0.24)
            bar.transform.y = Math.round(H * 0.3)
            barTrack.clips.push(bar)
            const textTrack = vids().find((t) => t.z > barTrack.z && free(t)) ?? newTop()
            const text: Clip = {
              ...baseClip(),
              kind: 'text',
              text: {
                ...baseText,
                content: 'Name Here\nTitle or role',
                size: Math.round(H * 0.037),
                align: 'left',
                lineHeight: 1.25,
                maxWidth: Math.round(W * 0.3),
              },
              animation: { in: 'slideLeft', out: 'fade', duration: 0.3 },
            }
            text.transform.x = bar.transform.x
            text.transform.y = bar.transform.y
            expandTextAnimation(text)
            textTrack.clips.push(text)
          } else if (kind === 'centered') {
            const track = free(vids()[0]) ? vids()[0] : newTop()
            const text: Clip = {
              ...baseClip(),
              kind: 'text',
              text: {
                ...baseText,
                content: 'Title',
                size: Math.round(H * 0.09),
                weight: 800,
                align: 'center',
                letterSpacing: 1,
                shadow: { color: '#000000', blur: 12, x: 0, y: 4 },
              },
              animation: { in: 'popIn', out: 'fade', duration: 0.35 },
            }
            expandTextAnimation(text)
            track.clips.push(text)
          } else {
            // Caption bar: single text clip with a padded background box,
            // parked in the lower quarter.
            const track = free(vids()[0]) ? vids()[0] : newTop()
            const text: Clip = {
              ...baseClip(),
              kind: 'text',
              text: {
                ...baseText,
                content: 'Caption text',
                size: Math.round(H * 0.033),
                weight: 600,
                align: 'center',
                background: { color: '#000000', padding: 14, radius: 8 },
              },
              animation: { in: 'fade', out: 'fade', duration: 0.25 },
            }
            text.transform.y = Math.round(H * 0.38)
            text.transform.opacity = 0.95
            expandTextAnimation(text)
            track.clips.push(text)
          }
        }),

      // Effects (foundation, Phase 4): structured patches; scalar params go
      // through setClipProperty for stopwatch semantics.
      addEffect: (clipId, type) =>
        mutateProject((p) => {
          const found = findClip(p, clipId)
          if (!found || found.track.locked) return
          found.clip.effects.push(mkEffect(type))
        }),

      removeEffect: (clipId, effectId) =>
        mutateProject((p) => {
          const found = findClip(p, clipId)
          if (!found || found.track.locked) return
          found.clip.effects = found.clip.effects.filter((e) => e.id !== effectId)
          // Orphaned keyframes go with the instance.
          found.clip.keyframes = found.clip.keyframes.filter(
            (k) => !k.prop.startsWith(`fx.${effectId}.`),
          )
        }),

      toggleEffect: (clipId, effectId) =>
        mutateProject((p) => {
          const found = findClip(p, clipId)
          if (!found || found.track.locked) return
          const fx = found.clip.effects.find((e) => e.id === effectId)
          if (fx) fx.enabled = !fx.enabled
        }),

      moveEffect: (clipId, effectId, dir) =>
        mutateProject((p) => {
          const found = findClip(p, clipId)
          if (!found || found.track.locked) return
          const list = found.clip.effects
          const i = list.findIndex((e) => e.id === effectId)
          if (i < 0) return
          // Swap with the nearest neighbor of the SAME audio/visual class:
          // the panel shows the stack split across the Adjust and Audio tabs,
          // and cross-kind order is semantically irrelevant (each render
          // chain filters its own types) — so ▲▼ must not appear to no-op
          // when an other-kind instance sits in between (Run 1, Phase 1a).
          const cls = isAudioFx(list[i].type)
          let j = i + dir
          while (j >= 0 && j < list.length && isAudioFx(list[j].type) !== cls) j += dir
          if (j < 0 || j >= list.length) return
          ;[list[i], list[j]] = [list[j], list[i]]
        }),

      duplicateEffect: (clipId, effectId) =>
        mutateProject((p) => {
          const found = findClip(p, clipId)
          if (!found || found.track.locked) return
          const list = found.clip.effects
          const i = list.findIndex((e) => e.id === effectId)
          if (i < 0) return
          const copy = structuredClone(current(list[i])) as Effect
          copy.id = uid('fx')
          list.splice(i + 1, 0, copy)
        }),

      updateEffectParams: (clipId, effectId, patch) =>
        mutateProject((p) => {
          const found = findClip(p, clipId)
          if (!found || found.track.locked) return
          const fx = found.clip.effects.find((e) => e.id === effectId)
          if (fx) Object.assign(fx.params, patch)
        }),

      setClipBlend: (clipId, blend) =>
        mutateProject((p) => {
          const found = findClip(p, clipId)
          if (!found || found.track.locked) return
          found.clip.blend = blend && blend !== 'normal' ? blend : undefined
        }),

      setClipMatte: (clipId, matte) =>
        mutateProject((p) => {
          const found = findClip(p, clipId)
          if (found && !found.track.locked) found.clip.matte = matte ?? undefined
        }),

      setClipMotionBlur: (clipId, v) =>
        mutateProject((p) => {
          const found = findClip(p, clipId)
          if (found && !found.track.locked) found.clip.motionBlur = v || undefined
        }),

      setClipLabel: (ids, label) =>
        mutateProject((p) => {
          for (const tr of p.tracks)
            for (const c of tr.clips)
              if (ids.includes(c.id)) c.label = label ?? undefined
        }),

      selectByLabel: (label) =>
        set((s) => {
          s.selection = s.project.tracks
            .flatMap((t) => t.clips)
            .filter((c) => c.label === label)
            .map((c) => c.id)
        }),

      setMediaFolder: (mediaId, folder) =>
        mutateProject((p) => {
          const m = p.media.find((a) => a.id === mediaId)
          if (m) m.folder = folder ?? undefined
        }),

      editingCompound: null,
      openCompound: (compoundId) =>
        set((s) => {
          s.editingCompound = compoundId
          s.selection = []
        }),

      makeCompound: (ids) =>
        mutateProject((p) => {
          // Pull the selected clips out into a nested timeline; drop ONE
          // compound clip spanning their extent where they were.
          const members: { clip: Clip; track: Track }[] = []
          for (const tr of p.tracks)
            for (const c of tr.clips)
              if (ids.includes(c.id)) members.push({ clip: c, track: tr })
          if (members.length < 2) return
          if (members.some(({ track }) => track.locked)) return
          const start = Math.min(...members.map((m) => m.clip.start))
          const end = Math.max(...members.map((m) => clipEnd(m.clip)))
          const id = uid('cmp')
          // Nested tracks mirror the members' tracks (order + kind).
          const trackIds = [...new Set(members.map((m) => m.track.id))]
          const nestedTracks: Track[] = trackIds.map((tid, i) => {
            const src = p.tracks.find((t) => t.id === tid)!
            return {
              id: uid('t'),
              kind: src.kind,
              z: src.kind === 'video' ? trackIds.length - i : 0,
              name: src.name,
              clips: members
                .filter((m) => m.track.id === tid)
                .map((m) => {
                  const c = structuredClone(current(m.clip)) as Clip
                  c.start = snapToFrame(c.start - start, p.canvas.fps)
                  return c
                }),
            }
          })
          if (!p.compounds) p.compounds = {}
          p.compounds[id] = {
            name: `Compound ${Object.keys(p.compounds).length + 1}`,
            duration: end - start,
            tracks: nestedTracks,
          }
          // Remove members; place the compound clip on the topmost involved
          // video track (or the first track if all-audio).
          for (const tr of p.tracks) tr.clips = tr.clips.filter((c) => !ids.includes(c.id))
          const host =
            p.tracks
              .filter((t) => trackIds.includes(t.id) && t.kind === 'video')
              .sort((a, b) => b.z - a.z)[0] ?? p.tracks.find((t) => trackIds.includes(t.id))!
          host.clips.push({
            id: uid('c'),
            kind: 'video',
            compoundId: id,
            start: snapToFrame(start, p.canvas.fps),
            in: 0,
            out: end - start,
            speed: 1,
            volume: 1,
            transform: defaultTransform(),
            keyframes: [],
            transitions: { in: null, out: null },
            effects: [],
          })
        }),

      ungroupCompound: (clipId) =>
        mutateProject((p) => {
          const found = findClip(p, clipId)
          const cmpId = found?.clip.compoundId
          if (!found || !cmpId || !p.compounds?.[cmpId] || found.track.locked) return
          const cmp = p.compounds[cmpId]
          const base = found.clip.start - found.clip.in
          // Remove the compound clip FIRST — it must not block its own
          // members' return (the p8 e2e caught overlapping members being
          // DROPPED because the compound still occupied the host track).
          found.track.clips = found.track.clips.filter((c) => c.id !== clipId)
          for (const nt of cmp.tracks) {
            for (const nc of nt.clips) {
              const back = structuredClone(current(nc)) as Clip
              back.id = uid('c')
              back.start = snapToFrame(nc.start + base, p.canvas.fps)
              const dur = clipDuration(back)
              let host = p.tracks.find(
                (t) =>
                  t.kind === nt.kind &&
                  !t.locked &&
                  !t.clips.some((c) => back.start < clipEnd(c) && c.start < back.start + dur),
              )
              if (!host) {
                // NEVER drop content: grow a track for the returning clip.
                const same = p.tracks.filter((t) => t.kind === nt.kind)
                host = {
                  id: uid('t'),
                  kind: nt.kind,
                  z: same.length ? Math.max(...same.map((t) => t.z)) + 1 : 0,
                  name: `${nt.kind === 'video' ? 'V' : 'A'}${same.length + 1}`,
                  clips: [],
                }
                if (nt.kind === 'video') p.tracks.unshift(host)
                else p.tracks.push(host)
              }
              host.clips.push(back)
            }
          }
          delete p.compounds[cmpId]
        }),

      autoReframe: async (clipId, mode) => {
        const s = get()
        const found = findClip(s.project, clipId)
        const asset = found?.clip.mediaId
          ? s.project.media.find((m) => m.id === found.clip.mediaId)
          : null
        if (!found || !asset?.width || !asset.height) return
        const { canvas } = s.project
        // The compositor contain-fits; cover the canvas instead.
        const fit = Math.min(canvas.width / asset.width, canvas.height / asset.height)
        const cover = Math.max(canvas.width / asset.width, canvas.height / asset.height)
        const scale = Number((cover / fit).toFixed(4))
        get().setClipProperty(clipId, 'transform.scale', scale)
        if (mode === 'center') {
          get().setClipProperty(clipId, 'transform.x', 0)
          get().setClipProperty(clipId, 'transform.y', 0)
          get().pushToast('success', `Reframed to cover (scale ${scale}×)`)
          return
        }
        try {
          const { invoke } = await import('@tauri-apps/api/core')
          const pts = await invoke<[number, number, number][]>('analyze_activity', {
            path: asset.path,
            duration: asset.duration,
          })
          if (!pts.length) {
            get().pushToast('info', 'No activity detected — centered instead')
            return
          }
          // Smooth (moving average of 5) + thin (≥1s apart) + clamp so the
          // covered frame never reveals background.
          const dw = asset.width * fit * scale
          const dh = asset.height * fit * scale
          const maxX = Math.max(0, (dw - canvas.width) / 2)
          const maxY = Math.max(0, (dh - canvas.height) / 2)
          const clip = found.clip
          mutateProject((p) => {
            const f2 = findClip(p, clipId)
            if (!f2) return
            f2.clip.keyframes = f2.clip.keyframes.filter(
              (k) => k.prop !== 'transform.x' && k.prop !== 'transform.y',
            )
            let lastT = -Infinity
            for (let i = 0; i < pts.length; i++) {
              const from = Math.max(0, i - 2)
              const to = Math.min(pts.length, i + 3)
              const win = pts.slice(from, to)
              const cx = win.reduce((a, q) => a + q[1], 0) / win.length
              const cy = win.reduce((a, q) => a + q[2], 0) / win.length
              const srcT = pts[i][0]
              const rel = (srcT - clip.in) / clip.speed
              if (rel < 0 || rel > clipDuration(clip) || srcT - lastT < 1) continue
              lastT = srcT
              f2.clip.keyframes.push(
                {
                  prop: 'transform.x',
                  t: snapToFrame(rel, p.canvas.fps),
                  v: Math.max(-maxX, Math.min(maxX, (0.5 - cx) * dw)),
                  ease: 'easeInOut',
                },
                {
                  prop: 'transform.y',
                  t: snapToFrame(rel, p.canvas.fps),
                  v: Math.max(-maxY, Math.min(maxY, (0.5 - cy) * dh)),
                  ease: 'easeInOut',
                },
              )
            }
          })
          get().pushToast('success', `Auto-reframed: ${pts.length} activity samples`)
        } catch (e) {
          get().pushToast('error', `Auto-reframe failed: ${e}`)
        }
      },

      attrClipboard: null,
      copyAttributes: (clipId) => {
        const found = findClip(get().project, clipId)
        if (!found) return
        set((s) => {
          s.attrClipboard = structuredClone({
            transform: found.clip.transform,
            effects: found.clip.effects as Effect[],
            blend: found.clip.blend,
          })
        })
      },

      pasteAttributes: (targetIds) =>
        mutateProject((p) => {
          const attrs = useStore.getState().attrClipboard
          if (!attrs) return
          for (const id of targetIds) {
            const found = findClip(p, id)
            if (!found || found.track.locked) continue
            const c = found.clip
            c.transform = structuredClone(attrs.transform)
            // Fresh instance ids per target: keyframes/panel address instances.
            c.effects = attrs.effects.map((e) => ({ ...structuredClone(e), id: uid('fx') }))
            c.blend = attrs.blend
            // Stale fx keyframes from the clip's previous stack die here;
            // transform keyframes are the CLIP's animation and survive.
            c.keyframes = c.keyframes.filter((k) => !k.prop.startsWith('fx.'))
          }
        }),

      updateShape: (clipId, patch) =>
        mutateProject((p) => {
          const found = findClip(p, clipId)
          if (!found || found.track.locked || !found.clip.shape) return
          Object.assign(found.clip.shape, patch)
        }),

      updateTextClip: (clipId, patch) =>
        mutateProject((p) => {
          const found = findClip(p, clipId)
          if (!found || found.clip.kind !== 'text') return
          const clip = found.clip
          if (patch.content !== undefined && clip.text) clip.text.content = patch.content
          if (patch.style && clip.text) Object.assign(clip.text, patch.style)
          if (patch.animation) {
            clip.animation = {
              in: 'fadeUp',
              out: 'fade',
              duration: 0.3,
              ...clip.animation,
              ...patch.animation,
            }
            expandTextAnimation(clip)
          }
        }),

      setPlayhead: (t) =>
        set((s) => {
          s.playhead = clampPlayhead(snapToFrame(t, s.project.canvas.fps), s.project as Project)
        }),

      enginePlayhead: (t) =>
        set((s) => {
          s.playhead = clampPlayhead(t, s.project as Project)
        }),

      play: () =>
        set((s) => {
          if (s.project.duration <= 0) return
          if (s.playhead >= s.project.duration) s.playhead = 0
          s.playing = true
          s.shuttle = 1
        }),

      pause: () =>
        set((s) => {
          s.playing = false
          s.shuttle = 1
        }),

      togglePlay: () => (get().playing ? get().pause() : get().play()),

      setShuttle: (rate) =>
        set((s) => {
          if (rate === 0) {
            s.playing = false
            s.shuttle = 1
          } else {
            if (s.project.duration <= 0) return
            s.playing = true
            s.shuttle = rate
          }
        }),

      frameStep: (frames) =>
        set((s) => {
          s.playing = false
          const fps = s.project.canvas.fps
          s.playhead = clampPlayhead(
            snapToFrame(s.playhead + frames / fps, fps),
            s.project as Project,
          )
        }),

      select: (ids, mode = 'set') =>
        set((s) => {
          if (mode === 'set') s.selection = ids
          else if (mode === 'add') s.selection = [...new Set([...s.selection, ...ids])]
          else
            for (const id of ids) {
              const i = s.selection.indexOf(id)
              if (i >= 0) s.selection.splice(i, 1)
              else s.selection.push(id)
            }
        }),

      markIn: null,
      markOut: null,
      setMarkIn: (t) =>
        set((s) => {
          s.markIn = t === null ? null : snapToFrame(Math.max(0, t), s.project.canvas.fps)
          if (s.markIn !== null && s.markOut !== null && s.markOut <= s.markIn) s.markOut = null
        }),
      setMarkOut: (t) =>
        set((s) => {
          s.markOut = t === null ? null : snapToFrame(Math.max(0, t), s.project.canvas.fps)
          if (s.markIn !== null && s.markOut !== null && s.markOut <= s.markIn) s.markIn = null
        }),

      editMode: 'overwrite',
      setEditMode: (m) =>
        set((s) => {
          s.editMode = m
        }),

      sourcePreview: null,
      openSource: (mediaId) =>
        set((s) => {
          s.sourcePreview = mediaId ? { mediaId, in: null, out: null } : null
        }),
      setSourceRange: (edge, t) =>
        set((s) => {
          if (!s.sourcePreview) return
          if (edge === 'in') s.sourcePreview.in = t
          else s.sourcePreview.out = t
          const sp = s.sourcePreview
          if (sp.in !== null && sp.out !== null && sp.out <= sp.in) {
            if (edge === 'in') sp.out = null
            else sp.in = null
          }
        }),

      setClipDisabled: (ids, disabled) =>
        mutateProject((p) => {
          for (const tr of p.tracks) {
            if (tr.locked) continue
            for (const c of tr.clips) if (ids.includes(c.id)) c.disabled = disabled
          }
        }),

      nudgeSelection: (frames) => {
        const s = get()
        if (!s.selection.length) return
        const delta = frames / s.project.canvas.fps
        const entries = s.project.tracks
          .flatMap((t) => t.clips)
          .filter((c) => s.selection.includes(c.id))
          .map((c) => ({ id: c.id, start: Math.max(0, c.start + delta) }))
        get().moveClipsTo(entries)
      },

      scrubbing: false,
      setScrubbing: (v) =>
        set((s) => {
          s.scrubbing = v
        }),

      setMasterVolume: (v) =>
        mutateProject(
          (p) => {
            p.masterVolume = Math.min(1.5, Math.max(0, v))
          },
          { history: false }, // slider drags shouldn't spam undo; persisted anyway
        ),

      normalizeClip: async (clipId) => {
        const s = get()
        const clip = s.project.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)
        const asset = clip?.mediaId ? s.project.media.find((m) => m.id === clip.mediaId) : null
        if (!clip || !asset) return
        const { getWaveform } = await import('../engine/waveform')
        const wf = await getWaveform(asset)
        if (!wf) return
        const from = Math.floor(clip.in * wf.pps)
        const to = Math.min(wf.peaks.length, Math.ceil(clip.out * wf.pps))
        let peak = 0
        for (let i = from; i < to; i++) if (wf.peaks[i] > peak) peak = wf.peaks[i]
        if (peak <= 1e-4) {
          get().pushToast('info', 'Clip is silent — nothing to normalize')
          return
        }
        const gain = Math.min(4, 0.891 / peak) // -1 dBFS target
        get().setClipProperty(clipId, 'volume', Number(gain.toFixed(3)))
        get().pushToast('success', `Normalized to -1 dB (gain ×${gain.toFixed(2)})`)
      },

      addFade: (clipId, edge, dur = 0.5) =>
        mutateProject((p) => {
          const found = findClip(p, clipId)
          if (!found || found.track.locked) return
          const { clip } = found
          const D = clipDuration(clip)
          const d = snapToFrame(Math.min(dur, D / 2), p.canvas.fps)
          if (d <= 0) return
          const base = clip.volume
          const upsert = (t: number, v: number) => {
            const existing = clip.keyframes.find(
              (k) => k.prop === 'volume' && Math.abs(k.t - t) < 1 / p.canvas.fps / 2,
            )
            if (existing) existing.v = v
            else clip.keyframes.push({ prop: 'volume', t, v, ease: 'linear' })
          }
          if (edge === 'in') {
            upsert(0, 0)
            upsert(d, base)
          } else {
            upsert(snapToFrame(D - d, p.canvas.fps), base)
            upsert(snapToFrame(D, p.canvas.fps), 0)
          }
        }),

      applyDuckingEnvelope: (clipId, points) =>
        mutateProject((p) => {
          const found = findClip(p, clipId)
          if (!found || found.track.locked) return
          const { clip } = found
          clip.keyframes = clip.keyframes.filter((k) => k.prop !== 'volume')
          for (const pt of points)
            clip.keyframes.push({
              prop: 'volume',
              t: snapToFrame(pt.t, p.canvas.fps),
              v: pt.v,
              ease: 'linear',
            })
        }),

      addTrack: (kind) =>
        mutateProject((p) => {
          const same = p.tracks.filter((t) => t.kind === kind)
          const z = same.length ? Math.max(...same.map((t) => t.z)) + 1 : 0
          const tr: Track = {
            id: uid('t'),
            kind,
            z,
            name: `${kind === 'video' ? 'V' : 'A'}${same.length + 1}`,
            clips: [],
          }
          if (kind === 'video') p.tracks.unshift(tr)
          else p.tracks.push(tr)
        }),

      renameTrack: (trackId, name) =>
        mutateProject((p) => {
          const t = p.tracks.find((x) => x.id === trackId)
          if (t && name.trim()) t.name = name.trim()
        }),

      setTrackFlag: (trackId, flag, v) =>
        mutateProject((p) => {
          const t = p.tracks.find((x) => x.id === trackId)
          if (t) t[flag] = v
        }),

      setTrackGain: (trackId, v) =>
        mutateProject(
          (p) => {
            const tr = p.tracks.find((t) => t.id === trackId)
            if (tr) tr.gain = Math.min(1.5, Math.max(0, v))
          },
          { history: false }, // fader drags shouldn't spam undo; persisted anyway
        ),

      setTrackEffects: (trackId, effects) =>
        mutateProject((p) => {
          const tr = p.tracks.find((t) => t.id === trackId)
          if (tr) tr.effects = effects
        }),

      normalizeLoudness: async (clipId) => {
        const s = get()
        const found = findClip(s.project, clipId)
        const asset = found?.clip.mediaId
          ? s.project.media.find((m) => m.id === found.clip.mediaId)
          : null
        if (!asset) return
        try {
          const { invoke } = await import('@tauri-apps/api/core')
          // Whole-file integrated loudness (typical use: full recordings) —
          // logged simplification; clip-range measurement when needed later.
          const lufs = await invoke<number>('measure_loudness', { path: asset.path })
          const gain = Math.min(8, Math.pow(10, (-14 - lufs) / 20))
          get().setClipProperty(clipId, 'volume', Number(gain.toFixed(4)))
          get().pushToast(
            'success',
            `Loudness ${lufs.toFixed(1)} LUFS → −14: gain ${gain.toFixed(2)}×`,
          )
        } catch (e) {
          get().pushToast('error', `Loudness measurement failed: ${e}`)
        }
      },

      reorderTrack: (trackId, dir) =>
        mutateProject((p) => {
          const track = p.tracks.find((t) => t.id === trackId)
          if (!track) return
          const group = p.tracks
            .filter((t) => t.kind === track.kind)
            .sort((a, b) => (track.kind === 'video' ? b.z - a.z : a.z - b.z))
          const i = group.indexOf(track)
          const j = i + dir
          if (j < 0 || j >= group.length) return
          const other = group[j]
          const tmp = track.z
          track.z = other.z
          other.z = tmp
        }),

      addMarkerAtPlayhead: () =>
        mutateProject((p) => {
          const t = snapToFrame(get().playhead, p.canvas.fps)
          p.markers ??= []
          if (p.markers.some((m) => Math.abs(m.t - t) < 0.5 / p.canvas.fps)) return
          p.markers.push({ id: uid('mk'), t, label: `Marker ${p.markers.length + 1}` })
          p.markers.sort((a, b) => a.t - b.t)
        }),

      renameMarker: (id, label) =>
        mutateProject((p) => {
          const m = p.markers?.find((x) => x.id === id)
          if (m) m.label = label
        }),

      deleteMarker: (id) =>
        mutateProject((p) => {
          if (p.markers) p.markers = p.markers.filter((x) => x.id !== id)
        }),

      setPxPerSec: (v) =>
        set((s) => {
          s.pxPerSec = Math.min(500, Math.max(4, v))
        }),

      setSnap: (v) =>
        set((s) => {
          s.snap = v
        }),

      setCanvasPreset: (preset) =>
        set((s) => {
          s.past.push(structuredClone(current(s.project)))
          if (s.past.length > HISTORY_LIMIT) s.past.shift()
          s.future = []
          const dims = typeof preset === 'string' ? CANVAS_PRESETS[preset] : preset
          s.project.canvas.width = Math.max(16, Math.round(dims.width))
          s.project.canvas.height = Math.max(16, Math.round(dims.height))
          // Export resolution mirrors the canvas until the user overrides it.
          s.exportSettings.width = s.project.canvas.width
          s.exportSettings.height = s.project.canvas.height
        }),

      setCanvasFps: (fps) =>
        set((s) => {
          s.past.push(structuredClone(current(s.project)))
          if (s.past.length > HISTORY_LIMIT) s.past.shift()
          s.future = []
          s.project.canvas.fps = Math.min(120, Math.max(1, Math.round(fps)))
          s.exportSettings.fps = s.project.canvas.fps
        }),

      setSafeZones: (v) =>
        set((s) => {
          s.safeZones = v
        }),

      guides: false,
      setGuides: (v) =>
        set((s) => {
          s.guides = v
        }),

      setExportOpen: (v) =>
        set((s) => {
          s.exportOpen = v
        }),

      mixerOpen: false,
      setMixerOpen: (v) =>
        set((s) => {
          s.mixerOpen = v
          s.leftPanel = v ? 'mixer' : 'media'
          s.binOpen = !v
        }),

      scopesOpen: false,
      setScopesOpen: (v) =>
        set((s) => {
          s.scopesOpen = v
        }),

      setExportSettings: (patch) =>
        set((s) => {
          Object.assign(s.exportSettings, patch)
        }),

      setTimelineHeight: (h) =>
        set((s) => {
          s.timelineHeight = Math.min(480, Math.max(140, h))
        }),

      setPropsWidth: (w) =>
        set((s) => {
          s.propsWidth = Math.min(420, Math.max(220, w))
        }),

      setCompositorStatus: (active, fps) =>
        set((s) => {
          s.compositorActive = active
          s.compositorFps = fps
        }),

      setPreviewFull: (v) =>
        set((s) => {
          s.previewFull = v
        }),

      setProjectPath: (path) =>
        set((s) => {
          s.projectPath = path
        }),

      replaceProject: (project, path) =>
        set((s) => {
          s.project = project
          s.project.duration = computeDuration(project)
          s.past = []
          s.future = []
          s.selection = []
          s.playhead = 0
          s.playing = false
          s.projectPath = path
          s.dirty = false
        }),

      addProjectFont: (font) =>
        mutateProject((p) => {
          if (!p.fonts) p.fonts = []
          if (!p.fonts.some((f) => f.fileName === font.fileName)) p.fonts.push(font)
        }),

      selectAllClips: () =>
        set((s) => {
          s.selection = s.project.tracks.flatMap((t) => t.clips.map((c) => c.id))
        }),

      loadPipDemo: (screen, cam) =>
        mutateProject((p) => {
          for (const tr of p.tracks) tr.clips = []
          const mkAsset = (m: SpikeMediaInput, name: string): MediaAsset => ({
            id: uid('m'),
            path: m.path,
            playbackUrl: m.playbackUrl,
            name,
            kind: 'video',
            duration: m.duration,
            width: m.width,
            height: m.height,
            hasAudio: false,
          })
          const screenAsset = mkAsset(screen, 'screen.mp4')
          const camAsset = mkAsset(cam, 'cam.mp4')
          // Repeat demo loads must not accumulate duplicate media — invisible
          // until the media bin existed, caught by its listing (session 9).
          p.media = p.media.filter((m) => m.path !== screen.path && m.path !== cam.path)
          p.media.push(screenAsset, camAsset)

          const videoTracks = p.tracks.filter((t) => t.kind === 'video').sort((a, b) => a.z - b.z)
          const [v1, v2] = videoTracks
          if (!v1 || !v2) return

          const mkClip = (asset: MediaAsset): Clip => ({
            id: uid('c'),
            kind: 'video',
            mediaId: asset.id,
            start: 0,
            in: 0,
            out: Math.min(asset.duration, 10),
            speed: 1,
            volume: 1,
            transform: defaultTransform(),
            keyframes: [],
            transitions: { in: null, out: null },
            effects: [],
          })
          v1.clips.push(mkClip(screenAsset))

          const camClip = mkClip(camAsset)
          // Flagship PiP: fullscreen → 10% bottom-right (32px margin, r=12) → back.
          const px = 0.45 * p.canvas.width - 32
          const py = 0.45 * p.canvas.height - 32
          const kf = (prop: string, t: number, v: number) => ({
            prop,
            t,
            v,
            ease: 'easeInOut' as const,
          })
          camClip.keyframes = [
            kf('transform.scale', 1.0, 1.0),
            kf('transform.scale', 2.2, 0.1),
            kf('transform.scale', 5.0, 0.1),
            kf('transform.scale', 6.2, 1.0),
            kf('transform.x', 1.0, 0),
            kf('transform.x', 2.2, px),
            kf('transform.x', 5.0, px),
            kf('transform.x', 6.2, 0),
            kf('transform.y', 1.0, 0),
            kf('transform.y', 2.2, py),
            kf('transform.y', 5.0, py),
            kf('transform.y', 6.2, 0),
            kf('transform.cornerRadius', 1.0, 0),
            kf('transform.cornerRadius', 2.2, 12),
            kf('transform.cornerRadius', 5.0, 12),
            kf('transform.cornerRadius', 6.2, 0),
          ]
          v2.clips.push(camClip)
        }),
    }
  }),
)

// Dev-only handle so scripted browser tests can drive the real store.
if (import.meta.env.DEV && typeof window !== 'undefined') {
  const w = window as unknown as { __motionaire?: Record<string, unknown> }
  w.__motionaire = { ...w.__motionaire, store: useStore }
}
