import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { useStore } from '../state/store'
import type { Project } from '../types/project'

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
function flatten(project: Project) {
  const layers = []
  for (const track of project.tracks) {
    if (track.kind !== 'video') continue
    for (const clip of track.clips) {
      if (clip.kind !== 'video' || !clip.mediaId) continue
      const asset = project.media.find((m) => m.id === clip.mediaId)
      if (!asset || !asset.path.startsWith('/')) continue
      layers.push({
        id: clip.id,
        z: track.z,
        mediaPath: asset.path,
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
        },
        keyframes: clip.keyframes,
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

export function startCompositorBridge() {
  if (!isTauri) return

  let syncTimer: number | undefined
  let lastProject: Project | null = null
  let lastPlayhead = -1
  let lastPlaying = false

  const syncProject = (project: Project) => {
    window.clearTimeout(syncTimer)
    syncTimer = window.setTimeout(() => {
      void invoke('sync_project', { project: flatten(project) }).catch((e) =>
        console.error('sync_project failed:', e),
      )
    }, 60)
  }

  useStore.subscribe((s) => {
    if (s.project !== lastProject) {
      lastProject = s.project
      syncProject(s.project)
    }
    if (s.playhead !== lastPlayhead || s.playing !== lastPlaying) {
      lastPlayhead = s.playhead
      lastPlaying = s.playing
      void invoke('set_playhead', { t: s.playhead, playing: s.playing }).catch(() => {})
    }
  })

  // Initial push.
  const s = useStore.getState()
  syncProject(s.project)
  void invoke('set_playhead', { t: s.playhead, playing: s.playing }).catch(() => {})

  // Self-demo mode (SPIKE_DEMO=1): load and play the PiP demo with no clicks,
  // so the full webview→Rust loop is verifiable from logs alone.
  void invoke<boolean>('autorun_demo')
    .then((yes) => {
      if (yes) return loadPipDemo().then(() => useStore.getState().play())
    })
    .catch(() => {})
}

export async function loadPipDemo() {
  const [screen, cam] = await invoke<[SpikeMedia, SpikeMedia]>('spike_setup')
  useStore
    .getState()
    .loadPipDemo(
      { ...screen, playbackUrl: convertFileSrc(screen.path) },
      { ...cam, playbackUrl: convertFileSrc(cam.path) },
    )
}
