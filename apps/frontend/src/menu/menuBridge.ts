import { listen } from '@tauri-apps/api/event'
import { invoke } from '@tauri-apps/api/core'
import { useStore } from '../state/store'
import { createProject } from '../types/project'
import { isTauri, loadPipDemo } from '../compositor/bridge'
import {
  importMediaNative,
  openProject,
  openProjectPath,
  saveProject,
} from '../persistence/projectIO'

// Native-menu → app dispatch. Accelerators on native items are global, so
// text-editing keys (Cmd+Z / Cmd+A) route back to the focused field when the
// user is typing — matching what a Mac user expects.

let started = false

function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    (el?.isContentEditable ?? false)
  )
}

async function dispatch(action: string, path?: string) {
  const s = useStore.getState()
  switch (action) {
    case 'file:new':
      // ponytail: no dirty-check prompt yet — undo history is cleared by design.
      s.replaceProject(createProject(), null)
      break
    case 'file:open':
      await openProject()
      break
    case 'file:open_recent':
      if (path) await openProjectPath(path)
      break
    case 'file:save':
      await saveProject()
      break
    case 'file:save_as':
      await saveProject(true)
      break
    case 'file:import':
      await importMediaNative()
      break
    case 'file:import_font': {
      const { importFontFlow } = await import('../persistence/fontManager')
      await importFontFlow()
      break
    }
    case 'edit:undo':
      if (isTyping()) document.execCommand('undo')
      else s.undo()
      break
    case 'edit:redo':
      if (isTyping()) document.execCommand('redo')
      else s.redo()
      break
    case 'edit:delete':
      if (!isTyping() && s.selection.length) s.deleteClips(s.selection)
      break
    case 'edit:ripple_delete':
      if (!isTyping() && s.selection.length) s.rippleDeleteClips(s.selection)
      break
    case 'edit:select_all':
      if (isTyping()) document.execCommand('selectAll')
      else s.selectAllClips()
      break
    case 'view:safe_zones':
      s.setSafeZones(!s.safeZones)
      break
    case 'view:snap':
      s.setSnap(!s.snap)
      break
    case 'view:zoom_in':
      s.setPxPerSec(s.pxPerSec * 1.5)
      break
    case 'view:zoom_out':
      s.setPxPerSec(s.pxPerSec / 1.5)
      break
    case 'view:full_preview': {
      const next = !s.previewFull
      s.setPreviewFull(next)
      await invoke('set_preview_quality', { full: next }).catch(() => {})
      break
    }
    case 'view:pip_demo':
      await loadPipDemo()
      break
    // Dev-remote passthroughs (debug builds drive these via the trigger file).
    case 'dev:play':
      s.play()
      break
    case 'dev:pause':
      s.pause()
      break
    case 'dev:reload':
      window.location.reload()
      break
    case 'dev:grade_demo': {
      // Keyframed grade on the fullscreen cam layer: exposure 0→2 and
      // saturation 0→-1 across 0..6s — Phase 3 animation verification.
      await loadPipDemo()
      const st = useStore.getState()
      const cam = st.project.tracks
        .filter((t) => t.kind === 'video')
        .sort((a, b) => b.z - a.z)[0]?.clips[0]
      if (!cam) break
      for (const prop of ['transform.scale', 'transform.x', 'transform.y', 'transform.cornerRadius'])
        st.clearKeyframes(cam.id, prop)
      st.setPlayhead(0)
      st.toggleKeyframe(cam.id, 'grade.exposure')
      st.toggleKeyframe(cam.id, 'grade.saturation')
      st.setPlayhead(6)
      st.setClipProperty(cam.id, 'grade.exposure', 2)
      st.setClipProperty(cam.id, 'grade.saturation', -1)
      st.setPlayhead(0.5)
      break
    }
    case 'dev:transition_demo': {
      // Two adjacent clips on ONE track with a dissolve on the cut — the
      // compositor-transition verification scene.
      await loadPipDemo()
      const st = useStore.getState()
      const tracks = st.project.tracks.filter((t) => t.kind === 'video').sort((a, b) => a.z - b.z)
      const [v1, v2] = tracks
      const a = v1?.clips[0]
      const b = v2?.clips[0]
      if (!a || !b) break
      st.trimClip(a.id, 'out', 5)
      st.moveClip(b.id, 5, v1!.id)
      const moved = useStore
        .getState()
        .project.tracks.flatMap((t) => t.clips)
        .find((c) => c.id === b.id)
      if (moved) {
        useStore.getState().trimClip(b.id, 'out', 10)
        useStore.getState().setClipProperty(b.id, 'transform.scale', 1) // clear PiP keyframes? kfs remain; scale kf overrides — clear all:
      }
      // Strip the PiP keyframes so the incoming clip is fullscreen.
      for (const prop of [
        'transform.scale',
        'transform.x',
        'transform.y',
        'transform.cornerRadius',
      ])
        useStore.getState().clearKeyframes(b.id, prop)
      useStore.getState().setTransition(b.id, 'in', { type: 'dissolve', duration: 1.2 })
      useStore.getState().setPlayhead(4.5)
      break
    }
  }
  if (action.startsWith('dev:seek:')) {
    const t = Number(action.slice('dev:seek:'.length))
    if (Number.isFinite(t)) s.setPlayhead(t)
  }
  if (action.startsWith('dev:scrubstorm')) {
    const secs = Number(action.split(':')[2] ?? 8)
    await runScrubStorm(Number.isFinite(secs) && secs > 0 ? secs : 8)
  }
}

