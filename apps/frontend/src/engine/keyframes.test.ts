import { describe, expect, it } from 'vitest'
import { applyEase, resolveProp, staticValue } from './keyframes'
import { mkClip } from './testUtils'
import type { Ease } from '../types/project'

// This module is the DISPLAY MIRROR of the Rust resolver (see the header in
// keyframes.ts). These tests pin the CONTEXT.md §1.2 contract on the TS side;
// the dev:f1_parity_test e2e keeps TS and Rust agreeing with each other.

describe('staticValue', () => {
  it('reads transform, volume, effect scalars, and defaults to 0', () => {
    const c = mkClip({ volume: 0.5, blur: 3, vignette: 0.2 })
    c.transform.scale = 2
    expect(staticValue(c, 'transform.scale')).toBe(2)
    expect(staticValue(c, 'volume')).toBe(0.5)
    expect(staticValue(c, 'blur')).toBe(3)
    expect(staticValue(c, 'vignette')).toBe(0.2)
    expect(staticValue(c, 'grade.exposure')).toBe(0) // no grade set
    expect(staticValue(c, 'nonsense')).toBe(0)
  })
})

describe('resolveProp', () => {
  it('returns the static value with no keyframes', () => {
    const c = mkClip({ volume: 0.7 })
    expect(resolveProp(c, 'volume', 1)).toBe(0.7)
  })

  it('holds first before and last after the keyframed range', () => {
    const c = mkClip({
      keyframes: [
        { prop: 'transform.x', t: 1, v: 10, ease: 'linear' },
        { prop: 'transform.x', t: 2, v: 20, ease: 'linear' },
      ],
    })
    expect(resolveProp(c, 'transform.x', 0)).toBe(10)
    expect(resolveProp(c, 'transform.x', 5)).toBe(20)
  })

  it('interpolates between brackets with the LEFT keyframe easing', () => {
    const c = mkClip({
      keyframes: [
        { prop: 'transform.x', t: 0, v: 0, ease: 'linear' },
        { prop: 'transform.x', t: 2, v: 100, ease: 'easeIn' }, // right ease must NOT matter
      ],
    })
    expect(resolveProp(c, 'transform.x', 1)).toBeCloseTo(50, 9)
  })

  it('ignores keyframes of other properties', () => {
    const c = mkClip({
      volume: 1,
      keyframes: [{ prop: 'transform.x', t: 0, v: 99, ease: 'linear' }],
    })
    expect(resolveProp(c, 'volume', 0)).toBe(1)
  })

  it('unsorted keyframe storage still resolves in time order', () => {
    const c = mkClip({
      keyframes: [
        { prop: 'volume', t: 2, v: 0, ease: 'linear' },
        { prop: 'volume', t: 0, v: 1, ease: 'linear' },
      ],
    })
    expect(resolveProp(c, 'volume', 1)).toBeCloseTo(0.5, 9)
  })
})

describe('easings', () => {
  const eases: Ease[] = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'spring']
  it('all map 0→0 and 1→1 (spring approximately)', () => {
    for (const e of eases) {
      expect(applyEase(e, 0)).toBeCloseTo(0, 6)
      expect(applyEase(e, 1)).toBeCloseTo(1, e === 'spring' ? 1 : 6)
    }
  })
  it('clamps outside [0,1]', () => {
    expect(applyEase('linear', -1)).toBe(0)
    expect(applyEase('linear', 2)).toBe(1)
  })
  it('the non-spring easings are monotonic', () => {
    for (const e of ['linear', 'easeIn', 'easeOut', 'easeInOut'] as Ease[]) {
      let prev = -Infinity
      for (let i = 0; i <= 100; i++) {
        const v = applyEase(e, i / 100)
        expect(v).toBeGreaterThanOrEqual(prev - 1e-12)
        prev = v
      }
    }
  })
})
