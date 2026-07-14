import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useStore } from '../state/store'
import type { MediaAsset } from '../types/project'
import { isTauri } from '../compositor/bridge'

// Proxy orchestration (foundation session, Phase 5). Rust owns the transcode
// queue; this side requests, tracks progress toasts, and lands proxyPath on
// the asset. THE RULE: preview decodes proxies, export decodes originals —
// enforced where flatten() picks the media path.

// Retina screen recordings are the core use case: anything taller than 1080
// gets a 720p proxy. 1080p and below decodes fine without one.
const PROXY_MIN_HEIGHT = 1081

const requested = new Set<string>()

export function proxyEligible(asset: MediaAsset): boolean {
  return (
    isTauri &&
    asset.kind === 'video' &&
    !asset.missing &&
    asset.path.startsWith('/') &&
    !/\.(png|jpe?g)$/i.test(asset.path) &&
    (asset.height ?? 0) >= PROXY_MIN_HEIGHT
  )
}

export function maybeRequestProxy(asset: MediaAsset): void {
  if (!useStore.getState().prefs.autoProxy) return // preference (Phase 7)
  if (!proxyEligible(asset) || asset.proxyPath || requested.has(asset.path)) return
  requested.add(asset.path)
  useStore
    .getState()
    .pushToast('progress', `Creating proxy — ${asset.name}`, `proxy-${asset.path}`)
  void invoke('request_proxy', { path: asset.path }).catch(() => {
    useStore.getState().dismissToast(`proxy-${asset.path}`)
    requested.delete(asset.path)
  })
}

let listenersStarted = false
export function startProxyListeners(): void {
  if (!isTauri || listenersStarted) return
  listenersStarted = true
  void listen<{ src: string; progress: number }>('proxy:progress', (e) => {
    useStore.getState().updateToast(`proxy-${e.payload.src}`, { progress: e.payload.progress })
  })
  void listen<{ src: string; proxyPath: string }>('proxy:done', (e) => {
    const s = useStore.getState()
    s.dismissToast(`proxy-${e.payload.src}`)
    requested.delete(e.payload.src)
    for (const m of s.project.media)
      if (m.path === e.payload.src) s.updateMedia(m.id, { proxyPath: e.payload.proxyPath })
    const name = e.payload.src.split('/').pop()
    s.pushToast('success', `Proxy ready — ${name}`)
  })
  void listen<{ src: string; error: string }>('proxy:failed', (e) => {
    const s = useStore.getState()
    s.dismissToast(`proxy-${e.payload.src}`)
    requested.delete(e.payload.src)
    s.pushToast('error', `Proxy failed for ${e.payload.src.split('/').pop()}: ${e.payload.error}`)
  })
}

// On project load: request proxies for eligible assets that lack one (the
// cache makes re-requests of known footage instant).
export function requestMissingProxies(): void {
  for (const m of useStore.getState().project.media) maybeRequestProxy(m)
}
