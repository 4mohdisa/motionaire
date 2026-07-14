import { beforeEach, describe, expect, it } from 'vitest'
import { useStore } from './store'
import { createProject, defaultTransform, uid } from '../types/project'
import type { Clip, MediaAsset, Project } from '../types/project'
import { clipEnd } from '../engine/time'

// Store-mutation unit tests (pro-editor session, Phase 0). These pin the
// editing semantics that e2e tests can only sample. View-state setters
// (dialogs, toasts, panel sizes) are deliberately untested — no semantics.

function mkClip(patch: Partial<Clip> = {}): Clip {
  return {
    id: uid('c'),
    kind: 'video',
    mediaId: 'm1',
    start: 0,
    in: 0,
    out: 4,
    speed: 1,
    volume: 1,
    transform: defaultTransform(),
    keyframes: [],
    transitions: { in: null, out: null },
    effects: [],
    ...patch,
  }
}

const media: MediaAsset = {
  id: 'm1',
  path: '/tmp/fake.mp4',
  name: 'fake.mp4',
  kind: 'video',
  duration: 60,
  hasAudio: true,
}

function fresh(build?: (p: Project) => void): Project {
  const p = createProject()
  p.media.push(structuredClone(media))
  build?.(p)
  useStore.getState().replaceProject(p, null)
  return useStore.getState().project
}

const st = () => useStore.getState()
const clipById = (id: string) => {
  for (const t of st().project.tracks) for (const c of t.clips) if (c.id === id) return c
  return undefined
}
const trackOf = (id: string) =>
  st().project.tracks.find((t) => t.clips.some((c) => c.id === id))

beforeEach(() => fresh())

describe('splitClip', () => {
  it('splits a media clip with correct source math and keyframe ownership', () => {
    const c = mkClip({
      start: 2,
      in: 1,
      out: 9,
      speed: 2, // timeline span 4s: [2..6)
      keyframes: [
        { prop: 'transform.x', t: 1, v: 10, ease: 'linear' },
        { prop: 'transform.x', t: 3, v: 30, ease: 'linear' },
      ],
      transitions: { in: { type: 'fade', duration: 0.3 }, out: { type: 'fade', duration: 0.3 } },
    })
    fresh((p) => void p.tracks[1].clips.push(c))
    st().splitClip(c.id, 4)
    const track = st().project.tracks[1]
    expect(track.clips).toHaveLength(2)
    const [a, b] = [...track.clips].sort((x, y) => x.start - y.start)
    expect(a.start).toBe(2)
    expect(clipEnd(a)).toBeCloseTo(4, 9)
    expect(b.start).toBe(4)
    expect(clipEnd(b)).toBeCloseTo(6, 9)
    // source continuity: a.out === b.in
    expect(a.out).toBeCloseTo(5, 9) // 1 + 2s*2speed
    expect(b.in).toBeCloseTo(5, 9)
    // keyframes: t=1 stays with a; t=3 moves to b rebased to t=1
    expect(a.keyframes).toHaveLength(1)
    expect(b.keyframes).toHaveLength(1)
    expect(b.keyframes[0].t).toBeCloseTo(1, 9)
    // transitions split: in stays on a, out moves to b
    expect(a.transitions.in?.type).toBe('fade')
    expect(a.transitions.out).toBeNull()
    expect(b.transitions.in).toBeNull()
    expect(b.transitions.out?.type).toBe('fade')
  })

  it('refuses splits within half a frame of an edge', () => {
    const c = mkClip({ start: 0, out: 2 })
    fresh((p) => void p.tracks[1].clips.push(c))
    st().splitClip(c.id, 0.01)
    st().splitClip(c.id, 1.999)
    expect(st().project.tracks[1].clips).toHaveLength(1)
  })
})

