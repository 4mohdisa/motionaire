import TopBar from './components/TopBar'
import Preview from './components/Preview'
import PropertiesPanel from './components/PropertiesPanel'
import ExportPanel from './components/ExportPanel'
import Timeline from './components/timeline/Timeline'
import { useEffect } from 'react'
import { useShortcuts } from './hooks/useShortcuts'
import { useStore } from './state/store'
import { startCompositorBridge } from './compositor/bridge'
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

function App() {
  useShortcuts()
  useEffect(() => startCompositorBridge(), [])
  const timelineHeight = useStore((s) => s.timelineHeight)
  const propsWidth = useStore((s) => s.propsWidth)
  const { setTimelineHeight, setPropsWidth } = useStore.getState()

  return (
    <div
      className="app-shell"
      style={{ '--props-width': `${propsWidth}px` } as React.CSSProperties}
    >
      <TopBar />
      <main className="workspace">
        <Preview />
        <Resizer
          direction="col"
          onDrag={(d) => setPropsWidth(useStore.getState().propsWidth - d)}
        />
        <PropertiesPanel />
      </main>
      <Resizer
        direction="row"
        onDrag={(d) => setTimelineHeight(useStore.getState().timelineHeight - d)}
      />
      <div style={{ height: timelineHeight, display: 'flex', flexDirection: 'column' }}>
        <Timeline />
      </div>
      <ExportPanel />
    </div>
  )
}

export default App
