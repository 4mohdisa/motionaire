import { useStore } from '../state/store'

// Receives composited frames from the Rust compositor over a localhost WebSocket
// and paints them into the preview canvas. Header (LE): u32 magic "MOTN",
// u16 w, u16 h, f32 timeline_t, f32 render_fps, then tight RGBA.

const WS_URL = 'ws://127.0.0.1:43117'
const MAGIC = 0x4d4f544e

export function startCompositorClient(canvas: HTMLCanvasElement): () => void {
  let ws: WebSocket | null = null
  let stopped = false
  let retryTimer: number | undefined
  let lastActive = false
  let staleTimer: number | undefined
  // Delivered-to-canvas rate, measured here — the honest number. The header's
  // fps field is Rust's render-work capacity, which is much higher.
  let frameTimes: number[] = []

  const ctx = canvas.getContext('2d')!

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
      if (import.meta.env.DEV) {
        // Rust's timeline time for this frame — used by clock-sync self-tests.
        const wm = window as unknown as { __motionaire?: Record<string, unknown> }
        wm.__motionaire = { ...wm.__motionaire, lastFrameT: dv.getFloat32(8, true) }
      }
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w
        canvas.height = h
      }
      ctx.putImageData(new ImageData(new Uint8ClampedArray(buf, 16), w, h), 0, 0)
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
    ws?.close()
    setActive(false)
  }
}
