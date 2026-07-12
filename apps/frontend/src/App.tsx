import TopBar from './components/TopBar'
import Preview from './components/Preview'
import TimelineStrip from './components/TimelineStrip'
import './App.css'

function App() {
  return (
    <div className="app-shell">
      <TopBar />
      <main className="workspace">
        <Preview />
      </main>
      <TimelineStrip />
    </div>
  )
}

export default App
