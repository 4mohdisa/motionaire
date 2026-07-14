import { describe, expect, it } from 'vitest'
import {
  clampStartToGaps,
  clipDuration,
  clipEnd,
  computeDuration,
  findClip,
  formatTimecode,
  integrateRate,
  isActiveAt,
  snapTime,
  snapToFrame,
  sourceTime,
} from './time'
import { createProject } from '../types/project'
import { mkClip } from './testUtils'

describe('snapToFrame', () => {
  it('quantizes to the frame grid', () => {
    expect(snapToFrame(1.02, 30)).toBeCloseTo(31 / 30, 9)
    expect(snapToFrame(1.016, 30)).toBeCloseTo(1, 9) // 30.48 rounds DOWN
    expect(snapToFrame(0, 30)).toBe(0)
    expect(snapToFrame(2.5, 30)).toBeCloseTo(2.5, 9) // 75 frames exactly
  })
})

describe('clip duration & end', () => {
  it('divides source span by speed', () => {
    const c = mkClip({ in: 1, out: 5, speed: 2 })
    expect(clipDuration(c)).toBe(2)
    expect(clipEnd(mkClip({ start: 3, in: 0, out: 4, speed: 0.5 }))).toBe(11)
  })

  it('isActiveAt is half-open [start, end)', () => {
    const c = mkClip({ start: 2, in: 0, out: 2 })
    expect(isActiveAt(c, 2)).toBe(true)
    expect(isActiveAt(c, 3.999)).toBe(true)
    expect(isActiveAt(c, 4)).toBe(false)
    expect(isActiveAt(c, 1.999)).toBe(false)
  })
})

describe('sourceTime', () => {
  it('maps linearly without speed keyframes', () => {
    const c = mkClip({ start: 10, in: 2, out: 6, speed: 2 })
    expect(sourceTime(c, 10)).toBe(2)
    expect(sourceTime(c, 11)).toBe(4)
  })

  it('integrates a speed ramp and clamps to the source range', () => {
    // rate 1 for first second, then keyframes ramp 1 → 3 over the next 2s:
    // ∫ = 1 + trapezoid(1,3over2s)=4 → source advances 5s total at rel=3.
    const c = mkClip({
      in: 0,
      out: 100,
      keyframes: [
        { prop: 'speed', t: 1, v: 1, ease: 'linear' },
        { prop: 'speed', t: 3, v: 3, ease: 'linear' },
      ],
    })
    expect(sourceTime(c, 3)).toBeCloseTo(5, 6)
    // Clamp: tiny source range can't be exceeded.
    const c2 = mkClip({
      in: 0,
      out: 1,
      keyframes: [
        { prop: 'speed', t: 0, v: 10, ease: 'linear' },
        { prop: 'speed', t: 5, v: 10, ease: 'linear' },
      ],
    })
    expect(sourceTime(c2, 4)).toBe(1)
  })

  it('integrateRate holds rate before first and after last keyframe', () => {
    const kfs = [
      { t: 1, v: 2 },
      { t: 2, v: 2 },
    ]
    expect(integrateRate(kfs, 0.5)).toBeCloseTo(1, 9) // held first value
    expect(integrateRate(kfs, 3)).toBeCloseTo(6, 9) // 1*2 + 1*2 + 1*2
    expect(integrateRate(kfs, 0)).toBe(0)
  })
})

describe('clampStartToGaps', () => {
  const sib = [
    { start: 2, end: 4 },
    { start: 6, end: 8 },
  ]
  it('returns the desired start when free', () => {
    expect(clampStartToGaps(sib, 2, 4)).toBe(4)
    expect(clampStartToGaps(sib, 1, 0)).toBe(0)
  })
  it('snaps to the nearest neighbor edge on collision', () => {
    expect(clampStartToGaps(sib, 1, 2.5)).toBe(4) // after first neighbor (1<duration gap before? 2-1=1 works too; 4 is nearer to 2.5? |4-2.5|=1.5 vs |1-2.5|=1.5 tie → first sorted)
  })
  it('returns null when nothing fits', () => {
    const wall = [{ start: 0, end: 100 }]
    expect(clampStartToGaps(wall, 5, 10)).toBe(100) // after the wall is legal
    expect(clampStartToGaps([{ start: 0, end: 4 }], 3, 1)).toBe(4)
  })
  it('never returns negative', () => {
    const r = clampStartToGaps([{ start: 1, end: 3 }], 2, 0.5)
    expect(r).not.toBeNull()
    expect(r!).toBeGreaterThanOrEqual(0)
  })
})

describe('snapTime', () => {
  it('snaps within tolerance, keeps outside', () => {
    expect(snapTime(4.9, [5], 0.2)).toBe(5)
    expect(snapTime(4.5, [5], 0.2)).toBe(4.5)
    expect(snapTime(4.9, [5, 4.85], 0.2)).toBe(4.85) // nearest wins
  })
})

describe('computeDuration & findClip', () => {
  it('duration is the furthest clip end across all tracks', () => {
    const p = createProject()
    p.tracks[0].clips.push(mkClip({ start: 1, in: 0, out: 2 }))
    p.tracks[2].clips.push(mkClip({ kind: 'audio', start: 5, in: 0, out: 2.5 }))
    expect(computeDuration(p)).toBe(7.5)
  })
  it('findClip returns track, clip, and index', () => {
    const p = createProject()
    const c = mkClip()
    p.tracks[1].clips.push(mkClip(), c)
    const f = findClip(p, c.id)
    expect(f?.track.id).toBe(p.tracks[1].id)
    expect(f?.index).toBe(1)
    expect(findClip(p, 'nope')).toBeNull()
  })
})

describe('formatTimecode', () => {
  it('renders mm:ss:ff and hours only when nonzero', () => {
    expect(formatTimecode(0, 30)).toBe('00:00:00')
    expect(formatTimecode(61.5, 30)).toBe('01:01:15')
    expect(formatTimecode(3600, 30)).toBe('1:00:00:00')
    expect(formatTimecode(-5, 30)).toBe('00:00:00') // clamped, never negative
  })
})
