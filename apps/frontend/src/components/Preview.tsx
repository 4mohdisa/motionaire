import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { activeVideoClips } from '../engine/time'
import { clipsToMount, usePlaybackEngine, type ElementMap } from '../engine/playback'
import TransportControls from './TransportControls'

function Preview() {
  const project = useStore((s) => s.project)
  const playhead = useStore((s) => s.playhead)
  const elements = useRef<ElementMap>(new Map())
  usePlaybackEngine(elements)

  // Fit the canvas into the available area; the scale factor also drives
  // canvas-coordinate overlays (text, safe zones) in later phases.
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
  const visibleId = activeVideoClips(project, playhead)[0]?.clip.id

  const registerEl = (clipId: string) => (el: HTMLVideoElement | null) => {
    if (el) elements.current.set(clipId, el)
    else elements.current.delete(clipId)
  }

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
                style={{ visibility: clip.id === visibleId ? 'visible' : 'hidden' }}
                src={asset.path}
                playsInline
                preload="auto"
              />
            )
          })}
        </div>
      </div>
      <TransportControls />
    </div>
  )
}

export default Preview
