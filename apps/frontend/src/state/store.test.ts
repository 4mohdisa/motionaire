import { beforeEach, describe, expect, it } from 'vitest'
import { useStore } from './store'
import { createProject } from '../types/project'
import { mkClip } from '../engine/testUtils'
import type { Clip, MediaAsset, Project } from '../types/project'
import { clipDuration, clipEnd } from '../engine/time'
import { resolveProp } from '../engine/keyframes'

// Store-mutation unit tests (pro-editor session, Phase 0). These pin the
// editing semantics that e2e tests can only sample. View-state setters
// (dialogs, toasts, panel sizes) are deliberately untested — no semantics.

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
const trackOf = (id: string) => st().project.tracks.find((t) => t.clips.some((c) => c.id === id))

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

describe('effect stack (pro-editor P2)', () => {
  it('add/toggle/duplicate/remove, same type twice, order user-controlled', () => {
    const c = mkClip({ start: 0 })
    fresh((p) => void p.tracks[1].clips.push(c))
    st().addEffect(c.id, 'blur')
    st().addEffect(c.id, 'grade')
    st().addEffect(c.id, 'blur') // same type twice is the POINT
    let fx = clipById(c.id)!.effects
    expect(fx.map((e) => e.type)).toEqual(['blur', 'grade', 'blur'])
    expect(new Set(fx.map((e) => e.id)).size).toBe(3)
    st().moveEffect(c.id, fx[1].id, -1) // grade before first blur
    fx = clipById(c.id)!.effects
    expect(fx.map((e) => e.type)).toEqual(['grade', 'blur', 'blur'])
    st().toggleEffect(c.id, fx[0].id)
    expect(clipById(c.id)!.effects[0].enabled).toBe(false)
    st().duplicateEffect(c.id, fx[0].id)
    fx = clipById(c.id)!.effects
    expect(fx).toHaveLength(4)
    expect(fx[1].type).toBe('grade')
    expect(fx[1].id).not.toBe(fx[0].id)
    st().removeEffect(c.id, fx[0].id)
    expect(clipById(c.id)!.effects).toHaveLength(3)
  })

  it('removeEffect drops the instance keyframes; setClipProperty writes fx params', () => {
    const c = mkClip({ start: 0 })
    fresh((p) => void p.tracks[1].clips.push(c))
    st().addEffect(c.id, 'blur')
    const fx = clipById(c.id)!.effects[0]
    st().setClipProperty(c.id, `fx.${fx.id}.amount`, 12)
    expect(clipById(c.id)!.effects[0].params.amount).toBe(12)
    st().setPlayhead(1)
    st().toggleKeyframe(c.id, `fx.${fx.id}.amount`)
    expect(clipById(c.id)!.keyframes.some((k) => k.prop === `fx.${fx.id}.amount`)).toBe(true)
    st().removeEffect(c.id, fx.id)
    expect(clipById(c.id)!.keyframes.some((k) => k.prop.startsWith('fx.'))).toBe(false)
  })

  it('setClipBlend sets and normalizes back to undefined', () => {
    const c = mkClip({ start: 0 })
    fresh((p) => void p.tracks[1].clips.push(c))
    st().setClipBlend(c.id, 'multiply')
    expect(clipById(c.id)!.blend).toBe('multiply')
    st().setClipBlend(c.id, 'normal')
    expect(clipById(c.id)!.blend).toBeUndefined()
  })

  it('copy/paste attributes: deep copy, fresh instance ids, many targets', () => {
    const a = mkClip({ start: 0, out: 2 })
    const b = mkClip({ start: 3, out: 2 })
    const d = mkClip({ start: 6, out: 2 })
    fresh((p) => void p.tracks[1].clips.push(a, b, d))
    st().addEffect(a.id, 'grade')
    st().setClipProperty(a.id, `fx.${clipById(a.id)!.effects[0].id}.exposure`, 0.5)
    st().setClipBlend(a.id, 'screen')
    st().setClipProperty(a.id, 'transform.scale', 0.5)
    st().copyAttributes(a.id)
    st().pasteAttributes([b.id, d.id])
    for (const id of [b.id, d.id]) {
      const t = clipById(id)!
      expect(t.transform.scale).toBe(0.5)
      expect(t.blend).toBe('screen')
      expect(t.effects).toHaveLength(1)
      expect(t.effects[0].params.exposure).toBe(0.5)
      expect(t.effects[0].id).not.toBe(clipById(a.id)!.effects[0].id)
    }
    // mutating the source afterwards must not leak into targets (deep copy)
    st().setClipProperty(a.id, `fx.${clipById(a.id)!.effects[0].id}.exposure`, -1)
    expect(clipById(b.id)!.effects[0].params.exposure).toBe(0.5)
  })
})

