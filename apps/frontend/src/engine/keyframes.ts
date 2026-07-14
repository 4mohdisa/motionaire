import type { Clip, Ease, Keyframe } from '../types/project'

// ============================================================================
// DISPLAY-ONLY MIRROR (foundation session, Phase 1).
// Rust (compositor/keyframes.rs + types.rs source_time) is the single source
// of truth for anything that RENDERS or EXPORTS. This TypeScript copy exists
// only for DOM-side consumers that cannot reach Rust per tick: properties-
// panel readouts, audio-element gain, element pre-seeking, and the browser-
// mode fallback overlay. It must stay formula-identical; the f1-parity
// self-test (dev:f1_parity_test) compares both against a torture fixture and
// fails loudly on drift. Change the formulas in BOTH places or not at all.
// ============================================================================

// Numeric properties that can carry keyframes. CONTEXT.md §1.2.
export const KEYFRAMEABLE_PROPS = [
  'transform.x',
  'transform.y',
  'transform.scale',
  'transform.rotation',
  'transform.opacity',
  'transform.cornerRadius',
  'volume',
] as const

export type KeyframeableProp = (typeof KEYFRAMEABLE_PROPS)[number]

const easings: Record<Ease, (t: number) => number> = {
  linear: (t) => t,
  easeIn: (t) => t * t * t,
  easeOut: (t) => 1 - Math.pow(1 - t, 3),
  easeInOut: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  // ponytail: damped-cosine spring approximation; real spring solver if it ever matters
  spring: (t) => 1 - Math.exp(-6 * t) * Math.cos(12 * t),
}

export function applyEase(ease: Ease, t: number): number {
  return easings[ease](Math.min(1, Math.max(0, t)))
}

// Static (non-keyframed) value of a property on a clip.
export function staticValue(clip: Clip, prop: string): number {
  if (prop === 'volume') return clip.volume
  if (prop === 'speed') return clip.speed
  if (prop.startsWith('transform.')) {
    const key = prop.slice('transform.'.length) as keyof typeof clip.transform
    const v = clip.transform[key]
    return typeof v === 'number' ? v : 0
  }
  // Effect-stack params (Phase 2): fx.<effectId>.<param>.
  if (prop.startsWith('fx.')) {
    const [, id, param] = prop.split('.')
    const fx = clip.effects.find((e) => e.id === id)
    const v = fx?.params[param]
    return typeof v === 'number' ? v : 0
  }
  return 0
}

// Resolve a property at clip-relative time tRel.
// CONTEXT.md §1.2: bracketing keyframes, interpolate with the easing of the LEFT keyframe.
// No keyframes → static value.
export function resolveProp(clip: Clip, prop: string, tRel: number): number {
  const kfs = clip.keyframes.filter((k) => k.prop === prop).sort((a, b) => a.t - b.t)
  if (kfs.length === 0) return staticValue(clip, prop)
  if (tRel <= kfs[0].t) return kfs[0].v
  const last = kfs[kfs.length - 1]
  if (tRel >= last.t) return last.v
  let left: Keyframe = kfs[0]
  let right: Keyframe = last
  for (let i = 0; i < kfs.length - 1; i++) {
    if (kfs[i].t <= tRel && tRel <= kfs[i + 1].t) {
      left = kfs[i]
      right = kfs[i + 1]
      break
    }
  }
  const span = right.t - left.t
  const p = span <= 0 ? 1 : (tRel - left.t) / span
  if (left.ease === 'bezier') return bezierValue(left, right, tRel)
  return left.v + (right.v - left.v) * applyEase(left.ease, p)
}

// ---- Bezier segments (pro-editor session, Phase 3) ----
// Cubic in (t, v) space: P0=(k1.t,k1.v), P1=P0+k1.ho, P2=P3+k2.hi,
// P3=(k2.t,k2.v). Handle dt is clamped inside the segment so x(u) stays
// monotonic; missing handles default to thirds (= exact linear).
// MIRROR CONTRACT: keep formula-identical with compositor/keyframes.rs.
export function bezierValue(
  k1: Pick<Keyframe, 't' | 'v' | 'ho'>,
  k2: Pick<Keyframe, 't' | 'v' | 'hi'>,
  tAbs: number,
): number {
  const span = k2.t - k1.t
  if (span <= 0) return k2.v
  const ho = k1.ho ?? [span / 3, 0]
  const hi = k2.hi ?? [-span / 3, 0]
  const x0 = k1.t
  const x1 = k1.t + Math.min(Math.max(ho[0], 0), span)
  const x2 = k2.t + Math.max(Math.min(hi[0], 0), -span)
  const x3 = k2.t
  const y0 = k1.v
  const y1 = k1.v + ho[1]
  const y2 = k2.v + hi[1]
  const y3 = k2.v
  // Solve x(u) = tAbs by bisection (x monotone under the clamps above).
  let lo = 0
  let hiU = 1
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hiU) / 2
    const m = 1 - mid
    const x = m * m * m * x0 + 3 * m * m * mid * x1 + 3 * m * mid * mid * x2 + mid * mid * mid * x3
    if (x < tAbs) lo = mid
    else hiU = mid
  }
  const u = (lo + hiU) / 2
  const m = 1 - u
  return m * m * m * y0 + 3 * m * m * u * y1 + 3 * m * u * u * y2 + u * u * u * y3
}

// Convert a preset ease on the segment [k1, k2] into equivalent bezier
// handles. linear/easeIn/easeOut are EXACT (thirds x-spacing makes x(u)=u,
// and cubic y control points reproduce t³ / 1-(1-t)³); easeInOut is the
// standard approximation; spring is not expressible — callers keep it.
export function presetHandles(
  ease: Ease,
  k1: Pick<Keyframe, 't' | 'v'>,
  k2: Pick<Keyframe, 't' | 'v'>,
): { ho: [number, number]; hi: [number, number] } | null {
  const dt = k2.t - k1.t
  const dv = k2.v - k1.v
  switch (ease) {
    case 'linear':
      return { ho: [dt / 3, dv / 3], hi: [-dt / 3, -dv / 3] }
    case 'easeIn': // y = u³ → y1 = y0, y2 = y0 (then scaled by dv)
      return { ho: [dt / 3, 0], hi: [-dt / 3, -dv] }
    case 'easeOut': // y = 1-(1-u)³ → y1 = y3, y2 = y3
      return { ho: [dt / 3, dv], hi: [-dt / 3, 0] }
    case 'easeInOut': // css-ish (0.65,0)(0.35,1) approximation
      return { ho: [dt * 0.65, 0], hi: [-dt * 0.65, 0] }
    default:
      return null // spring: damped oscillation, not a single cubic
  }
}

export function keyframesFor(clip: Clip, prop: string): Keyframe[] {
  return clip.keyframes.filter((k) => k.prop === prop).sort((a, b) => a.t - b.t)
}
