import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { getLastFrame } from '../compositor/client'

// Video scopes (pro-editor session, Phase 5): waveform (luma), RGB parade,
// vectorscope, histogram — fed from the compositor's REAL output frames
// (client.ts getLastFrame), not a DOM re-render. 10Hz refresh, every-4th
// pixel sampling: honest signal, negligible cost.

type Mode = 'waveform' | 'parade' | 'vectorscope' | 'histogram'
const W = 340
const H = 190

export default function Scopes() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [mode, setMode] = useState<Mode>('waveform')
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx) return
    const timer = window.setInterval(() => {
      const frame = getLastFrame()
      ctx.fillStyle = '#0c0c0e'
      ctx.fillRect(0, 0, W, H)
      if (!frame) return
      draw(ctx, frame, mode)
    }, 100)
    return () => clearInterval(timer)
  }, [mode])

  const onDragStart = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button,select')) return
    const rect = panelRef.current!.getBoundingClientRect()
    const dx = e.clientX - rect.left
    const dy = e.clientY - rect.top
    const onMove = (ev: PointerEvent) =>
      setPos({
        x: Math.min(window.innerWidth - rect.width, Math.max(0, ev.clientX - dx)),
        y: Math.min(window.innerHeight - 40, Math.max(0, ev.clientY - dy)),
      })
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  return (
    <div
      ref={panelRef}
      className="scopes"
      style={pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : undefined}
    >
      <div className="scopes__head" onPointerDown={onDragStart} style={{ cursor: 'grab' }}>
        <select
          className="scopes__mode"
          value={mode}
          onChange={(e) => setMode(e.target.value as Mode)}
        >
          <option value="waveform">Waveform (luma)</option>
          <option value="parade">RGB parade</option>
          <option value="vectorscope">Vectorscope</option>
          <option value="histogram">Histogram</option>
        </select>
        <button
          className="scopes__close"
          onClick={() => useStore.getState().setScopesOpen(false)}
          title="Close scopes"
        >
          ×
        </button>
      </div>
      <canvas ref={canvasRef} width={W} height={H} className="scopes__canvas" />
    </div>
  )
}

function draw(ctx: CanvasRenderingContext2D, frame: ImageData, mode: Mode) {
  const { data, width, height } = frame
  const img = ctx.createImageData(W, H)
  const buf = img.data
  const put = (x: number, y: number, r: number, g: number, b: number, add = 40) => {
    if (x < 0 || x >= W || y < 0 || y >= H) return
    const i = (y * W + x) * 4
    buf[i] = Math.min(255, buf[i] + r)
    buf[i + 1] = Math.min(255, buf[i + 1] + g)
    buf[i + 2] = Math.min(255, buf[i + 2] + b)
    buf[i + 3] = Math.min(255, buf[i + 3] + add + 140)
  }

  if (mode === 'waveform' || mode === 'parade') {
    for (let y = 0; y < height; y += 4) {
      for (let x = 0; x < width; x += 4) {
        const i = (y * width + x) * 4
        const r = data[i]
        const g = data[i + 1]
        const b = data[i + 2]
        if (mode === 'waveform') {
          const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
          const sx = Math.floor((x / width) * W)
          const sy = Math.floor((1 - luma / 255) * (H - 1))
          put(sx, sy, 90, 220, 90)
        } else {
          const third = W / 3
          const sxr = Math.floor((x / width) * (third - 2))
          const yr = (v: number) => Math.floor((1 - v / 255) * (H - 1))
          put(sxr, yr(r), 230, 60, 60)
          put(Math.floor(third) + sxr, yr(g), 60, 230, 60)
          put(Math.floor(third * 2) + sxr, yr(b), 80, 80, 240)
        }
      }
    }
  } else if (mode === 'vectorscope') {
    const cx = W / 2
    const cy = H / 2
    const scale = (Math.min(W, H) / 2 - 6) / 128
    for (let y = 0; y < height; y += 4) {
      for (let x = 0; x < width; x += 4) {
        const i = (y * width + x) * 4
        const r = data[i]
        const g = data[i + 1]
        const b = data[i + 2]
        const cb = -0.168736 * r - 0.331264 * g + 0.5 * b
        const cr = 0.5 * r - 0.418688 * g - 0.081312 * b
        put(Math.round(cx + cb * scale), Math.round(cy - cr * scale), 120, 220, 160)
      }
    }
  } else {
    const bins = [new Array(256).fill(0), new Array(256).fill(0), new Array(256).fill(0)]
    for (let i = 0; i < data.length; i += 16) {
      bins[0][data[i]]++
      bins[1][data[i + 1]]++
      bins[2][data[i + 2]]++
    }
    const peak = Math.max(1, ...bins.flat())
    for (let v = 0; v < 256; v++) {
      const x = Math.floor((v / 256) * W)
      const colors = [
        [230, 60, 60],
        [60, 230, 60],
        [80, 80, 240],
      ]
      bins.forEach((bin, c) => {
        const h = Math.floor((bin[v] / peak) * (H - 4))
        for (let y = H - 1; y >= H - 1 - h; y--)
          put(x, y, colors[c][0] / 3, colors[c][1] / 3, colors[c][2] / 3, 90)
      })
    }
  }

  ctx.putImageData(img, 0, 0)
  // Graticule on top.
  ctx.strokeStyle = 'rgba(255,255,255,0.13)'
  ctx.beginPath()
  if (mode === 'vectorscope') {
    ctx.arc(W / 2, H / 2, Math.min(W, H) / 2 - 6, 0, Math.PI * 2)
    ctx.moveTo(W / 2 - 6, H / 2)
    ctx.lineTo(W / 2 + 6, H / 2)
    ctx.moveTo(W / 2, H / 2 - 6)
    ctx.lineTo(W / 2, H / 2 + 6)
  } else {
    for (const f of [0.25, 0.5, 0.75]) {
      ctx.moveTo(0, H * f)
      ctx.lineTo(W, H * f)
    }
    if (mode === 'parade') {
      ctx.moveTo(W / 3, 0)
      ctx.lineTo(W / 3, H)
      ctx.moveTo((2 * W) / 3, 0)
      ctx.lineTo((2 * W) / 3, H)
    }
  }
  ctx.stroke()
}