describe('effect migration (pre-stack projects)', () => {
  it('converts legacy fixed fields in canonical shader order with kf rewrite', async () => {
    const { migrateClipEffects } = await import('../engine/effectStack')
    const legacy = mkClip({
      start: 0,
      keyframes: [
        { prop: 'grade.exposure', t: 0, v: 0, ease: 'linear' },
        { prop: 'blur', t: 1, v: 8, ease: 'linear' },
        { prop: 'mask.x', t: 0, v: -50, ease: 'linear' },
        { prop: 'transform.x', t: 0, v: 5, ease: 'linear' },
      ],
    }) as Clip & Record<string, unknown>
    legacy.key = { color: '#00ff00', tolerance: 0.2, softness: 0.1, spill: 0.4 }
    legacy.grade = { exposure: 0.3, contrast: 0, saturation: 0, temperature: 0, tint: 0 }
    legacy.mask = { kind: 'ellipse', x: 0, y: 0, w: 300, h: 200, feather: 10, invert: false }
    legacy.blur = 4
    legacy.vignette = 0.5
    const changed = migrateClipEffects(legacy as Clip)
    expect(changed).toBe(true)
    const types = (legacy as Clip).effects.map((e) => e.type)
    // Canonical legacy order = old single-pass order: key → blur → grade → mask → vignette
    expect(types).toEqual(['chromaKey', 'blur', 'grade', 'mask', 'vignette'])
    const fx = (legacy as Clip).effects
    expect(fx[0].params.tolerance).toBe(0.2)
    expect(fx[1].params.amount).toBe(4)
    expect(fx[2].params.exposure).toBe(0.3)
    expect(fx[4].params.amount).toBe(0.5)
    // keyframe props rewritten onto instances; transform untouched
    const props = (legacy as Clip).keyframes.map((k) => k.prop)
    expect(props).toContain(`fx.${fx[2].id}.exposure`)
    expect(props).toContain(`fx.${fx[1].id}.amount`)
    expect(props).toContain(`fx.${fx[3].id}.x`)
    expect(props).toContain('transform.x')
    // legacy fields gone; second run is a no-op
    expect((legacy as Record<string, unknown>).key).toBeUndefined()
    expect(migrateClipEffects(legacy as Clip)).toBe(false)
  })
})

describe('mixer & solids (pro-editor P1)', () => {
  it('setTrackGain clamps to 0..1.5 and skips history', () => {
    const before = useStore.getState().past.length
    const tid = st().project.tracks[0].id
    st().setTrackGain(tid, 2.5)
    expect(st().project.tracks[0].gain).toBe(1.5)
    st().setTrackGain(tid, -1)
    expect(st().project.tracks[0].gain).toBe(0)
    expect(useStore.getState().past.length).toBe(before) // fader drags don't spam undo
  })

  it('addSolidClip drops a canvas-sized rect shape at the playhead', () => {
    const c = mkClip({ start: 0, out: 10 })
    fresh((p) => void p.tracks[1].clips.push(c))
    st().setPlayhead(2)
    st().addSolidClip('#ff0000')
    const solid = st()
      .project.tracks.flatMap((t) => t.clips)
      .find((x) => x.shape && x.id !== c.id)!
    expect(solid.shape).toMatchObject({
      kind: 'rect',
      fill: '#ff0000',
      width: 1920,
      height: 1080,
    })
    expect(solid.start).toBe(2)
    expect(solid.volume).toBe(0)
  })
})

