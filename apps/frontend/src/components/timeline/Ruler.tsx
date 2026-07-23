import { useEffect, useRef, useState } from 'react'
import { useStore } from '../../state/store'
import { useTimeline } from './timelineContext'

const TICK_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]

function label(t: number): string {
  const m = Math.floor(t / 60)
  const s = t - m * 60
  const sStr = Number.isInteger(s) ? String(s).padStart(2, '0') : s.toFixed(1).padStart(4, '0')
  return `${m}:${sStr}`
}

function Ruler() {
  const { pxPerSec, xToTime, scrollEl } = useTimeline()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const markers = useStore((s) => s.project.markers)
  const [editing, setEditing] = useState<string | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    const scroll = scrollEl()
    if (!canvas || !scroll) return

    const draw = () => {
      const dpr = window.devicePixelRatio || 1
      const w = scroll.clientWidth
      const h = 24
      if (canvas.width !== w * dpr) {
        canvas.width = w * dpr
        canvas.height = h * dpr
        canvas.style.width = `${w}px`
        canvas.style.height = `${h}px`
      }
      const ctx = canvas.getContext('2d')!
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      // Canvas can't resolve CSS vars — read the tokens once per draw.
      const tok = getComputedStyle(document.documentElement)
      const textColor = tok.getPropertyValue('--text-secondary')
      const majorColor = tok.getPropertyValue('--text-disabled')
      const minorColor = tok.getPropertyValue('--border-default')
      const step = TICK_STEPS.find((s) => s * pxPerSec >= 70) ?? 600
      const sub = step / 5
      const t0 = scroll.scrollLeft / pxPerSec
      const t1 = (scroll.scrollLeft + w) / pxPerSec
      ctx.font = '10px system-ui, sans-serif'
      ctx.textBaseline = 'top'
      for (let t = Math.floor(t0 / sub) * sub; t <= t1; t += sub) {
        const x = t * pxPerSec - scroll.scrollLeft
        const major = Math.abs(t / step - Math.round(t / step)) < 1e-6
        ctx.fillStyle = major ? majorColor : minorColor
        ctx.fillRect(x, major ? 10 : 17, 1, major ? 14 : 7)
        if (major) {
          ctx.fillStyle = textColor
          ctx.fillText(label(Math.round(t / sub) * sub), x + 4, 3)
        }
      }
    }

    draw()
    const ro = new ResizeObserver(draw)
    ro.observe(scroll)
    scroll.addEventListener('scroll', draw)
    return () => {
      ro.disconnect()
      scroll.removeEventListener('scroll', draw)
    }
  }, [pxPerSec, scrollEl])

  const scrub = (e: React.PointerEvent) => useStore.getState().setPlayhead(xToTime(e.clientX))
  const markIn = useStore((s) => s.markIn)
  const markOut = useStore((s) => s.markOut)

  return (
    <div
      className="tl__ruler"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        useStore.getState().setScrubbing(true) // audio scrub (foundation, Phase 2)
        scrub(e)
      }}
      onPointerMove={(e) => {
        if (e.buttons & 1) scrub(e)
      }}
      onPointerUp={() => useStore.getState().setScrubbing(false)}
      onLostPointerCapture={() => useStore.getState().setScrubbing(false)}
    >
      {markIn !== null && markOut !== null && (
        <div
          className="tl__range"
          style={{ left: markIn * pxPerSec, width: (markOut - markIn) * pxPerSec }}
        />
      )}
      {markIn !== null && (
        <div className="tl__mark tl__mark--in" style={{ left: markIn * pxPerSec }} />
      )}
      {markOut !== null && (
        <div className="tl__mark tl__mark--out" style={{ left: markOut * pxPerSec }} />
      )}
      <canvas ref={canvasRef} className="tl__ruler-canvas" />
      {(markers ?? []).map((m) => {
        const s = useStore.getState()
        return (
          <div
            key={m.id}
            className="tl__marker"
            style={{ left: m.t * pxPerSec }}
            title={`${m.label} — double-click to rename, right-click to delete`}
            onPointerDown={(e) => {
              e.stopPropagation()
              s.setPlayhead(m.t)
            }}
            onDoubleClick={(e) => {
              e.stopPropagation()
              setEditing(m.id)
            }}
            onContextMenu={(e) => {
              e.preventDefault()
              e.stopPropagation()
              s.deleteMarker(m.id)
            }}
          >
            <span className="tl__marker-flag" />
            {editing === m.id ? (
              <input
                className="tl__marker-input selectable"
                autoFocus
                defaultValue={m.label}
                onPointerDown={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur()
                }}
                onBlur={(e) => {
                  const v = e.target.value.trim()
                  if (v && v !== m.label) s.renameMarker(m.id, v)
                  setEditing(null)
                }}
              />
            ) : (
              <span className="tl__marker-label">{m.label}</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

export default Ruler
