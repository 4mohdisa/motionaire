import { invoke } from '@tauri-apps/api/core'
import type { Project, TextStyle } from '../types/project'

// Text into the compositor (session 9, Phase 4 — the export blocker).
// Each text clip is rasterized at 2x canvas pixels whenever its content or
// style changes (NEVER per frame); Rust composites the bitmap as an ordinary
// texture layer, so transform/keyframes/opacity/z apply unchanged. Pixel
// parity with the DOM overlay is free: the same WebKit shaper renders both.

const SS = 2 // supersample factor; Rust draws at fit=1/SS

let sent = new Map<string, string>() // clipId → hash last shipped

function hash(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0
  return (h >>> 0).toString(36)
}

// Mirror of the DOM overlay's layout (Preview.tsx TextOverlay + .preview__text
// CSS): line-height 1.4, shrink-to-fit block ≤ maxWidth, padding/background,
// -webkit-text-stroke ≈ stroke under fill at 2x lineWidth.
export function rasterizeText(st: TextStyle): { b64: string; w: number; h: number } | null {
  const canvas = document.createElement('canvas')
  const ctx = canvas.getContext('2d')
  if (!ctx) return null
  const font = `${st.weight} ${st.size * SS}px ${st.font}, system-ui, sans-serif`
  ctx.font = font
  const maxW = Math.max(8, st.maxWidth * SS)
  const lines: string[] = []
  for (const para of st.content.split('\n')) {
    let cur = ''
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const test = cur ? `${cur} ${word}` : word
      if (ctx.measureText(test).width > maxW && cur) {
        lines.push(cur)
        cur = word
      } else {
        cur = test
      }
    }
    lines.push(cur) // empty paragraphs keep their blank line
  }
  if (!lines.some((l) => l.length)) return null

  const pad = (st.background?.padding ?? 0) * SS
  const lineH = st.size * 1.4 * SS
  const strokePad = (st.stroke?.width ?? 0) * SS
  const textW = Math.min(Math.max(...lines.map((l) => ctx.measureText(l).width)), maxW)
  const w = Math.ceil(textW + pad * 2 + strokePad * 2)
  const h = Math.ceil(lines.length * lineH + pad * 2 + strokePad * 2)
  canvas.width = w
  canvas.height = h
  ctx.font = font // canvas resize resets state
  ctx.textBaseline = 'middle'

  if (st.background) {
    ctx.fillStyle = st.background.color
    ctx.beginPath()
    ctx.roundRect(0, 0, w, h, st.background.radius * SS)
    ctx.fill()
  }
  lines.forEach((line, i) => {
    if (!line) return
    const lw = ctx.measureText(line).width
    const x =
      st.align === 'left'
        ? pad + strokePad
        : st.align === 'right'
          ? w - pad - strokePad - lw
          : (w - lw) / 2
    const y = pad + strokePad + (i + 0.5) * lineH
    if (st.stroke && st.stroke.width > 0) {
      ctx.strokeStyle = st.stroke.color
      ctx.lineWidth = st.stroke.width * 2 * SS
      ctx.lineJoin = 'round'
      ctx.strokeText(line, x, y)
    }
    ctx.fillStyle = st.color
    ctx.fillText(line, x, y)
  })
  const b64 = canvas.toDataURL('image/png').split(',')[1]
  return b64 ? { b64, w, h } : null
}

export async function syncTextRasters(project: Project): Promise<void> {
  const live: string[] = []
  const rasters: {
    clipId: string
    hash: string
    width: number
    height: number
    pngBase64: string
  }[] = []
  for (const track of project.tracks) {
    if (track.kind !== 'video' || track.hidden) continue
    for (const clip of track.clips) {
      if (clip.kind !== 'text' || !clip.text) continue
      live.push(clip.id)
      const rev = hash(JSON.stringify(clip.text))
      if (sent.get(clip.id) === rev) continue
      const r = rasterizeText(clip.text)
      if (!r) continue
      rasters.push({ clipId: clip.id, hash: rev, width: r.w, height: r.h, pngBase64: r.b64 })
      sent.set(clip.id, rev)
    }
  }
  const liveSet = new Set(live)
  let pruned = false
  for (const id of [...sent.keys()])
    if (!liveSet.has(id)) {
      sent.delete(id)
      pruned = true
    }
  if (rasters.length || pruned) {
    await invoke('set_text_rasters', { rasters, live }).catch((e) => {
      console.error('set_text_rasters failed:', e)
      // Retry next sync: forget what we thought we sent.
      for (const r of rasters) sent.delete(r.clipId)
    })
  }
}

export function resetTextRasterCache() {
  sent = new Map()
}
