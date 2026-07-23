import type { Effect } from '../types/project'

// Audio effects (pro-editor session, Phase 6): one source of truth for the
// FFmpeg fragment each effect produces on export. Preview mirrors these with
// Web Audio nodes (audioGraph.ts); the EXPORTED FILE is the authority and
// the e2e suite measures it (volumedetect / ebur128).
//
// Deliberate simplification, logged: audio effect params are NOT
// keyframeable — the export fragment is static per clip, and a preview that
// animated what the export can't would violate the parity principle.

export const AUDIO_FX_TYPES = ['eq', 'compressor', 'gate', 'deesser'] as const
export type AudioFxType = (typeof AUDIO_FX_TYPES)[number]

export function isAudioFx(type: string): boolean {
  return (AUDIO_FX_TYPES as readonly string[]).includes(type)
}

const num = (fx: Effect, key: string, dflt: number): number => {
  const v = fx.params[key]
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt
}

const dbToLin = (db: number) => Math.pow(10, db / 20)

// FFmpeg filter fragment for one enabled audio effect; null = identity.
export function audioFxFilter(fx: Effect): string | null {
  if (!fx.enabled) return null
  switch (fx.type) {
    case 'eq': {
      // Three-band parametric: low shelf, mid peak, high shelf.
      const parts: string[] = []
      const lg = num(fx, 'lowGain', 0)
      const mg = num(fx, 'midGain', 0)
      const hg = num(fx, 'highGain', 0)
      if (lg !== 0)
        parts.push(`lowshelf=g=${lg.toFixed(1)}:f=${num(fx, 'lowFreq', 120).toFixed(0)}`)
      if (mg !== 0)
        parts.push(
          `equalizer=f=${num(fx, 'midFreq', 1000).toFixed(0)}:t=q:w=${num(fx, 'midQ', 1).toFixed(2)}:g=${mg.toFixed(1)}`,
        )
      if (hg !== 0)
        parts.push(`highshelf=g=${hg.toFixed(1)}:f=${num(fx, 'highFreq', 8000).toFixed(0)}`)
      return parts.length ? parts.join(',') : null
    }
    case 'compressor': {
      // Threshold dBFS, ratio, attack/release ms, makeup dB. ratio ≥ 20 is
      // the limiter setting — same node, no special case.
      const thr = dbToLin(num(fx, 'threshold', -24))
      const ratio = Math.min(20, Math.max(1, num(fx, 'ratio', 4)))
      const makeup = Math.min(64, Math.max(1, dbToLin(num(fx, 'makeup', 0))))
      // detection=peak: predictable reduction math (RMS detection reads a
      // sine 3dB low and softens the measured drop — found by the p6 export
      // verification).
      return (
        `acompressor=threshold=${thr.toFixed(6)}:ratio=${ratio.toFixed(2)}` +
        `:attack=${Math.max(0.01, num(fx, 'attack', 20)).toFixed(1)}` +
        `:release=${Math.max(0.01, num(fx, 'release', 250)).toFixed(1)}` +
        `:makeup=${makeup.toFixed(3)}:detection=peak`
      )
    }
    case 'gate': {
      const thr = dbToLin(num(fx, 'threshold', -45))
      return (
        `agate=threshold=${thr.toFixed(6)}:ratio=9000` +
        `:attack=${Math.max(0.01, num(fx, 'attack', 10)).toFixed(1)}` +
        `:release=${Math.max(0.01, num(fx, 'release', 120)).toFixed(1)}` +
        `:range=0`
      )
    }
    case 'deesser': {
      const i = Math.min(1, Math.max(0, num(fx, 'intensity', 0.5)))
      const f = Math.min(1, Math.max(0.1, num(fx, 'freqRatio', 0.5)))
      return `deesser=i=${i.toFixed(2)}:f=${f.toFixed(2)}:m=0.5`
    }
    default:
      return null
  }
}

// Ordered fragments for a whole stack (enabled audio effects only).
export function audioFxChain(effects: Effect[]): string[] {
  return effects
    .filter((e) => isAudioFx(e.type))
    .map(audioFxFilter)
    .filter((f): f is string => !!f)
}
