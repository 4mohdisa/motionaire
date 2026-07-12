import type { Clip, Keyframe, TextAnimationPreset } from '../types/project'
import { clipDuration } from './time'

// CONTEXT.md §1.3: `animation` is sugar that expands into keyframes.
// Expansion writes plain keyframes so the whole animation system stays single-path.

// Props each preset touches; rest values come from the clip's transform.
const PRESET_PROPS: Record<TextAnimationPreset, string[]> = {
  none: [],
  fade: ['transform.opacity'],
  fadeUp: ['transform.opacity', 'transform.y'],
  popIn: ['transform.opacity', 'transform.scale'],
  slideLeft: ['transform.opacity', 'transform.x'],
}

function presetKeyframes(
  preset: TextAnimationPreset,
  edge: 'in' | 'out',
  clip: Clip,
  t0: number,
  t1: number,
): Keyframe[] {
  const { opacity, x, y, scale } = clip.transform
  const from = edge === 'in'
  const kf = (prop: string, t: number, v: number): Keyframe => ({
    prop,
    t,
    v,
    ease: preset === 'popIn' ? 'spring' : 'easeInOut',
  })
  const pairs: Record<Exclude<TextAnimationPreset, 'none'>, [string, number, number][]> = {
    fade: [['transform.opacity', 0, opacity]],
    fadeUp: [
      ['transform.opacity', 0, opacity],
      ['transform.y', y + 40, y],
    ],
    popIn: [
      ['transform.opacity', 0, opacity],
      ['transform.scale', scale * 0.5, scale],
    ],
    slideLeft: [
      ['transform.opacity', 0, opacity],
      ['transform.x', x + 80, x],
    ],
  }
  if (preset === 'none') return []
  return pairs[preset].flatMap(([prop, hidden, rest]) => [
    kf(prop, t0, from ? hidden : rest),
    kf(prop, t1, from ? rest : hidden),
  ])
}

// Re-derive all animation keyframes on a text clip from its `animation` field.
// Clobbers keyframes on the preset-controlled props inside the edge windows.
export function expandTextAnimation(clip: Clip): void {
  if (clip.kind !== 'text' || !clip.animation) return
  const D = clipDuration(clip)
  const d = Math.min(clip.animation.duration, D / 2)
  const inProps = PRESET_PROPS[clip.animation.in]
  const outProps = PRESET_PROPS[clip.animation.out]
  clip.keyframes = clip.keyframes.filter((k) => {
    const inWindow = k.t <= d + 1e-6 && inProps.includes(k.prop)
    const outWindow = k.t >= D - d - 1e-6 && outProps.includes(k.prop)
    return !inWindow && !outWindow
  })
  clip.keyframes.push(
    ...presetKeyframes(clip.animation.in, 'in', clip, 0, d),
    ...presetKeyframes(clip.animation.out, 'out', clip, D - d, D),
  )
}
