import { useEffect, useRef } from 'react'
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
      const step = TICK_STEPS.find((s) => s * pxPerSec >= 70) ?? 600
      const sub = step / 5
      const t0 = scroll.scrollLeft / pxPerSec
      const t1 = (scroll.scrollLeft + w) / pxPerSec
      ctx.fillStyle = '#8b8b93'
      ctx.font = '10px system-ui, sans-serif'
      ctx.textBaseline = 'top'
      for (let t = Math.floor(t0 / sub) * sub; t <= t1; t += sub) {
        const x = t * pxPerSec - scroll.scrollLeft
        const major = Math.abs(t / step - Math.round(t / step)) < 1e-6
        ctx.fillStyle = major ? '#5a5a63' : '#3a3a41'
        ctx.fillRect(x, major ? 10 : 17, 1, major ? 14 : 7)
        if (major) {
          ctx.fillStyle = '#8b8b93'
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

  return (
    <div
      className="tl__ruler"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId)
        scrub(e)
      }}
      onPointerMove={(e) => {
        if (e.buttons & 1) scrub(e)
      }}
    >
      <canvas ref={canvasRef} className="tl__ruler-canvas" />
    </div>
  )
}

export default Ruler
