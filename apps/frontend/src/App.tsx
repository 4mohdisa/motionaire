import TopBar from './components/TopBar'
import Preview from './components/Preview'
import PropertiesPanel from './components/PropertiesPanel'
import ExportPanel from './components/ExportPanel'
import Timeline from './components/timeline/Timeline'
import { Activation, Launcher, Onboarding } from './components/Shell'
import { useBootFlow } from './hooks/useBootFlow'
import MediaBin from './components/MediaBin'
import { useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useShortcuts } from './hooks/useShortcuts'
import { guardDirty, resolveUnsaved } from './hooks/unsaved'
import { useStore } from './state/store'
import { isTauri, startCompositorBridge } from './compositor/bridge'
import { startMenuBridge } from './menu/menuBridge'
import { serializeProject } from './persistence/projectIO'
import './App.css'

// Thin drag strip that resizes a neighboring panel.
function Resizer({
  direction,
  onDrag,
}: {
  direction: 'row' | 'col'
  onDrag: (delta: number) => void
}) {
  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    let last = direction === 'row' ? e.clientY : e.clientX
    const move = (ev: PointerEvent) => {
      const cur = direction === 'row' ? ev.clientY : ev.clientX
      onDrag(cur - last)
      last = cur
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return <div className={`resizer resizer--${direction}`} onPointerDown={onPointerDown} />
}

// Vertical space the preview column needs beside the timeline:
// topbar 48 + transport 40 + preview floor 140 + padding/resizer ~42.
const NON_TIMELINE_MIN = 270

// 3-way unsaved-changes prompt (session 9, Phase 6).
function UnsavedPrompt() {
  const open = useStore((s) => s.unsavedOpen)
  if (!open) return null
  return (
    <div className="modal">
      <div className="modal__panel" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal__title">Unsaved changes</div>
        <p className="shell__sub">This project has unsaved changes. Save them before continuing?</p>
        <div className="modal__actions">
          <button className="topbar__btn" onClick={() => resolveUnsaved('cancel')}>
            Cancel
          </button>
          <button className="topbar__btn" onClick={() => resolveUnsaved('discard')}>
            Don&apos;t Save
          </button>
          <button className="topbar__btn topbar__btn--primary" onClick={() => resolveUnsaved('save')}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}

const AUTOSAVE_MS = 30_000

function App() {
  useShortcuts()
  useBootFlow()
  const appView = useStore((s) => s.appView)
  useEffect(() => {
    startCompositorBridge()
    startMenuBridge()
  }, [])
  // Project safety plumbing: titlebar edited dot, autosave, close guard.
  useEffect(() => {
    if (!isTauri) return
    let lastDirty = false
    const unsub = useStore.subscribe((s) => {
      if (s.dirty !== lastDirty) {
        lastDirty = s.dirty
        void invoke('set_edited', { edited: s.dirty }).catch(() => {})
      }
    })
    const timer = window.setInterval(() => {
      const s = useStore.getState()
      if (s.dirty && s.projectPath && s.appView === 'editor') {
        void invoke('save_recovery', {
          bundlePath: s.projectPath,
          projectJson: serializeProject(s.project),
        }).catch(() => {})
      }
    }, AUTOSAVE_MS)
    let unlisten: (() => void) | undefined
    void import('@tauri-apps/api/window').then(({ getCurrentWindow }) => {
      void getCurrentWindow()
        .onCloseRequested(async (e) => {
          const s = useStore.getState()
          if (!s.dirty || s.appView !== 'editor') return
          e.preventDefault()
          if (await guardDirty()) void getCurrentWindow().destroy()
        })
        .then((f) => {
          unlisten = f
        })
    })
    return () => {
      unsub()
      window.clearInterval(timer)
      unlisten?.()
    }
  }, [])
  // Panel sizes are user-dragged absolutes; re-clamp them when the window
  // shrinks so the preview always keeps its floor (Part 1, session 6).
  useEffect(() => {
    const clamp = () => {
      const s = useStore.getState()
      const maxTl = Math.max(140, window.innerHeight - NON_TIMELINE_MIN)
      if (s.timelineHeight > maxTl) s.setTimelineHeight(maxTl)
      const maxProps = Math.max(220, window.innerWidth - 400)
      if (s.propsWidth > maxProps) s.setPropsWidth(maxProps)
    }
    clamp()
    window.addEventListener('resize', clamp)
    return () => window.removeEventListener('resize', clamp)
  }, [])
  const timelineHeight = useStore((s) => s.timelineHeight)
  const propsWidth = useStore((s) => s.propsWidth)
  const { setTimelineHeight, setPropsWidth } = useStore.getState()

  if (appView === 'boot') return null
  if (appView === 'activate') return <Activation />
  if (appView === 'onboard') return <Onboarding />
  if (appView === 'launcher') return <Launcher />

  return (
    <div
      className="app-shell"
      style={{ '--props-width': `${propsWidth}px` } as React.CSSProperties}
    >
      <TopBar />
      <main className="workspace">
        <MediaBin />
        <Preview />
        <Resizer
          direction="col"
          onDrag={(d) =>
            setPropsWidth(Math.min(useStore.getState().propsWidth - d, window.innerWidth - 400))
          }
        />
        <PropertiesPanel />
      </main>
      <Resizer
        direction="row"
        onDrag={(d) =>
          setTimelineHeight(
            Math.min(useStore.getState().timelineHeight - d, window.innerHeight - NON_TIMELINE_MIN),
          )
        }
      />
      <div style={{ height: timelineHeight, display: 'flex', flexDirection: 'column' }}>
        <Timeline />
      </div>
      <ExportPanel />
      <UnsavedPrompt />
    </div>
  )
}

export default App
