import TopBar from './components/TopBar'
import Preview from './components/Preview'
import Timeline from './components/timeline/Timeline'
import './App.css'

function App() {
  return (
    <div className="app-shell">
      <TopBar />
      <main className="workspace">
        <Preview />
      </main>
      <Timeline />
    </div>
  )
}

export default App
