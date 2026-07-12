import { useEffect } from 'react'
import { useStore } from '../state/store'

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
      const mod = e.metaKey || e.ctrlKey

      if (mod && e.key.toLowerCase() === 'z') {
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
    return () => window.removeEventListener('keydown', onKey)
  }, [])
}
