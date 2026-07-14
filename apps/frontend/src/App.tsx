import TopBar from './components/TopBar'
import Preview from './components/Preview'
import PropertiesPanel from './components/PropertiesPanel'
import ExportPanel from './components/ExportPanel'
import Timeline from './components/timeline/Timeline'
import { Activation, Launcher, Onboarding } from './components/Shell'
import { WorkflowDialogs } from './components/WorkflowDialogs'
import { useBootFlow } from './hooks/useBootFlow'
import MediaBin from './components/MediaBin'
import Toasts from './components/Toasts'
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


function App() {
  useShortcuts()
  useBootFlow()
  const appView = useStore((s) => s.appView)
  useEffect(() => {
    startCompositorBridge()
    startMenuBridge()
    void import('./persistence/proxyManager').then((m) => m.startProxyListeners())
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
    let lastAutosave = 0
    const timer = window.setInterval(() => {
      const s = useStore.getState()
      // Interval honors the preference (foundation, Phase 7).
      if (Date.now() - lastAutosave < s.prefs.autosaveSecs * 1000) return
      if (s.dirty && s.projectPath && s.appView === 'editor') {
        lastAutosave = Date.now()
        void invoke('save_recovery', {
          bundlePath: s.projectPath,
          projectJson: serializeProject(s.project),
        }).catch(() => {})
      } else if (s.dirty && !s.projectPath && s.appView === 'editor') {
        // Untitled projects (foundation, Phase 8): recovery lives in app data
        // until the first real save gives it a bundle.
        lastAutosave = Date.now()
        void invoke('save_untitled_recovery', {
          projectJson: serializeProject(s.project),
        }).catch(() => {})
      }
    }, 5000)
    // Global export notifications (works even when the panel is closed —
    // background export in Phase 6 leans on this).
    // dead-flag: listen() resolves ASYNC, after StrictMode's immediate
    // cleanup — without it both mounts' listeners leak (seen as doubled
    // toasts in the foundation session's own break-test).
    let dead = false
    let unExp: (() => void) | undefined
    void import('@tauri-apps/api/event').then(({ listen }) => {
      void listen<{ ok: boolean; cancelled?: boolean; error?: string }>('export:done', (e) => {
        const s = useStore.getState()
        s.dismissToast('export-progress')
        if (e.payload.ok) s.pushToast('success', 'Export finished')
        else if (e.payload.cancelled) s.pushToast('info', 'Export cancelled')
        else s.pushToast('error', `Export failed: ${e.payload.error ?? 'unknown error'}`)
      }).then((f) => {
        if (dead) f()
        else unExp = f
      })
      // Background export (foundation, Phase 6): progress survives the panel
      // being closed, and queued jobs announce themselves.
      void listen<{ done: number; total: number }>('export:progress', (e) => {
        const s = useStore.getState()
        s.pushToast('progress', 'Exporting…', 'export-progress')
        s.updateToast('export-progress', {
          progress: e.payload.done / Math.max(1, e.payload.total),
          text: `Exporting… ${e.payload.done}/${e.payload.total} frames`,
        })
      })
      void listen<{ depth: number }>('export:queued', (e) => {
        useStore.getState().pushToast('info', `Export queued (${e.payload.depth} waiting)`)
      })
    })
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
          if (dead) f()
          else unlisten = f
        })
    })
    return () => {
      dead = true
      unsub()
      window.clearInterval(timer)
      unlisten?.()
      unExp?.()
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
      <WorkflowDialogs />
      <Toasts />
    </div>
  )
}

export default App
