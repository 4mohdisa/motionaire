import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { current } from 'immer'
import type { MediaAsset, Project } from '../types/project'
import { createProject, defaultTransform, uid } from '../types/project'
import { clipEnd, computeDuration, findClip, snapToFrame } from '../engine/time'

const HISTORY_LIMIT = 100

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

  // --- transport / ui ---
  setPlayhead: (t: number) => void
  enginePlayhead: (t: number) => void // raw, from playback loop; no frame snap
  play: () => void
  pause: () => void
  togglePlay: () => void
  setShuttle: (rate: number) => void
  frameStep: (frames: number) => void
  select: (ids: string[], mode?: 'set' | 'add' | 'toggle') => void
  setPxPerSec: (v: number) => void
  setSnap: (v: boolean) => void
}

function clampPlayhead(t: number, p: Project): number {
  return Math.min(Math.max(0, t), Math.max(p.duration, 0))
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

      setPxPerSec: (v) =>
        set((s) => {
          s.pxPerSec = Math.min(500, Math.max(4, v))
        }),

      setSnap: (v) =>
        set((s) => {
          s.snap = v
        }),
    }
  }),
)

// Dev-only handle so scripted browser tests can drive the real store.
if (import.meta.env.DEV) {
  const w = window as unknown as { __motionaire?: Record<string, unknown> }
  w.__motionaire = { ...w.__motionaire, store: useStore }
}
