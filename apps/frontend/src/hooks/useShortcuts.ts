import { useEffect } from 'react'
import { useStore } from '../state/store'
import { isTauri } from '../compositor/bridge'

const SHUTTLE_CAP = 8

function isTyping(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement
  return (
    t instanceof HTMLInputElement ||
    t instanceof HTMLTextAreaElement ||
    t instanceof HTMLSelectElement ||
    t.isContentEditable
  )
}

export function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e)) return
      const s = useStore.getState()
      if (s.appView !== 'editor') return // launcher/gate: no editing keys
      const mod = e.metaKey || e.ctrlKey

      if (mod && e.key.toLowerCase() === 'z') {
        // In Tauri the native Edit-menu accelerator owns Cmd+Z/Cmd+Shift+Z;
        // handling it here too would double-fire every undo.
        if (isTauri) return
        e.preventDefault()
        if (e.shiftKey) s.redo()
        else s.undo()
        return
      }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        for (const id of s.selection) s.duplicateClip(id)
        return
      }
      if (mod) return

      switch (e.key) {
        case ' ':
          e.preventDefault()
          s.togglePlay()
          break
        case 'j':
        case 'J':
          s.setShuttle(s.playing && s.shuttle < 0 ? Math.max(-SHUTTLE_CAP, s.shuttle * 2) : -1)
          break
        case 'k':
        case 'K':
          s.pause()
          break
        case 'l':
        case 'L':
          s.setShuttle(s.playing && s.shuttle > 0 ? Math.min(SHUTTLE_CAP, s.shuttle * 2) : 1)
          break
        case 's':
        case 'S':
          s.splitAtPlayhead()
          break
        case 'm':
        case 'M':
          s.addMarkerAtPlayhead()
          break
        // Timeline mark in/out (foundation, Phase 2); ⌥ clears (Premiere).
        case 'i':
        case 'I':
          if (e.altKey) s.setMarkIn(null)
          else s.setMarkIn(s.playhead)
          break
        case 'o':
        case 'O':
          if (e.altKey) s.setMarkOut(null)
          else s.setMarkOut(s.playhead)
          break
        // Nudge selection by frame — comma/period, the classic NLE keys
        // (arrows stay on the playhead per standard transport behavior).
        case ',':
          s.nudgeSelection(e.shiftKey ? -5 : -1)
          break
        case '.':
          s.nudgeSelection(e.shiftKey ? 5 : 1)
          break
        case 'ArrowLeft':
          e.preventDefault()
          s.frameStep(e.shiftKey ? -10 : -1)
          break
        case 'ArrowRight':
          e.preventDefault()
          s.frameStep(e.shiftKey ? 10 : 1)
          break
        case 'Home':
          s.setPlayhead(0)
          break
        case 'End':
          s.setPlayhead(s.project.duration)
          break
        case 'Backspace':
        case 'Delete':
          if (s.selection.length) {
            e.preventDefault()
            if (e.shiftKey) s.rippleDeleteClips(s.selection)
            else s.deleteClips(s.selection)
          }
          break
        case '=':
        case '+':
          s.setPxPerSec(s.pxPerSec * 1.5)
          break
        case '-':
          s.setPxPerSec(s.pxPerSec / 1.5)
          break
        case 'Escape':
          s.select([])
          break
      }
    }
    window.addEventListener('keydown', onKey)
    // Clip clipboard (session 9, Phase 6): the native Edit-menu cut/copy/paste
    // stay Predefined (text fields keep real system clipboard); outside text
    // WebKit forwards them to the DOM as ClipboardEvents, which we claim for
    // clips. Context-menu entries cover the same ops regardless.
    const onClip = (e: ClipboardEvent) => {
      const t = e.target as HTMLElement
      const typing =
        t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t?.isContentEditable
      const s = useStore.getState()
      if (typing || s.appView !== 'editor') return
      if (e.type === 'copy' && s.selection.length) {
        e.preventDefault()
        s.copyClips(s.selection)
      } else if (e.type === 'cut' && s.selection.length) {
        e.preventDefault()
        s.cutClips(s.selection)
      } else if (e.type === 'paste' && s.clipboard.length) {
        e.preventDefault()
        s.pasteAtPlayhead()
      }
    }
    document.addEventListener('copy', onClip)
    document.addEventListener('cut', onClip)
    document.addEventListener('paste', onClip)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('copy', onClip)
      document.removeEventListener('cut', onClip)
      document.removeEventListener('paste', onClip)
    }
  }, [])
}
