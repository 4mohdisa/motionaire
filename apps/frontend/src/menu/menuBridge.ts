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

export async function dispatch(action: string, path?: string) {
  // dev:* cases are the e2e surface — debug builds only. The DEV guard is
  // statically false in production, so the devCases chunk never ships.
  if (action.startsWith('dev:')) {
    if (import.meta.env.DEV) {
      const { handleDevCase } = await import('./devCases')
      await handleDevCase(action)
    }
    return
  }
  const s = useStore.getState()
  switch (action) {
    case 'file:new': {
      const { guardDirty } = await import('../hooks/unsaved')
      if (!(await guardDirty())) break
      // Passing the guard on an untitled project abandons it deliberately —
      // drop its crash copy so the launcher stops offering it.
      if (!s.projectPath) void invoke('clear_untitled_recovery').catch(() => {})
      s.replaceProject(createProject(), null)
      break
    }
    case 'file:open': {
      const { guardDirty } = await import('../hooks/unsaved')
      if (!(await guardDirty())) break
      await openProject()
      break
    }
    case 'file:open_recent': {
      const { guardDirty } = await import('../hooks/unsaved')
      if (!(await guardDirty())) break
      if (path) await openProjectPath(path)
      break
    }
    case 'file:save':
      await saveProject()
      break
    case 'file:save_as':
      await saveProject(true)
      break
    case 'file:close': {
      const { guardDirty } = await import('../hooks/unsaved')
      if (!(await guardDirty())) break
      if (!s.projectPath) void invoke('clear_untitled_recovery').catch(() => {})
      // Back to the launcher; the editor is a full-window view it replaces.
      s.pause()
      s.replaceProject(createProject(), null)
      s.setAppView('launcher')
      break
    }
    case 'file:import':
      await importMediaNative()
      break
    case 'app:settings':
      s.setDialog('preferences')
      break
    case 'file:project_settings':
      s.setDialog('projectSettings')
      break
    case 'file:consolidate': {
      const { consolidateMedia } = await import('../persistence/projectIO')
      try {
        await consolidateMedia()
      } catch (e) {
        useStore.getState().pushToast('error', `Consolidate failed: ${e}`)
      }
      break
    }
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
