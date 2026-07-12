import { openImportDialog } from '../media/importMedia'
import { useStore } from '../state/store'

function TopBar() {
  return (
    <header className="topbar">
      <span className="topbar__brand">Motionaire</span>
      <div className="topbar__actions">
        <button className="topbar__btn" onClick={() => useStore.getState().addTextClip()}>
          + Text
        </button>
        <button className="topbar__btn" onClick={openImportDialog}>
          Import
        </button>
      </div>
    </header>
  )
}

export default TopBar
