import { useStore } from '../state/store'

// AI chat panel container (Run 1, Phase 1h). Built now so the chat UI is
// not restyled twice: header, scrollable message area, composer. Phase 4
// wires the conversation; until then it shows the empty state.
export default function ChatPanel() {
  const configured = useStore((s) => s.aiConfigured)
  return (
    <aside className="panel chatpanel">
      <div className="panel__title">AI assistant</div>
      <div className="chatpanel__messages">
        <div className="chatpanel__empty">
          <p className="chatpanel__emptylead">Edit the timeline in plain English.</p>
          {!configured && (
            <button
              className="topbar__btn"
              onClick={() => useStore.getState().setDialog('preferences')}
            >
              Configure an API key…
            </button>
          )}
          <div className="chatpanel__examples">
            {[
              'Cut the first 3 seconds',
              'Shrink the webcam to a corner from 0:10 to 0:45',
              'Add a title that says Welcome',
            ].map((ex) => (
              <div key={ex} className="chatpanel__example">
                {ex}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="chatpanel__composer">
        <textarea
          className="chatpanel__input"
          placeholder={configured ? 'Describe an edit… (⌘↵ to send)' : 'Configure an API key to start'}
          disabled
          rows={2}
        />
        <button className="topbar__btn topbar__btn--primary" disabled>
          Send
        </button>
      </div>
    </aside>
  )
}
