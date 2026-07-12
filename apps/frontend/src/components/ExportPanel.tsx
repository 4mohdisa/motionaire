import { useState } from 'react'
import { CANVAS_PRESETS, useStore, type CanvasPresetId } from '../state/store'

function ExportPanel() {
  const open = useStore((s) => s.exportOpen)
  const canvas = useStore((s) => s.project.canvas)
  const settings = useStore((s) => s.exportSettings)
  const safeZones = useStore((s) => s.safeZones)
  const { setExportOpen, setCanvasPreset, setCanvasFps, setExportSettings, setSafeZones } =
    useStore.getState()
  const [notice, setNotice] = useState(false)

  if (!open) return null

  const activePreset = (
    Object.entries(CANVAS_PRESETS) as [CanvasPresetId, { width: number; height: number }][]
  ).find(([, p]) => p.width === canvas.width && p.height === canvas.height)?.[0]

  return (
    <div className="modal" onPointerDown={() => setExportOpen(false)}>
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
            <select value={canvas.fps} onChange={(e) => setCanvasFps(Number(e.target.value))}>
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
              onChange={(e) =>
                setExportSettings({ format: e.target.value as typeof settings.format })
              }
            >
              <option value="mp4">MP4 (H.264)</option>
              <option value="webm">WebM (VP9)</option>
              <option value="mov">MOV (ProRes)</option>
            </select>
          </label>
          <label className="modal__field modal__field--wide">
            <span>Quality — {settings.quality}</span>
            <input
              type="range"
              min={1}
              max={100}
              value={settings.quality}
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

        {notice && (
          <div className="modal__notice">
            Rendering isn&apos;t wired up yet — export arrives with the native FFmpeg pipeline.
            These settings are saved on the project.
          </div>
        )}

        <div className="modal__actions">
          <button className="topbar__btn" onClick={() => setExportOpen(false)}>
            Close
          </button>
          <button className="topbar__btn topbar__btn--primary" onClick={() => setNotice(true)}>
            Export
          </button>
        </div>
      </div>
    </div>
  )
}

export default ExportPanel
