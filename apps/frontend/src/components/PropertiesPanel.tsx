import { useState } from 'react'
import { useStore } from '../state/store'
import { findClip, snapToFrame } from '../engine/time'
import { keyframesFor, resolveProp } from '../engine/keyframes'
import type { Clip, Ease, TextAnimationPreset, TransitionType } from '../types/project'

const EASES: Ease[] = ['linear', 'easeIn', 'easeOut', 'easeInOut', 'spring']
const TRANSITION_TYPES: TransitionType[] = ['cut', 'dissolve', 'fade', 'slide', 'wipe']
const TEXT_PRESETS: TextAnimationPreset[] = ['none', 'fade', 'fadeUp', 'popIn', 'slideLeft']
const FONTS = ['Inter', 'system-ui', 'Helvetica Neue', 'Georgia', 'Courier New']

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
      <div className="props__clipname">
        {clip.kind === 'text' ? 'Text' : (asset?.name ?? clip.kind)}
      </div>

      {clip.kind === 'text' && (
        <>
          <Section label="Text">
            <TextEditor clip={clip} />
          </Section>
          <Section label="Animation">
            <AnimationEditor clip={clip} />
          </Section>
        </>
      )}

      <Section label="Transform">
        <NumberRow clip={clip} prop="transform.x" label="X" step={1} />
        <NumberRow clip={clip} prop="transform.y" label="Y" step={1} />
        <NumberRow clip={clip} prop="transform.scale" label="Scale" step={0.01} min={0} />
        <NumberRow clip={clip} prop="transform.rotation" label="Rotation" step={1} />
        <NumberRow
          clip={clip}
          prop="transform.opacity"
          label="Opacity"
          step={0.01}
          min={0}
          max={1}
        />
        <NumberRow clip={clip} prop="transform.cornerRadius" label="Radius" step={1} min={0} />
      </Section>

      {clip.kind === 'video' && (
        <Section label="Crop">
          <CropEditor clip={clip} />
        </Section>
      )}

      <Section label="Shadow">
        <ShadowEditor clip={clip} />
      </Section>

      {clip.mediaId && (
        <Section label="Playback">
          <SpeedRow clip={clip} />
          {(clip.kind === 'audio' ||
            (asset?.hasAudio && clip.volume > 0) ||
            clip.kind === 'video') && (
            <NumberRow clip={clip} prop="volume" label="Volume" step={0.01} min={0} max={1.5} />
          )}
        </Section>
      )}

      {clip.kind !== 'audio' && (
        <Section label="Transitions">
          <TransitionRow clip={clip} edge="in" />
          <TransitionRow clip={clip} edge="out" />
        </Section>
      )}
    </div>
  )
}

