import { describe, expect, it } from 'vitest'
import { audioFxChain, audioFxFilter } from './audioFx'
import type { Effect } from '../types/project'

const fx = (type: Effect['type'], params: Effect['params'], enabled = true): Effect => ({
  id: 'x',
  type,
  enabled,
  params,
})

describe('audioFxFilter (the export authority)', () => {
  it('eq emits only non-zero bands, in low→mid→high order', () => {
    expect(audioFxFilter(fx('eq', { lowGain: 0, midGain: 0, highGain: 0 }))).toBeNull()
    const f = audioFxFilter(
      fx('eq', {
        lowGain: -6,
        lowFreq: 100,
        midGain: 3,
        midFreq: 2000,
        midQ: 2,
        highGain: -12,
        highFreq: 6000,
      }),
    )!
    expect(f).toBe(
      'lowshelf=g=-6.0:f=100,equalizer=f=2000:t=q:w=2.00:g=3.0,highshelf=g=-12.0:f=6000',
    )
  })

  it('compressor converts dB threshold/makeup to linear and clamps ratio', () => {
    const f = audioFxFilter(
      fx('compressor', { threshold: -20, ratio: 50, attack: 5, release: 100, makeup: 6 }),
    )!
    expect(f).toContain(`threshold=${Math.pow(10, -20 / 20).toFixed(6)}`)
    expect(f).toContain('ratio=20.00') // limiter cap
    expect(f).toContain(`makeup=${Math.pow(10, 6 / 20).toFixed(3)}`)
    expect(f).toContain('detection=peak')
  })

  it('gate uses linear threshold and full-range mute', () => {
    const f = audioFxFilter(fx('gate', { threshold: -40, attack: 10, release: 120 }))!
    expect(f).toContain(`agate=threshold=${Math.pow(10, -40 / 20).toFixed(6)}`)
    expect(f).toContain('range=0')
  })

  it('disabled effects and non-audio types are identity', () => {
    expect(audioFxFilter(fx('compressor', {}, false))).toBeNull()
    expect(audioFxFilter(fx('blur', { amount: 5 }))).toBeNull()
  })

  it('audioFxChain keeps stack order and skips video effects', () => {
    const chain = audioFxChain([
      fx('gate', { threshold: -40 }),
      fx('blur', { amount: 3 }),
      fx('compressor', { threshold: -24, ratio: 4 }),
    ])
    expect(chain).toHaveLength(2)
    expect(chain[0]).toContain('agate')
    expect(chain[1]).toContain('acompressor')
  })
})
