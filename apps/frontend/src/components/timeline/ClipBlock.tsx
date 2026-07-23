import { useEffect, useRef, useState } from 'react'
import type { Clip } from '../../types/project'
import { useStore } from '../../state/store'
import { clipDuration, clipEnd, snapTime } from '../../engine/time'
import { columnReduce, getWaveform } from '../../engine/waveform'
import { getFilmstrip, type Strip } from '../../engine/filmstrip'
import { useTimeline, type LaneRect } from './timelineContext'

const EDGE_PX = 8
const DRAG_THRESHOLD_PX = 4
const SNAP_PX = 8

interface Props {
  clip: Clip
  trackId: string
}

function ClipBlock({ clip, trackId }: Props) {
  const { pxPerSec, xToTime, captureLanes, openClipMenu } = useTimeline()
  const selected = useStore((s) => s.selection.includes(clip.id))
  const asset = useStore((s) => s.project.media.find((m) => m.id === clip.mediaId))
  const dur = clipDuration(clip)
  const widthPx = Math.max(2, dur * pxPerSec)

  // Waveform for audio clips (real decoded peaks, cached per media).
  const waveRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    if (clip.kind !== 'audio' || !asset) return
    let cancelled = false
    void getWaveform(asset).then((wf) => {
      const canvas = waveRef.current
      if (!wf || !canvas || cancelled) return
      const dpr = window.devicePixelRatio || 1
      const w = Math.ceil(widthPx)
      const h = canvas.clientHeight || 28
      canvas.width = w * dpr
      canvas.height = h * dpr
      const ctx = canvas.getContext('2d')!
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, w, h)
      // Filled symmetric envelope (peak, translucent) over an RMS body
      // (solid) — per-column MAX over the covered source range, so peaks
      // survive any zoom level (pro-editor session, Phase 1).
      const { peak, rms } = columnReduce(wf, clip.in, clip.speed / pxPerSec, w)
      const mid = h / 2
      const color = getComputedStyle(document.documentElement).getPropertyValue('--text-primary')
      const drawEnvelope = (vals: Float32Array, alpha: number) => {
        ctx.globalAlpha = alpha
        ctx.fillStyle = color
        ctx.beginPath()
        ctx.moveTo(0, mid)
        for (let x = 0; x < w; x++) ctx.lineTo(x, mid - Math.max(0.5, vals[x] * (mid - 1)))
        for (let x = w - 1; x >= 0; x--) ctx.lineTo(x, mid + Math.max(0.5, vals[x] * (mid - 1)))
        ctx.closePath()
        ctx.fill()
      }
      drawEnvelope(peak, 0.35)
      drawEnvelope(rms, 0.75)
    })
    return () => {
      cancelled = true
    }
  }, [clip.kind, clip.in, clip.out, clip.speed, asset, widthPx, pxPerSec])

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const store = useStore.getState()

    if (e.shiftKey || e.metaKey) {
      store.select([clip.id], 'toggle')
      return
    }
    if (!store.selection.includes(clip.id)) store.select([clip.id])

    const target = e.currentTarget as HTMLElement
    const rect = target.getBoundingClientRect()
    const localX = e.clientX - rect.left
    const tool = store.tool
    const onEdgeIn = localX < EDGE_PX && dur * pxPerSec > EDGE_PX * 3
    const onEdgeOut = localX > rect.width - EDGE_PX && dur * pxPerSec > EDGE_PX * 3
    const mode: 'move' | 'trim-in' | 'trim-out' = onEdgeIn
      ? 'trim-in'
      : onEdgeOut
        ? 'trim-out'
        : 'move'

    const grabOffset = xToTime(e.clientX) - clip.start
    let started = false
    let lanes: LaneRect[] = []
    let snapTargets: number[] = []
    // Multi-select drag: all selected clips move together, offsets preserved.
    // Since the foundation session the drag is 2D: vertical movement shifts
    // every member by the same DISPLAY-lane delta (all-or-nothing).
    let group: { id: string; start: number; trackId: string; laneIdx: number }[] | null = null
    let anchorLaneIdx = -1
    const startX = e.clientX

    const begin = () => {
      started = true
      store.beginGesture()
      lanes = captureLanes()
      const p = useStore.getState().project
      const sel = useStore.getState().selection
      if (mode === 'move' && sel.length > 1 && sel.includes(clip.id)) {
        const laneIdxByTrack = new Map(lanes.map((l, i) => [l.trackId, i]))
        group = []
        for (const t of p.tracks)
          for (const c of t.clips)
            if (sel.includes(c.id))
              group.push({
                id: c.id,
                start: c.start,
                trackId: t.id,
                laneIdx: laneIdxByTrack.get(t.id) ?? -1,
              })
        anchorLaneIdx = laneIdxByTrack.get(trackId) ?? -1
      }
      const moving = new Set(group ? group.map((g) => g.id) : [clip.id])
      snapTargets = [0, useStore.getState().playhead]
      for (const tr of p.tracks)
        for (const c of tr.clips) if (!moving.has(c.id)) snapTargets.push(c.start, clipEnd(c))
    }

    // Trim tools (Phase 4): the active tool decides what a drag means.
    const slipSlideStart = { in: clip.in, start: clip.start }
    const onMove = (ev: PointerEvent) => {
      if (!started && Math.abs(ev.clientX - startX) < DRAG_THRESHOLD_PX) return
      if (!started) begin()
      const s = useStore.getState()
      const snapEnabled = s.snap && !ev.altKey
      const tol = SNAP_PX / pxPerSec
      const pointerTime = xToTime(ev.clientX)
      const dxTime = (ev.clientX - startX) / pxPerSec

      if (tool === 'slip') {
        // Dragging right shows EARLIER source (window slides back) —
        // standard slip feel. Increment against current state so internal
        // clamps hold across the gesture.
        const cur = useStore.getState()
        const me = cur.project.tracks.flatMap((t) => t.clips).find((c) => c.id === clip.id)!
        const desiredIn = slipSlideStart.in - dxTime * clip.speed
        s.slipClip(clip.id, desiredIn - me.in, true)
        return
      }
      if (tool === 'slide') {
        const cur = useStore.getState()
        const me = cur.project.tracks.flatMap((t) => t.clips).find((c) => c.id === clip.id)!
        const desiredStart = slipSlideStart.start + dxTime
        s.slideClip(clip.id, desiredStart - me.start, true)
        return
      }
      if (tool === 'ripple' && mode !== 'move') {
        const t = snapEnabled ? snapTime(pointerTime, snapTargets, tol) : pointerTime
        s.rippleTrim(clip.id, mode === 'trim-in' ? 'in' : 'out', t, true)
        return
      }
      if (tool === 'roll' && mode !== 'move') {
        // Roll the boundary this edge belongs to: out-edge → me|next,
        // in-edge → previous|me.
        const t = snapEnabled ? snapTime(pointerTime, snapTargets, tol) : pointerTime
        if (mode === 'trim-out') {
          s.rollEdit(clip.id, t, true)
        } else {
          const cur = useStore.getState()
          const track = cur.project.tracks.find((tr) => tr.clips.some((c) => c.id === clip.id))!
          const prev = track.clips.find(
            (c) =>
              c.id !== clip.id &&
              Math.abs(clipEnd(c) - clip.start) < 1 / cur.project.canvas.fps / 2,
          )
          if (prev) s.rollEdit(prev.id, t, true)
        }
        return
      }

      if (mode === 'move') {
        let desired = pointerTime - grabOffset
        if (snapEnabled) {
          const snappedStart = snapTime(desired, snapTargets, tol)
          const snappedEnd = snapTime(desired + dur, snapTargets, tol)
          if (snappedStart !== desired) desired = snappedStart
          else if (snappedEnd !== desired + dur) desired = snappedEnd - dur
        }
        if (group) {
          const anchor = group.find((g) => g.id === clip.id)!
          const delta = Math.max(desired - anchor.start, -Math.min(...group.map((g) => g.start)))
          // Vertical: shift all members by the pointer's display-lane delta;
          // any invalid target (edge, kind mismatch via lane kind) keeps the
          // whole move horizontal for this frame (store re-validates anyway).
          const pointerLane = lanes.findIndex((l) => ev.clientY >= l.top && ev.clientY <= l.bottom)
          let laneDelta = pointerLane >= 0 && anchorLaneIdx >= 0 ? pointerLane - anchorLaneIdx : 0
          if (laneDelta !== 0) {
            for (const g of group) {
              const target = lanes[g.laneIdx + laneDelta]
              const own = lanes[g.laneIdx]
              if (g.laneIdx < 0 || !target || !own || target.kind !== own.kind) {
                laneDelta = 0
                break
              }
            }
          }
          s.moveClipsTo(
            group.map((g) => ({
              id: g.id,
              start: g.start + delta,
              trackId: laneDelta !== 0 ? lanes[g.laneIdx + laneDelta].trackId : g.trackId,
            })),
            true,
          )
        } else {
          const lane = lanes.find(
            (l) => ev.clientY >= l.top && ev.clientY <= l.bottom && l.kind === laneKind(clip),
          )
          s.moveClip(clip.id, Math.max(0, desired), lane?.trackId, true)
        }
      } else {
        const t = snapEnabled ? snapTime(pointerTime, snapTargets, tol) : pointerTime
        s.trimClip(clip.id, mode === 'trim-in' ? 'in' : 'out', t, true)
      }
    }

    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // Persistent filmstrip (Run 1, Phase 1c): the hover-scrub sprite cache,
  // rendered inline at all times. Same source mapping as the hover thumb.
  const stripRef = useRef<HTMLCanvasElement>(null)
  const canStripInline = clip.kind === 'video' && !clip.adjust && !!asset && !asset.missing
  useEffect(() => {
    if (!canStripInline) return
    let cancelled = false
    void getFilmstrip(asset!).then((s) => {
      const canvas = stripRef.current
      if (!s || !canvas || cancelled) return
      const img = new Image()
      img.onload = () => {
        if (cancelled || !stripRef.current) return
        const dpr = window.devicePixelRatio || 1
        const w = Math.ceil(widthPx)
        const h = canvas.clientHeight || 34
        canvas.width = w * dpr
        canvas.height = h * dpr
        const ctx = canvas.getContext('2d')!
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        // Tile frames left→right; each column shows the frame nearest its
        // own source time, so trims and speed changes stay honest.
        const tileW = Math.max(24, Math.round((s.frameW / s.h) * h))
        for (let x = 0; x < w; x += tileW) {
          const srcT = clip.in + ((x + tileW / 2) / pxPerSec) * clip.speed
          const idx = Math.min(
            s.frames - 1,
            Math.max(0, Math.floor((srcT / s.duration) * s.frames)),
          )
          ctx.drawImage(img, idx * s.frameW, 0, s.frameW, s.h, x, 0, tileW, h)
        }
      }
      img.src = s.url
    })
    return () => {
      cancelled = true
    }
  }, [canStripInline, asset, clip.in, clip.out, clip.speed, widthPx, pxPerSec])

  // Hover-scrub: pre-sampled filmstrip frame nearest the pointer's source
  // time, floated above the clip (position: fixed escapes scroll clipping).
  const [hover, setHover] = useState<{ cx: number; top: number; idx: number } | null>(null)
  const [strip, setStrip] = useState<Strip | null>(null)
  const canScrub = clip.kind === 'video' && !clip.adjust && !!asset && !asset.missing

  const onHoverMove = (e: React.PointerEvent) => {
    if (!canScrub || e.buttons !== 0) {
      if (hover) setHover(null)
      return
    }
    if (!strip) {
      // getFilmstrip caches the promise per asset — repeat calls are free.
      void getFilmstrip(asset!).then((s) => s && setStrip(s))
      return
    }
    const s = strip
    const rect = e.currentTarget.getBoundingClientRect()
    const srcT = clip.in + ((e.clientX - rect.left) / pxPerSec) * clip.speed
    const idx = Math.min(s.frames - 1, Math.max(0, Math.floor((srcT / s.duration) * s.frames)))
    setHover({ cx: e.clientX, top: rect.top - s.h - 8, idx })
  }

  const missing = !!asset?.missing
  // Reference-style "fx" badge: any non-default visual treatment.
  const c = clip.transform.crop
  const hasFx =
    clip.keyframes.length > 0 ||
    clip.transform.shadow != null ||
    c.l + c.t + c.r + c.b > 0 ||
    clip.effects.length > 0
  const compound = useStore((s) =>
    clip.compoundId ? s.project.compounds?.[clip.compoundId] : undefined,
  )
  const name = clip.compoundId
    ? (compound?.name ?? 'Compound')
    : clip.adjust
      ? 'Adjustment'
      : clip.shape
        ? clip.shape.kind.charAt(0).toUpperCase() + clip.shape.kind.slice(1)
        : clip.kind === 'text'
          ? (clip.text?.content ?? 'Text')
          : `${asset?.name ?? clip.kind}${missing ? ' (offline)' : ''}`

  return (
    <div
      className={`clip clip--${clip.kind}${clip.adjust ? ' clip--adjust' : ''}${clip.shape ? ' clip--shape' : ''}${asset && /\.(png|jpe?g)$/i.test(asset.path) ? ' clip--image' : ''}${selected ? ' clip--selected' : ''}${missing ? ' clip--missing' : ''}${clip.disabled ? ' clip--disabled' : ''}`}
      style={{
        left: clip.start * pxPerSec,
        width: widthPx,
        // Label colors (Phase 8): tint rides above the kind styling.
        ...(clip.label ? { boxShadow: `inset 0 2px 0 var(--label-${clip.label})` } : {}),
      }}
      data-clip-id={clip.id}
      data-track-id={trackId}
      onPointerDown={onPointerDown}
      onPointerMove={onHoverMove}
      onPointerLeave={() => setHover(null)}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        const store = useStore.getState()
        if (!store.selection.includes(clip.id)) store.select([clip.id])
        openClipMenu(e, clip.id)
      }}
    >
      <div className="clip__head">
        <span className="clip__headname">{name}</span>
        <span className="clip__headdur">{dur.toFixed(1)}s</span>
      </div>
      {canStripInline && <canvas ref={stripRef} className="clip__film" />}
      {clip.kind === 'audio' && <canvas ref={waveRef} className="clip__wave" />}
      {hasFx && (
        <span className="clip__fxbadge" title="Has effects (keyframes, crop, shadow, or stack)">
          fx
        </span>
      )}
      {[...new Set(clip.keyframes.map((k) => k.t))].map((t) => (
        <div
          key={t}
          className="clip__kf"
          style={{ left: t * pxPerSec }}
          title="Keyframe — click to seek"
          onPointerDown={(e) => {
            e.stopPropagation()
            useStore.getState().setPlayhead(clip.start + t)
          }}
        />
      ))}
      {clip.transitions.in && (
        <div
          className="clip__transition clip__transition--in"
          style={{ width: Math.min(clip.transitions.in.duration * pxPerSec, widthPx / 2) }}
          title={`${clip.transitions.in.type} ${clip.transitions.in.duration}s`}
        />
      )}
      {clip.transitions.out && (
        <div
          className="clip__transition clip__transition--out"
          style={{ width: Math.min(clip.transitions.out.duration * pxPerSec, widthPx / 2) }}
          title={`${clip.transitions.out.type} ${clip.transitions.out.duration}s`}
        />
      )}
      <div className="clip__edge clip__edge--l" />
      <div className="clip__edge clip__edge--r" />
      {hover && strip && (
        <div
          className="clip__thumb"
          style={{
            left: hover.cx,
            top: hover.top,
            width: strip.frameW,
            height: strip.h,
            backgroundImage: `url(${strip.url})`,
            backgroundPositionX: -hover.idx * strip.frameW,
          }}
        />
      )}
    </div>
  )
}

function laneKind(clip: Clip): 'video' | 'audio' {
  return clip.kind === 'audio' ? 'audio' : 'video'
}

export default ClipBlock
