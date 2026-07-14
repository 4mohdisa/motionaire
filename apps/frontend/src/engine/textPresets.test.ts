import { describe, expect, it } from 'vitest'
import { expandTextAnimation } from './textPresets'
import { mkClip } from './testUtils'

describe('expandTextAnimation', () => {
  it('fade in/out expands to opacity keyframes at both edges', () => {
    const c = mkClip({
      kind: 'text',
      mediaId: undefined,
      in: 0,
      out: 3,
      animation: { in: 'fade', out: 'fade', duration: 0.3 },
    })
    expandTextAnimation(c)
    const op = c.keyframes.filter((k) => k.prop === 'transform.opacity').sort((a, b) => a.t - b.t)
    expect(op.length).toBeGreaterThanOrEqual(4)
    expect(op[0].t).toBe(0)
    expect(op[0].v).toBe(0)
    expect(op[op.length - 1].t).toBeCloseTo(3, 6)
    expect(op[op.length - 1].v).toBe(0)
  })

  it('none produces no keyframes', () => {
    const c = mkClip({
      kind: 'text',
      mediaId: undefined,
      in: 0,
      out: 3,
      animation: { in: 'none', out: 'none', duration: 0.3 },
    })
    expandTextAnimation(c)
    expect(c.keyframes).toHaveLength(0)
  })

  it('fadeUp adds a y movement alongside opacity', () => {
    const c = mkClip({
      kind: 'text',
      mediaId: undefined,
      in: 0,
      out: 3,
      animation: { in: 'fadeUp', out: 'none', duration: 0.3 },
    })
    expandTextAnimation(c)
    expect(c.keyframes.some((k) => k.prop === 'transform.y')).toBe(true)
    expect(c.keyframes.some((k) => k.prop === 'transform.opacity')).toBe(true)
  })

  it('re-expansion replaces previous animation keyframes instead of stacking', () => {
    const c = mkClip({
      kind: 'text',
      mediaId: undefined,
      in: 0,
      out: 3,
      animation: { in: 'fade', out: 'fade', duration: 0.3 },
    })
    expandTextAnimation(c)
    const n = c.keyframes.length
    expandTextAnimation(c)
    expect(c.keyframes.length).toBe(n)
  })
})
