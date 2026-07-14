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
// Audio fx preview (Phase 6): per-element chains mirroring the export
// fragments. Rev = JSON of the audio effects; rebuild only on change.
const sources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>()
const elChains = new WeakMap<HTMLMediaElement, { nodes: AudioNode[]; rev: string }>()
let gateWorkletReady = false
// Track buses (pro-editor session, Phase 1): panner → track GainNode →
// master. The bus GainNode is what lets a mixer fader exceed 1.0 — element
// .volume clamps at 1, a GainNode doesn't — and its analyser feeds the
// per-track meter.
interface TrackBus {
  input: GainNode // fx chain hangs between input and gain
  gain: GainNode
  analyser: AnalyserNode
  buf: Uint8Array<ArrayBuffer>
  fxNodes: AudioNode[]
  fxRev: string
}
const trackBuses = new Map<string, TrackBus>()
const elBus = new WeakMap<HTMLMediaElement, string>()
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
  // Release the hardware on page teardown. WebKit caps live AudioContexts
  // per web process; without this, every dev-reload strands one until GC
  // and deep test sequences saw analysers go silent (Phase 2 gate flake).
  window.addEventListener('pagehide', () => {
    void ctx?.close().catch(() => {})
    ctx = null
  })
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
  // Noise-gate worklet (Phase 6): envelope follower with attack/release,
  // hard-mutes below threshold — DynamicsCompressor can't gate. Registered
  // from a blob; gates pass through until it's ready.
  const workletSrc = `
    class NoiseGate extends AudioWorkletProcessor {
      static get parameterDescriptors() {
        return [
          { name: 'threshold', defaultValue: 0.005, minValue: 0, maxValue: 1 },
          { name: 'attack', defaultValue: 0.01, minValue: 0.0001, maxValue: 1 },
          { name: 'release', defaultValue: 0.12, minValue: 0.001, maxValue: 2 },
        ]
      }
      constructor() { super(); this.env = 0; this.gain = 0 }
      process(inputs, outputs, params) {
        const inp = inputs[0]; const out = outputs[0]
        if (!inp.length) return true
        const thr = params.threshold[0]
        const aCoef = Math.exp(-1 / (sampleRate * params.attack[0]))
        const rCoef = Math.exp(-1 / (sampleRate * params.release[0]))
        for (let i = 0; i < inp[0].length; i++) {
          let peak = 0
          for (let c = 0; c < inp.length; c++) peak = Math.max(peak, Math.abs(inp[c][i]))
          this.env = peak > this.env ? peak : this.env * rCoef
          const target = this.env > thr ? 1 : 0
          this.gain = target > this.gain
            ? 1 - (1 - this.gain) * aCoef
            : this.gain * rCoef
          for (let c = 0; c < out.length; c++) out[c][i] = (inp[c] ? inp[c][i] : 0) * this.gain
        }
        return true
      }
    }
    registerProcessor('noise-gate', NoiseGate)
  `
  const url = URL.createObjectURL(new Blob([workletSrc], { type: 'application/javascript' }))
  void ctx.audioWorklet
    .addModule(url)
    .then(() => {
      gateWorkletReady = true
    })
    .catch(() => {})
  return true
}

// Build Web Audio nodes for one audio effect — the preview mirror of
// audioFxFilter (engine/audioFx.ts). De-esser preview is a STATIC high-band
// cut approximation (no sidechain without another worklet); the export uses
// FFmpeg's real deesser — logged divergence, export is the authority.
function buildFxNode(fx: import('../types/project').Effect): AudioNode[] {
  if (!ctx) return []
  const n = (k: string, d: number) => {
    const v = fx.params[k]
    return typeof v === 'number' && Number.isFinite(v) ? v : d
  }
  if (fx.type === 'eq') {
    const nodes: AudioNode[] = []
    const mk = (type: BiquadFilterType, f: number, g: number, q?: number) => {
      const b = ctx!.createBiquadFilter()
      b.type = type
      b.frequency.value = f
      b.gain.value = g
      if (q !== undefined) b.Q.value = q
      nodes.push(b)
    }
    if (n('lowGain', 0) !== 0) mk('lowshelf', n('lowFreq', 120), n('lowGain', 0))
    if (n('midGain', 0) !== 0) mk('peaking', n('midFreq', 1000), n('midGain', 0), n('midQ', 1))
    if (n('highGain', 0) !== 0) mk('highshelf', n('highFreq', 8000), n('highGain', 0))
    return nodes
  }
  if (fx.type === 'compressor') {
    const c = ctx.createDynamicsCompressor()
    c.threshold.value = Math.max(-100, Math.min(0, n('threshold', -24)))
    c.ratio.value = Math.max(1, Math.min(20, n('ratio', 4)))
    c.attack.value = Math.max(0.001, n('attack', 20) / 1000)
    c.release.value = Math.max(0.01, n('release', 250) / 1000)
    const makeup = ctx.createGain()
    makeup.gain.value = Math.pow(10, n('makeup', 0) / 20)
    return [c, makeup]
  }
  if (fx.type === 'gate' && gateWorkletReady) {
    try {
      const g = new AudioWorkletNode(ctx, 'noise-gate', { outputChannelCount: [2] })
      g.parameters.get('threshold')!.value = Math.pow(10, n('threshold', -45) / 20)
      g.parameters.get('attack')!.value = Math.max(0.0001, n('attack', 10) / 1000)
      g.parameters.get('release')!.value = Math.max(0.001, n('release', 120) / 1000)
      return [g]
    } catch {
      return []
    }
  }
  if (fx.type === 'deesser') {
    const b = ctx.createBiquadFilter()
    b.type = 'peaking'
    b.frequency.value = 3000 + n('freqRatio', 0.5) * 6000
    b.Q.value = 1.2
    b.gain.value = -15 * Math.min(1, Math.max(0, n('intensity', 0.5)))
    return [b]
  }
  return []
}

