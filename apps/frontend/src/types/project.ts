// Project document model — CONTEXT.md §1 is the source of truth for this shape.
// One deviation, logged in DECISIONS.md: text clips use in/out like media clips
// (in=0, out=duration) instead of a separate `duration` field, so every clip
// shares one time system.

export type Ease = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'spring'

export interface Crop {
  l: number
  t: number
  r: number
  b: number
}

export interface Shadow {
  blur: number
  spread: number
  color: string
  x: number
  y: number
}

export interface Transform {
  x: number // offset from canvas center, px
  y: number
  scale: number
  rotation: number // degrees
  opacity: number // 0..1
  cornerRadius: number // px
  crop: Crop
  shadow: Shadow | null
}

export interface Keyframe {
  prop: string // e.g. "transform.scale" — clip-relative time in storage
  t: number
  v: number
  ease: Ease
}

export type TransitionType = 'cut' | 'dissolve' | 'fade' | 'slide' | 'wipe'

export interface Transition {
  type: TransitionType
  duration: number
}

export interface TextStyle {
  content: string
  font: string
  size: number
  weight: number
  color: string
  align: 'left' | 'center' | 'right'
  stroke: { color: string; width: number } | null
  background: { color: string; padding: number; radius: number } | null
  maxWidth: number
}

export type TextAnimationPreset = 'fade' | 'fadeUp' | 'popIn' | 'slideLeft' | 'none'

export interface TextAnimation {
  in: TextAnimationPreset
  out: TextAnimationPreset
  duration: number
}

export type ClipKind = 'video' | 'audio' | 'text'

export interface Clip {
  id: string
  kind: ClipKind
  mediaId?: string
  start: number // position on timeline (s)
  in: number // source in-point (s); 0 for text
  out: number // source out-point (s); for text, out - in = duration
  speed: number
  volume: number
  transform: Transform
  keyframes: Keyframe[]
  transitions: { in: Transition | null; out: Transition | null }
  effects: unknown[]
  linkId?: string // shared between clips produced by detach-audio
  text?: TextStyle
  animation?: TextAnimation
}

export interface MediaAsset {
  id: string
  path: string // object URL this session; absolute file path once native import lands
  name: string
  kind: 'video' | 'audio'
  duration: number
  width?: number
  height?: number
  fps?: number
  hasAudio: boolean
  proxyPath?: string
}

export interface Track {
  id: string
  kind: 'video' | 'audio'
  z: number // compositing order, higher = on top
  name: string
  clips: Clip[]
}

export interface CanvasSettings {
  width: number
  height: number
  fps: number
  background: string
}

export interface Project {
  version: 1
  canvas: CanvasSettings
  duration: number
  media: MediaAsset[]
  tracks: Track[]
  transcript: { words: unknown[] }
}

let uidCounter = 0
export function uid(prefix: string): string {
  return `${prefix}_${(++uidCounter).toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

export function defaultTransform(): Transform {
  return {
    x: 0,
    y: 0,
    scale: 1,
    rotation: 0,
    opacity: 1,
    cornerRadius: 0,
    crop: { l: 0, t: 0, r: 0, b: 0 },
    shadow: null,
  }
}

export function createProject(): Project {
  return {
    version: 1,
    canvas: { width: 1920, height: 1080, fps: 30, background: '#000000' },
    duration: 0,
    media: [],
    tracks: [
      { id: uid('t'), kind: 'video', z: 1, name: 'V2', clips: [] },
      { id: uid('t'), kind: 'video', z: 0, name: 'V1', clips: [] },
      { id: uid('t'), kind: 'audio', z: 0, name: 'A1', clips: [] },
    ],
    transcript: { words: [] },
  }
}