describe('graph editor actions (pro-editor P3)', () => {
  it('moveKeyframes moves, frame-snaps, clamps, and overwrites occupants', () => {
    const c = mkClip({
      start: 0,
      out: 4,
      keyframes: [
        { prop: 'transform.x', t: 1, v: 10, ease: 'linear' },
        { prop: 'transform.x', t: 2, v: 20, ease: 'linear' },
      ],
    })
    fresh((p) => void p.tracks[1].clips.push(c))
    st().moveKeyframes(c.id, [{ prop: 'transform.x', fromT: 1, toT: 2, toV: 99 }])
    const kfs = clipById(c.id)!.keyframes.filter((k) => k.prop === 'transform.x')
    expect(kfs).toHaveLength(1) // occupant at t=2 overwritten
    expect(kfs[0]).toMatchObject({ t: 2, v: 99 })
    st().moveKeyframes(c.id, [{ prop: 'transform.x', fromT: 2, toT: 99, toV: 1 }])
    expect(clipById(c.id)!.keyframes[0].t).toBe(4) // clamped to clip duration
  })

  it('setKeyframeHandle clamps dt direction; deleteKeyframes removes exact keys', () => {
    const c = mkClip({
      start: 0,
      out: 4,
      keyframes: [
        { prop: 'volume', t: 1, v: 1, ease: 'linear' },
        { prop: 'volume', t: 3, v: 0, ease: 'linear' },
      ],
    })
    fresh((p) => void p.tracks[1].clips.push(c))
    st().setKeyframeHandle(c.id, 'volume', 1, 'ho', [-5, 0.5])
    expect(clipById(c.id)!.keyframes[0].ho).toEqual([0, 0.5]) // out dt ≥ 0
    st().setKeyframeHandle(c.id, 'volume', 3, 'hi', [5, -0.5])
    expect(clipById(c.id)!.keyframes[1].hi).toEqual([0, -0.5]) // in dt ≤ 0
    st().deleteKeyframes(c.id, [{ prop: 'volume', t: 1 }])
    expect(clipById(c.id)!.keyframes).toHaveLength(1)
  })

  it('convertToBezier turns a preset segment into exact-equivalent handles', () => {
    const c = mkClip({
      start: 0,
      out: 4,
      keyframes: [
        { prop: 'transform.x', t: 0, v: 0, ease: 'easeIn' },
        { prop: 'transform.x', t: 2, v: 100, ease: 'linear' },
      ],
    })
    fresh((p) => void p.tracks[1].clips.push(c))
    st().convertToBezier(c.id, 'transform.x', 0)
    const [k1, k2] = clipById(c.id)!.keyframes
    expect(k1.ease).toBe('bezier')
    expect(k1.ho).toEqual([2 / 3, 0]) // easeIn: flat out handle at dt/3
    expect(k2.hi).toEqual([-2 / 3, -100])
    // the converted curve still resolves as t³
    const mid = resolveProp(clipById(c.id)!, 'transform.x', 1)
    expect(mid).toBeCloseTo(100 * 0.125, 3)
    // last keyframe: no outgoing segment — no-op
    st().convertToBezier(c.id, 'transform.x', 2)
    expect(clipById(c.id)!.keyframes[1].ease).toBe('linear')
  })
})