// Phase-1 forensics: hammer the playhead like an aggressive scrub drag while
// capturing (a) the native webview pixels and (b) the canvas's OWN pixel data
// at the same instants. If (b) is valid while (a) shows garbage, the defect is
// WebKit displaying a surface that isn't our canvas content; if (b) is also
// garbage, our pipeline delivered bad pixels.
async function runScrubStorm(secs = 8) {
  const report = (pass: boolean, detail: string) =>
    invoke('report_test', { name: 'scrub-storm', pass, detail }).catch(() => {})
  try {
    const s = useStore.getState()
    const dur = Math.max(1, s.project.duration - 0.2)
    s.pause()
    const canvas = document.querySelector('.preview__composite') as HTMLCanvasElement | null
    if (!canvas) {
      void report(false, 'no composite canvas')
      return
    }
    const ctx = canvas.getContext('2d')!
    const samples: string[] = []
    const sampleCanvas = (label: string) => {
      // 5 fixed probe points; a valid composited frame is never all-black
      // at all probes (testsrc2 bars) nor uniform garbage.
      const pts = [
        [0.1, 0.1],
        [0.5, 0.2],
        [0.85, 0.5],
        [0.3, 0.8],
        [0.65, 0.65],
      ]
      const px = pts
        .map(([fx, fy]) => {
          const d = ctx.getImageData(
            Math.floor(canvas.width * fx),
            Math.floor(canvas.height * fy),
            1,
            1,
          ).data
          return `${d[0]},${d[1]},${d[2]}`
        })
        .join(' | ')
      samples.push(`${label}: ${px}`)
    }

    const start = performance.now()
    let captures = 0
    const timer = window.setInterval(() => {
      const t = Math.random() * dur
      useStore.getState().setPlayhead(t)
      const elapsed = performance.now() - start
      if (elapsed > (secs * 250) * (captures + 1) && captures < 3) {
        captures++
        sampleCanvas(`t+${(elapsed / 1000).toFixed(1)}s`)
        void invoke('capture_preview', { path: `/tmp/scrub-${captures}.png` }).catch(() => {})
      }
      if (elapsed > secs * 1000) {
        window.clearInterval(timer)
        sampleCanvas('end')
        void report(true, `storm done; canvas probes → ${samples.join(' ;; ')}`)
      }
      // 30Hz seek rate: still ~3x faster than the pipeline can deliver under
      // seek churn (the user hit 11fps), but leaves the main thread enough
      // slack for WKWebView to service a takeSnapshot mid-storm.
    }, 33)
  } catch (e) {
    void report(false, String(e))
  }
}

export function startMenuBridge() {
  if (!isTauri || started) return
  started = true
  void listen<{ action: string; path?: string }>('menu', (e) => {
    void dispatch(e.payload.action, e.payload.path).catch((err) =>
      console.error(`menu action ${e.payload.action} failed:`, err),
    )
  })
  // Keep the View-menu checkmarks honest when the same toggles flip in-app.
  let lastSafe = useStore.getState().safeZones
  let lastSnap = useStore.getState().snap
  let lastFull = useStore.getState().previewFull
  useStore.subscribe((s) => {
    if (s.safeZones !== lastSafe || s.snap !== lastSnap || s.previewFull !== lastFull) {
      lastSafe = s.safeZones
      lastSnap = s.snap
      lastFull = s.previewFull
      void invoke('sync_view_menu', {
        safeZones: s.safeZones,
        snap: s.snap,
        fullPreview: s.previewFull,
      }).catch(() => {})
    }
  })
}
