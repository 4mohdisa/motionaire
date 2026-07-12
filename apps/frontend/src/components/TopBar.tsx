import { openImportDialog } from '../media/importMedia'
import { useStore } from '../state/store'

function TopBar() {
  const canUndo = useStore((s) => s.past.length > 0)
  const canRedo = useStore((s) => s.future.length > 0)
  const { undo, redo, addTextClip, setExportOpen } = useStore.getState()

  return (
    <header className="topbar">
      <span className="topbar__brand">Motionaire</span>
      <div className="topbar__actions">
        <button className="topbar__btn" disabled={!canUndo} onClick={undo} title="Undo (⌘Z)">
          ↩
        </button>
        <button className="topbar__btn" disabled={!canRedo} onClick={redo} title="Redo (⇧⌘Z)">
          ↪
        </button>
        <button className="topbar__btn" onClick={() => addTextClip()}>
          + Text
        </button>
        <button className="topbar__btn" onClick={openImportDialog}>
          Import
        </button>
        <button className="topbar__btn topbar__btn--primary" onClick={() => setExportOpen(true)}>
          Export
        </button>
      </div>
    </header>
  )
}

export default TopBar
