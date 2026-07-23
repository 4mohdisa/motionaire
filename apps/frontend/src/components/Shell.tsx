import { useEffect, useState } from 'react'
import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import { Clapperboard, FolderOpen, Plus, X } from 'lucide-react'
import { useStore } from '../state/store'
import { createProject } from '../types/project'
import type { Project } from '../types/project'
import {
  importMediaNative,
  openProject,
  openProjectPath,
  saveProject,
  type RecentProject,
} from '../persistence/projectIO'
import { loadPipDemo } from '../compositor/bridge'
import { migrateProjectEffects } from '../engine/effectStack'

// App shell (session 9, Phase 1): activation → onboarding (first run) →
// launcher → editor. All full-window views in one window.

const CANVAS_CHOICES = [
  { id: 'youtube', label: 'YouTube 16:9', w: 1920, h: 1080 },
  { id: 'reel', label: 'Reel 9:16', w: 1080, h: 1920 },
  { id: 'square', label: 'Square 1:1', w: 1080, h: 1080 },
  { id: 'portrait', label: 'Portrait 4:5', w: 1080, h: 1350 },
]

async function finishOnboarding() {
  await invoke('set_setting', { key: 'onboarding_completed', value: '1' }).catch(() => {})
  useStore.getState().setAppView('launcher')
}

export function Activation() {
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const activate = async () => {
    if (!key.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await invoke('activate_license', { key })
      const done = await invoke<string | null>('get_setting', {
        key: 'onboarding_completed',
      }).catch(() => null)
      useStore.getState().setAppView(done === '1' ? 'launcher' : 'onboard')
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="shell shell--center" data-tauri-drag-region>
      <div className="shell__card">
        <Clapperboard size={40} className="shell__logo" />
        <h1 className="shell__title">Activate Motionaire</h1>
        <p className="shell__sub">
          Enter the activation key from your account. You only need to do this once.
        </p>
        <input
          className="shell__input selectable"
          placeholder="MOTIONAIRE-XXXX-XXXX-XXXX"
          value={key}
          autoFocus
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void activate()}
        />
        {error && <div className="shell__error">{error}</div>}
        <button
          className="shell__primary"
          disabled={!key.trim() || busy}
          onClick={() => void activate()}
        >
          {busy ? 'Checking…' : 'Activate'}
        </button>
        {import.meta.env.DEV && (
          <p className="shell__hint">dev build — test key: MOTIONAIRE-TEST-0000-0000</p>
        )}
      </div>
    </div>
  )
}

const SLIDES = [
  {
    title: 'Welcome to Motionaire',
    body: 'A video editor built for screen recordings and talking-head content. Cut, layer, animate, grade — everything lands on a real timeline you stay in control of.',
  },
  {
    title: 'Tell it what you want',
    body: 'Soon you will edit by prompting: "shrink my face to the corner from 0:10 to 0:45." The AI edits the timeline — normal clips and keyframes you can adjust by hand. No black boxes.',
  },
  {
    title: 'Start with footage',
    body: 'Import a screen recording to begin, or open the demo project to poke at a timeline that is already set up.',
  },
]

export function Onboarding() {
  const [step, setStep] = useState(0)
  const last = step === SLIDES.length - 1

  return (
    <div className="shell shell--center" data-tauri-drag-region>
      <div className="shell__card shell__card--wide">
        <button className="shell__skip" onClick={() => void finishOnboarding()}>
          Skip
        </button>
        <h1 className="shell__title">{SLIDES[step].title}</h1>
        <p className="shell__sub shell__sub--roomy">{SLIDES[step].body}</p>
        <div className="shell__dots">
          {SLIDES.map((_, i) => (
            <span key={i} className={`shell__dot${i === step ? ' shell__dot--on' : ''}`} />
          ))}
        </div>
        {last ? (
          <div className="shell__row">
            <button
              className="shell__primary"
              onClick={() => {
                void finishOnboarding().then(() => {
                  useStore.getState().setAppView('editor')
                  void importMediaNative()
                })
              }}
            >
              Import media…
            </button>
            <button
              className="shell__secondary"
              onClick={() => {
                void finishOnboarding().then(() => void loadPipDemo())
              }}
            >
              Open demo project
            </button>
          </div>
        ) : (
          <button className="shell__primary" onClick={() => setStep(step + 1)}>
            Next
          </button>
        )}
      </div>
    </div>
  )
}

