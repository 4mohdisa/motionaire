import type { Clip, Effect, EffectType } from '../types/project'
import { uid } from '../types/project'

// Effect stack (pro-editor session, Phase 2 — ARCHITECTURAL).
// Effects were fixed clip properties (grade/key/mask/blur/vignette slots);
// professional editors treat them as an ordered, mutable stack: reorder,
// toggle, duplicate, same type twice. A clip's `effects` array is now that
// stack; keyframes address instances as `fx.<effectId>.<param>`.
//
// Blend mode deliberately stays a CLIP property: it's how the finished layer
// composites against what's below, not a step inside the layer's chain.

export type { Effect, EffectType } from '../types/project'

const IDENTITY_POINTS: [number, number][] = [
  [0, 0],
  [1, 1],
]

export const EFFECT_DEFAULTS: Record<EffectType, Record<string, import('../types/project').EffectParam>> = {
  chromaKey: { color: '#00ff00', tolerance: 0.3, softness: 0.1, spill: 0.5 },
  grade: { exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0 },
  blur: { amount: 0 },
  mask: { kind: 'rect', x: 0, y: 0, w: 400, h: 300, feather: 20, invert: false },
  vignette: { amount: 0.3 },
  wheels: {
    liftR: 0, liftG: 0, liftB: 0,
    gammaR: 0, gammaG: 0, gammaB: 0,
    gainR: 0, gainG: 0, gainB: 0,
  },
  curves: {
    pointsR: IDENTITY_POINTS,
    pointsG: IDENTITY_POINTS,
    pointsB: IDENTITY_POINTS,
    pointsM: IDENTITY_POINTS,
  },
  lut: { path: '' },
}

export const EFFECT_LABELS: Record<EffectType, string> = {
  chromaKey: 'Chroma key',
  grade: 'Color grade',
  blur: 'Blur / sharpen',
  mask: 'Mask',
  vignette: 'Vignette',
  wheels: 'Color wheels',
  curves: 'RGB curves',
  lut: '3D LUT (.cube)',
}

// Scalar params that can carry keyframes (strings/bools/arrays cannot).
export const EFFECT_SCALAR_PARAMS: Record<EffectType, string[]> = {
  chromaKey: ['tolerance', 'softness', 'spill'],
  grade: ['exposure', 'contrast', 'saturation', 'temperature', 'tint'],
  blur: ['amount'],
  mask: ['x', 'y', 'w', 'h', 'feather'],
  vignette: ['amount'],
  wheels: ['liftR', 'liftG', 'liftB', 'gammaR', 'gammaG', 'gammaB', 'gainR', 'gainG', 'gainB'],
  curves: [],
  lut: [],
}

export function mkEffect(type: EffectType): Effect {
  return { id: uid('fx'), type, enabled: true, params: structuredClone(EFFECT_DEFAULTS[type]) }
}

export function effectsOf(clip: Clip): Effect[] {
  return (clip.effects ?? []) as Effect[]
}

// ---- Migration from the fixed-property model (pre-stack projects) ----
//
// CANONICAL LEGACY ORDER = the exact order the old single-pass shader
// applied: chromaKey (per sample) → blur → grade → mask → vignette.
// Migrating in this order is what makes migration OUTPUT-PRESERVING.
// Keyframe props are rewritten onto the new instances:
//   key.tolerance → fx.<id>.tolerance, grade.exposure → fx.<id>.exposure,
//   blur → fx.<id>.amount, mask.x → fx.<id>.x, vignette → fx.<id>.amount.
export function migrateClipEffects(clip: Clip): boolean {
  const legacy = clip as Clip & {
    grade?: Record<string, number>
    key?: { color: string; tolerance: number; softness: number; spill: number }
    mask?: {
      kind: string
      x: number
      y: number
      w: number
      h: number
      feather: number
      invert: boolean
    }
    blur?: number
    vignette?: number
  }
  const hasLegacy =
    legacy.key !== undefined ||
    legacy.grade !== undefined ||
    legacy.mask !== undefined ||
    (legacy.blur !== undefined && legacy.blur !== 0) ||
    (legacy.vignette !== undefined && legacy.vignette !== 0)
  if (!hasLegacy) return false
  const stack = effectsOf(clip)
  const rewrites: [string, string][] = [] // old kf prop prefix → effect id

  if (legacy.key) {
    const fx = mkEffect('chromaKey')
    fx.params = { ...legacy.key }
    stack.push(fx)
    rewrites.push(['key.', `fx.${fx.id}.`])
  }
  if (legacy.blur !== undefined && legacy.blur !== 0) {
    const fx = mkEffect('blur')
    fx.params = { amount: legacy.blur }
    stack.push(fx)
    rewrites.push(['blur', `fx.${fx.id}.amount`])
  }
  if (legacy.grade) {
    const fx = mkEffect('grade')
    fx.params = { ...legacy.grade }
    stack.push(fx)
    rewrites.push(['grade.', `fx.${fx.id}.`])
  }
  if (legacy.mask) {
    const fx = mkEffect('mask')
    fx.params = { ...legacy.mask }
    stack.push(fx)
    rewrites.push(['mask.', `fx.${fx.id}.`])
  }
  if (legacy.vignette !== undefined && legacy.vignette !== 0) {
    const fx = mkEffect('vignette')
    fx.params = { amount: legacy.vignette }
    stack.push(fx)
    rewrites.push(['vignette', `fx.${fx.id}.amount`])
  }

  clip.effects = stack
  clip.keyframes = clip.keyframes.map((k) => {
    for (const [from, to] of rewrites) {
      if (from.endsWith('.') ? k.prop.startsWith(from) : k.prop === from) {
        return { ...k, prop: from.endsWith('.') ? to + k.prop.slice(from.length) : to }
      }
    }
    return k
  })
  // The stack is now the single source of truth — adjustment layers
  // included: the compositor folds an adjust layer's stack GRADES onto
  // lower layers.
  delete legacy.key
  delete legacy.grade
  delete legacy.mask
  delete legacy.blur
  delete legacy.vignette
  return true
}

// Whole-project migration; returns how many clips converted.
export function migrateProjectEffects(p: { tracks: { clips: Clip[] }[] }): number {
  let n = 0
  for (const t of p.tracks) for (const c of t.clips) if (migrateClipEffects(c)) n++
  return n
}