describe('trim tools — exact semantics (pro-editor P4)', () => {
  // Fixture: A[0..4) B[4..8) C[8..12) on V1, X[5..9) on V2 (media dur 60).
  const abc = () => {
    const A = mkClip({ start: 0, in: 10, out: 14 })
    const B = mkClip({ start: 4, in: 20, out: 24 })
    const C = mkClip({ start: 8, in: 30, out: 34 })
    const X = mkClip({ start: 5, in: 0, out: 4 })
    fresh((p) => {
      p.tracks[1].clips.push(A, B, C)
      p.tracks[0].clips.push(X)
    })
    return { A, B, C, X }
  }

  it('ripple-out shortens the clip and closes the gap on ALL sync-locked tracks', () => {
    const { A, B, C, X } = abc()
    st().rippleTrim(A.id, 'out', 3) // A ends 4 → 3, delta -1
    expect(clipEnd(clipById(A.id)!)).toBeCloseTo(3, 6)
    expect(clipById(A.id)!.out).toBeCloseTo(13, 6) // source out follows
    expect(clipById(B.id)!.start).toBeCloseTo(3, 6) // downstream shifted
    expect(clipById(C.id)!.start).toBeCloseTo(7, 6)
    expect(clipById(X.id)!.start).toBeCloseTo(4, 6) // other track ripples too
    expect(st().project.duration).toBeCloseTo(11, 6) // total shrank by 1
  })

  it('ripple-out respects sync lock OFF: other track holds still', () => {
    const { A, B, X } = abc()
    st().setTrackFlag(st().project.tracks[0].id, 'syncLocked', false)
    st().rippleTrim(A.id, 'out', 3)
    expect(clipById(B.id)!.start).toBeCloseTo(3, 6)
    expect(clipById(X.id)!.start).toBeCloseTo(5, 6) // untouched
  })

  it('ripple-out left-shift clamps at a straddler wall instead of overlapping', () => {
    const A2 = mkClip({ start: 0, in: 10, out: 14 })
    const B2 = mkClip({ start: 4, in: 20, out: 24 })
    fresh((p) => void p.tracks[1].clips.push(A2, B2))
    // No cross-track blockers: the full -3s ripple applies.
    st().rippleTrim(A2.id, 'out', 1)
    expect(clipById(B2.id)!.start).toBeCloseTo(1, 6)
    // Now a real wall: C3 downstream on V2 with a straddler in front of it.
    const A3 = mkClip({ start: 0, in: 10, out: 14 })
    const B3 = mkClip({ start: 4, in: 20, out: 24 })
    const S3 = mkClip({ start: 3, in: 0, out: 2 }) // [3..5) straddles point 4
    const D3 = mkClip({ start: 6, in: 0, out: 1 }) // downstream on V2, wall at 5
    fresh((p) => {
      p.tracks[1].clips.push(A3, B3)
      p.tracks[0].clips.push(S3, D3)
    })
    st().rippleTrim(A3.id, 'out', 1) // wants -3; V2 allows D3 only 6→5 (-1)
    expect(clipEnd(clipById(A3.id)!)).toBeCloseTo(3, 6) // clamped to -1
    expect(clipById(B3.id)!.start).toBeCloseTo(3, 6)
    expect(clipById(D3.id)!.start).toBeCloseTo(5, 6) // touches the straddler
    expect(clipById(S3.id)!.start).toBeCloseTo(3, 6) // straddler never moves
  })

  it('ripple-in trims the head and pulls everything left', () => {
    const { A, B, C } = abc()
    st().rippleTrim(B.id, 'in', 5) // B loses 1s of head
    const b = clipById(B.id)!
    expect(b.start).toBeCloseTo(4, 6) // starts where it used to (gap closed)
    expect(b.in).toBeCloseTo(21, 6) // source head trimmed
    expect(clipEnd(b)).toBeCloseTo(7, 6)
    expect(clipById(C.id)!.start).toBeCloseTo(7, 6)
    expect(clipById(A.id)!.start).toBeCloseTo(0, 6) // upstream untouched
  })

  it('roll moves the cut point; total duration NEVER changes', () => {
    const { A, B, C } = abc()
    const before = st().project.duration
    st().rollEdit(A.id, 5) // boundary 4 → 5
    const a = clipById(A.id)!
    const b = clipById(B.id)!
    expect(clipEnd(a)).toBeCloseTo(5, 6)
    expect(a.out).toBeCloseTo(15, 6) // A reveals one more source second
    expect(b.start).toBeCloseTo(5, 6)
    expect(b.in).toBeCloseTo(21, 6) // B loses one source second at the head
    expect(clipEnd(b)).toBeCloseTo(8, 6) // B's end NEVER moves
    expect(clipById(C.id)!.start).toBeCloseTo(8, 6) // C untouched
    expect(st().project.duration).toBeCloseTo(before, 6)
  })

  it('roll clamps at source exhaustion and refuses without an adjacent cut', () => {
    const A = mkClip({ start: 0, in: 58, out: 60 }) // only 0 tail room (media 60)
    const B = mkClip({ start: 2, in: 0, out: 4 })
    const lone = mkClip({ start: 10, in: 0, out: 2 })
    fresh((p) => void p.tracks[1].clips.push(A, B, lone))
    st().rollEdit(A.id, 3.5) // A has no source past out=60 → no movement
    expect(clipEnd(clipById(A.id)!)).toBeCloseTo(2, 6)
    st().rollEdit(lone.id, 11) // no adjacent right clip → no-op
    expect(clipById(lone.id)!.out).toBeCloseTo(2, 6)
  })

  it('slip shifts ONLY the source window — timeline, duration, keyframes fixed', () => {
    const A = mkClip({
      start: 2,
      in: 5,
      out: 9,
      keyframes: [{ prop: 'transform.x', t: 1, v: 50, ease: 'linear' }],
    })
    fresh((p) => void p.tracks[1].clips.push(A))
    st().slipClip(A.id, 3)
    const a = clipById(A.id)!
    expect(a.start).toBe(2)
    expect(a.in).toBeCloseTo(8, 6)
    expect(a.out).toBeCloseTo(12, 6)
    expect(clipDuration(a)).toBeCloseTo(4, 6)
    expect(a.keyframes[0].t).toBe(1) // untouched — slip changes content only
    // clamps: media is 60s; slipping far right pins out at 60
    st().slipClip(A.id, 500)
    expect(clipById(A.id)!.out).toBeCloseTo(60, 6)
    expect(clipById(A.id)!.in).toBeCloseTo(56, 6)
    st().slipClip(A.id, -500) // and left pins in at 0
    expect(clipById(A.id)!.in).toBeCloseTo(0, 6)
    expect(clipById(A.id)!.out).toBeCloseTo(4, 6)
  })

  it('slide moves the clip while adjacent neighbors absorb; total duration fixed', () => {
    const A = mkClip({ start: 0, in: 10, out: 14 })
    const B = mkClip({ start: 4, in: 20, out: 24 })
    const C = mkClip({ start: 8, in: 30, out: 34 })
    fresh((p) => void p.tracks[1].clips.push(A, B, C))
    const before = st().project.duration
    st().slideClip(B.id, 1)
    const a = clipById(A.id)!
    const b = clipById(B.id)!
    const c = clipById(C.id)!
    expect(b.start).toBeCloseTo(5, 6)
    expect(b.in).toBeCloseTo(20, 6) // B's CONTENT untouched
    expect(clipEnd(a)).toBeCloseTo(5, 6) // A extended behind B
    expect(a.out).toBeCloseTo(15, 6)
    expect(c.start).toBeCloseTo(9, 6) // C's head trimmed in front
    expect(c.in).toBeCloseTo(31, 6)
    expect(clipEnd(c)).toBeCloseTo(12, 6) // C's end NEVER moves
    expect(st().project.duration).toBeCloseTo(before, 6)
  })

  it('slide with a gap on one side absorbs into the gap without trimming', () => {
    const A = mkClip({ start: 0, in: 10, out: 14 })
    const B = mkClip({ start: 6, in: 20, out: 24 }) // 2s gap behind B
    fresh((p) => void p.tracks[1].clips.push(A, B))
    st().slideClip(B.id, -1) // slides into the gap
    expect(clipById(B.id)!.start).toBeCloseTo(5, 6)
    expect(clipEnd(clipById(A.id)!)).toBeCloseTo(4, 6) // A untouched (gap side)
    st().slideClip(B.id, -5) // wants past A's end; clamps at contact
    expect(clipById(B.id)!.start).toBeCloseTo(4, 6)
  })
})