// Sample project (Run 1, Phase 7): impressive within ten seconds of opening.
// Deterministic and offline: 60s screen+cam scene, a pip window already
// keyframed via the SAME layout macro the AI uses, and a title.
async function openSampleProject(): Promise<void> {
  const { invoke } = await import('@tauri-apps/api/core')
  const s = useStore.getState()
  try {
    const [screenPath, camPath] = await invoke<[string, string]>('spike_long_fixtures')
    const p = createProject()
    s.replaceProject(p, null)
    s.setAppView('editor')
    const add = (path: string, name: string, w: number, h: number) => {
      const id = `m_${name.replace(/\W/g, '')}`
      useStore.getState().addMedia({
        id,
        path,
        playbackUrl: convertFileSrc(path),
        name,
        kind: 'video',
        duration: 60,
        width: w,
        height: h,
        hasAudio: false,
      })
      return id
    }
    const mScreen = add(screenPath, 'screen-share.mp4', 1280, 720)
    const mCam = add(camPath, 'webcam.mp4', 640, 360)
    const st2 = useStore.getState()
    const vids = st2.project.tracks.filter((t) => t.kind === 'video')
    st2.insertClipAt(mScreen, vids[1].id, 0)
    st2.insertClipAt(mCam, vids[0].id, 0)
    // The pip move, through the same tool the AI calls.
    const { runTool } = await import('../ai/tools')
    await import('../ai/chatSession') // side effect: registers set_layout
    runTool('set_layout', {
      layout: 'pip',
      track: 'auto-cam',
      corner: 'bottom_right',
      scale: 0.22,
      radius: 18,
      margin: 40,
      at: 4,
      duration: 1,
    })
    runTool('set_layout', { layout: 'fullscreen', track: 'auto-cam', at: 20, duration: 1 })
    runTool('add_text', { content: 'Motionaire', start: 0.8, duration: 3.5, size: 96 })
    useStore.getState().setPlayhead(10)
    useStore.getState().select([])
  } catch (e) {
    s.pushToast('error', `Couldn't build the sample project: ${e}`)
  }
}

