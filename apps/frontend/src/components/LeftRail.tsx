import { Film, Sparkles, MessageSquare, SlidersVertical } from 'lucide-react'
import { useStore, type LeftPanel } from '../state/store'

// Far-left icon rail (Run 1, Phase 1f): switches the left panel between
// media, effects, AI chat, and the audio mixer. Clicking the active icon
// collapses the panel entirely.
const ITEMS: { id: LeftPanel; icon: typeof Film; label: string }[] = [
  { id: 'media', icon: Film, label: 'Media' },
  { id: 'effects', icon: Sparkles, label: 'Effects' },
  { id: 'chat', icon: MessageSquare, label: 'AI assistant' },
  { id: 'mixer', icon: SlidersVertical, label: 'Audio mixer' },
]

export default function LeftRail() {
  const leftPanel = useStore((s) => s.leftPanel)
  const setLeftPanel = useStore.getState().setLeftPanel
  return (
    <nav className="rail">
      {ITEMS.map(({ id, icon: Icon, label }) => (
        <button
          key={id}
          className={`rail__btn${leftPanel === id ? ' rail__btn--on' : ''}`}
          title={label}
          onClick={() => setLeftPanel(leftPanel === id ? null : id)}
        >
          <Icon size={17} />
        </button>
      ))}
    </nav>
  )
}
