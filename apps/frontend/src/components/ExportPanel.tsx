import { useEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { CANVAS_PRESETS, useStore, type CanvasPresetId } from '../state/store'
import { isTauri } from '../compositor/bridge'
import { runExport } from '../compositor/exportRunner'

function ExportPanel() {
  const open = useStore((s) => s.exportOpen)
  const canvas = useStore((s) => s.project.canvas)
  const settings = useStore((s) => s.exportSettings)
  const safeZones = useStore((s) => s.safeZones)
  const guides = useStore((s) => s.guides)
  const { setExportOpen, setCanvasPreset, setCanvasFps, setExportSettings, setSafeZones } =
    useStore.getState()

  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [donePath, setDonePath] = useState<string | null>(null)
  const outRef = useRef<string | null>(null)

  useEffect(() => {
    if (!isTauri) return
    const un1 = listen<{ done: number; total: number }>('export:progress', (e) =>
      setProgress(e.payload),
    )
    const un2 = listen<{ ok: boolean; cancelled?: boolean; error?: string }>(
      'export:done',
      (e) => {
        setProgress(null)
        if (e.payload.ok) setDonePath(outRef.current)
        else if (!e.payload.cancelled) setError(e.payload.error ?? 'unknown error')
      },
    )
    return () => {
      void un1.then((f) => f())
      void un2.then((f) => f())
    }
  }, [])

  const markIn = useStore((s) => s.markIn)
  const markOut = useStore((s) => s.markOut)

  if (!open) return null

  const running = progress !== null
  const activePreset = (
    Object.entries(CANVAS_PRESETS) as [CanvasPresetId, { width: number; height: number }][]
  ).find(([, p]) => p.width === canvas.width && p.height === canvas.height)?.[0]

  const begin = async () => {
    setError(null)
    setDonePath(null)
    try {
      const path = await runExport()
      if (path) {
        outRef.current = path
        setProgress({ done: 0, total: 1 })
      }
    } catch (e) {
      setError(String(e))
    }
  }

  return (
    <div className="modal" onPointerDown={() => setExportOpen(false)}>
      <div className="modal__panel" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal__title">Export</div>

        <div className="modal__section">Export preset</div>
        <div className="modal__chips">
          {(
            [
              ['YouTube 1080p', 1080, 30, 80, 'mp4'],
              ['YouTube 4K', 2160, 30, 85, 'hevc'],
              ['Reel / TikTok', 1920, 30, 75, 'mp4'],
              ['Square', 1080, 30, 75, 'mp4'],
              ['GIF clip', 480, 15, 60, 'gif'],
            ] as [string, number, number, number, typeof settings.format][]
          ).map(([label, h, pfps, q, fmt]) => (
            <button
              key={label}
              className="chip"
              disabled={running}
              title={`${h}p @ ${pfps}fps, quality ${q}, ${fmt}`}
              onClick={() => setExportSettings({ height: h, fps: pfps, quality: q, format: fmt })}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="modal__section">Canvas preset</div>
        <div className="modal__chips">
          {(
            Object.entries(CANVAS_PRESETS) as [
              CanvasPresetId,
              (typeof CANVAS_PRESETS)[CanvasPresetId],
            ][]
          ).map(([id, p]) => (
            <button
              key={id}
              className={`chip${activePreset === id ? ' chip--on' : ''}`}
              disabled={running}
              onClick={() => setCanvasPreset(id)}
            >
              {p.label}
            </button>
          ))}
          <button className={`chip${!activePreset ? ' chip--on' : ''}`} disabled>
            Custom
          </button>
        </div>

        <div className="modal__grid">
          <label className="modal__field">
            <span>Width</span>
            <input
              type="number"
              min={16}
              value={canvas.width}
              disabled={running}
              onChange={(e) =>
                setCanvasPreset({
                  width: Number(e.target.value) || canvas.width,
                  height: canvas.height,
                })
              }
            />
          </label>
          <label className="modal__field">
            <span>Height</span>
            <input
              type="number"
              min={16}
              value={canvas.height}
              disabled={running}
              onChange={(e) =>
                setCanvasPreset({
                  width: canvas.width,
                  height: Number(e.target.value) || canvas.height,
                })
              }
            />
          </label>
          <label className="modal__field">
            <span>Frame rate</span>
            <select
              value={canvas.fps}
              disabled={running}
              onChange={(e) => setCanvasFps(Number(e.target.value))}
            >
              {[24, 25, 30, 50, 60].map((f) => (
                <option key={f} value={f}>
                  {f} fps
                </option>
              ))}
            </select>
          </label>
          <label className="modal__field">
            <span>Format</span>
            <select
              value={settings.format}
              disabled={running}
              onChange={(e) =>
                setExportSettings({ format: e.target.value as typeof settings.format })
              }
            >
              <option value="mp4">MP4 (H.264)</option>
              <option value="hevc">MP4 (H.265/HEVC)</option>
              <option value="prores">MOV (ProRes 422)</option>
              <option value="m4a">M4A (audio only)</option>
              <option value="gif">GIF (15fps, silent)</option>
              <option value="png">PNG sequence</option>
            </select>
          </label>
          <label className="modal__field modal__field--wide">
            <span>Quality — {settings.quality}</span>
            <input
              type="range"
              min={1}
              max={100}
              value={settings.quality}
              disabled={running}
              onChange={(e) => setExportSettings({ quality: Number(e.target.value) })}
            />
          </label>
        </div>

        <label className="modal__check">
          <input
            type="checkbox"
            checked={safeZones}
            onChange={(e) => setSafeZones(e.target.checked)}
          />
          Show safe-zone guides on preview
        </label>
        <div className="modal__actions" style={{ justifyContent: 'flex-start', marginTop: 4 }}>
          <button
            className="topbar__btn"
            title="Copy markers as YouTube chapter text"
            onClick={() => {
              const p = useStore.getState().project
              const fmtYt = (t: number) => {
                const s = Math.floor(t)
                const m = Math.floor(s / 60)
                const h = Math.floor(m / 60)
                const pad = (n: number) => String(n).padStart(2, '0')
                return h > 0 ? `${h}:${pad(m % 60)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
              }
              const lines = [...(p.markers ?? [])]
                .sort((a, b) => a.t - b.t)
                .map((mk) => `${fmtYt(mk.t)} ${mk.label || 'Chapter'}`)
              // YouTube requires a chapter at 0:00.
              if (!lines.length || !lines[0].startsWith('0:00')) lines.unshift('0:00 Intro')
              void navigator.clipboard.writeText(lines.join('\n'))
              useStore.getState().pushToast('success', `${lines.length} chapters copied`)
            }}
          >
            Copy YouTube chapters
          </button>
        </div>
        <label className="modal__check">
          <input
            type="checkbox"
            checked={guides}
            onChange={(e) => useStore.getState().setGuides(e.target.checked)}
          />
          Show thirds/center guides on preview
        </label>

        {running && (
          <div className="export__progress">
            <div className="export__bar">
              <div
                className="export__fill"
                style={{ width: `${(progress.done / Math.max(1, progress.total)) * 100}%` }}
              />
            </div>
            <span className="export__label">
              {progress.done} / {progress.total} frames
            </span>
          </div>
        )}

        {error && <div className="modal__notice modal__notice--error">Export failed: {error}</div>}
        {donePath && !running && (
          <div className="modal__notice modal__notice--ok">
            Exported to {donePath}{' '}
            <button
              className="chip"
              onClick={() => void invoke('reveal_in_finder', { path: donePath }).catch(() => {})}
            >
              Reveal in Finder
            </button>
          </div>
        )}

        {markIn !== null && markOut !== null && markOut > markIn && (
          <div className="modal__notice">
            Export range: {markIn.toFixed(2)}s → {markOut.toFixed(2)}s (timeline in/out marks —
            ⌥I/⌥O clears)
          </div>
        )}
        <div className="modal__actions">
          {running && (
            <button
              className="topbar__btn"
              onClick={() => void invoke('cancel_export').catch(() => {})}
            >
              Cancel export
            </button>
          )}
          <button className="topbar__btn" onClick={() => setExportOpen(false)}>
            {running ? 'Close (keeps running)' : 'Close'}
          </button>
          <button
            className="topbar__btn topbar__btn--primary"
            onClick={() => void begin()}
            title={running ? 'Queues behind the running export' : undefined}
          >
            {running ? 'Queue export…' : 'Export…'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default ExportPanel
