import { useRef, useState } from 'react'
import { ArrowDownToLine, Pause, Play, SkipBack, StepBack, StepForward, X } from 'lucide-react'
import { useStore } from '../state/store'
import { formatTimecode } from '../engine/time'
import IconBtn from './IconBtn'
import { MEDIA_DND } from './MediaBin'

// Source monitor (foundation session, Phase 2 — the single biggest workflow
// gap): preview a bin asset, set in/out on the SOURCE, then insert exactly
// that range. Long screen recordings never have to hit the timeline whole.
// Playback here is a plain <video> element — source preview is a DOM-side
// concern; the compositor keeps rendering the program in the background.

function SourceMonitor() {
  const sp = useStore((s) => s.sourcePreview)!
  const asset = useStore((s) => s.project.media.find((m) => m.id === sp.mediaId))
  const fps = useStore((s) => s.project.canvas.fps)
  const videoRef = useRef<HTMLVideoElement>(null)
  const [t, setT] = useState(0)
  const [dur, setDur] = useState(0)
  const [playing, setPlaying] = useState(false)
  // No reset effect needed: Preview mounts this with key={mediaId}, so a
  // different source is a fresh component.

  if (!asset) return null
  const { openSource, setSourceRange } = useStore.getState()

  const seek = (to: number) => {
    const el = videoRef.current
    if (!el) return
    el.currentTime = Math.max(0, Math.min(to, dur || asset.duration))
  }
  const togglePlay = () => {
    const el = videoRef.current
    if (!el) return
    if (el.paused) void el.play()
    else el.pause()
  }
  const range = { in: sp.in ?? 0, out: sp.out ?? (dur || asset.duration) }
  const insert = () => {
    const s = useStore.getState()
    s.insertClipAt(asset.id, null, s.playhead, range)
    s.pushToast(
      'success',
      `Added ${formatTimecode(range.out - range.in, fps)} of ${asset.name} at the playhead`,
    )
  }

  const D = dur || asset.duration || 1
  return (
    <div className="srcmon">
      <div className="srcmon__head">
        <span className="srcmon__title">Source — {asset.name}</span>
        <IconBtn icon={X} label="Close source (back to program)" onClick={() => openSource(null)} />
      </div>
      <div className="srcmon__stage">
        <video
          ref={videoRef}
          className="srcmon__video"
          src={asset.playbackUrl || asset.path}
          playsInline
          onTimeUpdate={(e) => setT((e.target as HTMLVideoElement).currentTime)}
          onLoadedMetadata={(e) => {
            const el = e.target as HTMLVideoElement
            setDur(el.duration)
            el.currentTime = 0.001 // paint the first frame instead of black
          }}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onClick={togglePlay}
        />
      </div>
      <div
        className="srcmon__scrub selectable"
        onPointerDown={(e) => {
          const el = e.currentTarget
          el.setPointerCapture(e.pointerId)
          const r = el.getBoundingClientRect()
          const to = (x: number) => seek(((x - r.left) / r.width) * D)
          to(e.clientX)
          const move = (ev: PointerEvent) => to(ev.clientX)
          const up = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
          }
          window.addEventListener('pointermove', move)
          window.addEventListener('pointerup', up)
        }}
      >
        <div
          className="srcmon__iorange"
          style={{
            left: `${(range.in / D) * 100}%`,
            width: `${(Math.max(0, range.out - range.in) / D) * 100}%`,
          }}
        />
        <div className="srcmon__cursor" style={{ left: `${(t / D) * 100}%` }} />
      </div>
      <div className="srcmon__bar">
        <span className="transport__time">{formatTimecode(t, fps)}</span>
        <div className="transport__buttons">
          <IconBtn icon={SkipBack} label="Go to start" onClick={() => seek(0)} />
          <IconBtn icon={StepBack} label="Back one frame" onClick={() => seek(t - 1 / fps)} />
          <IconBtn
            icon={playing ? Pause : Play}
            label={playing ? 'Pause' : 'Play'}
            onClick={togglePlay}
          />
          <IconBtn icon={StepForward} label="Forward one frame" onClick={() => seek(t + 1 / fps)} />
        </div>
        <div className="srcmon__io">
          <button className="chip" onClick={() => setSourceRange('in', t)} title="Set in point">
            I&nbsp;{sp.in !== null ? formatTimecode(sp.in, fps) : '—'}
          </button>
          <button className="chip" onClick={() => setSourceRange('out', t)} title="Set out point">
            O&nbsp;{sp.out !== null ? formatTimecode(sp.out, fps) : '—'}
          </button>
          <button
            className="chip"
            draggable
            title="Drag this range to the timeline, or click Add"
            onDragStart={(e) => {
              e.dataTransfer.setData(MEDIA_DND, asset.id)
              e.dataTransfer.setData(
                'text/motionaire-range',
                JSON.stringify({ in: range.in, out: range.out }),
              )
              e.dataTransfer.effectAllowed = 'copy'
            }}
          >
            ⠿ drag
          </button>
          <button className="shell__primary srcmon__add" onClick={insert}>
            <ArrowDownToLine size={13} /> Add at playhead
          </button>
        </div>
      </div>
    </div>
  )
}

export default SourceMonitor
