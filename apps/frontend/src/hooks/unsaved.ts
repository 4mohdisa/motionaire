import { useStore } from '../state/store'
import { saveProject } from '../persistence/projectIO'

// Unsaved-changes gate (session 9, Phase 6). guardDirty() opens the 3-way
// prompt (Save / Don't Save / Cancel) and resolves once the user picks.

export type UnsavedChoice = 'save' | 'discard' | 'cancel'

let resolver: ((r: UnsavedChoice) => void) | null = null

export function resolveUnsaved(r: UnsavedChoice) {
  useStore.getState().setUnsavedOpen(false)
  const f = resolver
  resolver = null
  f?.(r)
}

// true = proceed with the destructive action; false = user cancelled.
export async function guardDirty(): Promise<boolean> {
  const s = useStore.getState()
  if (!s.dirty || s.appView !== 'editor') return true
  s.setUnsavedOpen(true)
  const r = await new Promise<UnsavedChoice>((res) => {
    resolver = res
  })
  if (r === 'cancel') return false
  if (r === 'save') return await saveProject()
  return true
}
