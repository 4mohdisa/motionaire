import { Pause, Play, SkipBack, StepBack, StepForward } from 'lucide-react'
import { useStore } from '../state/store'
import { formatTimecode } from '../engine/time'
import IconBtn from './IconBtn'

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
        <IconBtn icon={SkipBack} label="Go to start (Home)" onClick={() => setPlayhead(0)} />
        <IconBtn icon={StepBack} label="Previous frame (←)" onClick={() => frameStep(-1)} />
        <IconBtn
          icon={playing ? Pause : Play}
          label={playing ? 'Pause (Space)' : 'Play (Space)'}
          onClick={togglePlay}
        />
        <IconBtn icon={StepForward} label="Next frame (→)" onClick={() => frameStep(1)} />
      </div>
      <span className="transport__time transport__time--total">
        {formatTimecode(duration, fps)}
      </span>
    </div>
  )
}

export default TransportControls
