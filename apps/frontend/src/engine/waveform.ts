import type { MediaAsset } from '../types/project'

export interface WaveformData {
  peaks: Float32Array // max |sample| per bucket, PPS buckets per second
  pps: number
  duration: number
}

export const WAVEFORM_PPS = 50

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

async function compute(asset: MediaAsset): Promise<WaveformData | null> {
  try {
    const buf = await fetch(asset.path).then((r) => r.arrayBuffer())
    // OfflineAudioContext decodes without autoplay-policy involvement.
    const ctx = new OfflineAudioContext(1, 1, 44100)
    const audio = await ctx.decodeAudioData(buf)
    if (audio.numberOfChannels === 0 || audio.length === 0) return null
    const buckets = Math.max(1, Math.ceil(audio.duration * WAVEFORM_PPS))
    const peaks = new Float32Array(buckets)
    const samplesPerBucket = audio.length / buckets
    for (let ch = 0; ch < audio.numberOfChannels; ch++) {
      const data = audio.getChannelData(ch)
      for (let b = 0; b < buckets; b++) {
        const from = Math.floor(b * samplesPerBucket)
        const to = Math.min(data.length, Math.floor((b + 1) * samplesPerBucket))
        let max = peaks[b]
        for (let i = from; i < to; i++) {
          const a = Math.abs(data[i])
          if (a > max) max = a
        }
        peaks[b] = max
      }
    }
    return { peaks, pps: WAVEFORM_PPS, duration: audio.duration }
  } catch {
    // No decodable audio track (or unsupported container) — treated as "no audio".
    return null
  }
}
