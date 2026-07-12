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

// Color grade (session 8, Phase 3): keyframeable via "grade.*" props.
// undefined = untouched (no grade pass in the shader).
export interface Grade {
  exposure: number // stops, -2..2
  contrast: number // -1..1, 0 neutral
  saturation: number // -1..1, 0 neutral (-1 = grayscale)
  temperature: number // -1..1, warm/cool
  tint: number // -1..1, magenta/green
}

export function defaultGrade(): Grade {
  return { exposure: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0 }
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
  grade?: Grade // color grade; undefined = no grade pass
  adjust?: boolean // adjustment layer: no source; grade applies to all lower z
}

export interface MediaAsset {
  id: string
  path: string // absolute file path (compositor-visible) or object URL (browser import)
  playbackUrl?: string // webview-playable URL for file-backed assets (asset protocol); transient
  missing?: boolean // source file gone at load time; transient, never persisted
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
  // Session 9, Phase 3 — standard NLE track controls. All optional so old
  // project.json files load unchanged.
  muted?: boolean // audio tracks
  solo?: boolean // audio tracks
  locked?: boolean // blocks all edits to the track's clips
  hidden?: boolean // video tracks: excluded from compositing (audio keeps playing, Premiere semantics)
}

export interface CanvasSettings {
  width: number
  height: number
  fps: number
  background: string
}

// Timeline marker / chapter point (session 8, Phase 5).
export interface Marker {
  id: string
  t: number // timeline seconds
  label: string
}

export interface ProjectFont {
  id: string
  family: string
  fileName: string // bytes live in the bundle's fonts/ dir
}

export interface Project {
  version: 1
  canvas: CanvasSettings
  duration: number
  media: MediaAsset[]
  tracks: Track[]
  transcript: { words: unknown[] }
  fonts?: ProjectFont[]
  markers?: Marker[]
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
