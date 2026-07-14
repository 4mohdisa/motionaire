// Web Audio tail for preview audio (foundation session, Phase 3).
// Media elements stay the decoders/mixers they've always been; each one now
// routes element → StereoPanner → master Gain → destination, with per-channel
// analysers on the master bus for the meters. Element .volume (clip volume ×
// track gains) still applies upstream — this graph adds pan, master gain,
// and metering only.

let ctx: AudioContext | null = null
let master: GainNode | null = null
let analyserL: AnalyserNode | null = null
let analyserR: AnalyserNode | null = null
let bufL: Uint8Array<ArrayBuffer> | null = null
let bufR: Uint8Array<ArrayBuffer> | null = null

const panners = new WeakMap<HTMLMediaElement, StereoPannerNode>()
let attachedCount = 0
// Debug roster of attached elements (test forensics — see graphDebug).
const attachedEls: WeakRef<HTMLMediaElement>[] = []

export function graphDebug(): string {
  const els = attachedEls
    .map((r) => r.deref())
    .filter((e): e is HTMLMediaElement => !!e)
    .map((e) => {
      const src = (e.currentSrc || e.src).split('/').pop()?.slice(-24) ?? '?'
      const err = e.error ? ` ERR${e.error.code}` : ''
      return `${src}:rs${e.readyState},${e.paused ? 'paused' : 'playing'},t${e.currentTime.toFixed(1)},v${e.volume.toFixed(2)}${e.muted ? ',MUTED' : ''}${err}`
    })
    .join(' | ')
  return `ctx=${ctx?.state ?? 'none'} attached=${attachedCount} gain=${master?.gain.value.toFixed(3) ?? 'n/a'} set=${lastSetGain} els[${els}]`
}

export function ensureGraph(): boolean {
  if (ctx) return true
  try {
    ctx = new AudioContext()
  } catch {
    return false
  }
  master = ctx.createGain()
  const splitter = ctx.createChannelSplitter(2)
  analyserL = ctx.createAnalyser()
  analyserR = ctx.createAnalyser()
  analyserL.fftSize = 1024
  analyserR.fftSize = 1024
  bufL = new Uint8Array(new ArrayBuffer(analyserL.fftSize))
  bufR = new Uint8Array(new ArrayBuffer(analyserR.fftSize))
  master.connect(splitter)
  splitter.connect(analyserL, 0)
  splitter.connect(analyserR, 1)
  master.connect(ctx.destination)
  return true
}

export function attachElement(el: HTMLMediaElement, pan: number) {
  if (!ensureGraph() || !ctx || !master) return
  let panner = panners.get(el)
  if (!panner) {
    // createMediaElementSource is once-per-element for the element's lifetime;
    // afterwards ALL of its audio flows through the graph.
    try {
      const src = ctx.createMediaElementSource(el)
      panner = ctx.createStereoPanner()
      src.connect(panner)
      panner.connect(master)
      panners.set(el, panner)
      attachedCount++
      attachedEls.push(new WeakRef(el))
    } catch {
      return // already claimed by a dead graph (shouldn't happen — one ctx)
    }
  }
  if (Math.abs(panner.pan.value - pan) > 1e-3) panner.pan.value = pan
}

export function resumeGraph() {
  if (ctx?.state === 'suspended') void ctx.resume()
}

let lastSetGain = -1
export function setMasterGain(v: number) {
  lastSetGain = v
  if (master) master.gain.value = v
}

// Instantaneous peak (0..~1+) per channel from the time-domain waveform.
export function readPeaks(): { l: number; r: number } {
  if (!analyserL || !analyserR || !bufL || !bufR) return { l: 0, r: 0 }
  analyserL.getByteTimeDomainData(bufL)
  analyserR.getByteTimeDomainData(bufR)
  const peak = (b: Uint8Array<ArrayBuffer>) => {
    let m = 0
    for (let i = 0; i < b.length; i++) {
      const d = Math.abs(b[i] - 128) / 127
      if (d > m) m = d
    }
    return m
  }
  return { l: peak(bufL), r: peak(bufR) }
}
