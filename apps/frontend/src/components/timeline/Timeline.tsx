import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeftToLine,
  AudioLines,
  Magnet,
  Maximize,
  Scissors,
  Trash2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { useStore } from '../../state/store'
import { findClip } from '../../engine/time'
import { TimelineContext, type LaneRect, type TimelineCtx } from './timelineContext'
import Ruler from './Ruler'
import ClipBlock from './ClipBlock'
import ContextMenu, { type MenuItem } from '../ContextMenu'
import IconBtn from '../IconBtn'

const LANE_HEIGHT: Record<'video' | 'audio', number> = { video: 56, audio: 44 }

function Timeline() {
  const project = useStore((s) => s.project)
  const pxPerSec = useStore((s) => s.pxPerSec)
  const snap = useStore((s) => s.snap)
  const selection = useStore((s) => s.selection)
  const scrollRef = useRef<HTMLDivElement>(null)
  const headersRef = useRef<HTMLDivElement>(null)

  // Display order: video tracks top (highest z first), audio tracks below.
  const ordered = useMemo(() => {
    const video = project.tracks.filter((t) => t.kind === 'video').sort((a, b) => b.z - a.z)
    const audio = project.tracks.filter((t) => t.kind === 'audio').sort((a, b) => a.z - b.z)
    return [...video, ...audio]
  }, [project.tracks])

  const contentWidth = Math.max((project.duration + 30) * pxPerSec, 600)

  const xToTime = useCallback(
    (clientX: number) => {
      const scroll = scrollRef.current
      if (!scroll) return 0
      const rect = scroll.getBoundingClientRect()
      return Math.max(0, (clientX - rect.left + scroll.scrollLeft) / pxPerSec)
    },
    [pxPerSec],
  )

  const captureLanes = useCallback((): LaneRect[] => {
    const scroll = scrollRef.current
    if (!scroll) return []
    return Array.from(scroll.querySelectorAll<HTMLElement>('[data-lane-track]')).map((el) => {
      const r = el.getBoundingClientRect()
      return {
        trackId: el.dataset.laneTrack!,
        kind: el.dataset.laneKind as 'video' | 'audio',
        top: r.top,
        bottom: r.bottom,
      }
    })
  }, [])

  const [menu, setMenu] = useState<{ x: number; y: number; clipId: string | null } | null>(null)

  const openClipMenu = useCallback((e: React.MouseEvent, clipId: string) => {
    setMenu({ x: e.clientX, y: e.clientY, clipId })
  }, [])

  const ctx = useMemo<TimelineCtx>(
    () => ({ pxPerSec, xToTime, scrollEl: () => scrollRef.current, captureLanes, openClipMenu }),
    [pxPerSec, xToTime, captureLanes, openClipMenu],
  )

  // Trackpad pinch arrives as ctrl+wheel in Chromium; zoom around the cursor.
  // React's synthetic onWheel is passive — a real listener is needed for preventDefault.
  useEffect(() => {
    const scroll = scrollRef.current
    if (!scroll) return
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return // plain wheel/two-finger pan scrolls natively
      e.preventDefault()
      const s = useStore.getState()
      const rect = scroll.getBoundingClientRect()
      const cursorX = e.clientX - rect.left
      const timeAtCursor = (scroll.scrollLeft + cursorX) / s.pxPerSec
      const next = Math.min(500, Math.max(4, s.pxPerSec * Math.exp(-e.deltaY * 0.01)))
      s.setPxPerSec(next)
      scroll.scrollLeft = timeAtCursor * next - cursorX
    }
    scroll.addEventListener('wheel', onWheel, { passive: false })
    return () => scroll.removeEventListener('wheel', onWheel)
  }, [])

  // Keep the playhead in view while playing (jump-scroll, NLE convention).
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        if (!s.playing || s.playhead === prev.playhead) return
        const scroll = scrollRef.current
        if (!scroll) return
        const x = s.playhead * s.pxPerSec
        if (x > scroll.scrollLeft + scroll.clientWidth - 40 || x < scroll.scrollLeft)
          scroll.scrollLeft = Math.max(0, x - 60)
      }),
    [],
  )

  const {
    setPxPerSec,
    setSnap,
    splitAtPlayhead,
    deleteClips,
    rippleDeleteClips,
    select,
    detachAudio,
  } = useStore.getState()

  // Detach is offered when exactly one video clip with (attached) audio is selected.
  const detachTarget = useMemo(() => {
    if (selection.length !== 1) return null
    for (const tr of project.tracks) {
      const c = tr.clips.find((x) => x.id === selection[0])
      if (!c) continue
      if (c.kind !== 'video' || !c.mediaId) return null
      const asset = project.media.find((m) => m.id === c.mediaId)
      if (!asset?.hasAudio) return null
      const alreadyDetached =
        c.linkId != null &&
        project.tracks.some((t) => t.clips.some((x) => x.linkId === c.linkId && x.kind === 'audio'))
      return alreadyDetached ? null : c.id
    }
    return null
  }, [selection, project])

  const fit = () => {
    const scroll = scrollRef.current
    if (!scroll || project.duration <= 0) return
    setPxPerSec((scroll.clientWidth - 60) / project.duration)
  }

  const hasClips = project.tracks.some((t) => t.clips.length > 0)

  return (
    <footer className="tl">
      <div className="tl__toolbar">
        <IconBtn icon={Scissors} label="Split at playhead (S)" onClick={splitAtPlayhead} />
        <IconBtn
          icon={Trash2}
          label="Delete selected (⌫)"
          disabled={!selection.length}
          onClick={() => deleteClips(selection)}
        />
        <IconBtn
          icon={ArrowLeftToLine}
          label="Ripple delete (close gap)"
          disabled={!selection.length}
          onClick={() => rippleDeleteClips(selection)}
        />
        <IconBtn
          icon={AudioLines}
          label="Detach audio to its own track"
          disabled={!detachTarget}
          onClick={() => detachTarget && detachAudio(detachTarget)}
        />
        <div className="tl__spacer" />
        <IconBtn icon={Magnet} label="Snapping" active={snap} onClick={() => setSnap(!snap)} />
        <IconBtn icon={ZoomOut} label="Zoom out (−)" onClick={() => setPxPerSec(pxPerSec / 1.5)} />
        <IconBtn icon={ZoomIn} label="Zoom in (+)" onClick={() => setPxPerSec(pxPerSec * 1.5)} />
        <IconBtn icon={Maximize} label="Fit timeline" onClick={fit} />
      </div>
      <div className="tl__body">
        <div className="tl__headers" ref={headersRef}>
          <div className="tl__headers-ruler" />
          {ordered.map((t) => (
            <div key={t.id} className="tl__header" style={{ height: LANE_HEIGHT[t.kind] }}>
              {t.name}
            </div>
          ))}
        </div>
        <div
          className="tl__scroll"
          ref={scrollRef}
          onScroll={(e) => {
            // Track headers scroll in lockstep with vertical lane scrolling;
            // the ruler stays pinned via position: sticky inside this element.
            if (headersRef.current)
              headersRef.current.scrollTop = (e.target as HTMLDivElement).scrollTop
          }}
        >
          <TimelineContext.Provider value={ctx}>
            <div className="tl__content" style={{ width: contentWidth }}>
              <Ruler />
              {ordered.map((t) => (
                <div
                  key={t.id}
                  className={`tl__lane tl__lane--${t.kind}`}
                  style={{ height: LANE_HEIGHT[t.kind] }}
                  data-lane-track={t.id}
                  data-lane-kind={t.kind}
                  onPointerDown={() => select([])}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setMenu({ x: e.clientX, y: e.clientY, clipId: null })
                  }}
                >
                  {t.clips.map((c) => (
                    <ClipBlock key={c.id} clip={c} trackId={t.id} />
                  ))}
                </div>
              ))}
              {!hasClips && <div className="tl__empty">Import media to get started</div>}
              <Playhead />
            </div>
          </TimelineContext.Provider>
        </div>
      </div>
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={buildMenuItems(menu.clipId)}
          onClose={() => setMenu(null)}
        />
      )}
    </footer>
  )
}

