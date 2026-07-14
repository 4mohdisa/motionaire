import { useStore } from '../state/store'

// Receives composited frames from the Rust compositor over a localhost WebSocket
// and paints them into the preview canvas. Header (LE): u32 magic "MOTN",
// u16 w, u16 h, f32 timeline_t, f32 render_fps, then tight RGBA.

const WS_URL = 'ws://127.0.0.1:43117'
const MAGIC = 0x4d4f544e

// Rust's timeline time from the latest frame header — the authoritative clock
// while the compositor is active (session 7: the frontend wall-clock crawls at
// ~0.4x when the window is occluded and rAF starves; Rust never does).
export const compositorClock = { t: NaN, at: 0 }

// Scopes (pro-editor session, Phase 5) read the compositor's ACTUAL output
// frames from here — not a re-render, the same RGBA the preview shows.
let lastFrameRef: ImageData | null = null
export function getLastFrame(): ImageData | null {
  return lastFrameRef
}

export function startCompositorClient(canvas: HTMLCanvasElement): () => void {
  let ws: WebSocket | null = null
  let stopped = false
  let retryTimer: number | undefined
  let lastActive = false
  let staleTimer: number | undefined
  // Delivered-to-canvas rate, measured here — the honest number. The header's
  // fps field is Rust's render-work capacity, which is much higher.
  let frameTimes: number[] = []
  // Last decoded frame, kept so the canvas can be repainted after macOS purges
  // an occluded canvas backing (session 7: a purged, never-repainted canvas
  // displayed uninitialized surface memory — on one machine, another app's UI).
  let lastImage: ImageData | null = null
  let lastFresh = 0

  // willReadFrequently opts OUT of WebKit's accelerated (IOSurface-pooled)
  // canvas backing. That pool is where the scrub-time artifact lived: under
  // memory pressure a recycled/purged surface could be DISPLAYED between our
  // draws, showing content that was never ours (session 8 forensics: canvas
  // pixel data always valid, display sometimes not). A CPU backing has no
  // pool to recycle. Also enables cheap getImageData for diagnostics.
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  // One reusable frame buffer — a fresh 3.7MB allocation per frame at 60fps
  // was feeding the same memory pressure that triggers backing purges.
  let frameBuf: ImageData | null = null

  const repaint = () => {
    if (!lastImage) return
    if (canvas.width !== lastImage.width || canvas.height !== lastImage.height) {
      canvas.width = lastImage.width
      canvas.height = lastImage.height
    }
    ctx.putImageData(lastImage, 0, 0)
  }
  const onVisible = () => repaint()
  document.addEventListener('visibilitychange', onVisible)
  window.addEventListener('focus', onVisible)
  window.addEventListener('pageshow', onVisible)
  // Belt over the Rust keepalive's suspenders: repaint from cache if no fresh
  // frame arrived recently (covers a dropped keepalive or purge mid-idle).
  const repaintTimer = window.setInterval(() => {
    if (lastActive && lastImage && performance.now() - lastFresh > 1500) repaint()
  }, 1000)

  const setActive = (v: boolean, fps = 0) => {
    if (v !== lastActive || v) {
      lastActive = v
      useStore.getState().setCompositorStatus(v, fps)
    }
  }

  const receivedFps = () => {
    const now = performance.now()
    frameTimes.push(now)
    frameTimes = frameTimes.filter((t) => now - t < 1000)
    return frameTimes.length
  }

  const connect = () => {
    if (stopped) return
    ws = new WebSocket(WS_URL)
    ws.binaryType = 'arraybuffer'
    ws.onmessage = (ev) => {
      const buf = ev.data as ArrayBuffer
      if (buf.byteLength < 16) return
      const dv = new DataView(buf)
      if (dv.getUint32(0, true) !== MAGIC) return
      const w = dv.getUint16(4, true)
      const h = dv.getUint16(6, true)
      if (buf.byteLength !== 16 + w * h * 4) return
      compositorClock.t = dv.getFloat32(8, true)
      compositorClock.at = performance.now()
      if (import.meta.env.DEV) {
        // Also exposed for scripted self-tests.
        const wm = window as unknown as { __motionaire?: Record<string, unknown> }
        wm.__motionaire = { ...wm.__motionaire, lastFrameT: compositorClock.t }
      }
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
        // Never display a freshly-reallocated (uninitialized) backing.
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, w, h)
      }
      if (!frameBuf || frameBuf.width !== w || frameBuf.height !== h) {
        frameBuf = new ImageData(w, h)
      }
      frameBuf.data.set(new Uint8ClampedArray(buf, 16))
      ctx.putImageData(frameBuf, 0, 0)
      lastImage = frameBuf

      lastFrameRef = lastImage
      lastFresh = performance.now()
      setActive(true, receivedFps())
      // No frames for a while (e.g. paused with no changes) still means active;
      // only a dropped socket deactivates. Refresh a stale-guard regardless.
      window.clearTimeout(staleTimer)
      staleTimer = window.setTimeout(() => setActive(true, 0), 2000)
    }
    ws.onclose = () => {
      setActive(false)
      if (!stopped) retryTimer = window.setTimeout(connect, 1000)
    }
    ws.onerror = () => ws?.close()
  }
  connect()

  return () => {
    stopped = true
    window.clearTimeout(retryTimer)
    window.clearTimeout(staleTimer)
    window.clearInterval(repaintTimer)
    document.removeEventListener('visibilitychange', onVisible)
    window.removeEventListener('focus', onVisible)
    window.removeEventListener('pageshow', onVisible)
    ws?.close()
    setActive(false)
  }
}
