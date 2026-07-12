import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useStore } from '../../state/store'
import { TimelineContext, type LaneRect, type TimelineCtx } from './timelineContext'
import Ruler from './Ruler'
import ClipBlock from './ClipBlock'

const LANE_HEIGHT: Record<'video' | 'audio', number> = { video: 56, audio: 44 }

function Timeline() {
  const project = useStore((s) => s.project)
  const pxPerSec = useStore((s) => s.pxPerSec)
  const snap = useStore((s) => s.snap)
  const selection = useStore((s) => s.selection)
  const scrollRef = useRef<HTMLDivElement>(null)

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

  const ctx = useMemo<TimelineCtx>(
    () => ({ pxPerSec, xToTime, scrollEl: () => scrollRef.current, captureLanes }),
    [pxPerSec, xToTime, captureLanes],
  )

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

  const { setPxPerSec, setSnap, splitAtPlayhead, deleteClips, rippleDeleteClips, select } =
    useStore.getState()

  const fit = () => {
    const scroll = scrollRef.current
    if (!scroll || project.duration <= 0) return
    setPxPerSec((scroll.clientWidth - 60) / project.duration)
  }

  const hasClips = project.tracks.some((t) => t.clips.length > 0)

  return (
    <footer className="tl">
      <div className="tl__toolbar">
        <button className="tl__btn" title="Split at playhead (S)" onClick={splitAtPlayhead}>
          Split
        </button>
        <button
          className="tl__btn"
          title="Delete selected (⌫)"
          disabled={!selection.length}
          onClick={() => deleteClips(selection)}
        >
          Delete
        </button>
        <button
          className="tl__btn"
          title="Ripple delete selected"
          disabled={!selection.length}
          onClick={() => rippleDeleteClips(selection)}
        >
          Ripple
        </button>
        <div className="tl__spacer" />
        <button
          className={`tl__btn${snap ? ' tl__btn--on' : ''}`}
          title="Toggle snapping"
          onClick={() => setSnap(!snap)}
        >
          Snap
        </button>
        <button className="tl__btn" title="Zoom out" onClick={() => setPxPerSec(pxPerSec / 1.5)}>
          −
        </button>
        <button className="tl__btn" title="Zoom in" onClick={() => setPxPerSec(pxPerSec * 1.5)}>
          +
        </button>
        <button className="tl__btn" title="Fit timeline" onClick={fit}>
          Fit
        </button>
      </div>
      <div className="tl__body">
        <div className="tl__headers">
          <div className="tl__headers-ruler" />
          {ordered.map((t) => (
            <div
              key={t.id}
              className="tl__header"
              style={{ height: LANE_HEIGHT[t.kind] }}
            >
              {t.name}
            </div>
          ))}
        </div>
        <div className="tl__scroll" ref={scrollRef}>
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
    </footer>
  )
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
    <div className="tl__playhead" style={{ left: playhead * pxPerSec }} onPointerDown={onPointerDown}>
      <div className="tl__playhead-cap" />
    </div>
  )
}

export default Timeline
