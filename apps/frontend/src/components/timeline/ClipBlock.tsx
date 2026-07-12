import { useEffect, useRef } from 'react'
import type { Clip } from '../../types/project'
import { useStore } from '../../state/store'
import { clipDuration, clipEnd, snapTime } from '../../engine/time'
import { getWaveform } from '../../engine/waveform'
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
      ctx.fillStyle = 'rgba(255,255,255,0.55)'
      for (let x = 0; x < w; x++) {
        const src = clip.in + (x / pxPerSec) * clip.speed
        const peak = wf.peaks[Math.floor(src * wf.pps)] ?? 0
        const bh = Math.max(1, peak * (h - 2))
        ctx.fillRect(x, (h - bh) / 2, 1, bh)
      }
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
    const mode: 'move' | 'trim-in' | 'trim-out' =
      localX < EDGE_PX && dur * pxPerSec > EDGE_PX * 3
        ? 'trim-in'
        : localX > rect.width - EDGE_PX && dur * pxPerSec > EDGE_PX * 3
          ? 'trim-out'
          : 'move'

    const grabOffset = xToTime(e.clientX) - clip.start
    let started = false
    let lanes: LaneRect[] = []
    let snapTargets: number[] = []
    // Multi-select drag: all selected clips move together, offsets preserved.
    let group: { id: string; start: number }[] | null = null
    const startX = e.clientX

    const begin = () => {
      started = true
      store.beginGesture()
      lanes = captureLanes()
      const p = useStore.getState().project
      const sel = useStore.getState().selection
      if (mode === 'move' && sel.length > 1 && sel.includes(clip.id)) {
        group = p.tracks
          .flatMap((t) => t.clips)
          .filter((c) => sel.includes(c.id))
          .map((c) => ({ id: c.id, start: c.start }))
      }
      const moving = new Set(group ? group.map((g) => g.id) : [clip.id])
      snapTargets = [0, useStore.getState().playhead]
      for (const tr of p.tracks)
        for (const c of tr.clips) if (!moving.has(c.id)) snapTargets.push(c.start, clipEnd(c))
    }

    const onMove = (ev: PointerEvent) => {
      if (!started && Math.abs(ev.clientX - startX) < DRAG_THRESHOLD_PX) return
      if (!started) begin()
      const s = useStore.getState()
      const snapEnabled = s.snap && !ev.altKey
      const tol = SNAP_PX / pxPerSec
      const pointerTime = xToTime(ev.clientX)

      if (mode === 'move') {
        let desired = pointerTime - grabOffset
        if (snapEnabled) {
          const snappedStart = snapTime(desired, snapTargets, tol)
          const snappedEnd = snapTime(desired + dur, snapTargets, tol)
          if (snappedStart !== desired) desired = snappedStart
          else if (snappedEnd !== desired + dur) desired = snappedEnd - dur
        }
        if (group) {
          // ponytail: group drag is horizontal-only; cross-track group moves
          // when a real need shows up.
          const anchor = group.find((g) => g.id === clip.id)!
          const delta = Math.max(
            desired - anchor.start,
            -Math.min(...group.map((g) => g.start)),
          )
          s.moveClipsTo(
            group.map((g) => ({ id: g.id, start: g.start + delta })),
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

  const missing = !!asset?.missing
  // Reference-style "fx" badge: any non-default visual treatment.
  const c = clip.transform.crop
  const hasFx =
    clip.keyframes.length > 0 ||
    clip.transform.shadow != null ||
    c.l + c.t + c.r + c.b > 0 ||
    clip.grade != null
  const name =
    clip.kind === 'text'
      ? (clip.text?.content ?? 'Text')
      : `${asset?.name ?? clip.kind}${missing ? ' (offline)' : ''}`

  return (
    <div
      className={`clip clip--${clip.kind}${selected ? ' clip--selected' : ''}${missing ? ' clip--missing' : ''}`}
      style={{ left: clip.start * pxPerSec, width: widthPx }}
      data-clip-id={clip.id}
      data-track-id={trackId}
      onPointerDown={onPointerDown}
      onContextMenu={(e) => {
        e.preventDefault()
        e.stopPropagation()
        const store = useStore.getState()
        if (!store.selection.includes(clip.id)) store.select([clip.id])
        openClipMenu(e, clip.id)
      }}
    >
      {clip.kind === 'audio' && <canvas ref={waveRef} className="clip__wave" />}
      <span className="clip__label">{name}</span>
      {hasFx && (
        <span className="clip__fxbadge" title="Has effects (keyframes, crop, shadow, or grade)">
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
    </div>
  )
}

function laneKind(clip: Clip): 'video' | 'audio' {
  return clip.kind === 'audio' ? 'audio' : 'video'
}

export default ClipBlock
