import { useState } from 'react'
import { AlignCenter, AlignLeft, AlignRight } from 'lucide-react'
import { useStore } from '../state/store'
import IconBtn from './IconBtn'
import { findClip, snapToFrame } from '../engine/time'
import { keyframesFor, resolveProp } from '../engine/keyframes'
import { customFamilies } from '../persistence/fontManager'
import type { Clip, Ease, Effect, EffectType, TextAnimationPreset, TransitionType } from '../types/project'
import { EFFECT_LABELS } from '../engine/effectStack'
import { isAudioFx } from '../engine/audioFx'
import { Popover } from './Popover'
import { invoke } from '@tauri-apps/api/core'

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

      {clip.shape && (
        <Section label="Shape">
          <ShapeEditor clip={clip} />
        </Section>
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

      {clip.kind !== 'text' && (
        <Section label="Effects">
          <FxEditor clip={clip} />
        </Section>
      )}

      {clip.mediaId && (
        <Section label="Playback">
          {/* Keyframeable (session 9, Phase 7): armed = speed RAMP remapping
              time inside the clip's fixed window; audio goes video-only. */}
          <NumberRow clip={clip} prop="speed" label="Speed" step={0.05} min={0.0625} max={16} />
          {(clip.kind === 'audio' ||
            (asset?.hasAudio && clip.volume > 0) ||
            clip.kind === 'video') && (
            <>
              <NumberRow clip={clip} prop="volume" label="Volume" step={0.01} min={0} max={1.5} />
              <div className="prow">
                <span className="prow__label">Pan</span>
                <input
                  className="prow__input selectable"
                  type="range"
                  min={-1}
                  max={1}
                  step={0.05}
                  value={clip.pan ?? 0}
                  onChange={(e) =>
                    useStore.getState().setClipProperty(clip.id, 'pan', Number(e.target.value))
                  }
                  title={`Pan ${((clip.pan ?? 0) * 100).toFixed(0)}%`}
                />
                <span className="prow__unit">{(clip.pan ?? 0) < 0 ? 'L' : (clip.pan ?? 0) > 0 ? 'R' : 'C'}</span>
              </div>
            </>
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

// Effect stack (pro-editor session, Phase 2): ordered cards — reorder,
// toggle, duplicate, remove; same type twice is legal. Scalar params ride
// NumberRow with fx.<id>.<param> props → keyframeable through the existing
// stopwatch. Blend stays a clip property (composite behavior, not a step).
function FxEditor({ clip }: { clip: Clip }) {
  const s = useStore.getState()
  const [addAnchor, setAddAnchor] = useState<DOMRect | null>(null)
  const effects = clip.effects
  return (
    <>
      <div className="prow">
        <span className="prow__label">Blend</span>
        <select
          className="prow__ease prow__ease--wide"
          value={clip.blend ?? 'normal'}
          onChange={(e) => s.setClipBlend(clip.id, e.target.value as Clip['blend'])}
        >
          {['normal', 'multiply', 'screen', 'add'].map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </div>

      {effects.map((fx, i) => (
        <div key={fx.id} className={`fxcard${fx.enabled ? '' : ' fxcard--off'}`}>
          <div className="fxcard__head">
            <button
              className="fxcard__btn"
              disabled={i === 0}
              onClick={() => s.moveEffect(clip.id, fx.id, -1)}
              title="Move up (applied earlier)"
            >
              ▲
            </button>
            <button
              className="fxcard__btn"
              disabled={i === effects.length - 1}
              onClick={() => s.moveEffect(clip.id, fx.id, 1)}
              title="Move down (applied later)"
            >
              ▼
            </button>
            <span className="fxcard__label">{EFFECT_LABELS[fx.type]}</span>
            <input
              type="checkbox"
              checked={fx.enabled}
              onChange={() => s.toggleEffect(clip.id, fx.id)}
              title="Enable/disable"
            />
            <button
              className="fxcard__btn"
              onClick={() => s.duplicateEffect(clip.id, fx.id)}
              title="Duplicate"
            >
              ⧉
            </button>
            <button
              className="fxcard__btn"
              onClick={() => s.removeEffect(clip.id, fx.id)}
              title="Remove"
            >
              ×
            </button>
          </div>
          <FxParams clip={clip} fx={fx} />
        </div>
      ))}

      <div className="prow">
        <button
          className="topbar__btn"
          onPointerDown={(e) => setAddAnchor((e.currentTarget as HTMLElement).getBoundingClientRect())}
        >
          + Add effect
        </button>
        {addAnchor && (
          <Popover anchorRect={addAnchor} onClose={() => setAddAnchor(null)}>
            {(Object.keys(EFFECT_LABELS) as EffectType[])
              .filter((t) =>
                clip.kind === 'audio' ? isAudioFx(t) : !isAudioFx(t),
              )
              .map((t) => (
              <button
                key={t}
                className="menu__item"
                onClick={() => {
                  s.addEffect(clip.id, t)
                  setAddAnchor(null)
                }}
              >
                {EFFECT_LABELS[t]}
              </button>
              ))}
          </Popover>
        )}
        <FxPresets clip={clip} />
      </div>
    </>
  )
}

function FxParams({ clip, fx }: { clip: Clip; fx: Effect }) {
  const s = useStore.getState()
  const p = (name: string) => `fx.${fx.id}.${name}`
  if (fx.type === 'grade')
    return (
      <>
        <NumberRow clip={clip} prop={p('exposure')} label="Exposure" step={0.05} min={-2} max={2} />
        <NumberRow clip={clip} prop={p('contrast')} label="Contrast" step={0.05} min={-1} max={1} />
        <NumberRow clip={clip} prop={p('saturation')} label="Saturation" step={0.05} min={-1} max={1} />
        <NumberRow clip={clip} prop={p('temperature')} label="Temp" step={0.05} min={-1} max={1} />
        <NumberRow clip={clip} prop={p('tint')} label="Tint" step={0.05} min={-1} max={1} />
      </>
    )
  if (fx.type === 'chromaKey')
    return (
      <>
        <div className="prow">
          <span className="prow__label">Color</span>
          <input
            className="prow__color"
            type="color"
            value={String(fx.params.color ?? '#00ff00')}
            onChange={(e) => s.updateEffectParams(clip.id, fx.id, { color: e.target.value })}
          />
        </div>
        <NumberRow clip={clip} prop={p('tolerance')} label="Tolerance" step={0.01} min={0} max={0.6} />
        <NumberRow clip={clip} prop={p('softness')} label="Softness" step={0.01} min={0} max={0.5} />
        <NumberRow clip={clip} prop={p('spill')} label="Spill" step={0.05} min={0} max={1} />
      </>
    )
  if (fx.type === 'blur')
    return <NumberRow clip={clip} prop={p('amount')} label="Blur/Sharp" step={0.5} min={-20} max={40} />
  if (fx.type === 'wheels')
    return (
      <div className="wheels">
        {(
          [
            ['Lift', 'liftR', 'liftG', 'liftB', 0.35],
            ['Gamma', 'gammaR', 'gammaG', 'gammaB', 0.6],
            ['Gain', 'gainR', 'gainG', 'gainB', 0.5],
          ] as const
        ).map(([label, rk, gk, bk, range]) => (
          <ColorWheel
            key={label}
            label={label}
            r={Number(fx.params[rk] ?? 0)}
            g={Number(fx.params[gk] ?? 0)}
            b={Number(fx.params[bk] ?? 0)}
            range={range}
            onChange={(r, g, b) =>
              s.updateEffectParams(clip.id, fx.id, { [rk]: r, [gk]: g, [bk]: b })
            }
          />
        ))}
      </div>
    )
  if (fx.type === 'curves') return <CurveEditor clip={clip} fx={fx} />
  if (fx.type === 'eq' || fx.type === 'compressor' || fx.type === 'gate' || fx.type === 'deesser')
    return <AudioFxParams clip={clip} fx={fx} />
  if (fx.type === 'lut')
    return (
      <div className="prow">
        <span className="prow__label">File</span>
        <button
          className="topbar__btn"
          onClick={() => {
            void import('@tauri-apps/plugin-dialog').then(async ({ open }) => {
              const picked = await open({
                title: 'Load .cube LUT',
                filters: [{ name: 'Cube LUT', extensions: ['cube'] }],
                multiple: false,
              })
              if (typeof picked === 'string')
                s.updateEffectParams(clip.id, fx.id, { path: picked })
            })
          }}
        >
          {typeof fx.params.path === 'string' && fx.params.path
            ? (fx.params.path.split('/').pop() ?? 'Load .cube…')
            : 'Load .cube…'}
        </button>
      </div>
    )
  if (fx.type === 'vignette')
    return <NumberRow clip={clip} prop={p('amount')} label="Amount" step={0.02} min={0} max={1} />
  // mask
  return (
    <>
      <div className="prow">
        <span className="prow__label">Shape</span>
        <select
          className="prow__ease"
          value={String(fx.params.kind ?? 'rect')}
          onChange={(e) => s.updateEffectParams(clip.id, fx.id, { kind: e.target.value })}
        >
          {['rect', 'ellipse'].map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <label className="prow__unit selectable" style={{ cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={!!fx.params.invert}
            onChange={(e) => s.updateEffectParams(clip.id, fx.id, { invert: e.target.checked })}
          />{' '}
          inv
        </label>
      </div>
      <NumberRow clip={clip} prop={p('x')} label="Mask X" step={1} />
      <NumberRow clip={clip} prop={p('y')} label="Mask Y" step={1} />
      <NumberRow clip={clip} prop={p('w')} label="Mask W" step={1} min={2} />
      <NumberRow clip={clip} prop={p('h')} label="Mask H" step={1} min={2} />
      <NumberRow clip={clip} prop={p('feather')} label="Feather" step={1} min={0} max={200} />
    </>
  )
}

// Effect presets: a named copy of the whole stack in the app-level SQLite
// settings table (key fxPresets). Apply = replace target stack, fresh ids.
function FxPresets({ clip }: { clip: Clip }) {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const [presets, setPresets] = useState<{ name: string; effects: Effect[] }[]>([])
  const s = useStore.getState()
  const load = async () => {
    const raw = await invoke<string | null>('get_setting', { key: 'fxPresets' }).catch(() => null)
    setPresets(raw ? (JSON.parse(raw) as { name: string; effects: Effect[] }[]) : [])
  }
  const persist = (next: { name: string; effects: Effect[] }[]) => {
    setPresets(next)
    void invoke('set_setting', { key: 'fxPresets', value: JSON.stringify(next) }).catch(() => {})
  }
  return (
    <>
      <button
        className="topbar__btn"
        title="Effect presets"
        onPointerDown={(e) => {
          setAnchor((e.currentTarget as HTMLElement).getBoundingClientRect())
          void load()
        }}
      >
        Presets
      </button>
      {anchor && (
        <Popover anchorRect={anchor} onClose={() => setAnchor(null)}>
          <button
            className="menu__item"
            disabled={clip.effects.length === 0}
            onClick={() => {
              const name = `Preset ${presets.length + 1} (${clip.effects.map((e) => e.type).join('+')})`
              persist([...presets, { name, effects: structuredClone(clip.effects) }])
            }}
          >
            Save stack as preset
          </button>
          {presets.map((pr, i) => (
            <div key={i} className="menu__item menu__item--row">
              <button
                className="menu__inline"
                onClick={() => {
                  for (const fx of pr.effects)
                    s.addEffect(clip.id, fx.type) // placeholder ids…
                  // …then overwrite the placeholders with the preset params in
                  // one history step less; simpler: rebuild via update
                  const added = useStore
                    .getState()
                    .project.tracks.flatMap((t) => t.clips)
                    .find((c) => c.id === clip.id)!
                    .effects.slice(-pr.effects.length)
                  added.forEach((fx, j) =>
                    s.updateEffectParams(clip.id, fx.id, { ...pr.effects[j].params }),
                  )
                  setAnchor(null)
                }}
              >
                {pr.name}
              </button>
              <button
                className="menu__inline menu__inline--danger"
                title="Delete preset"
                onClick={() => persist(presets.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </div>
          ))}
          {presets.length === 0 && <div className="menu__empty">No presets yet</div>}
        </Popover>
      )}
    </>
  )
}

function ShapeEditor({ clip }: { clip: Clip }) {
  const { updateShape } = useStore.getState()
  const sh = clip.shape
  if (!sh) return null
  const num = (label: string, key: 'width' | 'height' | 'strokeWidth', min = 1) => (
    <div className="prow">
      <span className="prow__label">{label}</span>
      <input
        className="prow__input"
        type="number"
        min={min}
        value={sh[key]}
        onChange={(e) => updateShape(clip.id, { [key]: Number(e.target.value) || sh[key] })}
      />
    </div>
  )
  return (
    <>
      <div className="prow">
        <span className="prow__label">Fill</span>
        <input
          className="prow__color"
          type="color"
          value={sh.fill}
          onChange={(e) => updateShape(clip.id, { fill: e.target.value })}
        />
      </div>
      {sh.kind === 'rect' || sh.kind === 'ellipse' ? (
        <div className="prow">
          <span className="prow__label">Stroke</span>
          <input
            className="prow__color"
            type="color"
            value={sh.stroke ?? '#000000'}
            onChange={(e) => updateShape(clip.id, { stroke: e.target.value })}
          />
          <button
            className="chip"
            onClick={() => updateShape(clip.id, { stroke: null })}
            disabled={!sh.stroke}
          >
            none
          </button>
        </div>
      ) : null}
      {sh.stroke && num('Stroke W', 'strokeWidth')}
      {num('Width', 'width', 2)}
      {num(sh.kind === 'line' ? 'Thickness' : 'Height', 'height', 1)}
    </>
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
          {[...FONTS, ...customFamilies()].map((f) => (
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
          {(
            [
              ['left', AlignLeft, 'Align left'],
              ['center', AlignCenter, 'Align center'],
              ['right', AlignRight, 'Align right'],
            ] as const
          ).map(([a, Icon, label]) => (
            <IconBtn
              key={a}
              icon={Icon}
              label={label}
              active={st.align === a}
              onClick={() => updateTextClip(clip.id, { style: { align: a } })}
            />
          ))}
        </div>
      </div>
      <div className="prow">
        <span className="prow__label">Spacing</span>
        <input
          className="prow__input"
          type="number"
          step={0.5}
          min={-10}
          max={50}
          value={st.letterSpacing ?? 0}
          title="Letter spacing (px)"
          onChange={(e) =>
            updateTextClip(clip.id, { style: { letterSpacing: Number(e.target.value) || 0 } })
          }
        />
        <input
          className="prow__input"
          type="number"
          step={0.1}
          min={0.8}
          max={3}
          value={st.lineHeight ?? 1.4}
          title="Line height (multiplier)"
          onChange={(e) =>
            updateTextClip(clip.id, { style: { lineHeight: Number(e.target.value) || 1.4 } })
          }
        />
      </div>
      <div className="prow">
        <span className="prow__label">
          <label className="prow__toggle">
            <input
              type="checkbox"
              checked={!!st.shadow}
              onChange={(e) =>
                updateTextClip(clip.id, {
                  style: {
                    shadow: e.target.checked ? { color: '#000000', blur: 8, x: 0, y: 2 } : null,
                  },
                })
              }
            />
            Shadow
          </label>
        </span>
        {st.shadow && (
          <>
            <input
              className="prow__color"
              type="color"
              value={st.shadow.color}
              onChange={(e) =>
                updateTextClip(clip.id, { style: { shadow: { ...st.shadow!, color: e.target.value } } })
              }
            />
            <input
              className="prow__input"
              type="number"
              min={0}
              max={64}
              value={st.shadow.blur}
              title="Blur"
              onChange={(e) =>
                updateTextClip(clip.id, {
                  style: { shadow: { ...st.shadow!, blur: Number(e.target.value) || 0 } },
                })
              }
            />
            <input
              className="prow__input"
              type="number"
              min={-64}
              max={64}
              value={st.shadow.y}
              title="Offset Y"
              onChange={(e) =>
                updateTextClip(clip.id, {
                  style: { shadow: { ...st.shadow!, y: Number(e.target.value) || 0 } },
                })
              }
            />
          </>
        )}
      </div>
      <div className="prow">
        <span className="prow__label">
          <label className="prow__toggle">
            <input
              type="checkbox"
              checked={!!st.gradient}
              onChange={(e) =>
                updateTextClip(clip.id, {
                  style: { gradient: e.target.checked ? { from: st.color, to: '#888888' } : null },
                })
              }
            />
            Gradient
          </label>
        </span>
        {st.gradient && (
          <>
            <input
              className="prow__color"
              type="color"
              value={st.gradient.from}
              title="Top color"
              onChange={(e) =>
                updateTextClip(clip.id, { style: { gradient: { ...st.gradient!, from: e.target.value } } })
              }
            />
            <input
              className="prow__color"
              type="color"
              value={st.gradient.to}
              title="Bottom color"
              onChange={(e) =>
                updateTextClip(clip.id, { style: { gradient: { ...st.gradient!, to: e.target.value } } })
              }
            />
          </>
        )}
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

// Color wheel pad (Phase 5): drag maps x → warm/cool (R vs B) and y → luma
// (all channels); the 9 underlying scalars stay keyframeable via the graph
// editor (fx.<id>.liftR …). Double-click resets the band.
function ColorWheel({
  label,
  r,
  g,
  b,
  range,
  onChange,
}: {
  label: string
  r: number
  g: number
  b: number
  range: number
  onChange: (r: number, g: number, b: number) => void
}) {
  const SIZE = 64
  // Display position back-projected from rgb (x = (r-b)/2, y = -(r+g+b)/3).
  const x = ((r - b) / 2 / range) * (SIZE / 2)
  const y = (-(r + g + b) / 3 / range) * (SIZE / 2)
  const startDrag = (e: React.PointerEvent) => {
    const el = e.currentTarget as HTMLElement
    const rect = el.getBoundingClientRect()
    const apply = (ev: { clientX: number; clientY: number }) => {
      const px = Math.max(-1, Math.min(1, ((ev.clientX - rect.left) / SIZE) * 2 - 1))
      const py = Math.max(-1, Math.min(1, ((ev.clientY - rect.top) / SIZE) * 2 - 1))
      const warm = px * range
      const luma = -py * range
      onChange(luma + warm / 2, luma, luma - warm / 2)
    }
    apply(e)
    const onMove = (ev: PointerEvent) => apply(ev)
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  return (
    <div className="wheel">
      <div
        className="wheel__pad"
        style={{ width: SIZE, height: SIZE }}
        onPointerDown={startDrag}
        onDoubleClick={() => onChange(0, 0, 0)}
        title={`${label} — drag: x warm/cool, y brightness; double-click resets`}
      >
        <div
          className="wheel__dot"
          style={{ left: SIZE / 2 + x - 3, top: SIZE / 2 + y - 3 }}
        />
      </div>
      <span className="wheel__label">{label}</span>
    </div>
  )
}

// RGB curve editor (Phase 5): channel tabs, draggable points, click empty
// space to add, double-click a point to remove. Rust bakes the same points
// with mirrored-endpoint Catmull-Rom — this SVG is a preview only.
function CurveEditor({ clip, fx }: { clip: Clip; fx: Effect }) {
  const s = useStore.getState()
  const [chan, setChan] = useState<'R' | 'G' | 'B' | 'M'>('M')
  const SIZE = 150
  const key = `points${chan}`
  const pts = (fx.params[key] as [number, number][] | undefined) ?? [
    [0, 0],
    [1, 1],
  ]
  const write = (next: [number, number][]) =>
    s.updateEffectParams(clip.id, fx.id, {
      [key]: [...next].sort((a, b) => a[0] - b[0]),
    })
  const toPx = (p: [number, number]) => [p[0] * SIZE, (1 - p[1]) * SIZE]
  const fromEvent = (e: { clientX: number; clientY: number }, rect: DOMRect): [number, number] => [
    Math.max(0, Math.min(1, (e.clientX - rect.left) / SIZE)),
    Math.max(0, Math.min(1, 1 - (e.clientY - rect.top) / SIZE)),
  ]
  const dragPoint = (e: React.PointerEvent, idx: number) => {
    e.stopPropagation()
    const rect = (e.currentTarget as SVGElement).ownerSVGElement!.getBoundingClientRect()
    const onMove = (ev: PointerEvent) => {
      const np = fromEvent(ev, rect)
      const next = pts.map((p, i) => (i === idx ? np : p)) as [number, number][]
      write(next)
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }
  // Preview polyline via dense sampling of a simple monotone-ish interp
  // (display only — the compositor's bake is the authority).
  const path = Array.from({ length: 51 }, (_, i) => {
    const x = i / 50
    let j = 0
    while (j + 1 < pts.length && pts[j + 1][0] < x) j++
    const a = pts[j]
    const bz = pts[Math.min(j + 1, pts.length - 1)]
    const t = bz[0] > a[0] ? (x - a[0]) / (bz[0] - a[0]) : 0
    const y = a[1] + (bz[1] - a[1]) * Math.max(0, Math.min(1, t))
    const [px, py] = toPx([x, y])
    return `${px.toFixed(1)},${py.toFixed(1)}`
  }).join(' ')
  const colors = { R: '#ff6b6b', G: '#51d88a', B: '#6b9bff', M: '#dddddd' }
  return (
    <div className="curves">
      <div className="curves__tabs">
        {(['R', 'G', 'B', 'M'] as const).map((c) => (
          <button
            key={c}
            className={`curves__tab${chan === c ? ' curves__tab--on' : ''}`}
            style={{ color: colors[c] }}
            onClick={() => setChan(c)}
          >
            {c === 'M' ? 'Master' : c}
          </button>
        ))}
      </div>
      <svg
        width={SIZE}
        height={SIZE}
        className="curves__svg"
        onPointerDown={(e) => {
          const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect()
          const np = fromEvent(e, rect)
          write([...pts, np])
        }}
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <g key={f}>
            <line x1={f * SIZE} x2={f * SIZE} y1={0} y2={SIZE} className="curves__grid" />
            <line y1={f * SIZE} y2={f * SIZE} x1={0} x2={SIZE} className="curves__grid" />
          </g>
        ))}
        <polyline points={path} fill="none" stroke={colors[chan]} strokeWidth={1.5} />
        {pts.map((p, i) => {
          const [px, py] = toPx(p)
          return (
            <circle
              key={i}
              cx={px}
              cy={py}
              r={4}
              fill={colors[chan]}
              style={{ cursor: 'move' }}
              onPointerDown={(e) => dragPoint(e, i)}
              onDoubleClick={(e) => {
                e.stopPropagation()
                if (pts.length > 2) write(pts.filter((_, j) => j !== i))
              }}
            />
          )
        })}
      </svg>
    </div>
  )
}

// Audio effect params (Phase 6): plain inputs — deliberately NOT
// keyframeable (export fragments are static; parity over flash).
function AudioFxParams({ clip, fx }: { clip: Clip; fx: Effect }) {
  const s = useStore.getState()
  const FIELDS: Record<string, [string, string, number][]> = {
    eq: [
      ['lowGain', 'Low dB', 1],
      ['lowFreq', 'Low Hz', 10],
      ['midGain', 'Mid dB', 1],
      ['midFreq', 'Mid Hz', 50],
      ['midQ', 'Mid Q', 0.1],
      ['highGain', 'High dB', 1],
      ['highFreq', 'High Hz', 100],
    ],
    compressor: [
      ['threshold', 'Thresh dB', 1],
      ['ratio', 'Ratio', 0.5],
      ['attack', 'Attack ms', 5],
      ['release', 'Release ms', 10],
      ['makeup', 'Makeup dB', 0.5],
    ],
    gate: [
      ['threshold', 'Thresh dB', 1],
      ['attack', 'Attack ms', 1],
      ['release', 'Release ms', 10],
    ],
    deesser: [
      ['intensity', 'Amount', 0.05],
      ['freqRatio', 'Freq', 0.05],
    ],
  }
  return (
    <>
      {(FIELDS[fx.type] ?? []).map(([key, label, step]) => (
        <div className="prow" key={key}>
          <span className="prow__label">{label}</span>
          <input
            className="prow__input"
            type="number"
            step={step}
            value={Number(fx.params[key] ?? 0)}
            onChange={(e) =>
              s.updateEffectParams(clip.id, fx.id, { [key]: Number(e.target.value) || 0 })
            }
          />
        </div>
      ))}
    </>
  )
}

function staticDisplay(clip: Clip, prop: string): number | undefined {
  if (prop === 'volume') return clip.volume
  if (prop.startsWith('transform.')) {
    const v = (clip.transform as unknown as Record<string, unknown>)[prop.slice(10)]
    return typeof v === 'number' ? v : undefined
  }
  if (prop.startsWith('fx.')) {
    const [, id, param] = prop.split('.')
    const v = clip.effects.find((e) => e.id === id)?.params[param]
    return typeof v === 'number' ? v : 0
  }
  return undefined
}

export default PropertiesPanel
