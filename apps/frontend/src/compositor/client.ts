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

  const ctx = canvas.getContext('2d')!

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
      const image = new ImageData(new Uint8ClampedArray(buf, 16), w, h)
      ctx.putImageData(image, 0, 0)
      lastImage = image
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
