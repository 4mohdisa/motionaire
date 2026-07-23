import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { effectiveProject } from '../engine/compound'
import { useStore } from '../state/store'
import type { Track, Project } from '../types/project'

// Sync split per the spike brief: structure (tracks/clips/keyframes) goes over
// IPC only when it changes, debounced; the playhead is a cheap (t, playing)
// float pair sent on every change — Rust free-runs its own clock between samples.

export const isTauri = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

interface SpikeMedia {
  path: string
  width: number
  height: number
  fps: number
  duration: number
}

// Only file-backed video clips reach the compositor; blob-URL media (browser
// file-input imports) stays DOM-only until native import fully replaces it.
export function flatten(project: Project, opts?: { originals?: boolean }) {
  const layers = []
  // Compound clips inline here (Phase 8): render consumers see the
  // effective project; z scales ×1000 so nested layers stack between hosts.
  const eff = effectiveProject(project)
  for (const track of eff.tracks) {
    if (track.kind !== 'video' || track.hidden) continue
    for (const clip of track.clips) {
      if (clip.disabled) continue // enable/disable (foundation, Phase 2)
      // Raster layers (text + shapes) share the webview-raster channel.
      const isRaster = (clip.kind === 'text' && !!clip.text) || !!clip.shape
      if (!isRaster && (clip.kind !== 'video' || (!clip.mediaId && !clip.adjust))) continue
      const asset =
        clip.adjust || isRaster ? null : project.media.find((m) => m.id === clip.mediaId)
      if (!clip.adjust && !isRaster && (!asset || !asset.path.startsWith('/'))) continue
      layers.push({
        id: clip.id,
        z: track.z * 1000 + ((track as Track & { __nestedZ?: number }).__nestedZ ?? 0),
        // THE proxy rule (foundation, Phase 5): preview decodes proxies,
        // export decodes originals — never the reverse.
        mediaPath: isRaster
          ? `text:${clip.id}`
          : opts?.originals
            ? (asset?.path ?? '')
            : (asset?.proxyPath ?? asset?.path ?? ''),
        adjust: clip.adjust ?? false,
        start: clip.start,
        in: clip.in,
        out: clip.out,
        speed: clip.speed,
        transform: {
          x: clip.transform.x,
          y: clip.transform.y,
          scale: clip.transform.scale,
          rotation: clip.transform.rotation,
          opacity: clip.transform.opacity,
          cornerRadius: clip.transform.cornerRadius,
          crop: clip.transform.crop,
          shadow: clip.transform.shadow,
        },
        keyframes: clip.keyframes,
        transitions: clip.transitions,
        // Ordered effect stack (Phase 2): enabled instances only; Rust
        // resolves fx.<id>.<param> keyframes per instance.
        stack: clip.effects.filter((e) => e.enabled),
        matte: clip.matte ?? null,
        motionBlur: clip.motionBlur ?? false,
        blend: clip.blend ?? null,
      })
    }
  }
  return {
    canvas: {
      width: project.canvas.width,
      height: project.canvas.height,
      fps: project.canvas.fps,
      background: project.canvas.background,
    },
    layers,
  }
}

let bridgeStarted = false

export function startCompositorBridge() {
  if (!isTauri) return
  // React StrictMode double-mounts effects; a second bridge would double every
  // IPC message and race any env-gated self-test against itself.
  if (bridgeStarted) return
  bridgeStarted = true

  let syncTimer: number | undefined
  let lastProject: Project | null = null
  let lastPlayhead = -1
  let lastAnchorT = -1
  let lastPlaying = false
  let lastShuttle = 1

  const syncProject = (project: Project) => {
    window.clearTimeout(syncTimer)
    syncTimer = window.setTimeout(() => {
      // Rasters first so a new/edited text layer never renders as a hole;
      // both are cheap no-ops when nothing text-related changed.
      void import('./textRaster')
        .then((m) => m.syncTextRasters(project))
        .finally(() => {
          void invoke('sync_project', {
            project: flatten(project, { originals: useStore.getState().previewOriginal }),
          }).catch((e) => console.error('sync_project failed:', e))
        })
    }, 60)
  }

  let lastOriginals = useStore.getState().previewOriginal
  useStore.subscribe((s) => {
    if (s.project !== lastProject || s.previewOriginal !== lastOriginals) {
      lastProject = s.project
      lastOriginals = s.previewOriginal
      syncProject(s.project)
    }
    // Anchor discipline (foundation, Phase 5 find, round 2). The per-tick
    // anchor echo is load-bearing: it doubles as the GOVERNOR that paces the
    // Rust clock to real render capacity on over-budget footage (2×4K) —
    // removing it entirely sent the free-running clock ahead of the decoder
    // and spiralled 23fps → 1fps. The actual defect was the BACKWARD jitter
    // in the echo (wall-clock skew), which stepped decode targets behind the
    // pipe and forced respawns. Fix: keep per-tick anchors while playing but
    // clamp them MONOTONIC; real seeks (forward or back > 0.35s) reset.
    if (s.playhead !== lastPlayhead || s.playing !== lastPlaying || s.shuttle !== lastShuttle) {
      const transportChanged = s.playing !== lastPlaying || s.shuttle !== lastShuttle
      const bigJump = Math.abs(s.playhead - lastAnchorT) > 0.35
      let t = s.playhead
      if (s.playing && !transportChanged && !bigJump && s.shuttle > 0) {
        t = Math.max(t, lastAnchorT) // forward playback: never anchor backwards
      }
      lastAnchorT = t
      lastPlayhead = s.playhead
      lastPlaying = s.playing
      lastShuttle = s.shuttle
      void invoke('set_playhead', { t, playing: s.playing, rate: s.shuttle }).catch(() => {})
    }
  })

  // Initial push.
  const s = useStore.getState()
  syncProject(s.project)
  void invoke('set_playhead', { t: s.playhead, playing: s.playing, rate: s.shuttle }).catch(
    () => {},
  )

  // Self-demo mode (SPIKE_DEMO=1, debug builds): load and play the PiP demo
  // with no clicks, so the full webview→Rust loop is verifiable from logs.
  if (import.meta.env.DEV)
    void invoke<boolean>('autorun_demo')
      .then((yes) => {
        if (yes) return loadPipDemo().then(() => useStore.getState().play())
      })
      .catch(() => {})
}

export async function loadPipDemo() {
  const [screen, cam] = await invoke<[SpikeMedia, SpikeMedia]>('spike_setup')
  useStore.getState().setAppView('editor') // demo always lands in the editor
  useStore
    .getState()
    .loadPipDemo(
      { ...screen, playbackUrl: convertFileSrc(screen.path) },
      { ...cam, playbackUrl: convertFileSrc(cam.path) },
    )
}
