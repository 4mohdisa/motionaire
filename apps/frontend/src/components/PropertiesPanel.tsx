import { useState } from 'react'
import { useStore } from '../state/store'
import { findClip, snapToFrame } from '../engine/time'
import { keyframesFor, resolveProp } from '../engine/keyframes'
import type { Clip, Ease } from '../types/project'

const EASES: Ease[] = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'spring']

function PropertiesPanel() {
  const selection = useStore((s) => s.selection)
  const project = useStore((s) => s.project)
  const clipId = selection.length === 1 ? selection[0] : null
  const found = clipId ? findClip(project, clipId) : null

  return (
    <aside className="props">
      <div className="props__title">Properties</div>
      {!found ? (
        <div className="props__empty">
          {selection.length > 1 ? `${selection.length} clips selected` : 'No clip selected'}
        </div>
      ) : (
        <ClipProperties clip={found.clip} />
      )}
    </aside>
  )
}

function ClipProperties({ clip }: { clip: Clip }) {
  const asset = useStore((s) => s.project.media.find((m) => m.id === clip.mediaId))

  return (
    <div className="props__body">
      <div className="props__clipname">{clip.kind === 'text' ? 'Text' : (asset?.name ?? clip.kind)}</div>

      <Section label="Transform">
        <NumberRow clip={clip} prop="transform.x" label="X" step={1} />
        <NumberRow clip={clip} prop="transform.y" label="Y" step={1} />
        <NumberRow clip={clip} prop="transform.scale" label="Scale" step={0.01} min={0} />
        <NumberRow clip={clip} prop="transform.rotation" label="Rotation" step={1} />
        <NumberRow clip={clip} prop="transform.opacity" label="Opacity" step={0.01} min={0} max={1} />
        <NumberRow clip={clip} prop="transform.cornerRadius" label="Radius" step={1} min={0} />
      </Section>

      <Section label="Shadow">
        <ShadowEditor clip={clip} />
      </Section>

      {clip.mediaId && (
        <Section label="Playback">
          <SpeedRow clip={clip} />
          {(clip.kind === 'audio' || (asset?.hasAudio && clip.volume > 0) || clip.kind === 'video') && (
            <NumberRow clip={clip} prop="volume" label="Volume" step={0.01} min={0} max={1.5} />
          )}
        </Section>
      )}
    </div>
  )
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="props__section">
      <div className="props__section-label">{label}</div>
      {children}
    </div>
  )
}

// Numeric input + stopwatch diamond + keyframe nav + easing (when on a keyframe).
function NumberRow({
  clip,
  prop,
  label,
  step,
  min,
  max,
}: {
  clip: Clip
  prop: string
  label: string
  step: number
  min?: number
  max?: number
}) {
  const playhead = useStore((s) => s.playhead)
  const fps = useStore((s) => s.project.canvas.fps)
  const { setClipProperty, toggleKeyframe, setKeyframeEase, setPlayhead } = useStore.getState()

  const kfs = keyframesFor(clip, prop)
  const armed = kfs.length > 0
  const rel = snapToFrame(playhead - clip.start, fps)
  const onKey = kfs.find((k) => Math.abs(k.t - rel) < 1 / fps / 2)

  // The displayed value tracks the resolved value at the playhead when armed.
  const value = armed ? resolveProp(clip, prop, rel) : (staticDisplay(clip, prop) ?? 0)
  const [draft, setDraft] = useState(String(round3(value)))
  const [synced, setSynced] = useState(value)
  if (value !== synced) {
    // External value changed (playhead moved, undo, …) — resync the draft.
    setSynced(value)
    setDraft(String(round3(value)))
  }

  const commit = () => {
    const n = Number(draft)
    if (!Number.isFinite(n)) {
      setDraft(String(round3(value)))
      return
    }
    const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n))
    setClipProperty(clip.id, prop, clamped)
  }

  const jump = (dir: -1 | 1) => {
    const next =
      dir === 1 ? kfs.find((k) => k.t > rel + 1e-6) : [...kfs].reverse().find((k) => k.t < rel - 1e-6)
    if (next) setPlayhead(clip.start + next.t)
  }

  return (
    <div className="prow">
      <span className="prow__label">{label}</span>
      <input
        className="prow__input"
        type="number"
        step={step}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
      />
      {onKey && (
        <select
          className="prow__ease"
          value={onKey.ease}
          onChange={(e) => setKeyframeEase(clip.id, prop, onKey.t, e.target.value as Ease)}
          title="Keyframe easing"
        >
          {EASES.map((ez) => (
            <option key={ez} value={ez}>
              {ez}
            </option>
          ))}
        </select>
      )}
      <button
        className="prow__nav"
        disabled={!armed || !kfs.some((k) => k.t < rel - 1e-6)}
        onClick={() => jump(-1)}
        title="Previous keyframe"
      >
        ‹
      </button>
      <button
        className={`prow__kf${armed ? ' prow__kf--armed' : ''}${onKey ? ' prow__kf--on' : ''}`}
        onClick={() => toggleKeyframe(clip.id, prop)}
        title={onKey ? 'Remove keyframe here' : 'Add keyframe at playhead'}
      >
        ◆
      </button>
      <button
        className="prow__nav"
        disabled={!armed || !kfs.some((k) => k.t > rel + 1e-6)}
        onClick={() => jump(1)}
        title="Next keyframe"
      >
        ›
      </button>
    </div>
  )
}