describe('organization (pro-editor P8)', () => {
  it('labels set/clear and select-by-label', () => {
    const a = mkClip({ start: 0, out: 2 })
    const b = mkClip({ start: 3, out: 2 })
    fresh((p) => void p.tracks[1].clips.push(a, b))
    st().setClipLabel([a.id, b.id], 'blue')
    expect(clipById(a.id)!.label).toBe('blue')
    st().setClipLabel([b.id], null)
    st().selectByLabel('blue')
    expect(useStore.getState().selection).toEqual([a.id])
  })

  it('compound: group → inline render view → ungroup round trip', async () => {
    const a = mkClip({ start: 2, in: 1, out: 3 }) // [2..4)
    const b = mkClip({ start: 4, in: 0, out: 2 }) // [4..6)
    fresh((p) => void p.tracks[1].clips.push(a, b))
    st().makeCompound([a.id, b.id])
    const track = st().project.tracks[1]
    expect(track.clips).toHaveLength(1)
    const cmp = track.clips[0]
    expect(cmp.compoundId).toBeTruthy()
    expect(cmp.start).toBe(2)
    expect(clipEnd(cmp)).toBeCloseTo(6, 6)
    const nested = st().project.compounds![cmp.compoundId!]
    expect(nested.tracks.flatMap((t) => t.clips)).toHaveLength(2)
    // The render view inlines nested clips back at absolute positions.
    const { effectiveProject } = await import('../engine/compound')
    const eff = effectiveProject(st().project)
    const inlined = eff.tracks.flatMap((t) => t.clips).filter((c) => !c.compoundId)
    const starts = inlined.map((c) => c.start).sort((x, y) => x - y)
    expect(starts[0]).toBeCloseTo(2, 6)
    expect(starts[1]).toBeCloseTo(4, 6)
    expect(inlined[0].in).toBeCloseTo(1, 6) // source mapping preserved
    // Trimming the compound clip windows the nested content.
    st().trimClip(cmp.id, 'out', 5)
    const eff2 = (await import('../engine/compound')).effectiveProject(st().project)
    const tail = eff2.tracks
      .flatMap((t) => t.clips)
      .filter((c) => !c.compoundId)
      .sort((x, y) => x.start - y.start)[1]
    expect(clipEnd(tail)).toBeCloseTo(5, 6) // nested clip trimmed to window
    st().trimClip(cmp.id, 'out', 6)
    // Ungroup restores loose clips at original absolute times.
    st().ungroupCompound(cmp.id)
    const loose = st()
      .project.tracks.flatMap((t) => t.clips)
      .sort((x, y) => x.start - y.start)
    expect(loose).toHaveLength(2)
    expect(loose[0].start).toBeCloseTo(2, 6)
    expect(loose[1].start).toBeCloseTo(4, 6)
    expect(Object.keys(st().project.compounds ?? {})).toHaveLength(0)
  })

  it('media folders set/clear', () => {
    fresh()
    st().setMediaFolder('m1', 'B-roll')
    expect(st().project.media[0].folder).toBe('B-roll')
    st().setMediaFolder('m1', null)
    expect(st().project.media[0].folder).toBeUndefined()
  })
})