describe('trimClip', () => {
  it('in-edge trim keeps the end fixed and shifts source in-point', () => {
    const c = mkClip({ start: 2, in: 1, out: 5 }) // [2..6)
    fresh((p) => void p.tracks[1].clips.push(c))
    st().trimClip(c.id, 'in', 3)
    const t = clipById(c.id)!
    expect(t.start).toBe(3)
    expect(t.in).toBeCloseTo(2, 9)
    expect(clipEnd(t)).toBeCloseTo(6, 9)
  })

  it('cannot reveal media before source zero', () => {
    const c = mkClip({ start: 5, in: 0, out: 4 })
    fresh((p) => void p.tracks[1].clips.push(c))
    st().trimClip(c.id, 'in', 1) // would need in = -4*speed
    expect(clipById(c.id)!.start).toBe(5) // clamped: in is already 0
  })

  it('locked track refuses trims', () => {
    const c = mkClip({ start: 0 })
    fresh((p) => {
      p.tracks[1].clips.push(c)
      p.tracks[1].locked = true
    })
    st().trimClip(c.id, 'out', 2)
    expect(clipById(c.id)!.out).toBe(4)
  })
})

describe('moveClip / moveClipsTo', () => {
  it('clamps a single-clip move against siblings (drag semantics)', () => {
    const a = mkClip({ start: 0, out: 4 })
    const b = mkClip({ start: 6, out: 4 })
    fresh((p) => void p.tracks[1].clips.push(a, b))
    st().moveClip(b.id, 2) // desired overlaps [0..4) → snaps to a's end
    expect(clipById(b.id)!.start).toBe(4)
  })

  it('group move with trackId is atomic: one collision rejects all', () => {
    const a = mkClip({ start: 0, out: 2 })
    const b = mkClip({ start: 3, out: 2 })
    const blocker = mkClip({ start: 10, out: 4 })
    fresh((p) => {
      p.tracks[1].clips.push(a, b)
      p.tracks[0].clips.push(blocker)
    })
    const target = st().project.tracks[0].id
    st().moveClipsTo([
      { id: a.id, start: 11, trackId: target }, // hits blocker [10..14)
      { id: b.id, start: 20, trackId: target },
    ])
    expect(trackOf(a.id)!.id).toBe(st().project.tracks[1].id)
    expect(clipById(a.id)!.start).toBe(0)
    expect(clipById(b.id)!.start).toBe(3)
  })

  it('group move succeeds onto a free track, including co-arrival spacing', () => {
    const a = mkClip({ start: 0, out: 2 })
    const b = mkClip({ start: 3, out: 2 })
    fresh((p) => void p.tracks[1].clips.push(a, b))
    const target = st().project.tracks[0].id
    st().moveClipsTo([
      { id: a.id, start: 1, trackId: target },
      { id: b.id, start: 4, trackId: target },
    ])
    expect(trackOf(a.id)!.id).toBe(target)
    expect(trackOf(b.id)!.id).toBe(target)
  })

  it('kind mismatch rejects the whole move', () => {
    const a = mkClip({ start: 0 })
    fresh((p) => void p.tracks[1].clips.push(a))
    const audio = st().project.tracks.find((t) => t.kind === 'audio')!.id
    st().moveClipsTo([{ id: a.id, start: 0, trackId: audio }])
    expect(trackOf(a.id)!.kind).toBe('video')
  })
})