function SpeedRow({ clip }: { clip: Clip }) {
  const { setClipProperty } = useStore.getState()
  const [draft, setDraft] = useState(String(clip.speed))
  const [synced, setSynced] = useState(clip.speed)
  if (clip.speed !== synced) {
    setSynced(clip.speed)
    setDraft(String(clip.speed))
  }
  return (
    <div className="prow">
      <span className="prow__label">Speed</span>
      <input
        className="prow__input"
        type="number"
        step={0.25}
        min={0.25}
        max={4}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const n = Number(draft)
          if (Number.isFinite(n) && n > 0) setClipProperty(clip.id, 'speed', n)
          else setDraft(String(clip.speed))
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
      />
      <span className="prow__unit">×</span>
    </div>
  )
}

function ShadowEditor({ clip }: { clip: Clip }) {
  const { setClipProperty } = useStore.getState()
  const shadow = clip.transform.shadow
  if (!shadow)
    return (
      <button
        className="props__addbtn"
        onClick={() =>
          setClipProperty(clip.id, 'transform.shadow', {
            blur: 24,
            spread: 0,
            color: '#000000',
            x: 0,
            y: 8,
          })
        }
      >
        + Add shadow
      </button>
    )

  const patch = (key: string, v: number | string) =>
    setClipProperty(clip.id, 'transform.shadow', { ...shadow, [key]: v })

  return (
    <>
      {(['blur', 'spread', 'x', 'y'] as const).map((k) => (
        <div className="prow" key={k}>
          <span className="prow__label">{k[0].toUpperCase() + k.slice(1)}</span>
          <input
            className="prow__input"
            type="number"
            value={shadow[k]}
            onChange={(e) => patch(k, Number(e.target.value) || 0)}
          />
        </div>
      ))}
      <div className="prow">
        <span className="prow__label">Color</span>
        <input
          className="prow__color"
          type="color"
          value={shadow.color}
          onChange={(e) => patch('color', e.target.value)}
        />
        <button
          className="props__addbtn"
          onClick={() => setClipProperty(clip.id, 'transform.shadow', null)}
        >
          Remove
        </button>
      </div>
    </>
  )
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

function staticDisplay(clip: Clip, prop: string): number | undefined {
  if (prop === 'volume') return clip.volume
  if (prop.startsWith('transform.')) {
    const v = (clip.transform as unknown as Record<string, unknown>)[prop.slice(10)]
    return typeof v === 'number' ? v : undefined
  }
  return undefined
}

export default PropertiesPanel
