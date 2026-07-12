import TopBar from './components/TopBar'
import Preview from './components/Preview'
import PropertiesPanel from './components/PropertiesPanel'
import ExportPanel from './components/ExportPanel'
import Timeline from './components/timeline/Timeline'
import { useEffect } from 'react'
import { useShortcuts } from './hooks/useShortcuts'
import { useStore } from './state/store'
import { startCompositorBridge } from './compositor/bridge'
import { startMenuBridge } from './menu/menuBridge'
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

// Vertical space the preview column needs beside the timeline:
// topbar 48 + transport 40 + preview floor 140 + padding/resizer ~42.
const NON_TIMELINE_MIN = 270

function App() {
  useShortcuts()
  useEffect(() => {
    startCompositorBridge()
    startMenuBridge()
  }, [])
  // Panel sizes are user-dragged absolutes; re-clamp them when the window
  // shrinks so the preview always keeps its floor (Part 1, session 6).
  useEffect(() => {
    const clamp = () => {
      const s = useStore.getState()
      const maxTl = Math.max(140, window.innerHeight - NON_TIMELINE_MIN)
      if (s.timelineHeight > maxTl) s.setTimelineHeight(maxTl)
      const maxProps = Math.max(220, window.innerWidth - 400)
      if (s.propsWidth > maxProps) s.setPropsWidth(maxProps)
    }
    clamp()
    window.addEventListener('resize', clamp)
    return () => window.removeEventListener('resize', clamp)
  }, [])
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
          onDrag={(d) =>
            setPropsWidth(Math.min(useStore.getState().propsWidth - d, window.innerWidth - 400))
          }
        />
        <PropertiesPanel />
      </main>
      <Resizer
        direction="row"
        onDrag={(d) =>
          setTimelineHeight(
            Math.min(useStore.getState().timelineHeight - d, window.innerHeight - NON_TIMELINE_MIN),
          )
        }
      />
      <div style={{ height: timelineHeight, display: 'flex', flexDirection: 'column' }}>
        <Timeline />
      </div>
      <ExportPanel />
    </div>
  )
}

export default App
