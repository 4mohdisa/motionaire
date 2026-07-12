import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { activeTextClips, activeVideoClips, clipEnd, crossTransitionAt } from '../engine/time'
import { resolveProp } from '../engine/keyframes'
import { clipsToMount, usePlaybackEngine, type ElementMap } from '../engine/playback'
import type { Clip } from '../types/project'
import TransportControls from './TransportControls'

function Preview() {
  const project = useStore((s) => s.project)
  const playhead = useStore((s) => s.playhead)
  const elements = useRef<ElementMap>(new Map())
  usePlaybackEngine(elements)

  // Fit the canvas into the available area; scale factor drives the
  // canvas-coordinate overlay layer (text, safe zones).
  const containerRef = useRef<HTMLDivElement>(null)
  const [stage, setStage] = useState({ w: 0, h: 0 })
  const { width: cw, height: ch } = project.canvas
  useEffect(() => {
    const el = containerRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      const scale = Math.min(r.width / cw, r.height / ch)
      setStage({ w: Math.floor(cw * scale), h: Math.floor(ch * scale) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [cw, ch])

  const mounted = clipsToMount(project, playhead)
  const visible = activeVideoClips(project, playhead)[0]?.clip
  const cross = crossTransitionAt(project, playhead)
  const texts = activeTextClips(project, playhead)

  // Outgoing fade-to-black on the visible clip's out edge.
  let visibleOpacity = 1
  if (visible?.transitions.out?.type === 'fade') {
    const d = visible.transitions.out.duration
    const end = clipEnd(visible)
    if (playhead > end - d) visibleOpacity = Math.max(0, (end - playhead) / d)
  }
  // Incoming fade-from-black (no outgoing partner involved).
  if (visible?.transitions.in?.type === 'fade') {
    const d = visible.transitions.in.duration
    if (playhead < visible.start + d)
      visibleOpacity = Math.min(visibleOpacity, (playhead - visible.start) / d)
  }

  const styleFor = (clip: Clip): React.CSSProperties => {
    const style: React.CSSProperties = { visibility: 'hidden' }
    if (cross && cross.a?.id === clip.id) {
      // Outgoing side of a cross transition: fully visible underneath.
      return { visibility: 'visible', zIndex: 1 }
    }
    if (clip.id !== visible?.id) return style
    if (cross && cross.b.id === clip.id) {
      const p = cross.progress
      switch (cross.type) {
        case 'dissolve':
          return { visibility: 'visible', zIndex: 2, opacity: p }
        case 'slide':
          return { visibility: 'visible', zIndex: 2, transform: `translateX(${(1 - p) * 100}%)` }
        case 'wipe':
          return { visibility: 'visible', zIndex: 2, clipPath: `inset(0 ${(1 - p) * 100}% 0 0)` }
      }
    }
    return { visibility: 'visible', zIndex: 2, opacity: visibleOpacity }
  }

  const registerEl = (clipId: string) => (el: HTMLVideoElement | null) => {
    if (el) elements.current.set(clipId, el)
    else elements.current.delete(clipId)
  }

  const overlayScale = cw > 0 ? stage.w / cw : 0

  return (
    <div className="preview">
      <div className="preview__fit" ref={containerRef}>
        <div
          className="preview__stage"
          style={{ width: stage.w, height: stage.h, background: project.canvas.background }}
        >
          {mounted.map((clip) => {
            const asset = project.media.find((m) => m.id === clip.mediaId)
            if (!asset) return null
            return (
              <video
                key={clip.id}
                ref={registerEl(clip.id)}
                className="preview__video"
                style={styleFor(clip)}
                src={asset.path}
                playsInline
                preload="auto"
              />
            )
          })}
          <div
            className="preview__overlay"
            style={{
              width: cw,
              height: ch,
              transform: `scale(${overlayScale})`,
            }}
          >
            {texts.map(({ clip }) => (
              <TextOverlay key={clip.id} clip={clip} t={playhead} />
            ))}
          </div>
        </div>
      </div>
      <TransportControls />
    </div>
  )
}

function TextOverlay({ clip, t }: { clip: Clip; t: number }) {
  const rel = t - clip.start
  const x = resolveProp(clip, 'transform.x', rel)
  const y = resolveProp(clip, 'transform.y', rel)
  const scale = resolveProp(clip, 'transform.scale', rel)
  const rotation = resolveProp(clip, 'transform.rotation', rel)
  const opacity = resolveProp(clip, 'transform.opacity', rel)
  const st = clip.text
  if (!st) return null
  return (
    <div
      className="preview__text"
      style={{
        transform: `translate(-50%, -50%) translate(${x}px, ${y}px) scale(${scale}) rotate(${rotation}deg)`,
        opacity,
        fontFamily: `${st.font}, system-ui, sans-serif`,
        fontSize: st.size,
        fontWeight: st.weight,
        color: st.color,
        textAlign: st.align,
        maxWidth: st.maxWidth,
        WebkitTextStroke: st.stroke ? `${st.stroke.width}px ${st.stroke.color}` : undefined,
        background: st.background?.color,
        padding: st.background?.padding,
        borderRadius: st.background?.radius,
      }}
    >
      {st.content}
    </div>
  )
}

export default Preview
