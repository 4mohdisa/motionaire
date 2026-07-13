import { invoke } from '@tauri-apps/api/core'
import { save, message } from '@tauri-apps/plugin-dialog'
import { useStore } from '../state/store'
import type { Clip, Project } from '../types/project'
import { flatten } from './bridge'
import { resolveProp } from '../engine/keyframes'
import { clipDuration } from '../engine/time'

// Export job assembly (session 9, Phase 5). Video structure reuses flatten()
// — the exact payload the preview compositor renders, per CONTEXT.md §3.1.
// Audio is a clip list the Rust side turns into an FFmpeg filter graph.

interface AudioClipSpec {
  path: string
  in: number
  out: number
  speed: number
  start: number
  volume: number
  volumePoints: [number, number][]
}

function audioSpecs(project: Project): AudioClipSpec[] {
  const specs: AudioClipSpec[] = []
  for (const track of project.tracks) {
    const anySolo = project.tracks.some((t) => t.kind === track.kind && t.solo)
    if (track.muted || (anySolo && !track.solo)) continue
    for (const clip of track.clips) {
      if (!clip.mediaId) continue
      const asset = project.media.find((m) => m.id === clip.mediaId)
      if (!asset?.hasAudio || asset.missing || !asset.path.startsWith('/')) continue
      // Speed-ramped clips are video-only (time-varying audio tempo is not
      // representable in the filter graph — logged Phase 7 decision).
      if (clip.keyframes.some((k) => k.prop === 'speed')) continue
      const kfs = volumePoints(clip)
      // Silent-forever clips (e.g. detached video halves) add nothing but
      // an ffmpeg input — skip them.
      if (clip.volume <= 0 && kfs.every(([, v]) => v <= 0)) continue
      specs.push({
        path: asset.path,
        in: clip.in,
        out: clip.out,
        speed: clip.speed,
        start: clip.start,
        volume: clip.volume,
        volumePoints: kfs,
      })
    }
  }
  return specs
}

// Volume keyframes for the FFmpeg piecewise-LINEAR volume expression.
// Foundation Phase 1 parity fix: preview eases these curves, but a linear
// expr between raw keyframes ignored easing — export now samples the eased
// curve (through the parity-locked mirror) at 10Hz across any segment whose
// left keyframe has a non-linear ease.
function volumePoints(clip: Clip): [number, number][] {
  const kfs = clip.keyframes
    .filter((k) => k.prop === 'volume')
    .sort((a, b) => a.t - b.t)
  if (!kfs.length) return []
  if (kfs.every((k) => k.ease === 'linear')) return kfs.map((k) => [k.t, k.v])
  const out: [number, number][] = []
  const end = Math.min(kfs[kfs.length - 1].t, clipDuration(clip))
  const STEP = 0.1
  out.push([kfs[0].t, kfs[0].v])
  for (let t = kfs[0].t + STEP; t < end; t += STEP)
    out.push([Number(t.toFixed(4)), resolveProp(clip, 'volume', t)])
  out.push([end, resolveProp(clip, 'volume', end)])
  return out
}

export async function runExport(outPathOverride?: string): Promise<string | null> {
  const s = useStore.getState()
  if (s.project.duration <= 0) {
    await message('Nothing to export — the timeline is empty.', {
      title: 'Export',
      kind: 'warning',
    })
    return null
  }
  let outputPath = outPathOverride
  if (!outputPath) {
    const picked = await save({
      title: 'Export video',
      defaultPath: 'Export.mp4',
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    })
    if (!picked) return null
    outputPath = picked.endsWith('.mp4') ? picked : `${picked}.mp4`
  }
  await invoke('start_export', {
    project: flatten(s.project),
    audio: audioSpecs(s.project),
    settings: {
      outputPath,
      height: s.project.canvas.height,
      fps: s.project.canvas.fps,
      duration: s.project.duration,
      quality: s.exportSettings.quality,
    },
  })
  return outputPath
}