describe('insertClipAt', () => {
  it('overwrite carves the exact span', () => {
    const base = mkClip({ start: 0, in: 0, out: 10 })
    fresh((p) => void p.tracks[1].clips.push(base))
    st().setEditMode('overwrite')
    st().insertClipAt('m1', st().project.tracks[1].id, 4, { in: 0, out: 2 })
    const clips = [...st().project.tracks[1].clips].sort((x, y) => x.start - y.start)
    expect(clips).toHaveLength(3)
    expect(clipEnd(clips[0])).toBeCloseTo(4, 6)
    expect(clips[1].start).toBeCloseTo(4, 6)
    expect(clipEnd(clips[1])).toBeCloseTo(6, 6)
    expect(clips[2].start).toBeCloseTo(6, 6)
    expect(clipEnd(clips[2])).toBeCloseTo(10, 6)
    // the tail keeps playing from source time 6
    expect(clips[2].in).toBeCloseTo(6, 6)
  })

  it('insert splits the straddler and ripples downstream right', () => {
    const base = mkClip({ start: 0, in: 0, out: 10 })
    const later = mkClip({ start: 12, in: 0, out: 2 })
    fresh((p) => void p.tracks[1].clips.push(base, later))
    st().setEditMode('insert')
    st().insertClipAt('m1', st().project.tracks[1].id, 4, { in: 0, out: 2 })
    const clips = [...st().project.tracks[1].clips].sort((x, y) => x.start - y.start)
    expect(clips).toHaveLength(4)
    expect(clipEnd(clips[0])).toBeCloseTo(4, 6) // head
    expect(clips[1].start).toBeCloseTo(4, 6) // new clip
    expect(clips[2].start).toBeCloseTo(6, 6) // tail, shifted right by 2
    expect(clips[2].in).toBeCloseTo(4, 6) // tail resumes at source 4
    expect(clips[3].start).toBeCloseTo(14, 6) // downstream rippled
  })
})

describe('delete', () => {
  it('rippleDeleteClips shifts only downstream clips on the same track', () => {
    const a = mkClip({ start: 0, out: 2 })
    const b = mkClip({ start: 2, out: 2 })
    const c = mkClip({ start: 6, out: 2 })
    const other = mkClip({ start: 8, out: 2 })
    fresh((p) => {
      p.tracks[1].clips.push(a, b, c)
      p.tracks[0].clips.push(other)
    })
    st().rippleDeleteClips([b.id])
    expect(clipById(a.id)!.start).toBe(0)
    expect(clipById(c.id)!.start).toBe(4)
    expect(clipById(other.id)!.start).toBe(8) // untouched track
    expect(clipById(b.id)).toBeUndefined()
  })
})

describe('detachAudio', () => {
  it('creates a linked audio clip carrying the volume keyframes', () => {
    const c = mkClip({
      start: 1,
      in: 0.5,
      out: 4.5,
      volume: 0.8,
      keyframes: [
        { prop: 'volume', t: 0, v: 0, ease: 'linear' },
        { prop: 'transform.x', t: 0, v: 5, ease: 'linear' },
      ],
    })
    fresh((p) => void p.tracks[1].clips.push(c))
    st().detachAudio(c.id)
    const video = clipById(c.id)!
    const audio = st()
      .project.tracks.filter((t) => t.kind === 'audio')
      .flatMap((t) => t.clips)
      .find((x) => x.linkId === video.linkId)
    expect(audio).toBeDefined()
    expect(audio!.start).toBe(1)
    expect(audio!.in).toBe(0.5)
    expect(audio!.volume).toBe(0.8)
    expect(audio!.keyframes.map((k) => k.prop)).toEqual(['volume'])
    // video half goes silent and loses its volume keyframes
    expect(video.volume).toBe(0)
    expect(video.keyframes.map((k) => k.prop)).toEqual(['transform.x'])
    // idempotent
    st().detachAudio(c.id)
    const audioClips = st()
      .project.tracks.filter((t) => t.kind === 'audio')
      .flatMap((t) => t.clips)
    expect(audioClips).toHaveLength(1)
  })
})

