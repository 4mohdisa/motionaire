import TopBar from './components/TopBar'
import Preview from './components/Preview'
import PropertiesPanel from './components/PropertiesPanel'
import ExportPanel from './components/ExportPanel'
import Timeline from './components/timeline/Timeline'
import './App.css'

function App() {
  return (
    <div className="app-shell">
      <TopBar />
      <main className="workspace">
        <Preview />
        <PropertiesPanel />
      </main>
      <Timeline />
      <ExportPanel />
    </div>
  )
}

export default App
