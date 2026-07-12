import type { Project } from '../types/project'
import { clipDuration, clipEnd, sourceTime } from './time'
import { getWaveform } from './waveform'
import { useStore } from '../state/store'

// Auto-duck (session 9, Phase 7): drop a music clip's volume while any OTHER
// audible clip has signal — a plain envelope follower over the waveform peaks
// we already decode for the timeline. No ML, no new decode path.

const BUCKET = 0.1 // seconds
const THRESHOLD = 0.06 // peak amplitude that counts as "speech present"
const DUCK_GAIN = 0.25
const RAMP = 0.25 // seconds
const GAP_MERGE = 0.6 // merge speech windows closer than this

export async function duckUnderSpeech(clipId: string): Promise<number> {
  const s = useStore.getState()
  const p: Project = s.project
  const target = p.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)
  if (!target) return 0
  const dur = clipDuration(target)
  const buckets = Math.ceil(dur / BUCKET)
  const active = new Array<boolean>(buckets).fill(false)

  // Every other audible clip overlapping the target's span votes into buckets.
  for (const track of p.tracks) {
    for (const other of track.clips) {
      if (other.id === clipId || !other.mediaId) continue
      const asset = p.media.find((m) => m.id === other.mediaId)
      if (!asset?.hasAudio || asset.missing) continue
      const wf = await getWaveform(asset)
      if (!wf) continue
      for (let b = 0; b < buckets; b++) {
        const tAbs = target.start + b * BUCKET
        if (tAbs < other.start || tAbs >= clipEnd(other)) continue
        const src = sourceTime(other, tAbs)
        const peak = wf.peaks[Math.floor(src * wf.pps)] ?? 0
        if (peak > THRESHOLD) active[b] = true
      }
    }
  }

  // Merge close windows, then emit a keyframe envelope with short ramps.
  const windows: [number, number][] = []
  let start: number | null = null
  for (let b = 0; b <= buckets; b++) {
    const on = b < buckets && active[b]
    if (on && start === null) start = b * BUCKET
    if (!on && start !== null) {
      windows.push([start, b * BUCKET])
      start = null
    }
  }
  const merged: [number, number][] = []
  for (const w of windows) {
    const last = merged[merged.length - 1]
    if (last && w[0] - last[1] < GAP_MERGE) last[1] = w[1]
    else merged.push([...w] as [number, number])
  }

  const base = target.volume
  const pts: { t: number; v: number }[] = []
  for (const [a, b] of merged) {
    pts.push({ t: Math.max(0, a - RAMP), v: base })
    pts.push({ t: a, v: base * DUCK_GAIN })
    pts.push({ t: b, v: base * DUCK_GAIN })
    pts.push({ t: Math.min(dur, b + RAMP), v: base })
  }
  if (pts.length) s.applyDuckingEnvelope(clipId, pts)
  return merged.length
}
