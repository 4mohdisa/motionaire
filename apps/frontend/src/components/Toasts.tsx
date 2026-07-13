import { useEffect, useRef } from 'react'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'
import { useStore } from '../state/store'

// Toast stack (foundation session, Phase 0) — bottom-right, non-blocking.
// info/success/error auto-dismiss; progress toasts live until their job
// resolves them.

const AUTO_DISMISS_MS = 4500

function Toast({ id, kind, text, progress }: {
  id: string
  kind: 'info' | 'success' | 'error' | 'progress'
  text: string
  progress?: number
}) {
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => {
    if (kind === 'progress') return
    timer.current = window.setTimeout(
      () => useStore.getState().dismissToast(id),
      kind === 'error' ? AUTO_DISMISS_MS * 2 : AUTO_DISMISS_MS,
    )
    return () => window.clearTimeout(timer.current)
  }, [id, kind])

  const Icon = kind === 'error' ? AlertCircle : kind === 'success' ? CheckCircle2 : Info
  return (
    <div className={`toast toast--${kind}`}>
      <Icon size={14} className="toast__icon" />
      <div className="toast__body">
        <span className="toast__text">{text}</span>
        {kind === 'progress' && (
          <div className="toast__bar">
            <div
              className="toast__fill"
              style={{ width: `${Math.round((progress ?? 0) * 100)}%` }}
            />
          </div>
        )}
      </div>
      <button
        className="toast__close"
        onClick={() => useStore.getState().dismissToast(id)}
        aria-label="Dismiss"
      >
        <X size={12} />
      </button>
    </div>
  )
}

function Toasts() {
  const toasts = useStore((s) => s.toasts)
  if (!toasts.length) return null
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <Toast key={t.id} {...t} />
      ))}
    </div>
  )
}

export default Toasts
