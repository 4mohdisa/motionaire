import { FileOutput, Import, Redo2, Type, Undo2 } from 'lucide-react'
import { openImportDialog } from '../media/importMedia'
import { useStore } from '../state/store'
import { isTauri } from '../compositor/bridge'
import { importMediaNative } from '../persistence/projectIO'
import IconBtn from './IconBtn'

// Slim editing toolbar. File-level actions (New/Open/Recents/Save) live in the
// native macOS menu bar; only constantly-used editing actions stay visible.

function TopBar() {
  const canUndo = useStore((s) => s.past.length > 0)
  const canRedo = useStore((s) => s.future.length > 0)
  const projectPath = useStore((s) => s.projectPath)
  const { undo, redo, addTextClip, setExportOpen } = useStore.getState()

  const projectName = projectPath
    ? (projectPath.split('/').pop() ?? '').replace(/\.motionaire$/, '')
    : 'Untitled'

  return (
    <header className="topbar">
      <span className="topbar__brand">
        Motionaire <span className="topbar__project">— {projectName}</span>
      </span>
      <div className="topbar__actions">
        <IconBtn icon={Undo2} label="Undo (⌘Z)" disabled={!canUndo} onClick={undo} tipBelow />
        <IconBtn icon={Redo2} label="Redo (⇧⌘Z)" disabled={!canRedo} onClick={redo} tipBelow />
        <span className="topbar__sep" />
        <IconBtn icon={Type} label="Add text" onClick={() => addTextClip()} tipBelow />
        <IconBtn
          icon={Import}
          label="Import media (⌘I)"
          onClick={() => (isTauri ? void importMediaNative() : openImportDialog())}
          tipBelow
        />
        <IconBtn
          icon={FileOutput}
          label="Export…"
          primary
          onClick={() => setExportOpen(true)}
          tipBelow
        />
      </div>
    </header>
  )
}

export default TopBar
