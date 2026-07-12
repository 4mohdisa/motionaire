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
    <div className="modal" onPointerDown={() => !running && setExportOpen(false)}>
      <div className="modal__panel" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal__title">Export</div>

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
            {/* ponytail: H.264/MP4 is the wired pipeline; other containers when asked for */}
            <select value="mp4" disabled>
              <option value="mp4">MP4 (H.264)</option>
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

        <div className="modal__actions">
          {running ? (
            <button
              className="topbar__btn"
              onClick={() => void invoke('cancel_export').catch(() => {})}
            >
              Cancel export
            </button>
          ) : (
            <>
              <button className="topbar__btn" onClick={() => setExportOpen(false)}>
                Close
              </button>
              <button className="topbar__btn topbar__btn--primary" onClick={() => void begin()}>
                Export…
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export default ExportPanel
