import { useEffect, useState } from 'react'
import { openImportDialog } from '../media/importMedia'
import { useStore } from '../state/store'
import { isTauri, loadPipDemo } from '../compositor/bridge'
import {
  importMediaNative,
  listRecents,
  openProject,
  openProjectPath,
  saveProject,
  type RecentProject,
} from '../persistence/projectIO'

function TopBar() {
  const canUndo = useStore((s) => s.past.length > 0)
  const canRedo = useStore((s) => s.future.length > 0)
  const projectPath = useStore((s) => s.projectPath)
  const { undo, redo, addTextClip, setExportOpen } = useStore.getState()
  const [recents, setRecents] = useState<RecentProject[]>([])

  useEffect(() => {
    if (isTauri) void listRecents().then(setRecents)
  }, [projectPath])

  const projectName = projectPath
    ? (projectPath.split('/').pop() ?? '').replace(/\.motionaire$/, '')
    : 'Untitled'

  return (
    <header className="topbar">
      <span className="topbar__brand">
        Motionaire <span className="topbar__project">— {projectName}</span>
      </span>
      <div className="topbar__actions">
        {isTauri && (
          <>
            <button
              className="topbar__btn"
              title="Load the keyframed PiP compositor demo"
              onClick={() => void loadPipDemo().catch((e) => console.error(e))}
            >
              PiP Demo
            </button>
            {recents.length > 0 && (
              <select
                className="topbar__recents"
                value=""
                title="Recent projects"
                onChange={(e) => {
                  if (e.target.value) void openProjectPath(e.target.value)
                }}
              >
                <option value="">Recent…</option>
                {recents.map((r) => (
                  <option key={r.path} value={r.path}>
                    {r.name}
                  </option>
                ))}
              </select>
            )}
            <button className="topbar__btn" onClick={() => void openProject()}>
              Open
            </button>
            <button
              className="topbar__btn"
              title={projectPath ?? 'Save (choose location)'}
              onClick={() => void saveProject()}
            >
              Save
            </button>
          </>
        )}
        <button className="topbar__btn" disabled={!canUndo} onClick={undo} title="Undo (⌘Z)">
          ↩
        </button>
        <button className="topbar__btn" disabled={!canRedo} onClick={redo} title="Redo (⇧⌘Z)">
          ↪
        </button>
        <button className="topbar__btn" onClick={() => addTextClip()}>
          + Text
        </button>
        <button
          className="topbar__btn"
          onClick={() => (isTauri ? void importMediaNative() : openImportDialog())}
        >
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