function chainRev(effects: import('../types/project').Effect[]): string {
  return JSON.stringify(
    effects.filter((e) => ['eq', 'compressor', 'gate', 'deesser'].includes(e.type) && e.enabled),
  )
}

function trackBus(trackId: string): TrackBus | null {
  if (!ensureGraph() || !ctx || !master) return null
  let bus = trackBuses.get(trackId)
  if (!bus) {
    const input = ctx.createGain()
    const gain = ctx.createGain()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    input.connect(gain)
    gain.connect(analyser)
    gain.connect(master)
    bus = {
      input,
      gain,
      analyser,
      buf: new Uint8Array(new ArrayBuffer(analyser.fftSize)),
      fxNodes: [],
      fxRev: '[]',
    }
    trackBuses.set(trackId, bus)
  }
  return bus
}

// Track-level fx (Phase 6): rebuild input→(fx…)→gain when the stack changes.
export function setTrackBusFx(trackId: string, effects: import('../types/project').Effect[]) {
  const bus = trackBus(trackId)
  if (!bus || !ctx) return
  const rev = chainRev(effects)
  if (rev === bus.fxRev) return
  bus.fxRev = rev
  bus.input.disconnect()
  for (const nd of bus.fxNodes) nd.disconnect()
  bus.fxNodes = effects
    .filter((e) => e.enabled)
    .flatMap((e) => buildFxNode(e))
  let head: AudioNode = bus.input
  for (const nd of bus.fxNodes) {
    head.connect(nd)
    head = nd
  }
  head.connect(bus.gain)
}

export function attachElement(
  el: HTMLMediaElement,
  pan: number,
  trackId?: string,
  fxList?: import('../types/project').Effect[],
) {
  if (!ensureGraph() || !ctx || !master) return
  let panner = panners.get(el)
  let srcNode = sources.get(el)
  if (!panner) {
    // createMediaElementSource is once-per-element for the element's lifetime;
    // afterwards ALL of its audio flows through the graph.
    try {
      srcNode = ctx.createMediaElementSource(el)
      sources.set(el, srcNode)
      panner = ctx.createStereoPanner()
      srcNode.connect(panner)
      panners.set(el, panner)
      attachedCount++
      attachedEls.push(new WeakRef(el))
    } catch {
      return // already claimed by a dead graph (shouldn't happen — one ctx)
    }
  }
  // Element fx chain (Phase 6): source → fx… → panner, rebuilt on rev change.
  const rev = chainRev(fxList ?? [])
  const existing = elChains.get(el)
  if (srcNode && rev !== (existing?.rev ?? '[]')) {
    srcNode.disconnect()
    for (const nd of existing?.nodes ?? []) nd.disconnect()
    const nodes = (fxList ?? []).filter((e) => e.enabled).flatMap((e) => buildFxNode(e))
    let head: AudioNode = srcNode
    for (const nd of nodes) {
      head.connect(nd)
      head = nd
    }
    head.connect(panner)
    elChains.set(el, { nodes, rev })
  }
  const routedTo = elBus.get(el)
  if (routedTo !== (trackId ?? '')) {
    panner.disconnect()
    const bus = trackId ? trackBus(trackId) : null
    panner.connect(bus ? bus.input : master)
    elBus.set(el, trackId ?? '')
  }
  if (Math.abs(panner.pan.value - pan) > 1e-3) panner.pan.value = pan
}

export function setTrackBusGain(trackId: string, v: number) {
  const bus = trackBus(trackId)
  if (bus) bus.gain.gain.value = v
}

// Mono peak for one track's meter (post-fader).
export function readTrackPeak(trackId: string): number {
  const bus = trackBuses.get(trackId)
  if (!bus) return 0
  bus.analyser.getByteTimeDomainData(bus.buf)
  let m = 0
  for (let i = 0; i < bus.buf.length; i++) {
    const d = Math.abs(bus.buf[i] - 128) / 127
    if (d > m) m = d
  }
  return m
}

// dBFS mapping shared by every meter (pure — unit-tested).
export function dbfs(v: number): number {
  return 20 * Math.log10(Math.max(v, 1e-4))
}
// 0..1 meter fraction over a -60..0 dB scale.
export function meterFrac(v: number): number {
  return Math.min(1, Math.max(0, (dbfs(v) + 60) / 60))
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
