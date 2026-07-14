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
// Track buses (pro-editor session, Phase 1): panner → track GainNode →
// master. The bus GainNode is what lets a mixer fader exceed 1.0 — element
// .volume clamps at 1, a GainNode doesn't — and its analyser feeds the
// per-track meter.
interface TrackBus {
  gain: GainNode
  analyser: AnalyserNode
  buf: Uint8Array<ArrayBuffer>
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
  return true
}

function trackBus(trackId: string): TrackBus | null {
  if (!ensureGraph() || !ctx || !master) return null
  let bus = trackBuses.get(trackId)
  if (!bus) {
    const gain = ctx.createGain()
    const analyser = ctx.createAnalyser()
    analyser.fftSize = 512
    gain.connect(analyser)
    gain.connect(master)
    bus = { gain, analyser, buf: new Uint8Array(new ArrayBuffer(analyser.fftSize)) }
    trackBuses.set(trackId, bus)
  }
  return bus
}

export function attachElement(el: HTMLMediaElement, pan: number, trackId?: string) {
  if (!ensureGraph() || !ctx || !master) return
  let panner = panners.get(el)
  if (!panner) {
    // createMediaElementSource is once-per-element for the element's lifetime;
    // afterwards ALL of its audio flows through the graph.
    try {
      const src = ctx.createMediaElementSource(el)
      panner = ctx.createStereoPanner()
      src.connect(panner)
      panners.set(el, panner)
      attachedCount++
      attachedEls.push(new WeakRef(el))
    } catch {
      return // already claimed by a dead graph (shouldn't happen — one ctx)
    }
  } else if (elBus.get(el) !== (trackId ?? '')) {
    panner.disconnect() // re-routed: clip moved to another track
  } else {
    if (Math.abs(panner.pan.value - pan) > 1e-3) panner.pan.value = pan
    return
  }
  const bus = trackId ? trackBus(trackId) : null
  panner.connect(bus ? bus.gain : master)
  elBus.set(el, trackId ?? '')
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
