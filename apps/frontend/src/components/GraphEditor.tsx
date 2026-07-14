import { useMemo, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { clipDuration, findClip, snapToFrame } from '../engine/time'
import { keyframesFor, resolveProp } from '../engine/keyframes'
import type { Keyframe } from '../types/project'

// Keyframe graph editor (pro-editor session, Phase 3): value-over-time
// curves for every keyframed property of the selected clip — draggable
// keyframes, draggable bezier in/out tangents, box select, multi-move,
// per-property visibility. Rust stays the resolution authority: this view
// EDITS data through the store; curves are drawn with the TS display mirror
// (the f1 parity suite keeps the two identical). Speed-ramp curves ride the
// same path — 'speed' is just another keyframed property here.

const H = 220
const PAD_L = 44
const PAD_R = 12
const PAD_T = 14
const PAD_B = 20
const PALETTE = ['#4da3ff', '#ffb340', '#3ad17c', '#ff6b81', '#c792ea', '#7fdbca', '#f7dc6f']

type KfRef = { prop: string; t: number }

export default function GraphEditor() {
  const selection = useStore((s) => s.selection)
  const project = useStore((s) => s.project)
  const playhead = useStore((s) => s.playhead)
  const st = useStore.getState
  const clip = selection.length ? findClip(project, selection[0])?.clip : undefined
  const [hidden, setHidden] = useState<Set<string>>(new Set())
  const [sel, setSel] = useState<KfRef[]>([])
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(
    null,
  )
  const svgRef = useRef<SVGSVGElement>(null)
  const [width, setWidth] = useState(900)

  const props = useMemo(() => {
    if (!clip) return []
    return [...new Set(clip.keyframes.map((k) => k.prop))].sort()
  }, [clip])

  // Per-prop vertical scale: min/max over keyframes AND handle extents.
  const scales = useMemo(() => {
    const m = new Map<string, { lo: number; hi: number }>()
    if (!clip) return m
    for (const p of props) {
      let lo = Infinity
      let hi = -Infinity
      for (const k of keyframesFor(clip, p)) {
        lo = Math.min(lo, k.v, k.v + (k.ho?.[1] ?? 0), k.v + (k.hi?.[1] ?? 0))
        hi = Math.max(hi, k.v, k.v + (k.ho?.[1] ?? 0), k.v + (k.hi?.[1] ?? 0))
      }
      if (!Number.isFinite(lo)) continue
      if (hi - lo < 1e-6) {
        lo -= 1
        hi += 1
      }
      const pad = (hi - lo) * 0.12
      m.set(p, { lo: lo - pad, hi: hi + pad })
    }
    return m
  }, [clip, props])

  if (!clip)
    return (
      <div className="graph graph--empty">
        Select a clip to edit its animation curves
        <button className="graph__close" onClick={() => st().setGraphOpen(false)}>
          ×
        </button>
      </div>
    )

  const dur = clipDuration(clip)
  const X = (t: number) => PAD_L + (t / Math.max(dur, 1e-6)) * (width - PAD_L - PAD_R)
  const T = (x: number) => ((x - PAD_L) / (width - PAD_L - PAD_R)) * dur
  const Y = (prop: string, v: number) => {
    const s = scales.get(prop)!
    return PAD_T + (1 - (v - s.lo) / (s.hi - s.lo)) * (H - PAD_T - PAD_B)
  }
  const V = (prop: string, y: number) => {
    const s = scales.get(prop)!
    return s.lo + (1 - (y - PAD_T) / (H - PAD_T - PAD_B)) * (s.hi - s.lo)
  }
  const colorOf = (prop: string) => PALETTE[props.indexOf(prop) % PALETTE.length]
  const isSel = (p: string, t: number) => sel.some((r) => r.prop === p && Math.abs(r.t - t) < 1e-6)

  const localPoint = (e: { clientX: number; clientY: number }) => {
    const r = svgRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left, y: e.clientY - r.top }
  }

  // --- keyframe drag (single or whole selection) ---
  const startKfDrag = (e: React.PointerEvent, prop: string, kf: Keyframe) => {
    e.stopPropagation()
    const already = isSel(prop, kf.t)
    const group: KfRef[] = already ? sel : [{ prop, t: kf.t }]
    if (!already) setSel(group)
    const p0 = localPoint(e)
    const c = clip
    const starts = group.map((g) => {
      const k = keyframesFor(c, g.prop).find((k2) => Math.abs(k2.t - g.t) < 1e-6)!
      return { ...g, v: k.v }
    })
    st().beginGesture()
    let lastRefs = group
    const onMove = (ev: PointerEvent) => {
      const p1 = localPoint(ev)
      const dt = T(p1.x) - T(p0.x)
      // fromT tracks each keyframe's CURRENT position (index-aligned with
      // starts) so successive transient moves keep finding their target.
      const moves = starts.map((s0, i) => ({
        prop: s0.prop,
        fromT: lastRefs[i].t,
        toT: s0.t + dt,
        toV: V(s0.prop, Y(s0.prop, s0.v) + (p1.y - p0.y)),
      }))
      st().moveKeyframes(clip.id, moves, true)
      const fps = st().project.canvas.fps
      lastRefs = moves.map((m) => ({
        prop: m.prop,
        t: snapToFrame(Math.min(Math.max(0, m.toT), dur), fps),
      }))
      setSel(lastRefs)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // --- bezier handle drag ---
  const startHandleDrag = (
    e: React.PointerEvent,
    prop: string,
    kf: Keyframe,
    which: 'ho' | 'hi',
  ) => {
    e.stopPropagation()
    st().beginGesture()
    const onMove = (ev: PointerEvent) => {
      const p1 = localPoint(ev)
      const dt = T(p1.x) - kf.t
      const dv = V(prop, p1.y) - kf.v
      st().setKeyframeHandle(clip.id, prop, kf.t, which, [dt, dv], true)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // --- box select ---
  const startMarquee = (e: React.PointerEvent) => {
    const p0 = localPoint(e)
    setMarquee({ x0: p0.x, y0: p0.y, x1: p0.x, y1: p0.y })
    const onMove = (ev: PointerEvent) => {
      const p1 = localPoint(ev)
      setMarquee({ x0: p0.x, y0: p0.y, x1: p1.x, y1: p1.y })
    }
    const onUp = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      const p1 = localPoint(ev)
      const [xa, xb] = [Math.min(p0.x, p1.x), Math.max(p0.x, p1.x)]
      const [ya, yb] = [Math.min(p0.y, p1.y), Math.max(p0.y, p1.y)]
      const hits: KfRef[] = []
      for (const p of props) {
        if (hidden.has(p)) continue
        for (const k of keyframesFor(clip, p)) {
          const kx = X(k.t)
          const ky = Y(p, k.v)
          if (kx >= xa && kx <= xb && ky >= ya && ky <= yb) hits.push({ prop: p, t: k.t })
        }
      }
      setSel(hits)
      setMarquee(null)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const visible = props.filter((p) => !hidden.has(p))

  return (
    <div
      className="graph"
      ref={(el) => {
        if (el) setWidth(el.clientWidth)
      }}
    >
      <div className="graph__bar">
        {props.map((p) => (
          <button
            key={p}
            className={`graph__chip${hidden.has(p) ? ' graph__chip--off' : ''}`}
            style={{ borderColor: colorOf(p) }}
            onClick={() =>
              setHidden((h) => {
                const n = new Set(h)
                if (n.has(p)) n.delete(p)
                else n.add(p)
                return n
              })
            }
          >
            <span className="graph__dot" style={{ background: colorOf(p) }} />
            {p.replace('transform.', '')}
          </button>
        ))}
        <span className="graph__spacer" />
        <button
          className="topbar__btn"
          disabled={!sel.length}
          title="Convert the outgoing segment of each selected keyframe to editable bezier"
          onClick={() => sel.forEach((r) => st().convertToBezier(clip.id, r.prop, r.t))}
        >
          → Bezier
        </button>
        <button
          className="topbar__btn"
          disabled={!sel.length}
          onClick={() => {
            st().deleteKeyframes(clip.id, sel)
            setSel([])
          }}
        >
          Delete
        </button>
        <button className="graph__close" onClick={() => st().setGraphOpen(false)}>
          ×
        </button>
      </div>
      <svg ref={svgRef} className="graph__svg" height={H} onPointerDown={startMarquee}>
        {/* grid + time axis */}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => (
          <g key={f}>
            <line
              x1={X(f * dur)}
              x2={X(f * dur)}
              y1={PAD_T}
              y2={H - PAD_B}
              className="graph__grid"
            />
            <text x={X(f * dur)} y={H - 6} className="graph__tick">
              {(f * dur).toFixed(1)}s
            </text>
          </g>
        ))}
        {/* playhead */}
        {playhead >= clip.start && playhead <= clip.start + dur && (
          <line
            x1={X(playhead - clip.start)}
            x2={X(playhead - clip.start)}
            y1={PAD_T}
            y2={H - PAD_B}
            className="graph__playhead"
          />
        )}
        {/* curves via the display mirror */}
        {visible.map((p) => {
          const pts: string[] = []
          const kfs = keyframesFor(clip, p)
          if (!kfs.length) return null
          for (let i = 0; i <= 160; i++) {
            const t = (i / 160) * dur
            pts.push(`${X(t).toFixed(1)},${Y(p, resolveProp(clip, p, t)).toFixed(1)}`)
          }
          return (
            <g key={p}>
              <polyline className="graph__curve" points={pts.join(' ')} stroke={colorOf(p)} />
              {kfs.map((k, i) => {
                const selected = isSel(p, k.t)
                const next = kfs[i + 1]
                const prev = kfs[i - 1]
                return (
                  <g key={`${k.t}-${i}`}>
                    {/* out handle: mine when my segment is bezier */}
                    {selected && k.ease === 'bezier' && next && (
                      <HandleGlyph
                        x0={X(k.t)}
                        y0={Y(p, k.v)}
                        x1={X(k.t + (k.ho?.[0] ?? (next.t - k.t) / 3))}
                        y1={Y(p, k.v + (k.ho?.[1] ?? 0))}
                        color={colorOf(p)}
                        onDrag={(e) => startHandleDrag(e, p, k, 'ho')}
                      />
                    )}
                    {/* in handle: previous segment must be bezier */}
                    {selected && prev?.ease === 'bezier' && (
                      <HandleGlyph
                        x0={X(k.t)}
                        y0={Y(p, k.v)}
                        x1={X(k.t + (k.hi?.[0] ?? -(k.t - prev.t) / 3))}
                        y1={Y(p, k.v + (k.hi?.[1] ?? 0))}
                        color={colorOf(p)}
                        onDrag={(e) => startHandleDrag(e, p, k, 'hi')}
                      />
                    )}
                    <circle
                      className={`graph__kf${selected ? ' graph__kf--sel' : ''}`}
                      cx={X(k.t)}
                      cy={Y(p, k.v)}
                      r={selected ? 5 : 3.5}
                      fill={colorOf(p)}
                      onPointerDown={(e) => startKfDrag(e, p, k)}
                    />
                  </g>
                )
              })}
            </g>
          )
        })}
        {marquee && (
          <rect
            className="graph__marquee"
            x={Math.min(marquee.x0, marquee.x1)}
            y={Math.min(marquee.y0, marquee.y1)}
            width={Math.abs(marquee.x1 - marquee.x0)}
            height={Math.abs(marquee.y1 - marquee.y0)}
          />
        )}
      </svg>
    </div>
  )
}

function HandleGlyph({
  x0,
  y0,
  x1,
  y1,
  color,
  onDrag,
}: {
  x0: number
  y0: number
  x1: number
  y1: number
  color: string
  onDrag: (e: React.PointerEvent) => void
}) {
  return (
    <g>
      <line x1={x0} y1={y0} x2={x1} y2={y1} stroke={color} strokeDasharray="2 2" opacity={0.7} />
      <rect
        x={x1 - 3.5}
        y={y1 - 3.5}
        width={7}
        height={7}
        fill="var(--bg-panel)"
        stroke={color}
        strokeWidth={1.5}
        style={{ cursor: 'move' }}
        onPointerDown={onDrag}
      />
    </g>
  )
}
