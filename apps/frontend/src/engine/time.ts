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
// Speed ramps (session 9, Phase 7): "speed" keyframes remap time WITHIN the
// clip's fixed timeline window — piecewise-linear rate, integrated, clamped
// to the source range. No keyframes → plain linear mapping.
export function sourceTime(c: Clip, t: number): number {
  const rel = t - c.start
  const kfs = c.keyframes
    .filter((k) => k.prop === 'speed')
    .sort((a, b) => a.t - b.t)
  if (!kfs.length) return c.in + rel * c.speed
  const src = c.in + integrateRate(kfs, rel)
  return Math.min(Math.max(src, Math.min(c.in, c.out)), Math.max(c.in, c.out))
}

// ∫₀^rel rate(u) du where rate is held before the first / after the last
// keyframe and linear between (easing approximated linearly — logged).
export function integrateRate(kfs: { t: number; v: number }[], rel: number): number {
  let acc = 0
  let u = 0
  if (rel <= 0) return 0
  // segment before first keyframe: constant first value
  const first = kfs[0]
  if (u < first.t) {
    const span = Math.min(rel, first.t) - u
    acc += span * first.v
    u += span
    if (u >= rel) return acc
  }
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]
    const b = kfs[i + 1]
    if (u >= rel) return acc
    if (rel <= a.t || b.t <= a.t) continue
    const from = Math.max(u, a.t)
    const to = Math.min(rel, b.t)
    if (to <= from) continue
    // linear rate between keyframes → trapezoid area
    const rateAt = (x: number) => a.v + ((b.v - a.v) * (x - a.t)) / (b.t - a.t)
    acc += ((rateAt(from) + rateAt(to)) / 2) * (to - from)
    u = to
  }
  if (u < rel) acc += (rel - u) * kfs[kfs.length - 1].v // hold last value
  return acc
}

export function hasSpeedRamp(c: Clip): boolean {
  return c.keyframes.some((k) => k.prop === 'speed')
}

export function computeDuration(p: Project): number {
  let max = 0
  for (const tr of p.tracks) for (const c of tr.clips) max = Math.max(max, clipEnd(c))
  return max
}

export function findClip(
  p: Project,
  clipId: string,
): { track: Track; clip: Clip; index: number } | null {
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
    for (const c of tr.clips)
      if (c.kind === 'video' && !c.disabled && isActiveAt(c, t)) out.push({ clip: c, z: tr.z })
  }
  return out.sort((a, b) => b.z - a.z)
}

export function activeAudioClips(p: Project, t: number): Clip[] {
  const out: Clip[] = []
  for (const tr of p.tracks) {
    if (tr.kind !== 'audio') continue
    for (const c of tr.clips) if (c.kind === 'audio' && !c.disabled && isActiveAt(c, t)) out.push(c)
  }
  return out
}

export function activeTextClips(p: Project, t: number): { clip: Clip; z: number }[] {
  const out: { clip: Clip; z: number }[] = []
  for (const tr of p.tracks) {
    if (tr.kind !== 'video') continue
    for (const c of tr.clips)
      if (c.kind === 'text' && !c.disabled && isActiveAt(c, t)) out.push({ clip: c, z: tr.z })
  }
  return out.sort((a, b) => a.z - b.z) // render order: lowest first, highest on top
}

// Cross transitions (dissolve/slide/wipe) need the outgoing clip's element to
// keep running past its end into the incoming clip's opening window.
export function transitionTail(p: Project, clip: Clip): number {
  const found = findClip(p, clip.id)
  if (!found) return 0
  const end = clipEnd(clip)
  const next = found.track.clips.find(
    (c) => c.id !== clip.id && Math.abs(c.start - end) < 1 / p.canvas.fps / 2,
  )
  const tr = next?.transitions.in
  return tr && tr.type !== 'fade' ? tr.duration : 0
}

// The clip pair for a cross transition at the playhead: incoming B (topmost,
// just started, has an in-transition) and outgoing A (same track, ends at B.start).
export function crossTransitionAt(
  p: Project,
  t: number,
): { a: Clip | null; b: Clip; progress: number; type: string } | null {
  const b = activeVideoClips(p, t)[0]?.clip
  const tr = b?.transitions.in
  if (!b || !tr) return null
  const d = tr.duration
  if (t < b.start || t >= b.start + d) return null
  const found = findClip(p, b.id)
  const a =
    found?.track.clips.find(
      (c) => c.id !== b.id && Math.abs(clipEnd(c) - b.start) < 1 / p.canvas.fps / 2,
    ) ?? null
  return { a, b, progress: (t - b.start) / d, type: tr.type }
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
