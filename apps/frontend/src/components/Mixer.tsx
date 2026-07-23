import { useEffect, useRef, useState } from 'react'
import { Volume2, VolumeX, Headphones } from 'lucide-react'
import { useStore } from '../state/store'
import { dbfs, meterFrac, readPeaks, readTrackPeak } from '../engine/audioGraph'

// Audio mixer (pro-editor session, Phase 1): one strip per track — fader
// (track.gain, routed through the track's Web Audio bus so >1.0 actually
// boosts), post-fader meter, mute/solo — plus a master strip on the shared
// bus. Faders write with history:false; the value persists in the project.

function useMeterLevels(trackIds: string[]) {
  const [levels, setLevels] = useState<Record<string, number>>({})
  const decayed = useRef<Record<string, number>>({})
  useEffect(() => {
    let raf = 0
    const tick = () => {
      const d = decayed.current
      const next: Record<string, number> = {}
      for (const id of trackIds) {
        const v = id === '__master' ? Math.max(readPeaks().l, readPeaks().r) : readTrackPeak(id)
        d[id] = Math.max(v, (d[id] ?? 0) * 0.88)
        next[id] = d[id]
      }
      setLevels(next)
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
    // trackIds is rebuilt per render; identity via join keeps the effect stable
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trackIds.join('|')])
  return levels
}

function Meter({ level }: { level: number }) {
  return (
    <div className="mixer__meter">
      <div className="mixer__meterfill" style={{ height: `${meterFrac(level) * 100}%` }} />
    </div>
  )
}

function gainLabel(g: number): string {
  if (g <= 0.001) return '-∞'
  const db = dbfs(g)
  return `${db > 0 ? '+' : ''}${db.toFixed(1)}`
}

export default function Mixer({ docked = false }: { docked?: boolean }) {
  const tracks = useStore((s) => s.project.tracks)
  const masterVolume = useStore((s) => s.project.masterVolume ?? 1)
  const { setTrackGain, setTrackFlag, setMasterVolume, setMixerOpen } = useStore.getState()
  const ids = [...tracks.map((t) => t.id), '__master']
  const levels = useMeterLevels(ids)
  // Draggable by the header — a fixed corner position buried the transport
  // controls at small window sizes (Phase 1 UI audit find).
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const onDragStart = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('.mixer__close')) return
    const rect = panelRef.current!.getBoundingClientRect()
    const dx = e.clientX - rect.left
    const dy = e.clientY - rect.top
    const onMove = (ev: PointerEvent) => {
      setPos({
        x: Math.min(window.innerWidth - rect.width, Math.max(0, ev.clientX - dx)),
        y: Math.min(window.innerHeight - 40, Math.max(0, ev.clientY - dy)),
      })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  // Docked (Run 1, Phase 1f): lives in the left-panel host — no float, no
  // drag, close returns to the media panel via the rail semantics.
  return (
    <div
      ref={panelRef}
      className={docked ? 'mixer mixer--docked panel' : 'mixer'}
      style={
        !docked && pos ? { left: pos.x, top: pos.y, right: 'auto', bottom: 'auto' } : undefined
      }
    >
      <div
        className="mixer__head"
        onPointerDown={docked ? undefined : onDragStart}
        style={docked ? undefined : { cursor: 'grab' }}
      >
        <span>Mixer</span>
        {!docked && (
          <button className="mixer__close" onClick={() => setMixerOpen(false)} title="Close mixer">
            ×
          </button>
        )}
      </div>
      <div className="mixer__strips">
        {tracks.map((t) => {
          const g = t.gain ?? 1
          return (
            <div key={t.id} className={`mixer__strip${t.muted ? ' mixer__strip--muted' : ''}`}>
              <span className="mixer__db">{gainLabel(g)}</span>
              <div className="mixer__fadergroup">
                <input
                  className="mixer__fader"
                  type="range"
                  min={0}
                  max={1.5}
                  step={0.01}
                  value={g}
                  onChange={(e) => setTrackGain(t.id, Number(e.target.value))}
                  onDoubleClick={() => setTrackGain(t.id, 1)}
                  title={`${t.name} fader (double-click = unity)`}
                />
                <Meter level={levels[t.id] ?? 0} />
              </div>
              <div className="mixer__toggles">
                <button
                  className={`mixer__tog${t.muted ? ' mixer__tog--on' : ''}`}
                  title="Mute"
                  onClick={() => setTrackFlag(t.id, 'muted', !t.muted)}
                >
                  {t.muted ? <VolumeX size={11} /> : <Volume2 size={11} />}
                </button>
                <button
                  className={`mixer__tog${t.solo ? ' mixer__tog--solo' : ''}`}
                  title="Solo"
                  onClick={() => setTrackFlag(t.id, 'solo', !t.solo)}
                >
                  <Headphones size={11} />
                </button>
              </div>
              <span className="mixer__name" title={t.name}>
                {t.name}
              </span>
            </div>
          )
        })}
        <div className="mixer__strip mixer__strip--master">
          <span className="mixer__db">{gainLabel(masterVolume)}</span>
          <div className="mixer__fadergroup">
            <input
              className="mixer__fader"
              type="range"
              min={0}
              max={1.5}
              step={0.01}
              value={masterVolume}
              onChange={(e) => setMasterVolume(Number(e.target.value))}
              onDoubleClick={() => setMasterVolume(1)}
              title="Master fader (double-click = unity)"
            />
            <Meter level={levels['__master'] ?? 0} />
          </div>
          <span className="mixer__name">Master</span>
        </div>
      </div>
    </div>
  )
}
