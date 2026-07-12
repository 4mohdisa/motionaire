import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import type { MediaAsset } from '../types/project'
import { isTauri } from '../compositor/bridge'

// Pre-sampled hover-scrub strips (session 8, Phase 5). One strip PNG per
// media asset, extracted once by Rust; hovering only moves a background
// offset — never a live decode.

export interface Strip {
  url: string
  frames: number
  frameW: number
  h: number
  duration: number
}

const cache = new Map<string, Promise<Strip | null>>()

export function getFilmstrip(asset: MediaAsset): Promise<Strip | null> {
  // Real file-backed video only; stills have nothing to scrub (Rust also
  // rejects zero-duration sources as the backstop).
  if (
    !isTauri ||
    asset.kind !== 'video' ||
    !asset.path.startsWith('/') ||
    /\.(png|jpe?g)$/i.test(asset.path)
  )
    return Promise.resolve(null)
  let p = cache.get(asset.id)
  if (!p) {
    p = invoke<{ path: string; width: number; height: number; frames: number; duration: number }>(
      'extract_filmstrip',
      { path: asset.path },
    )
      .then((r) => ({
        url: convertFileSrc(r.path),
        frames: r.frames,
        frameW: r.width / r.frames,
        h: r.height,
        duration: r.duration,
      }))
      .catch(() => null)
    cache.set(asset.id, p)
  }
  return p
}
