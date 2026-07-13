import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { activeTextClips, activeVideoClips, clipEnd, crossTransitionAt } from '../engine/time'
import { resolveProp } from '../engine/keyframes'
import { clipsToMount, usePlaybackEngine, type ElementMap } from '../engine/playback'
import { startCompositorClient } from '../compositor/client'
import type { Clip } from '../types/project'
import TransportControls from './TransportControls'
import SourceMonitor from './SourceMonitor'

function Preview() {
  const project = useStore((s) => s.project)
  const playhead = useStore((s) => s.playhead)
  const elements = useRef<ElementMap>(new Map())
  usePlaybackEngine(elements)

  // Stage geometry is pure CSS (aspect-ratio + container-query units) so the
  // frame can never distort or collapse, regardless of JS callback delivery.
  // The observer only feeds the overlay scale factor (text, safe zones).
  const stageRef = useRef<HTMLDivElement>(null)
  const [overlayScale, setOverlayScale] = useState(0)
  const { width: cw, height: ch } = project.canvas
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const measure = () => setOverlayScale(el.getBoundingClientRect().width / cw)
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    measure()
    return () => ro.disconnect()
  }, [cw, ch])

  const mounted = clipsToMount(project, playhead)
  const visible = activeVideoClips(project, playhead)[0]?.clip
  const cross = crossTransitionAt(project, playhead)
  const texts = activeTextClips(project, playhead)
  const safeZones = useStore((s) => s.safeZones)
  const compositorActive = useStore((s) => s.compositorActive)
  const sourcePreview = useStore((s) => s.sourcePreview)

  // Rust compositor stream → canvas. When frames flow, the canvas is the video
  // surface (real multi-clip composite) and DOM <video> stays for audio only.
  const compositeCanvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = compositeCanvasRef.current
    if (!canvas) return
    return startCompositorClient(canvas)
  }, [])

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

  return (
    <div className="preview">
      {sourcePreview && <SourceMonitor key={sourcePreview.mediaId} />}
      <div className="preview__fit" style={sourcePreview ? { display: 'none' } : undefined}>
        <div
          className="preview__stage"
          ref={stageRef}
          style={
            {
              '--ar': `${cw} / ${ch}`,
              background: project.canvas.background,
            } as React.CSSProperties
          }
        >
          {mounted.map((clip) => {
            const asset = project.media.find((m) => m.id === clip.mediaId)
            if (!asset) return null
            return (
              <video
                key={clip.id}
                ref={registerEl(clip.id)}
                className="preview__video"
                style={compositorActive ? { visibility: 'hidden' } : styleFor(clip)}
                src={asset.playbackUrl || asset.path}
                playsInline
                preload="auto"
              />
            )
          })}
          <canvas
            ref={compositeCanvasRef}
            className="preview__composite"
            style={{ display: compositorActive ? 'block' : 'none' }}
          />
          <div
            className="preview__overlay"
            style={{
              width: cw,
              height: ch,
              transform: `scale(${overlayScale})`,
            }}
          >
            {/* Compositor active: text is IN the composited frame (session 9,
                Phase 4) — the DOM overlay would double-draw it. It remains the
                fallback for browser mode / compositor outages. */}
            {!compositorActive &&
              texts.map(({ clip }) => <TextOverlay key={clip.id} clip={clip} t={playhead} />)}
            {safeZones && <SafeZones w={cw} h={ch} />}
          </div>
        </div>
      </div>
      {!sourcePreview && <TransportControls />}
    </div>
  )
}

// Action-safe (90%) and title-safe (80%) guides + center cross, broadcast/social convention.
function SafeZones({ w, h }: { w: number; h: number }) {
  const zone = (f: number, cls: string) => (
    <div
      className={`preview__safezone ${cls}`}
      style={{
        left: (w * (1 - f)) / 2,
        top: (h * (1 - f)) / 2,
        width: w * f,
        height: h * f,
      }}
    />
  )
  return (
    <>
      {zone(0.9, 'preview__safezone--action')}
      {zone(0.8, 'preview__safezone--title')}
      <div className="preview__center-h" style={{ top: h / 2, width: w }} />
      <div className="preview__center-v" style={{ left: w / 2, height: h }} />
    </>
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
