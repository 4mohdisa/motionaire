import TopBar from './components/TopBar'
import TimelineStrip from './components/TimelineStrip'
import './App.css'

function App() {
  return (
    <div className="app-shell">
      <TopBar />
      <main className="workspace">
        <div className="canvas-placeholder" />
      </main>
      <TimelineStrip />
    </div>
  )
}

export default App