function buildMenuItems(clipId: string | null): MenuItem[] {
  const s = useStore.getState()
  if (!clipId) {
    return [
      { label: 'Add text at playhead', onClick: () => s.addTextClip() },
      { label: 'Paste is coming later', onClick: () => {}, disabled: true },
    ]
  }
  const found = findClip(s.project, clipId)
  const clip = found?.clip
  const asset = clip?.mediaId ? s.project.media.find((m) => m.id === clip.mediaId) : null
  const detachable =
    clip?.kind === 'video' &&
    !!asset?.hasAudio &&
    !(
      clip.linkId &&
      s.project.tracks.some((t) =>
        t.clips.some((c) => c.linkId === clip.linkId && c.kind === 'audio'),
      )
    )
  const ids = s.selection.includes(clipId) ? s.selection : [clipId]
  return [
    { label: 'Split at playhead', onClick: () => s.splitAtPlayhead() },
    { label: 'Duplicate', onClick: () => ids.forEach((id) => s.duplicateClip(id)) },
    { label: 'Detach audio', onClick: () => s.detachAudio(clipId), disabled: !detachable },
    { label: '', onClick: () => {}, separator: true },
    { label: 'Delete', onClick: () => s.deleteClips(ids), danger: true },
    { label: 'Ripple delete', onClick: () => s.rippleDeleteClips(ids), danger: true },
  ]
}

function Playhead() {
  const playhead = useStore((s) => s.playhead)
  const pxPerSec = useStore((s) => s.pxPerSec)

  const onPointerDown = (e: React.PointerEvent) => {
    e.stopPropagation()
    const el = e.currentTarget as HTMLElement
    el.setPointerCapture(e.pointerId)
    const parent = el.parentElement!.getBoundingClientRect()
    const move = (ev: PointerEvent) =>
      useStore.getState().setPlayhead((ev.clientX - parent.left) / useStore.getState().pxPerSec)
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div
      className="tl__playhead"
      style={{ left: playhead * pxPerSec }}
      onPointerDown={onPointerDown}
    >
      <div className="tl__playhead-cap" />
    </div>
  )
}

export default Timeline