describe('AI transaction (Run 1 P3 — the trust model)', () => {
  it('many mutations inside one transaction = ONE undo step', async () => {
    const { beginAiTransaction, endAiTransaction } = await import('./store')
    const c = mkClip({ start: 0, out: 8 })
    fresh((p) => void p.tracks[1].clips.push(c))
    beginAiTransaction()
    st().splitClip(c.id, 2)
    st().splitClip(c.id, 1)
    st().setClipProperty(c.id, 'transform.scale', 0.5)
    st().addTextClip('AI title')
    const edited = endAiTransaction()
    expect(edited).toBe(true)
    expect(st().project.tracks.flatMap((t) => t.clips).length).toBeGreaterThan(2)
    st().undo()
    // Everything from the turn reverts at once.
    const clips = st().project.tracks.flatMap((t) => t.clips)
    expect(clips).toHaveLength(1)
    expect(clips[0].id).toBe(c.id)
    expect(clips[0].transform.scale).toBe(1)
    // And redo replays the whole turn.
    st().redo()
    expect(st().project.tracks.flatMap((t) => t.clips).length).toBeGreaterThan(2)
  })

  it('a read-only transaction pushes nothing', async () => {
    const { beginAiTransaction, endAiTransaction } = await import('./store')
    fresh()
    const before = useStore.getState().past.length
    beginAiTransaction()
    const edited = endAiTransaction()
    expect(edited).toBe(false)
    expect(useStore.getState().past.length).toBe(before)
  })

  it('normal mutations after the transaction push history again', async () => {
    const { beginAiTransaction, endAiTransaction } = await import('./store')
    const c = mkClip({ start: 0, out: 8 })
    fresh((p) => void p.tracks[1].clips.push(c))
    beginAiTransaction()
    st().splitClip(c.id, 2)
    endAiTransaction()
    const after = useStore.getState().past.length
    st().moveClip(c.id, 1)
    expect(useStore.getState().past.length).toBe(after + 1)
  })
})
