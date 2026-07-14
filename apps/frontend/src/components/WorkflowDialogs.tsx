import { invoke } from '@tauri-apps/api/core'
import { CANVAS_PRESETS, useStore, type CanvasPresetId } from '../state/store'

// Workflow dialogs (foundation session, Phase 7): project settings (canvas
// is changeable AFTER creation now), app preferences, and the ⌘/ shortcut
// cheat sheet. All ride the shared modal styling.

export function ProjectSettingsDialog() {
  const canvas = useStore((s) => s.project.canvas)
  const { setCanvasPreset, setCanvasFps, setDialog } = useStore.getState()
  const activePreset = (
    Object.entries(CANVAS_PRESETS) as [CanvasPresetId, { width: number; height: number }][]
  ).find(([, p]) => p.width === canvas.width && p.height === canvas.height)?.[0]

  return (
    <div className="modal" onPointerDown={() => setDialog(null)}>
      <div className="modal__panel" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal__title">Project Settings</div>
        <div className="modal__section">Canvas</div>
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
        </div>
        <div className="modal__grid">
          <label className="modal__field">
            <span>Width</span>
            <input
              type="number"
              min={16}
              value={canvas.width}
              onChange={(e) =>
                setCanvasPreset({ width: Number(e.target.value) || canvas.width, height: canvas.height })
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
                setCanvasPreset({ width: canvas.width, height: Number(e.target.value) || canvas.height })
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
        </div>
        <div className="modal__notice">
          Clip keyframes are frame-snapped to the new rate on their next edit; existing timing is
          preserved.
        </div>
        <div className="modal__actions">
          <button className="topbar__btn topbar__btn--primary" onClick={() => setDialog(null)}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

export function PreferencesDialog() {
  const prefs = useStore((s) => s.prefs)
  const { setPrefs, setDialog } = useStore.getState()
  const save = (patch: Partial<typeof prefs>) => {
    setPrefs(patch)
    const next = { ...useStore.getState().prefs }
    void invoke('set_setting', { key: 'prefs', value: JSON.stringify(next) }).catch(() => {})
  }
  return (
    <div className="modal" onPointerDown={() => setDialog(null)}>
      <div className="modal__panel" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal__title">Settings</div>
        <div className="modal__grid">
          <label className="modal__field">
            <span>Autosave interval</span>
            <select
              value={prefs.autosaveSecs}
              onChange={(e) => save({ autosaveSecs: Number(e.target.value) })}
            >
              {[15, 30, 60, 120].map((v) => (
                <option key={v} value={v}>
                  every {v}s
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className="modal__check">
          <input
            type="checkbox"
            checked={prefs.autoProxy}
            onChange={(e) => save({ autoProxy: e.target.checked })}
          />
          Create proxies automatically for footage above 1080p
        </label>
        <div className="modal__section">License</div>
        <div className="modal__actions" style={{ justifyContent: 'flex-start', marginTop: 4 }}>
          <button
            className="topbar__btn"
            onClick={() => {
              void invoke('deactivate_license')
                .then(() => {
                  setDialog(null)
                  useStore.getState().setAppView('activate')
                })
                .catch(() => {})
            }}
          >
            Deactivate this Mac…
          </button>
        </div>
        <div className="modal__actions">
          <button className="topbar__btn topbar__btn--primary" onClick={() => setDialog(null)}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

const SHORTCUTS: [string, string][] = [
  ['Space', 'Play / pause'],
  ['J / K / L', 'Shuttle back / pause / forward (tap again to speed up)'],
  ['← / →', 'Step one frame (⇧ = 10)'],
  ['Home / End', 'Go to start / end'],
  ['S', 'Split at playhead'],
  ['M', 'Add marker'],
  ['I / O', 'Mark in / out (⌥ clears)'],
  [', / .', 'Nudge selection one frame (⇧ = 5)'],
  ['⌫ / ⇧⌫', 'Delete / ripple delete selection'],
  ['⌘Z / ⇧⌘Z', 'Undo / redo'],
  ['⌘D', 'Duplicate selection'],
  ['⌘A', 'Select all clips'],
  ['⌘X / ⌘C / ⌘V', 'Cut / copy / paste clips (at playhead)'],
  ['+ / -', 'Zoom timeline'],
  ['Esc', 'Clear selection'],
  ['⌘N / ⌘O / ⌘S', 'New / open / save project'],
  ['⌘W', 'Close project'],
  ['⌘I', 'Import media'],
  ['⌘,', 'Settings'],
  ['⌘/', 'This cheat sheet'],
]

export function ShortcutSheet() {
  const { setDialog } = useStore.getState()
  return (
    <div className="modal" onPointerDown={() => setDialog(null)}>
      <div className="modal__panel modal__panel--wide" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal__title">Keyboard Shortcuts</div>
        <div className="shortcuts">
          {SHORTCUTS.map(([keys, what]) => (
            <div key={keys} className="shortcuts__row">
              <span className="shortcuts__keys">{keys}</span>
              <span className="shortcuts__what">{what}</span>
            </div>
          ))}
        </div>
        <div className="modal__actions">
          <button className="topbar__btn topbar__btn--primary" onClick={() => setDialog(null)}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

export function WorkflowDialogs() {
  const dialog = useStore((s) => s.dialog)
  if (dialog === 'projectSettings') return <ProjectSettingsDialog />
  if (dialog === 'preferences') return <PreferencesDialog />
  if (dialog === 'shortcuts') return <ShortcutSheet />
  return null
}
