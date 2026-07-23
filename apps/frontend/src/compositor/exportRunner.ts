import { invoke } from '@tauri-apps/api/core'
import { save, message } from '@tauri-apps/plugin-dialog'
import { useStore } from '../state/store'
import type { Clip, Project } from '../types/project'
import { flatten } from './bridge'
import { resolveProp } from '../engine/keyframes'
import { audioFxChain } from '../engine/audioFx'
import { effectiveProject } from '../engine/compound'
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
  pan: number
  fx: string[]
  track: string
  trackFx: string[]
}

// Clamp clips to the export range and re-express them range-relative, so
// the Rust graph needs no range awareness at all (foundation, Phase 6).
function audioSpecs(projectRaw: Project, rangeStart: number, rangeEnd: number): AudioClipSpec[] {
  const project = effectiveProject(projectRaw)
  const specs: AudioClipSpec[] = []
  for (const track of project.tracks) {
    const anySolo = project.tracks.some((t) => t.kind === track.kind && t.solo)
    if (track.muted || (anySolo && !track.solo)) continue
    const trackGain = track.gain ?? 1 // mixer fader (Phase 1) — must survive export
    for (const clip of track.clips) {
      if (!clip.mediaId || clip.disabled) continue
      const asset = project.media.find((m) => m.id === clip.mediaId)
      if (!asset?.hasAudio || asset.missing || !asset.path.startsWith('/')) continue
      // Speed-ramped clips are video-only (time-varying audio tempo is not
      // representable in the filter graph — logged Phase 7 decision).
      if (clip.keyframes.some((k) => k.prop === 'speed')) continue
      const kfs = volumePoints(clip)
      // Silent-forever clips (e.g. detached video halves) add nothing but
      // an ffmpeg input — skip them.
      if (clip.volume <= 0 && kfs.every(([, v]) => v <= 0)) continue
      const clipEndT = clip.start + (clip.out - clip.in) / clip.speed
      if (clipEndT <= rangeStart || clip.start >= rangeEnd) continue
      const winStart = Math.max(clip.start, rangeStart)
      const winEnd = Math.min(clipEndT, rangeEnd)
      const inAdj = clip.in + (winStart - clip.start) * clip.speed
      const outAdj = clip.in + (winEnd - clip.start) * clip.speed
      const shift = winStart - clip.start // kf times are clip-relative
      specs.push({
        path: asset.path,
        in: inAdj,
        out: outAdj,
        speed: clip.speed,
        start: winStart - rangeStart,
        volume: clip.volume * trackGain,
        volumePoints: kfs.map(([t, v]) => [t - shift, v * trackGain] as [number, number]),
        // Audio effect chains (Phase 6): clip stack + track stack as ffmpeg
        // fragments — the same audioFxFilter mapper the preview mirrors.
        fx: audioFxChain(clip.effects),
        track: track.id,
        trackFx: audioFxChain(track.effects ?? []),
        pan: clip.pan ?? 0,
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
  const kfs = clip.keyframes.filter((k) => k.prop === 'volume').sort((a, b) => a.t - b.t)
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
  const format = s.exportSettings.format
  const ext =
    format === 'hevc' ? 'mp4' : format === 'prores' ? 'mov' : format === 'm4a' ? 'm4a' : format
  let outputPath = outPathOverride
  if (!outputPath) {
    const picked = await save({
      title: 'Export',
      defaultPath: `Export.${ext}`,
      filters: [{ name: format.toUpperCase(), extensions: [ext] }],
    })
    if (!picked) return null
    outputPath = picked.endsWith(`.${ext}`) ? picked : `${picked}.${ext}`
  }
  // Export range (foundation, Phase 6): between the timeline in/out marks
  // when both are set; the whole timeline otherwise.
  const hasRange = s.markIn !== null && s.markOut !== null && s.markOut > s.markIn
  const rangeStart = hasRange ? s.markIn! : 0
  const rangeEnd = hasRange ? s.markOut! : s.project.duration
  await invoke('start_export', {
    project: flatten(s.project, { originals: true }), // export NEVER decodes proxies
    audio: audioSpecs(s.project, rangeStart, rangeEnd),
    settings: {
      outputPath,
      height: s.exportSettings.height || s.project.canvas.height,
      fps: s.exportSettings.fps || s.project.canvas.fps,
      duration: rangeEnd - rangeStart,
      start: rangeStart,
      format,
      quality: s.exportSettings.quality,
      masterVolume: s.project.masterVolume ?? 1,
      // Chapter markers inside the export range, re-based (Phase 8).
      chapters: (s.project.markers ?? [])
        .filter((m) => m.t >= rangeStart && m.t < rangeEnd)
        .sort((a, b) => a.t - b.t)
        .map((m) => [m.t - rangeStart, m.label || 'Chapter'] as [number, string]),
    },
  })
  return outputPath
}