export function Launcher() {
  const [recents, setRecents] = useState<RecentProject[]>([])
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('Untitled')
  const [preset, setPreset] = useState(CANVAS_CHOICES[0])
  const [fps, setFps] = useState(30)
  // Untitled-project crash recovery (foundation, Phase 8).
  const [recovery, setRecovery] = useState<string | null>(null)

  useEffect(() => {
    void invoke<RecentProject[]>('list_recent_projects')
      .then(setRecents)
      .catch(() => setRecents([]))
    void invoke<string | null>('check_untitled_recovery')
      .then(setRecovery)
      .catch(() => {})
  }, [])

  const restoreUntitled = () => {
    if (!recovery) return
    try {
      const p = JSON.parse(recovery) as Project
      migrateProjectEffects(p)
      for (const m of p.media) if (m.path.startsWith('/')) m.playbackUrl = convertFileSrc(m.path)
      useStore.getState().replaceProject(p, null)
      // Still unsaved: dirty keeps the close guard and untitled autosave live.
      useStore.getState().markDirty()
      useStore.getState().setAppView('editor')
    } catch {
      useStore.getState().pushToast('error', 'Recovered project data was unreadable')
      discardUntitled()
    }
  }
  const discardUntitled = () => {
    setRecovery(null)
    void invoke('clear_untitled_recovery').catch(() => {})
  }

  const create = async () => {
    // The native save dialog is both the location picker and the final name
    // authority — more Mac-like than a separate location field (logged).
    const picked = await save({
      title: 'Create project',
      defaultPath: `${name.trim() || 'Untitled'}.motionaire`,
    })
    if (!picked) return
    const path = picked.endsWith('.motionaire') ? picked : `${picked}.motionaire`
    const p: Project = createProject()
    p.canvas.width = preset.w
    p.canvas.height = preset.h
    p.canvas.fps = fps
    useStore.getState().replaceProject(p, path)
    useStore.getState().setAppView('editor')
    await saveProject()
  }

  const remove = async (path: string) => {
    await invoke('remove_recent_project', { path }).catch(() => {})
    setRecents((r) => r.filter((x) => x.path !== path))
  }

  return (
    <div className="shell shell--launcher">
      <header className="launcher__head" data-tauri-drag-region>
        <div className="launcher__brand">
          <Clapperboard size={22} />
          <span>Motionaire</span>
        </div>
        <div className="shell__row">
          <button className="shell__primary" onClick={() => setCreating(true)}>
            <Plus size={14} /> New Project
          </button>
          <button className="shell__secondary" onClick={() => void openProject()}>
            <FolderOpen size={14} /> Open…
          </button>
          <button className="shell__secondary" onClick={() => void openSampleProject()}>
            <Clapperboard size={14} /> Sample project
          </button>
        </div>
      </header>

      {recovery && (
        <div className="launcher__recovery">
          <span>An unsaved project from your last session was recovered.</span>
          <div className="shell__row">
            <button className="shell__primary" onClick={restoreUntitled}>
              Restore
            </button>
            <button className="shell__secondary" onClick={discardUntitled}>
              Discard
            </button>
          </div>
        </div>
      )}

      {creating && (
        <div className="modal" onClick={() => setCreating(false)}>
          <div className="modal__panel" onClick={(e) => e.stopPropagation()}>
            <div className="modal__title">New Project</div>
            <div className="modal__field modal__field--wide">
              Name
              <input
                className="selectable"
                value={name}
                autoFocus
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void create()}
              />
            </div>
            <div className="modal__section">Canvas</div>
            <div className="modal__chips">
              {CANVAS_CHOICES.map((c) => (
                <button
                  key={c.id}
                  className={`chip${preset.id === c.id ? ' chip--on' : ''}`}
                  onClick={() => setPreset(c)}
                >
                  {c.label}
                </button>
              ))}
            </div>
            <div className="modal__section">Frame rate</div>
            <div className="modal__chips">
              {[24, 30, 60].map((f) => (
                <button
                  key={f}
                  className={`chip${fps === f ? ' chip--on' : ''}`}
                  onClick={() => setFps(f)}
                >
                  {f} fps
                </button>
              ))}
            </div>
            <div className="modal__actions">
              <button className="shell__secondary" onClick={() => setCreating(false)}>
                Cancel
              </button>
              <button className="shell__primary" onClick={() => void create()}>
                Create…
              </button>
            </div>
          </div>
        </div>
      )}

      <main className="launcher__body">
        <div className="launcher__label">Recent projects</div>
        {recents.length === 0 && (
          <div className="launcher__empty">
            Nothing yet — create a project or open the demo from the onboarding.
          </div>
        )}
        <div className="launcher__grid">
          {recents.map((r) => (
            <div
              key={r.path}
              className={`launcher__card${r.missing ? ' launcher__card--missing' : ''}`}
              onClick={() => {
                if (!r.missing) void openProjectPath(r.path)
              }}
              title={r.path}
            >
              <div className="launcher__thumb">
                {r.thumbnail && !r.missing ? (
                  <img src={convertFileSrc(r.thumbnail)} alt="" />
                ) : (
                  <Clapperboard size={22} />
                )}
                {r.missing && <span className="launcher__badge">Missing</span>}
              </div>
              <div className="launcher__meta">
                <span className="launcher__name">{r.name}</span>
                <span className="launcher__time">{relTime(r.lastOpenedAt)}</span>
              </div>
              <button
                className="launcher__remove"
                title="Remove from recents"
                onClick={(e) => {
                  e.stopPropagation()
                  void remove(r.path)
                }}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      </main>
    </div>
  )
}

function relTime(unixSecs: number): string {
  const d = Date.now() / 1000 - unixSecs
  if (d < 90) return 'just now'
  if (d < 3600) return `${Math.round(d / 60)}m ago`
  if (d < 86400) return `${Math.round(d / 3600)}h ago`
  return `${Math.round(d / 86400)}d ago`
}
