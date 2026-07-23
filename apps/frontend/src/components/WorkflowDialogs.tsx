import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { CHAT_MODELS, clearAiKey, saveAiKey, testConnection } from '../persistence/aiSettings'
import GeneratePanel from './GeneratePanel'
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
        <div className="modal__section">AI — chat provider</div>
        <AiProviderBlock
          key={prefs.aiChatProvider}
          kind="chat"
          value={prefs.aiChatProvider}
          options={[
            ['anthropic', 'Anthropic (Claude)'],
            ['openai', 'OpenAI'],
            ['mock', 'Mock (offline)'],
          ]}
          onSelect={(v) => save({ aiChatProvider: v as typeof prefs.aiChatProvider })}
          model={prefs.aiChatModel}
          onModel={(m) => save({ aiChatModel: m })}
        />
        <div className="modal__section">AI — video generation</div>
        <AiProviderBlock
          key={prefs.aiVideoProvider}
          kind="video"
          value={prefs.aiVideoProvider}
          options={[
            ['none', 'None'],
            ['seedance', 'Seedance'],
            ['gemini', 'Google (Veo)'],
          ]}
          onSelect={(v) => save({ aiVideoProvider: v as typeof prefs.aiVideoProvider })}
        />

        {/* Release decision: the open-source build ships unlocked — no boot
            gate, so a deactivate button here would be dead UI. The license
            seam (validator + commands + gate view) remains in code for any
            future commercial build. */}
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
  if (dialog === 'generate') return <GeneratePanel />
  return null
}

// AI provider selection + key management (Run 1, Phase 2). The key input is
// WRITE-ONLY: its value goes straight to ai_set_key (Rust → keychain) and
// the field clears — nothing key-shaped stays in JS state or the DOM.
function AiProviderBlock({
  kind,
  value,
  options,
  onSelect,
  model,
  onModel,
}: {
  kind: 'chat' | 'video'
  value: string
  options: [string, string][]
  onSelect: (v: string) => void
  model?: string
  onModel?: (m: string) => void
}) {
  const [keyDraft, setKeyDraft] = useState('')
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const needsKey = value !== 'mock' && value !== 'none'
  const { pushToast } = useStore.getState()

  useEffect(() => {
    if (!needsKey) return
    let dead = false
    void invoke<boolean>('ai_has_key', { provider: value })
      .then((v) => !dead && setHasKey(v))
      .catch(() => !dead && setHasKey(false))
    return () => {
      dead = true
    }
  }, [value, needsKey])

  return (
    <>
      <div className="modal__chips">
        {options.map(([id, label]) => (
          <button
            key={id}
            className={`chip${value === id ? ' chip--on' : ''}`}
            onClick={() => onSelect(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {needsKey && (
        <>
          <div className="modal__grid">
            <label className="modal__field modal__field--wide">
              <span>API key {hasKey === null ? '' : hasKey ? '· saved ✓' : '· not set'}</span>
              <input
                type="password"
                autoComplete="off"
                placeholder={hasKey ? '••••••••  (enter to replace)' : 'Paste key…'}
                value={keyDraft}
                onChange={(e) => setKeyDraft(e.target.value)}
              />
            </label>
            {model !== undefined && onModel && (
              <label className="modal__field">
                <span>Model</span>
                <select value={model} onChange={(e) => onModel(e.target.value)}>
                  {(CHAT_MODELS[value] ?? [model]).map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <div className="modal__actions" style={{ justifyContent: 'flex-start', marginTop: 4 }}>
            <button
              className="topbar__btn"
              disabled={!keyDraft.trim() || busy}
              onClick={() => {
                setBusy(true)
                void saveAiKey(value, keyDraft)
                  .then(() => {
                    setKeyDraft('')
                    setHasKey(true)
                    pushToast('success', 'Key saved to the system keychain')
                  })
                  .catch((e) => pushToast('error', String(e)))
                  .finally(() => setBusy(false))
              }}
            >
              Save key
            </button>
            <button
              className="topbar__btn"
              disabled={!hasKey || busy}
              onClick={() => {
                setBusy(true)
                void testConnection(value, model)
                  .then((msg) => pushToast('success', msg))
                  .catch((e) => pushToast('error', String(e)))
                  .finally(() => setBusy(false))
              }}
            >
              Test connection
            </button>
            <button
              className="topbar__btn"
              disabled={!hasKey || busy}
              onClick={() => {
                void clearAiKey(value).then(() => setHasKey(false))
              }}
            >
              Remove key
            </button>
          </div>
        </>
      )}
      {kind === 'chat' && !needsKey && (
        <div className="modal__notice">
          Mock provider: offline, deterministic — for demos and tests. No key, no network.
        </div>
      )}
    </>
  )
}
