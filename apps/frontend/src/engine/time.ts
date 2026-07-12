import type { Clip, Project, Track } from '../types/project'

// CONTEXT.md §2.4: frame-snap everything.
export function snapToFrame(t: number, fps: number): number {
  return Math.round(t * fps) / fps
}

export function clipDuration(c: Clip): number {
  return (c.out - c.in) / c.speed
}

export function clipEnd(c: Clip): number {
  return c.start + clipDuration(c)
}

export function isActiveAt(c: Clip, t: number): boolean {
  return c.start <= t && t < clipEnd(c)
}

// Map a timeline time to the clip's source (media) time.
export function sourceTime(c: Clip, t: number): number {
  return c.in + (t - c.start) * c.speed
}

export function computeDuration(p: Project): number {
  let max = 0
  for (const tr of p.tracks) for (const c of tr.clips) max = Math.max(max, clipEnd(c))
  return max
}

export function findClip(p: Project, clipId: string): { track: Track; clip: Clip; index: number } | null {
  for (const tr of p.tracks) {
    const i = tr.clips.findIndex((c) => c.id === clipId)
    if (i >= 0) return { track: tr, clip: tr.clips[i], index: i }
  }
  return null
}

// Video-kind clips active at t, sorted topmost (highest track z) first.
export function activeVideoClips(p: Project, t: number): { clip: Clip; z: number }[] {
  const out: { clip: Clip; z: number }[] = []
  for (const tr of p.tracks) {
    if (tr.kind !== 'video') continue
    for (const c of tr.clips) if (c.kind === 'video' && isActiveAt(c, t)) out.push({ clip: c, z: tr.z })
  }
  return out.sort((a, b) => b.z - a.z)
}

export function activeAudioClips(p: Project, t: number): Clip[] {
  const out: Clip[] = []
  for (const tr of p.tracks) {
    if (tr.kind !== 'audio') continue
    for (const c of tr.clips) if (c.kind === 'audio' && isActiveAt(c, t)) out.push(c)
  }
  return out
}

export function activeTextClips(p: Project, t: number): { clip: Clip; z: number }[] {
  const out: { clip: Clip; z: number }[] = []
  for (const tr of p.tracks) {
    if (tr.kind !== 'video') continue
    for (const c of tr.clips) if (c.kind === 'text' && isActiveAt(c, t)) out.push({ clip: c, z: tr.z })
  }
  return out.sort((a, b) => a.z - b.z) // render order: lowest first, highest on top
}

// Clamp a desired start so [start, start+duration) doesn't overlap siblings.
// Returns null when the clip can't be placed near the desired position.
export function clampStartToGaps(
  siblings: { start: number; end: number }[],
  duration: number,
  desired: number,
): number | null {
  const d = Math.max(0, desired)
  const hits = (s: number) =>
    siblings.some((o) => s < o.end - 1e-6 && o.start + 1e-6 < s + duration)
  if (!hits(d)) return d
  // Try snapping to the nearest colliding neighbor's edges.
  const candidates: number[] = []
  for (const o of siblings) {
    candidates.push(o.end) // after the neighbor
    if (o.start - duration >= 0) candidates.push(o.start - duration) // before it
  }
  const valid = candidates.filter((s) => !hits(s)).sort((a, b) => Math.abs(a - d) - Math.abs(b - d))
  return valid.length ? valid[0] : null
}

// Snap a time to nearby targets (playhead, clip edges) within tolerance seconds.
export function snapTime(t: number, targets: number[], tolerance: number): number {
  let best = t
  let bestDist = tolerance
  for (const target of targets) {
    const dist = Math.abs(target - t)
    if (dist < bestDist) {
      best = target
      bestDist = dist
    }
  }
  return best
}

export function formatTimecode(t: number, fps: number): string {
  const totalFrames = Math.round(Math.max(0, t) * fps)
  const f = totalFrames % fps
  const totalSecs = Math.floor(totalFrames / fps)
  const s = totalSecs % 60
  const m = Math.floor(totalSecs / 60) % 60
  const h = Math.floor(totalSecs / 3600)
  const pad = (n: number) => String(n).padStart(2, '0')
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}:${pad(f)}` : `${pad(m)}:${pad(s)}:${pad(f)}`
}
