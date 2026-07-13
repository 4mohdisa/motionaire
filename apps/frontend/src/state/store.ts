import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { current } from 'immer'
import type {
  Clip,
  Ease,
  Shape,
  Track,
  MediaAsset,
  Project,
  ProjectFont,
  TextAnimation,
  TextStyle,
  Transition,
} from '../types/project'
import { createProject, defaultGrade, defaultTransform, uid } from '../types/project'
import {
  clampStartToGaps,
  clipDuration,
  clipEnd,
  computeDuration,
  findClip,
  snapToFrame,
} from '../engine/time'
import { resolveProp } from '../engine/keyframes'
import { expandTextAnimation } from '../engine/textPresets'

const HISTORY_LIMIT = 100

export interface ExportSettings {
  width: number
  height: number
  fps: number
  format: 'mp4' | 'webm' | 'mov'
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
  toasts: { id: string; kind: 'info' | 'success' | 'error' | 'progress'; text: string; progress?: number }[]
  pushToast: (
    kind: 'info' | 'success' | 'error' | 'progress',
    text: string,
    id?: string,
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
  binOpen: boolean
  setBinOpen: (v: boolean) => void
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
  // Group drag: set several clips' starts atomically; the whole move is
  // rejected if any clip would overlap a clip outside the group.
  moveClipsTo: (entries: { id: string; start: number }[], transient?: boolean) => void
  trimClip: (clipId: string, edge: 'in' | 'out', timelineTime: number, transient?: boolean) => void
  splitClip: (clipId: string, at: number) => void
  splitAtPlayhead: () => void
  deleteClips: (ids: string[]) => void
  rippleDeleteClips: (ids: string[]) => void
  duplicateClip: (clipId: string) => void
  detachAudio: (clipId: string) => void

  // --- properties & keyframes ---
  // Static set; if the prop already has keyframes, upserts a keyframe at the
  // playhead instead (NLE stopwatch semantics).
  setClipProperty: (clipId: string, prop: string, value: unknown) => void
  // Stopwatch/diamond click: arm with first keyframe, or add/remove at playhead.
  toggleKeyframe: (clipId: string, prop: string) => void
  clearKeyframes: (clipId: string, prop: string) => void
  setKeyframeEase: (clipId: string, prop: string, t: number, ease: Ease) => void

  // --- transitions & text ---
  setTransition: (clipId: string, edge: 'in' | 'out', transition: Transition | null) => void
  addTextClip: (content?: string) => void
  addAdjustmentLayer: () => void
  addShapeClip: (kind: 'rect' | 'ellipse' | 'line') => void
  updateClipFx: (
    clipId: string,
    patch: {
      key?: Clip['key'] | null
      blend?: Clip['blend'] | null
      mask?: Clip['mask'] | null
    },
  ) => void
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
  setTrackFlag: (trackId: string, flag: 'muted' | 'solo' | 'locked' | 'hidden', v: boolean) => void
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
  setExportOpen: (v: boolean) => void
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
        if (opts?.history !== false) {
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
      pushToast: (kind, text, id) => {
        const tid = id ?? uid('toast')
        set((s) => {
          const existing = s.toasts.find((t) => t.id === tid)
          if (existing) {
            existing.kind = kind
            existing.text = text
          } else {
            s.toasts.push({ id: tid, kind, text })
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
              p.tracks.find((t) => t.kind === kind && !t.locked) ?? undefined
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

      binOpen: true,
      setBinOpen: (v) =>
        set((s) => {
          s.binOpen = v
        }),

      insertClipAt: (mediaId, trackId, at, range) =>
        mutateProject((p) => {
          const asset = p.media.find((a) => a.id === mediaId)
          if (!asset) return
          // Wrong-kind lane (or no lane): fall back to the first matching track.
          let track = trackId ? p.tracks.find((t) => t.id === trackId) : undefined
          if (!track || track.kind !== asset.kind || track.locked)
            track = p.tracks.find((t) => t.kind === asset.kind && !t.locked)
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
            const moves: { clip: Clip; track: Track; start: number }[] = []
            const newStart = new Map<string, number>()
            for (const e of entries) {
              const found = findClip(p, e.id)
              if (!found || found.track.locked) return
              const s = snapToFrame(Math.max(0, e.start), p.canvas.fps)
              moves.push({ clip: found.clip, track: found.track, start: s })
              newStart.set(e.id, s)
            }
            // All-or-nothing: any collision with a clip outside the group (or a
            // scrambled in-group pair on the same track) rejects the whole move.
            for (const m of moves) {
              const end = m.start + clipDuration(m.clip)
              for (const c of m.track.clips) {
                if (c.id === m.clip.id) continue
                const cs = ids.has(c.id) ? newStart.get(c.id)! : c.start
                if (m.start < cs + clipDuration(c) - 1e-6 && end > cs + 1e-6) return
              }
            }
            for (const m of moves) m.clip.start = m.start
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

      setClipProperty: (clipId, prop, value) =>
        mutateProject((p) => {
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
          else if (prop === 'blur' && isNumeric) clip.blur = Math.min(40, Math.max(-20, value))
          else if (prop === 'vignette' && isNumeric) clip.vignette = Math.min(1, Math.max(0, value))
          else if (prop.startsWith('key.') && isNumeric && clip.key)
            (clip.key as unknown as Record<string, number>)[prop.slice('key.'.length)] = value
          else if (prop.startsWith('mask.') && isNumeric && clip.mask)
            (clip.mask as unknown as Record<string, number>)[prop.slice('mask.'.length)] = value
          else if (prop.startsWith('transform.')) {
            const key = prop.slice('transform.'.length)
            ;(clip.transform as unknown as Record<string, unknown>)[key] = value
          } else if (prop.startsWith('grade.') && isNumeric) {
            if (!clip.grade) clip.grade = defaultGrade()
            ;(clip.grade as unknown as Record<string, number>)[prop.slice('grade.'.length)] = value
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
            effects: [],
            grade: defaultGrade(),
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

      // Effects (foundation, Phase 4): structured patches; scalar params go
      // through setClipProperty for stopwatch semantics.
      updateClipFx: (clipId, patch) =>
        mutateProject((p) => {
          const found = findClip(p, clipId)
          if (!found || found.track.locked) return
          const c = found.clip
          if ('key' in patch) c.key = patch.key ?? undefined
          if ('blend' in patch) c.blend = patch.blend ?? undefined
          if ('mask' in patch) c.mask = patch.mask ?? undefined
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

      setExportOpen: (v) =>
        set((s) => {
          s.exportOpen = v
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
if (import.meta.env.DEV) {
  const w = window as unknown as { __motionaire?: Record<string, unknown> }
  w.__motionaire = { ...w.__motionaire, store: useStore }
}
