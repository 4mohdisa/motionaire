import { useEffect, useRef, useState } from 'react'
import { Pause, Play, SkipBack, StepBack, StepForward, Volume2, SlidersVertical, Activity } from 'lucide-react'
import { useStore } from '../state/store'
import { formatTimecode } from '../engine/time'
import { meterFrac, readPeaks } from '../engine/audioGraph'
import IconBtn from './IconBtn'

// Live stereo peak meters + clip indicator (foundation, Phase 3). Peaks decay
// smoothly; a red dot latches for 1.5s after any near-full-scale sample.
function AudioMeters() {
  // Pro meters (pro-editor session, Phase 1): dBFS scale (-60..0), fixed
  // color zones (green → yellow at -12 → red at -3), 1.5s peak-hold
  // markers, latching clip lamp. L/R per channel.
  const [levels, setLevels] = useState({ l: 0, r: 0, hl: 0, hr: 0, clipping: false })
  const clipUntil = useRef(0)
  const decayed = useRef({ l: 0, r: 0 })
  const hold = useRef({ l: 0, r: 0, atL: 0, atR: 0 })
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const p = readPeaks()
      const d = decayed.current
      const h = hold.current
      const now = performance.now()
      d.l = Math.max(p.l, d.l * 0.88)
      d.r = Math.max(p.r, d.r * 0.88)
      if (p.l >= h.l || now - h.atL > 1500) {
        h.l = p.l
        h.atL = now
      }
      if (p.r >= h.r || now - h.atR > 1500) {
        h.r = p.r
        h.atR = now
      }
      if (p.l >= 0.985 || p.r >= 0.985) clipUntil.current = now + 1500
      setLevels({
        l: meterFrac(d.l),
        r: meterFrac(d.r),
        hl: meterFrac(h.l),
        hr: meterFrac(h.r),
        clipping: now < clipUntil.current,
      })
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <div className="meters" title="Output level, dBFS −60..0 (yellow −12, red −3; lamp latches on clip)">
      <div className="meters__bars">
        {(
          [
            ['l', 'hl'],
            ['r', 'hr'],
          ] as const
        ).map(([ch, hd]) => (
          <div key={ch} className="meters__track">
            <div className="meters__fill" style={{ width: `${levels[ch] * 100}%` }} />
            {levels[hd] > 0.01 && (
              <div className="meters__hold" style={{ left: `${levels[hd] * 100}%` }} />
            )}
          </div>
        ))}
        <div className="meters__scale">
          {[-60, -30, -12, -3].map((db) => (
            <span key={db} style={{ left: `${((db + 60) / 60) * 100}%` }} />
          ))}
        </div>
      </div>
      <span className={`meters__clip${levels.clipping ? ' meters__clip--on' : ''}`} />
    </div>
  )
}

function TransportControls() {
  const playing = useStore((s) => s.playing)
  const playhead = useStore((s) => s.playhead)
  const duration = useStore((s) => s.project.duration)
  const fps = useStore((s) => s.project.canvas.fps)
  const compositorActive = useStore((s) => s.compositorActive)
  const compositorFps = useStore((s) => s.compositorFps)
  const masterVolume = useStore((s) => s.project.masterVolume ?? 1)
  const mixerOpen = useStore((s) => s.mixerOpen)
  const scopesOpen = useStore((s) => s.scopesOpen)
  const { togglePlay, frameStep, setPlayhead } = useStore.getState()

  // Compositor status lives HERE, in chrome — never overlaid on the frame
  // (foundation session, Phase 0).
  const status = !compositorActive
    ? 'DOM preview'
    : playing && compositorFps > 0
      ? `${compositorFps.toFixed(0)} fps`
      : 'ready'

  return (
    <div className="transport">
      <span className="transport__time">{formatTimecode(playhead, fps)}</span>
      <span
        className={`transport__status${compositorActive ? ' transport__status--ok' : ''}`}
        title="Compositor status"
      >
        {status}
      </span>
      <div className="transport__buttons">
        <IconBtn icon={SkipBack} label="Go to start (Home)" onClick={() => setPlayhead(0)} />
        <IconBtn icon={StepBack} label="Previous frame (←)" onClick={() => frameStep(-1)} />
        <IconBtn
          icon={playing ? Pause : Play}
          label={playing ? 'Pause (Space)' : 'Play (Space)'}
          onClick={togglePlay}
        />
        <IconBtn icon={StepForward} label="Next frame (→)" onClick={() => frameStep(1)} />
      </div>
      <div className="transport__audio">
        <AudioMeters />
        <IconBtn
          icon={Activity}
          label="Video scopes"
          active={scopesOpen}
          onClick={() => useStore.getState().setScopesOpen(!scopesOpen)}
        />
        <IconBtn
          icon={SlidersVertical}
          label="Audio mixer"
          active={mixerOpen}
          onClick={() => useStore.getState().setMixerOpen(!mixerOpen)}
        />
        <Volume2 size={12} className="transport__volicon" />
        <input
          className="transport__master selectable"
          type="range"
          min={0}
          max={1.5}
          step={0.01}
          value={masterVolume}
          title={`Master volume ${(masterVolume * 100).toFixed(0)}%`}
          onChange={(e) => useStore.getState().setMasterVolume(Number(e.target.value))}
        />
      </div>
      <span className="transport__time transport__time--total">
        {formatTimecode(duration, fps)}
      </span>
    </div>
  )
}

export default TransportControls