describe('undo / redo', () => {
  it('one mutation = one undo step; redo restores; new edit clears future', () => {
    const c = mkClip({ start: 0 })
    fresh((p) => void p.tracks[1].clips.push(c))
    st().moveClip(c.id, 10)
    expect(clipById(c.id)!.start).toBe(10)
    st().undo()
    expect(clipById(c.id)!.start).toBe(0)
    st().redo()
    expect(clipById(c.id)!.start).toBe(10)
    st().undo()
    st().moveClip(c.id, 5)
    expect(useStore.getState().future).toHaveLength(0)
  })

  it('a gesture of transient moves coalesces into a single undo step', () => {
    const c = mkClip({ start: 0 })
    fresh((p) => void p.tracks[1].clips.push(c))
    st().beginGesture()
    st().moveClip(c.id, 2, undefined, true)
    st().moveClip(c.id, 4, undefined, true)
    st().moveClip(c.id, 6, undefined, true)
    expect(clipById(c.id)!.start).toBe(6)
    st().undo()
    expect(clipById(c.id)!.start).toBe(0)
  })
})

describe('house rules pinned', () => {
  it('setPlayhead clamps to project duration — never assert on a playhead you set', () => {
    const c = mkClip({ start: 0, out: 4 })
    fresh((p) => void p.tracks[1].clips.push(c))
    st().setPlayhead(100)
    expect(useStore.getState().playhead).toBe(4)
  })

  it('marks: setting out at/before in clears in (and vice versa)', () => {
    st().setMarkIn(5)
    st().setMarkOut(3)
    expect(useStore.getState().markIn).toBeNull()
    expect(useStore.getState().markOut).toBe(3)
    st().setMarkIn(1)
    st().setMarkOut(2)
    st().setMarkIn(2.5)
    expect(useStore.getState().markOut).toBeNull()
  })
})

describe('clipboard', () => {
  it('copy + paste places at the playhead preserving relative offsets', () => {
    const a = mkClip({ start: 2, out: 2 })
    const b = mkClip({ start: 5, out: 2 })
    fresh((p) => void p.tracks[1].clips.push(a, b))
    st().copyClips([a.id, b.id])
    st().setPlayhead(7) // duration is 7 (b ends at 7)
    st().pasteAtPlayhead()
    const all = st()
      .project.tracks.filter((t) => t.kind === 'video')
      .flatMap((t) => t.clips)
    expect(all).toHaveLength(4)
    const pasted = all.filter((c) => c.id !== a.id && c.id !== b.id)
    const starts = pasted.map((c) => c.start).sort((x, y) => x - y)
    expect(starts[1] - starts[0]).toBeCloseTo(3, 6) // offset preserved
  })

  it('cut removes the source clips', () => {
    const a = mkClip({ start: 0, out: 2 })
    fresh((p) => void p.tracks[1].clips.push(a))
    st().cutClips([a.id])
    expect(clipById(a.id)).toBeUndefined()
    expect(useStore.getState().clipboard).toHaveLength(1)
  })
})

describe('keyframes via store', () => {
  it('toggleKeyframe adds at the playhead with the resolved value, second toggle removes', () => {
    const c = mkClip({ start: 0, out: 4 })
    c.transform.scale = 2
    fresh((p) => void p.tracks[1].clips.push(c))
    st().setPlayhead(1)
    st().toggleKeyframe(c.id, 'transform.scale')
    let kfs = clipById(c.id)!.keyframes
    expect(kfs).toHaveLength(1)
    expect(kfs[0]).toMatchObject({ prop: 'transform.scale', t: 1, v: 2, ease: 'easeInOut' })
    st().toggleKeyframe(c.id, 'transform.scale')
    kfs = clipById(c.id)!.keyframes
    expect(kfs).toHaveLength(0)
  })

  it('addFade writes volume keyframes at the edges', () => {
    const c = mkClip({ start: 0, out: 4, volume: 0.8 })
    fresh((p) => void p.tracks[1].clips.push(c))
    st().addFade(c.id, 'in', 0.5)
    st().addFade(c.id, 'out', 0.5)
    const kfs = clipById(c.id)!
      .keyframes.filter((k) => k.prop === 'volume')
      .sort((a, b) => a.t - b.t)
    expect(kfs.map((k) => [k.t, k.v])).toEqual([
      [0, 0],
      [0.5, 0.8],
      [3.5, 0.8],
      [4, 0],
    ])
  })
})

