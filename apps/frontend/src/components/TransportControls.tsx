import { useStore } from '../state/store'
import { formatTimecode } from '../engine/time'

function TransportControls() {
  const playing = useStore((s) => s.playing)
  const playhead = useStore((s) => s.playhead)
  const duration = useStore((s) => s.project.duration)
  const fps = useStore((s) => s.project.canvas.fps)
  const { togglePlay, frameStep, setPlayhead } = useStore.getState()

  return (
    <div className="transport">
      <span className="transport__time">{formatTimecode(playhead, fps)}</span>
      <div className="transport__buttons">
        <button className="transport__btn" title="Go to start" onClick={() => setPlayhead(0)}>
          ⏮
        </button>
        <button className="transport__btn" title="Previous frame (←)" onClick={() => frameStep(-1)}>
          ◀︎▮
        </button>
        <button
          className="transport__btn transport__btn--play"
          title="Play/pause (space)"
          onClick={togglePlay}
        >
          {playing ? '❚❚' : '▶'}
        </button>
        <button className="transport__btn" title="Next frame (→)" onClick={() => frameStep(1)}>
          ▮▶︎
        </button>
      </div>
      <span className="transport__time transport__time--total">{formatTimecode(duration, fps)}</span>
    </div>
  )
}

export default TransportControls
