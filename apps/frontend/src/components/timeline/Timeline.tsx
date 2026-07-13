import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Ellipsis,
  Eye,
  EyeOff,
  Headphones,
  Lock,
  LockOpen,
  Plus,
  Scissors,
  SlidersHorizontal,
  Trash2,
  Volume2,
  VolumeX,
  ZoomIn,
} from 'lucide-react'
import { invoke } from '@tauri-apps/api/core'
import { useStore } from '../../state/store'
import type { Track } from '../../types/project'
import { findClip } from '../../engine/time'
import { isTauri } from '../../compositor/bridge'
import { TimelineContext, type LaneRect, type TimelineCtx } from './timelineContext'
import Ruler from './Ruler'
import ClipBlock from './ClipBlock'
import ContextMenu, { type MenuItem } from '../ContextMenu'
import { freezeFrame } from '../../persistence/projectIO'
import { MEDIA_DND } from '../MediaBin'
import IconBtn from '../IconBtn'
import { Dropdown, DropdownCheck, DropdownItem } from '../Dropdown'

const LANE_HEIGHT: Record<'video' | 'audio', number> = { video: 56, audio: 44 }

function Timeline() {
  const project = useStore((s) => s.project)
  const pxPerSec = useStore((s) => s.pxPerSec)
  const snap = useStore((s) => s.snap)
  const safeZones = useStore((s) => s.safeZones)
  const previewFull = useStore((s) => s.previewFull)
  const selection = useStore((s) => s.selection)
  const editMode = useStore((s) => s.editMode)
  const scrollRef = useRef<HTMLDivElement>(null)
  const headersRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(
    null,
  )

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
    setSafeZones,
    setPreviewFull,
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

  // Marquee select: drag on empty lane space. Coordinates are content-local so
  // mid-drag scrolling keeps the box anchored to timeline time, not the screen.
  const onLanePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) return
      const content = contentRef.current
      if (!content) return
      const additive = e.shiftKey || e.metaKey
      if (!additive) select([])
      const baseSel = additive ? useStore.getState().selection : []
      const r0 = content.getBoundingClientRect()
      const sx = e.clientX - r0.left
      const sy = e.clientY - r0.top
      let active = false
      const onMove = (ev: PointerEvent) => {
        const rect = content.getBoundingClientRect()
        const cx = ev.clientX - rect.left
        const cy = ev.clientY - rect.top
        if (!active && Math.hypot(cx - sx, cy - sy) < 4) return
        active = true
        const box = {
          x: Math.min(sx, cx),
          y: Math.min(sy, cy),
          w: Math.abs(cx - sx),
          h: Math.abs(cy - sy),
        }
        setMarquee(box)
        const s = useStore.getState()
        const t0 = box.x / s.pxPerSec
        const t1 = (box.x + box.w) / s.pxPerSec
        const ids: string[] = []
        for (const laneEl of content.querySelectorAll<HTMLElement>('[data-lane-track]')) {
          const lr = laneEl.getBoundingClientRect()
          if (lr.bottom - rect.top < box.y || lr.top - rect.top > box.y + box.h) continue
          const track = s.project.tracks.find((t) => t.id === laneEl.dataset.laneTrack)
          for (const c of track?.clips ?? [])
            if (c.start < t1 && c.start + (c.out - c.in) / c.speed > t0) ids.push(c.id)
        }
        s.select([...new Set([...baseSel, ...ids])])
      }
      const onUp = () => {
        window.removeEventListener('pointermove', onMove)
        window.removeEventListener('pointerup', onUp)
        setMarquee(null)
      }
      window.addEventListener('pointermove', onMove)
      window.addEventListener('pointerup', onUp)
    },
    [select],
  )

  const fit = () => {
    const scroll = scrollRef.current
    if (!scroll || project.duration <= 0) return
    setPxPerSec((scroll.clientWidth - 60) / project.duration)
  }

  const hasClips = project.tracks.some((t) => t.clips.length > 0)

  return (
    <footer className="tl">
      <div className="tl__toolbar">
        <Dropdown icon={Plus} label="Add">
          <DropdownItem
            label="Video track"
            onClick={() => useStore.getState().addTrack('video')}
          />
          <DropdownItem
            label="Audio track"
            onClick={() => useStore.getState().addTrack('audio')}
          />
          <DropdownItem label="Text at playhead" onClick={() => useStore.getState().addTextClip()} />
          <DropdownItem
            label="Image…"
            onClick={() => {
              void import('../../persistence/projectIO').then((m) => m.importImageNative())
            }}
          />
          <DropdownItem
            label="Adjustment layer at playhead"
            onClick={() => useStore.getState().addAdjustmentLayer()}
          />
          <DropdownItem label="Rectangle" onClick={() => useStore.getState().addShapeClip('rect')} />
          <DropdownItem label="Ellipse" onClick={() => useStore.getState().addShapeClip('ellipse')} />
          <DropdownItem label="Line" onClick={() => useStore.getState().addShapeClip('line')} />
        </Dropdown>
        <IconBtn icon={Scissors} label="Split at playhead (S)" onClick={splitAtPlayhead} />
        <button
          className="chip chip--mode"
          title="Drop behavior: Insert pushes clips right; Overwrite replaces what's underneath"
          onClick={() =>
            useStore.getState().setEditMode(editMode === 'insert' ? 'overwrite' : 'insert')
          }
        >
          {editMode === 'insert' ? 'Insert' : 'Overwrite'}
        </button>
        <IconBtn
          icon={Trash2}
          label="Delete selected (⌫)"
          disabled={!selection.length}
          onClick={() => deleteClips(selection)}
        />
        <Dropdown icon={Ellipsis} label="More tools">
          <DropdownItem
            label="Ripple delete (close gap)"
            disabled={!selection.length}
            onClick={() => rippleDeleteClips(selection)}
          />
          <DropdownItem
            label="Detach audio"
            disabled={!detachTarget}
            onClick={() => detachTarget && detachAudio(detachTarget)}
          />
        </Dropdown>
        <div className="tl__spacer" />
        <Dropdown icon={SlidersHorizontal} label="View options" alignRight>
          <DropdownCheck label="Snapping" checked={snap} onToggle={() => setSnap(!snap)} />
          <DropdownCheck
            label="Safe zones"
            checked={safeZones}
            onToggle={() => setSafeZones(!safeZones)}
          />
          <DropdownCheck
            label="Full resolution preview"
            checked={previewFull}
            onToggle={() => {
              const next = !previewFull
              setPreviewFull(next)
              if (isTauri) void invoke('set_preview_quality', { full: next }).catch(() => {})
            }}
          />
        </Dropdown>
        <Dropdown
          icon={ZoomIn}
          label="Timeline zoom"
          value={`${Math.round((pxPerSec / 60) * 100)}%`}
          alignRight
        >
          <div className="dropdown__zoom">
            <input
              className="selectable"
              type="range"
              min={7}
              max={800}
              value={Math.round((pxPerSec / 60) * 100)}
              onChange={(e) => setPxPerSec((Number(e.target.value) / 100) * 60)}
            />
            <div className="dropdown__zoom-row">
              {[50, 100, 200, 400].map((p) => (
                <button
                  key={p}
                  className="chip"
                  onClick={() => setPxPerSec((p / 100) * 60)}
                >
                  {p}%
                </button>
              ))}
            </div>
          </div>
          <DropdownItem label="Fit timeline to window" onClick={fit} />
        </Dropdown>
      </div>
      <div className="tl__body">
        <div className="tl__headers" ref={headersRef}>
          <div className="tl__headers-ruler" />
          {ordered.map((t) => (
            <TrackHeader key={t.id} track={t} height={LANE_HEIGHT[t.kind]} />
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
            <div className="tl__content" ref={contentRef} style={{ width: contentWidth }}>
              <Ruler />
              {ordered.map((t) => (
                <div
                  key={t.id}
                  className={`tl__lane tl__lane--${t.kind}`}
                  style={{ height: LANE_HEIGHT[t.kind] }}
                  data-lane-track={t.id}
                  data-lane-kind={t.kind}
                  onPointerDown={onLanePointerDown}
                  onDragOver={(e) => {
                    if (e.dataTransfer.types.includes(MEDIA_DND)) e.preventDefault()
                  }}
                  onDrop={(e) => {
                    const id = e.dataTransfer.getData(MEDIA_DND)
                    if (!id) return
                    e.preventDefault()
                    let range: { in: number; out: number } | undefined
                    const raw = e.dataTransfer.getData('text/motionaire-range')
                    if (raw) {
                      try {
                        range = JSON.parse(raw) as { in: number; out: number }
                      } catch {
                        range = undefined
                      }
                    }
                    useStore.getState().insertClipAt(id, t.id, xToTime(e.clientX), range)
                  }}
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
              {!hasClips && (
                <div className="tl__empty">
                  Drop media here, or import a file to get started
                  <div className="tl__empty-action">
                    <button
                      className="topbar__btn"
                      onClick={() =>
                        void import('../../persistence/projectIO').then((m) =>
                          m.importMediaNative(),
                        )
                      }
                    >
                      Import media…
                    </button>
                  </div>
                </div>
              )}
              {marquee && (
                <div
                  className="tl__marquee"
                  style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h }}
                />
              )}
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

// Track header (session 9, Phase 3): rename, per-kind toggles, drag reorder.
function TrackHeader({ track, height }: { track: Track; height: number }) {
  const [editing, setEditing] = useState(false)

  // Drag to reorder: crossing ~70% of a lane height swaps with the neighbor.
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, input')) return
    let lastY = e.clientY
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - lastY
      if (Math.abs(dy) > height * 0.7) {
        useStore.getState().reorderTrack(track.id, dy > 0 ? 1 : -1)
        lastY = ev.clientY
      }
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const flag = (f: 'muted' | 'solo' | 'locked' | 'hidden') =>
    useStore.getState().setTrackFlag(track.id, f, !track[f])

  return (
    <div
      className={`tl__header${track.kind === 'audio' ? ' tl__header--audio' : ''}`}
      style={{ height }}
      onPointerDown={onPointerDown}
      title="Drag to reorder"
    >
      {editing ? (
        <input
          className="th__rename selectable"
          defaultValue={track.name}
          autoFocus
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter' || e.key === 'Escape') (e.target as HTMLInputElement).blur()
          }}
          onBlur={(e) => {
            useStore.getState().renameTrack(track.id, e.target.value)
            setEditing(false)
          }}
        />
      ) : (
        <span className="th__name" onDoubleClick={() => setEditing(true)}>
          {track.name}
        </span>
      )}
      <span className="th__btns">
        {track.kind === 'video' && (
          <button
            className={`th__btn${track.hidden ? ' th__btn--on' : ''}`}
            title={track.hidden ? 'Show track' : 'Hide track'}
            onClick={() => flag('hidden')}
          >
            {track.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
          </button>
        )}
        {track.kind === 'audio' && (
          <>
            <button
              className={`th__btn${track.muted ? ' th__btn--on' : ''}`}
              title={track.muted ? 'Unmute' : 'Mute'}
              onClick={() => flag('muted')}
            >
              {track.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
            </button>
            <button
              className={`th__btn${track.solo ? ' th__btn--solo' : ''}`}
              title="Solo"
              onClick={() => flag('solo')}
            >
              <Headphones size={12} />
            </button>
          </>
        )}
        <button
          className={`th__btn${track.locked ? ' th__btn--on' : ''}`}
          title={track.locked ? 'Unlock track' : 'Lock track'}
          onClick={() => flag('locked')}
        >
          {track.locked ? <Lock size={12} /> : <LockOpen size={12} />}
        </button>
      </span>
    </div>
  )
}

function buildMenuItems(clipId: string | null): MenuItem[] {
  const s = useStore.getState()
  if (!clipId) {
    return [
      { label: 'Add text at playhead', onClick: () => s.addTextClip() },
      { label: 'Add adjustment layer at playhead', onClick: () => s.addAdjustmentLayer() },
      {
        label: 'Paste at playhead',
        onClick: () => s.pasteAtPlayhead(),
        disabled: !s.clipboard.length,
      },
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
  const freezable =
    clip?.kind === 'video' &&
    !!asset &&
    !asset.missing &&
    s.playhead >= clip.start &&
    s.playhead <= clip.start + (clip.out - clip.in) / clip.speed
  return [
    { label: 'Split at playhead', onClick: () => s.splitAtPlayhead() },
    { label: 'Cut', onClick: () => s.cutClips(ids) },
    { label: 'Copy', onClick: () => s.copyClips(ids) },
    { label: 'Paste at playhead', onClick: () => s.pasteAtPlayhead(), disabled: !s.clipboard.length },
    { label: 'Duplicate', onClick: () => ids.forEach((id) => s.duplicateClip(id)) },
    {
      label: clip?.disabled ? 'Enable' : 'Disable',
      onClick: () => s.setClipDisabled(ids, !clip?.disabled),
    },
    { label: 'Freeze frame at playhead', onClick: () => void freezeFrame(clipId), disabled: !freezable },
    { label: 'Detach audio', onClick: () => s.detachAudio(clipId), disabled: !detachable },
    ...(clip?.kind === 'audio' ||
    (clip?.kind === 'video' && !!asset?.hasAudio)
      ? [
          { label: 'Fade in (0.5s)', onClick: () => s.addFade(clipId, 'in') },
          { label: 'Fade out (0.5s)', onClick: () => s.addFade(clipId, 'out') },
          {
            label: 'Normalize (−1 dB peak)',
            onClick: () => void useStore.getState().normalizeClip(clipId),
          },
          {
            label: 'Duck under other audio',
            onClick: () =>
              void import('../../engine/ducking').then((m) => m.duckUnderSpeech(clipId)),
          },
        ]
      : []),
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
    useStore.getState().setScrubbing(true) // audio scrub (foundation, Phase 2)
    const parent = el.parentElement!.getBoundingClientRect()
    const move = (ev: PointerEvent) =>
      useStore.getState().setPlayhead((ev.clientX - parent.left) / useStore.getState().pxPerSec)
    const up = () => {
      useStore.getState().setScrubbing(false)
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
