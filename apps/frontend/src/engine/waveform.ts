import type { MediaAsset } from '../types/project'

export interface WaveformData {
  peaks: Float32Array // max |sample| per bucket, PPS buckets per second
  rms: Float32Array // RMS per bucket — the solid inner body of the render
  pps: number
  duration: number
}

// 500 buckets/s (pro-editor session, Phase 1; was 50): at typical zooms a
// pixel column spans ≥1 bucket, so rendering stays peak-accurate instead of
// blocky. Cost: two Float32Arrays ≈ 4KB/s of audio — negligible.
export const WAVEFORM_PPS = 500

// Decode once per media asset, cache the promise. Object URLs are fetchable same-origin.
const cache = new Map<string, Promise<WaveformData | null>>()

export function getWaveform(asset: MediaAsset): Promise<WaveformData | null> {
  let p = cache.get(asset.id)
  if (!p) {
    p = compute(asset)
    cache.set(asset.id, p)
  }
  return p
}

// Reduce cached buckets to per-pixel-column {peak, rms} at the current zoom:
// each column takes the MAX (and max RMS) over the source range it covers —
// never a point sample, so zooming out cannot alias peaks away.
// Pure so the unit suite can pin it.
export function columnReduce(
  wf: Pick<WaveformData, 'peaks' | 'rms' | 'pps'>,
  srcStart: number, // source seconds at column 0
  srcPerPx: number, // source seconds covered by one column
  cols: number,
): { peak: Float32Array; rms: Float32Array } {
  const peak = new Float32Array(cols)
  const rms = new Float32Array(cols)
  for (let x = 0; x < cols; x++) {
    const from = Math.max(0, Math.floor((srcStart + x * srcPerPx) * wf.pps))
    const to = Math.min(
      wf.peaks.length,
      Math.max(from + 1, Math.ceil((srcStart + (x + 1) * srcPerPx) * wf.pps)),
    )
    let p = 0
    let r = 0
    for (let i = from; i < to; i++) {
      if (wf.peaks[i] > p) p = wf.peaks[i]
      if (wf.rms[i] > r) r = wf.rms[i]
    }
    peak[x] = p
    rms[x] = r
  }
  return { peak, rms }
}

async function compute(asset: MediaAsset): Promise<WaveformData | null> {
  try {
    const buf = await fetch(asset.playbackUrl || asset.path).then((r) => r.arrayBuffer())
    // OfflineAudioContext decodes without autoplay-policy involvement.
    const ctx = new OfflineAudioContext(1, 1, 44100)
    const audio = await ctx.decodeAudioData(buf)
    if (audio.numberOfChannels === 0 || audio.length === 0) return null
    const buckets = Math.max(1, Math.ceil(audio.duration * WAVEFORM_PPS))
    const peaks = new Float32Array(buckets)
    const rms = new Float32Array(buckets)
    const samplesPerBucket = audio.length / buckets
    for (let ch = 0; ch < audio.numberOfChannels; ch++) {
      const data = audio.getChannelData(ch)
      for (let b = 0; b < buckets; b++) {
        const from = Math.floor(b * samplesPerBucket)
        const to = Math.min(data.length, Math.floor((b + 1) * samplesPerBucket))
        let max = peaks[b]
        let sum = 0
        for (let i = from; i < to; i++) {
          const a = Math.abs(data[i])
          if (a > max) max = a
          sum += data[i] * data[i]
        }
        peaks[b] = max
        const r = to > from ? Math.sqrt(sum / (to - from)) : 0
        if (r > rms[b]) rms[b] = r
      }
    }
    return { peaks, rms, pps: WAVEFORM_PPS, duration: audio.duration }
  } catch {
    // No decodable audio track (or unsupported container) — treated as "no audio".
    return null
  }
}
