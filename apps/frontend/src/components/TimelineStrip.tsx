import { useRef } from 'react'
import { useStore } from '../state/store'

// Phase A stopgap: a bare scrub surface. Replaced by the real timeline in Phase B.
function TimelineStrip() {
  const duration = useStore((s) => s.project.duration)
  const playhead = useStore((s) => s.playhead)
  const ref = useRef<HTMLDivElement>(null)
  const span = Math.max(duration, 1)

  const scrub = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    const t = ((e.clientX - r.left) / r.width) * span
    useStore.getState().setPlayhead(t)
  }

  return (
    <footer className="timeline">
      <span className="timeline__label">Timeline</span>
      <div
        ref={ref}
        className="timeline__tracks"
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId)
          scrub(e)
        }}
        onPointerMove={(e) => {
          if (e.buttons & 1) scrub(e)
        }}
      >
        <div className="timeline__playhead" style={{ left: `${(playhead / span) * 100}%` }} />
      </div>
    </footer>
  )
}

export default TimelineStrip
