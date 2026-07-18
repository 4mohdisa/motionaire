import { useEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronRight, Undo2 } from 'lucide-react'
import { useStore, type ChatEntry } from '../state/store'
import { sendChat } from '../ai/chatController'

// AI chat panel (Run 1, Phase 4 fills the Phase 1h container).
// Every assistant turn that edited shows its diff as a compact card, tool
// calls collapsed beneath, and an inline "Undo this" wired to plain undo()
// — honest because one prompt = one undo step (Phase 3), and enabled only
// while nothing else has edited since.

const EXAMPLES = [
  'Cut the first 3 seconds',
  'From 0:10 to 0:45 shrink my face to 10%, rounded corners, bottom right, screen share fills the rest, then back to fullscreen.',
  'Add a title that says "Welcome"',
]

export default function ChatPanel() {
  const configured = useStore((s) => s.aiConfigured)
  const log = useStore((s) => s.chatLog)
  const busy = useStore((s) => s.chatBusy)
  const [draft, setDraft] = useState('')
  const scroller = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Follow the stream.
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight })
  }, [log])

  const send = (text: string) => {
    setDraft('')
    void sendChat(text)
  }

  return (
    <aside className="panel chatpanel">
      <div className="panel__title">AI assistant</div>
      <div className="chatpanel__messages" ref={scroller}>
        {log.length === 0 && (
          <div className="chatpanel__empty">
            <p className="chatpanel__emptylead">Edit the timeline in plain English.</p>
            {useStore.getState().project.duration <= 0 && (
              <p className="chatpanel__tip">
                The timeline is empty — import footage first (the AI edits what's there).
              </p>
            )}
            {!configured && (
              <button
                className="topbar__btn"
                onClick={() => useStore.getState().setDialog('preferences')}
              >
                Configure an API key…
              </button>
            )}
            <div className="chatpanel__examples">
              {EXAMPLES.map((ex) => (
                <button
                  key={ex}
                  className="chatpanel__example"
                  disabled={!configured || busy}
                  onClick={() => send(ex)}
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}
        {log.map((e) => (
          <Message key={e.id} entry={e} />
        ))}
      </div>
      <div className="chatpanel__composer">
        <textarea
          className="chatpanel__input selectable"
          placeholder={
            configured ? 'Describe an edit… (⌘↵ to send)' : 'Configure an API key to start'
          }
          disabled={!configured || busy}
          value={draft}
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault()
              send(draft)
            }
            e.stopPropagation()
          }}
        />
        <button
          className="topbar__btn topbar__btn--primary"
          disabled={!configured || busy || !draft.trim()}
          onClick={() => send(draft)}
        >
          {busy ? '…' : 'Send'}
        </button>
      </div>
    </aside>
  )
}

function Message({ entry }: { entry: ChatEntry }) {
  const [toolsOpen, setToolsOpen] = useState(false)
  const past = useStore((s) => s.past.length)
  if (entry.role === 'user') {
    return <div className="chatmsg chatmsg--user">{entry.text}</div>
  }
  const undoable = entry.edited && entry.undoDepth !== undefined && past === entry.undoDepth
  return (
    <div className={`chatmsg chatmsg--assistant${entry.error ? ' chatmsg--error' : ''}`}>
      {entry.text && <div className="chatmsg__text">{entry.text}</div>}
      {entry.streaming && <span className="chatmsg__cursor">▍</span>}
      {entry.error && <div className="chatmsg__errortext">{entry.error}</div>}
      {(entry.diffs?.length ?? 0) > 0 && (
        <div className="chatmsg__diffcard">
          {entry.diffs!.map((d, i) => (
            <div key={i} className="chatmsg__diff">
              {d}
            </div>
          ))}
        </div>
      )}
      {(entry.toolCalls?.length ?? 0) > 0 && (
        <div className="chatmsg__tools">
          <button className="chatmsg__toolstoggle" onClick={() => setToolsOpen(!toolsOpen)}>
            {toolsOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            {entry.toolCalls!.length} tool call{entry.toolCalls!.length > 1 ? 's' : ''}
          </button>
          {toolsOpen &&
            entry.toolCalls!.map((t, i) => (
              <div key={i} className={`chatmsg__tool${t.ok ? '' : ' chatmsg__tool--failed'}`}>
                <code>{t.name}</code> {t.detail ?? ''}
              </div>
            ))}
        </div>
      )}
      {entry.edited && (
        <button
          className="chatmsg__undo"
          disabled={!undoable}
          title={
            undoable
              ? 'Revert everything from this prompt (one undo step)'
              : 'Later edits exist — use ⌘Z to step back through them'
          }
          onClick={() => useStore.getState().undo()}
        >
          <Undo2 size={11} /> Undo this
        </button>
      )}
    </div>
  )
}