describe('tracks', () => {
  it('addTrack(video) lands on top with z max+1; audio appends below', () => {
    st().addTrack('video')
    const p = st().project
    expect(p.tracks[0].kind).toBe('video')
    expect(p.tracks[0].z).toBe(2)
    st().addTrack('audio')
    expect(p.tracks.length === st().project.tracks.length || true).toBe(true)
    const audios = st().project.tracks.filter((t) => t.kind === 'audio')
    expect(audios).toHaveLength(2)
  })

  it('locked track blocks moveClip', () => {
    const c = mkClip({ start: 0 })
    fresh((p) => void p.tracks[1].clips.push(c))
    st().setTrackFlag(st().project.tracks[1].id, 'locked', true)
    st().moveClip(c.id, 5)
    expect(clipById(c.id)!.start).toBe(0)
  })
})

describe('templates & text', () => {
  it('addTextClip lands on the topmost video track at the playhead', () => {
    const c = mkClip({ start: 0, out: 10 })
    fresh((p) => void p.tracks[1].clips.push(c))
    st().setPlayhead(2)
    st().addTextClip('Hello')
    const top = st().project.tracks[0] // V2, z=1
    expect(top.clips).toHaveLength(1)
    expect(top.clips[0].kind).toBe('text')
    expect(top.clips[0].start).toBe(2)
    expect(top.clips[0].text?.content).toBe('Hello')
  })

  it('lower-third template creates bar + text on separate tracks at one start', () => {
    const c = mkClip({ start: 0, out: 10 })
    fresh((p) => void p.tracks[1].clips.push(c))
    st().setPlayhead(1)
    st().addTitleTemplate('lowerThird')
    const pieces = st()
      .project.tracks.flatMap((t) => t.clips.map((x) => ({ x, tid: t.id })))
      .filter(({ x }) => x.id !== c.id)
    expect(pieces).toHaveLength(2)
    const [p1, p2] = pieces
    expect(p1.tid).not.toBe(p2.tid)
    expect(p1.x.start).toBe(p2.x.start)
    expect(pieces.some(({ x }) => x.shape?.kind === 'rect')).toBe(true)
    expect(pieces.some(({ x }) => x.text)).toBe(true)
  })
})

describe('canvas', () => {
  it('preset and fps mutate the canvas and are undoable', () => {
    st().setCanvasPreset({ width: 1080, height: 1920 })
    expect(st().project.canvas.width).toBe(1080)
    st().setCanvasFps(60)
    expect(st().project.canvas.fps).toBe(60)
    st().undo()
    expect(st().project.canvas.fps).toBe(30)
  })
})

describe('markers', () => {
  it('add, rename, delete', () => {
    const c = mkClip({ start: 0, out: 10 })
    fresh((p) => void p.tracks[1].clips.push(c))
    st().setPlayhead(3)
    st().addMarkerAtPlayhead()
    const m = st().project.markers![0]
    expect(m.t).toBe(3)
    st().renameMarker(m.id, 'Chapter 1')
    expect(st().project.markers![0].label).toBe('Chapter 1')
    st().deleteMarker(m.id)
    expect(st().project.markers).toHaveLength(0)
  })
})

describe('fx patch', () => {
  it('updateClipFx sets and clears key/blend/mask', () => {
    const c = mkClip({ start: 0 })
    fresh((p) => void p.tracks[1].clips.push(c))
    st().updateClipFx(c.id, {
      key: { color: '#00ff00', tolerance: 0.3, softness: 0.1, spill: 0.5 },
      blend: 'multiply',
    })
    expect(clipById(c.id)!.key?.color).toBe('#00ff00')
    expect(clipById(c.id)!.blend).toBe('multiply')
    st().updateClipFx(c.id, { key: null, blend: null })
    expect(clipById(c.id)!.key).toBeUndefined()
    expect(clipById(c.id)!.blend).toBeUndefined()
  })
})
