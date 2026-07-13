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
  if (prop.startsWith('grade.')) {
    const g = clip.grade as Record<string, number> | undefined
    return g?.[prop.slice('grade.'.length)] ?? 0
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
  return left.v + (right.v - left.v) * applyEase(left.ease, p)
}

export function keyframesFor(clip: Clip, prop: string): Keyframe[] {
  return clip.keyframes.filter((k) => k.prop === prop).sort((a, b) => a.t - b.t)
}
