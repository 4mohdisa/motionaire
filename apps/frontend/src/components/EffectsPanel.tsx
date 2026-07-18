import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useStore } from '../state/store'
import { EFFECT_LABELS, type Effect, type EffectType } from '../engine/effectStack'
import { isAudioFx } from '../engine/audioFx'
import { findClip } from '../engine/time'

// Effects browser (Run 1, Phase 1f): the rail's second panel. Click applies
// the effect to the selected clip through the same store mutation the
// properties panel uses; saved presets apply below.
export default function EffectsPanel() {
  const selection = useStore((s) => s.selection)
  const project = useStore((s) => s.project)
  const clip = selection.length === 1 ? findClip(project, selection[0])?.clip : undefined
  const [presets, setPresets] = useState<{ name: string; effects: Effect[] }[]>([])
  useEffect(() => {
    void invoke<string | null>('get_setting', { key: 'fxPresets' })
      .then((raw) => setPresets(raw ? (JSON.parse(raw) as typeof presets) : []))
      .catch(() => {})
     
  }, [])

  const types = Object.keys(EFFECT_LABELS) as EffectType[]
  const applicable = (t: EffectType) =>
    !!clip && (clip.kind === 'audio' ? isAudioFx(t) : true)

  return (
    <aside className="panel effectspanel">
      <div className="panel__title">
        Effects
        {!clip && <span className="panel__hint">select a clip</span>}
      </div>
      <div className="effectspanel__body">
        <div className="effectspanel__group">Video</div>
        <div className="effectspanel__grid">
          {types
            .filter((t) => !isAudioFx(t))
            .map((t) => (
              <button
                key={t}
                className="effectspanel__item"
                disabled={!applicable(t)}
                title={clip ? `Add to ${clip.kind} clip` : 'Select a clip first'}
                onClick={() => clip && useStore.getState().addEffect(clip.id, t)}
              >
                {EFFECT_LABELS[t]}
              </button>
            ))}
        </div>
        <div className="effectspanel__group">Audio</div>
        <div className="effectspanel__grid">
          {types
            .filter((t) => isAudioFx(t))
            .map((t) => (
              <button
                key={t}
                className="effectspanel__item"
                disabled={!clip}
                onClick={() => clip && useStore.getState().addEffect(clip.id, t)}
              >
                {EFFECT_LABELS[t]}
              </button>
            ))}
        </div>
        {presets.length > 0 && (
          <>
            <div className="effectspanel__group">Presets</div>
            <div className="effectspanel__grid">
              {presets.map((pr, i) => (
                <button
                  key={i}
                  className="effectspanel__item"
                  disabled={!clip}
                  onClick={() => {
                    if (!clip) return
                    const s = useStore.getState()
                    for (const fx of pr.effects) s.addEffect(clip.id, fx.type)
                    const added = findClip(useStore.getState().project, clip.id)!
                      .clip.effects.slice(-pr.effects.length)
                    added.forEach((fx, j) =>
                      s.updateEffectParams(clip.id, fx.id, { ...pr.effects[j].params }),
                    )
                  }}
                >
                  {pr.name}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </aside>
  )
}