function TransitionRow({ clip, edge }: { clip: Clip; edge: 'in' | 'out' }) {
  const { setTransition } = useStore.getState()
  const tr = clip.transitions[edge]
  return (
    <div className="prow">
      <span className="prow__label">{edge === 'in' ? 'In' : 'Out'}</span>
      <select
        className="prow__ease prow__ease--wide"
        value={tr?.type ?? 'cut'}
        onChange={(e) => {
          const type = e.target.value as TransitionType
          setTransition(
            clip.id,
            edge,
            type === 'cut' ? null : { type, duration: tr?.duration ?? 0.5 },
          )
        }}
      >
        {TRANSITION_TYPES.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>
      {tr && (
        <input
          className="prow__input prow__input--narrow"
          type="number"
          step={0.1}
          min={0.1}
          max={3}
          value={tr.duration}
          onChange={(e) => {
            const d = Number(e.target.value)
            if (Number.isFinite(d) && d > 0) setTransition(clip.id, edge, { ...tr, duration: d })
          }}
          title="Duration (s)"
        />
      )}
    </div>
  )
}

function TextEditor({ clip }: { clip: Clip }) {
  const { updateTextClip } = useStore.getState()
  const st = clip.text
  if (!st) return null
  return (
    <>
      <textarea
        className="props__textarea"
        rows={2}
        value={st.content}
        onChange={(e) => updateTextClip(clip.id, { content: e.target.value })}
      />
      <div className="prow">
        <span className="prow__label">Font</span>
        <select
          className="prow__ease prow__ease--wide"
          value={st.font}
          onChange={(e) => updateTextClip(clip.id, { style: { font: e.target.value } })}
        >
          {FONTS.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </select>
      </div>
      <div className="prow">
        <span className="prow__label">Size</span>
        <input
          className="prow__input"
          type="number"
          min={8}
          max={400}
          value={st.size}
          onChange={(e) =>
            updateTextClip(clip.id, { style: { size: Number(e.target.value) || 64 } })
          }
        />
        <select
          className="prow__ease"
          value={st.weight}
          onChange={(e) => updateTextClip(clip.id, { style: { weight: Number(e.target.value) } })}
          title="Weight"
        >
          {[400, 500, 600, 700, 800].map((w) => (
            <option key={w} value={w}>
              {w}
            </option>
          ))}
        </select>
      </div>
      <div className="prow">
        <span className="prow__label">Color</span>
        <input
          className="prow__color"
          type="color"
          value={st.color}
          onChange={(e) => updateTextClip(clip.id, { style: { color: e.target.value } })}
        />
        <div className="props__align">
          {(['left', 'center', 'right'] as const).map((a) => (
            <button
              key={a}
              className={`tl__btn${st.align === a ? ' tl__btn--on' : ''}`}
              onClick={() => updateTextClip(clip.id, { style: { align: a } })}
            >
              {a === 'left' ? '⇤' : a === 'center' ? '↔' : '⇥'}
            </button>
          ))}
        </div>
      </div>
    </>
  )
}

function AnimationEditor({ clip }: { clip: Clip }) {
  const { updateTextClip } = useStore.getState()
  const anim = clip.animation ?? { in: 'none', out: 'none', duration: 0.3 }
  return (
    <>
      {(['in', 'out'] as const).map((edge) => (
        <div className="prow" key={edge}>
          <span className="prow__label">{edge === 'in' ? 'In' : 'Out'}</span>
          <select
            className="prow__ease prow__ease--wide"
            value={anim[edge]}
            onChange={(e) =>
              updateTextClip(clip.id, {
                animation: { [edge]: e.target.value as TextAnimationPreset },
              })
            }
          >
            {TEXT_PRESETS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>
      ))}
      <div className="prow">
        <span className="prow__label">Duration</span>
        <input
          className="prow__input"
          type="number"
          step={0.1}
          min={0.1}
          max={2}
          value={anim.duration}
          onChange={(e) => {
            const d = Number(e.target.value)
            if (Number.isFinite(d) && d > 0) updateTextClip(clip.id, { animation: { duration: d } })
          }}
        />
      </div>
    </>
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
      dir === 1
        ? kfs.find((k) => k.t > rel + 1e-6)
        : [...kfs].reverse().find((k) => k.t < rel - 1e-6)
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

// Crop stored as fractions per CONTEXT.md §1.2 shape, edited as percent.
function CropEditor({ clip }: { clip: Clip }) {
  const { setClipProperty } = useStore.getState()
  const crop = clip.transform.crop
  const edge = (key: 'l' | 't' | 'r' | 'b', label: string) => (
    <div className="prow" key={key}>
      <span className="prow__label">{label}</span>
      <input
        className="prow__input"
        type="number"
        min={0}
        max={45}
        step={1}
        value={Math.round(crop[key] * 100)}
        onChange={(e) => {
          const pct = Math.min(45, Math.max(0, Number(e.target.value) || 0))
          setClipProperty(clip.id, 'transform.crop', { ...crop, [key]: pct / 100 })
        }}
      />
      <span className="prow__unit">%</span>
    </div>
  )
  return (
    <>
      {edge('l', 'Left')}
      {edge('t', 'Top')}
      {edge('r', 'Right')}
      {edge('b', 'Bottom')}
    </>
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
