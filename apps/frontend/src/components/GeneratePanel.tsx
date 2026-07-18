import { useState } from 'react'
import { useStore } from '../state/store'
import { startGeneration } from '../persistence/genManager'

// Generate-video dialog (Run 1, Phase 6). COST HONESTY: generation spends
// the user's API credits per call — the submit button says so and the
// notice spells it out. Never a silent expensive call.
export default function GeneratePanel() {
  const prefs = useStore((s) => s.prefs)
  const lastPrompt = useStore((s) => s.lastGenPrompt)
  const canvas = useStore((s) => s.project.canvas)
  const { setDialog } = useStore.getState()
  const [prompt, setPrompt] = useState(lastPrompt ?? '')
  const [duration, setDuration] = useState(5)
  const defaultAspect =
    canvas.width === canvas.height ? '1:1' : canvas.width < canvas.height ? '9:16' : '16:9'
  const [aspect, setAspect] = useState(defaultAspect)

  const provider = prefs.aiVideoProvider
  const offline = provider === 'none'

  return (
    <div className="modal" onPointerDown={() => setDialog(null)}>
      <div className="modal__panel" onPointerDown={(e) => e.stopPropagation()}>
        <div className="modal__title">Generate video</div>
        <div className="modal__field modal__field--wide">
          Prompt
          <textarea
            className="chatpanel__input selectable"
            rows={3}
            autoFocus
            value={prompt}
            placeholder="A sunrise over mountains, slow aerial drift…"
            onChange={(e) => setPrompt(e.target.value)}
          />
        </div>
        <div className="modal__grid">
          <label className="modal__field">
            <span>Duration</span>
            <select value={duration} onChange={(e) => setDuration(Number(e.target.value))}>
              {[4, 5, 6, 8, 10].map((d) => (
                <option key={d} value={d}>
                  {d}s
                </option>
              ))}
            </select>
          </label>
          <label className="modal__field">
            <span>Aspect</span>
            <select value={aspect} onChange={(e) => setAspect(e.target.value)}>
              {['16:9', '9:16', '1:1'].map((a) => (
                <option key={a} value={a}>
                  {a}
                  {a === defaultAspect ? ' (canvas)' : ''}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="modal__notice">
          {offline
            ? 'No video provider configured — this uses the offline mock generator. Pick Seedance or Google in Settings for real generation.'
            : `Runs on ${provider === 'seedance' ? 'Seedance' : 'Google Veo'} with YOUR API key — each generation uses your API credits. The clip lands in the media bin when ready (minutes, not seconds); keep editing meanwhile.`}
        </div>
        <div className="modal__actions">
          <button className="topbar__btn" onClick={() => setDialog(null)}>
            Cancel
          </button>
          <button
            className="topbar__btn topbar__btn--primary"
            disabled={!prompt.trim()}
            onClick={() => {
              useStore.getState().setLastGenPrompt(prompt)
              void startGeneration({ prompt, durationSecs: duration, aspect })
              setDialog(null)
            }}
          >
            {offline ? 'Generate (offline mock)' : 'Generate — uses API credits'}
          </button>
        </div>
      </div>
    </div>
  )
}
