import { describe, expect, it } from 'vitest'
import { columnReduce } from './waveform'
import { dbfs, meterFrac } from './audioGraph'

describe('columnReduce', () => {
  // 10 buckets/s, 1s of data: a single hot bucket at index 5.
  const wf = {
    peaks: new Float32Array([0.1, 0.1, 0.1, 0.1, 0.1, 0.9, 0.1, 0.1, 0.1, 0.1]),
    rms: new Float32Array([0.05, 0.05, 0.05, 0.05, 0.05, 0.6, 0.05, 0.05, 0.05, 0.05]),
    pps: 10,
  }

  it('zoomed out, the hot peak survives (MAX, never point-sample)', () => {
    // 2 columns for the whole second: each covers 5 buckets.
    const { peak, rms } = columnReduce(wf, 0, 0.5, 2)
    expect(peak[0]).toBeCloseTo(0.1, 6)
    expect(peak[1]).toBeCloseTo(0.9, 6) // bucket 5 lands in column 1
    expect(rms[1]).toBeCloseTo(0.6, 6)
  })

  it('zoomed in, columns narrower than a bucket still read it', () => {
    // 4 columns over bucket 5 only (0.5s..0.6s).
    const { peak } = columnReduce(wf, 0.5, 0.025, 4)
    for (let i = 0; i < 4; i++) expect(peak[i]).toBeCloseTo(0.9, 6)
  })

  it('clamps out-of-range columns to silence', () => {
    const { peak } = columnReduce(wf, 5, 0.1, 3) // beyond the data
    expect(Array.from(peak)).toEqual([0, 0, 0])
  })
})

describe('meter dB mapping', () => {
  it('dbfs of full scale is 0, of silence is the floor', () => {
    expect(dbfs(1)).toBeCloseTo(0, 6)
    expect(dbfs(0)).toBe(-80) // 1e-4 floor
    expect(dbfs(0.5)).toBeCloseTo(-6.02, 1)
  })
  it('meterFrac spans -60..0 dB', () => {
    expect(meterFrac(1)).toBe(1)
    expect(meterFrac(0.001)).toBe(0) // -60 dB
    expect(meterFrac(0.25)).toBeCloseTo((dbfs(0.25) + 60) / 60, 6)
  })
})
