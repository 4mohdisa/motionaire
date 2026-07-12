import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { open, save, message } from '@tauri-apps/plugin-dialog'
import { useStore } from '../state/store'
import type { MediaAsset, Project } from '../types/project'
import { uid } from '../types/project'
import { isTauri } from '../compositor/bridge'
import { persistFonts, restoreFonts, type BundleFont } from './fontManager'

// Project bundle I/O (CONTEXT.md §8.1). The bundle is a `Name.motionaire/`
// directory; Rust owns the crash-safe writes and the recents DB.

interface ProbeResult {
  width: number
  height: number
  fps: number
  duration: number
  hasAudio: boolean
}

export interface RecentProject {
  path: string
  name: string
  lastOpenedAt: number
  thumbnail: string | null
  missing: boolean
}

// Launcher thumbnail: downscale the composite canvas (it holds the last
// rendered frame even while paused) to a small JPEG.
function grabThumb(): string | null {
  const src = document.querySelector<HTMLCanvasElement>('.preview__composite')
  if (!src || src.width === 0 || src.height === 0) return null
  try {
    const w = 320
    const h = Math.max(1, Math.round((src.height / src.width) * w))
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    c.getContext('2d')!.drawImage(src, 0, 0, w, h)
    return c.toDataURL('image/jpeg', 0.72).split(',')[1] ?? null
  } catch {
    return null
  }
}

function bundleName(path: string): string {
  const base = path.split('/').filter(Boolean).pop() ?? 'Project'
  return base.replace(/\.motionaire$/, '')
}

// Transient fields never hit disk; playbackUrl/missing are rebuilt on load.
export function serializeProject(p: Project): string {
  const clean = {
    ...p,
    media: p.media.map((m) => {
      const rest = { ...m }
      delete rest.playbackUrl
      delete rest.missing
      return rest
    }),
  }
  return JSON.stringify(clean, null, 2)
}

export async function saveProject(saveAs = false): Promise<boolean> {
  const s = useStore.getState()
  let path = s.projectPath
  if (!path || saveAs) {
    const picked = await save({
      title: 'Save project',
      defaultPath: 'Untitled.motionaire',
    })
    if (!picked) return false
    path = picked.endsWith('.motionaire') ? picked : `${picked}.motionaire`
  }
  try {
    await invoke('save_project', {
      bundlePath: path,
      projectJson: serializeProject(s.project),
      name: bundleName(path),
      thumbJpegBase64: grabThumb(),
    })
    await persistFonts(path)
    useStore.getState().setProjectPath(path)
    return true
  } catch (e) {
    await message(`Couldn't save project:\n${e}`, { title: 'Save failed', kind: 'error' })
    return false
  }
}

export async function openProject(): Promise<void> {
  const picked = await open({
    title: 'Open project (.motionaire folder)',
    directory: true,
    multiple: false,
  })
  if (typeof picked === 'string') await openProjectPath(picked)
}

export async function openProjectPath(path: string): Promise<void> {
  try {
    const { projectJson, missingMedia, fonts } = await invoke<{
      projectJson: string
      missingMedia: string[]
      fonts: BundleFont[]
    }>('load_project', { bundlePath: path, name: bundleName(path) })
    await restoreFonts(fonts ?? [])
    const project = JSON.parse(projectJson) as Project
    const missing = new Set(missingMedia)
    for (const m of project.media) {
      if (m.path.startsWith('/') && !missing.has(m.path)) {
        m.playbackUrl = convertFileSrc(m.path)
      } else {
        // Gone from disk, or a dead object URL from a browser-side import.
        m.missing = true
        m.playbackUrl = undefined
      }
    }
    useStore.getState().replaceProject(project, path)
    useStore.getState().setAppView('editor')
    if (missing.size > 0) {
      // Non-blocking: the warning must not stall the editor (or self-tests).
      void message(
        `${missing.size} media file(s) are missing on disk and are shown as offline:\n\n${[...missing].join('\n')}`,
        { title: 'Missing media', kind: 'warning' },
      )
    }
  } catch (e) {
    await message(`Couldn't open project:\n${e}`, { title: 'Open failed', kind: 'error' })
  }
}

export async function listRecents(): Promise<RecentProject[]> {
  if (!isTauri) return []
  try {
    return await invoke<RecentProject[]>('list_recent_projects')
  } catch {
    return []
  }
}

// Freeze frame: extract a still at the playhead's source time and drop it on
// the topmost video track as an image clip. The PNG lives in the app cache —
// same absolute-path model as every other media file.
export async function freezeFrame(clipId: string): Promise<void> {
  const s = useStore.getState()
  const clip = s.project.tracks.flatMap((t) => t.clips).find((c) => c.id === clipId)
  const asset = clip?.mediaId ? s.project.media.find((m) => m.id === clip.mediaId) : null
  if (!clip || !asset || asset.missing) return
  const local = Math.max(0, Math.min(s.playhead - clip.start, (clip.out - clip.in) / clip.speed))
  const srcT = clip.in + local * clip.speed
  try {
    const res = await invoke<{ path: string; width: number; height: number }>('extract_frame', {
      path: asset.path,
      time: srcT,
    })
    s.addStillClip(
      {
        id: uid('m'),
        path: res.path,
        playbackUrl: convertFileSrc(res.path),
        name: `${asset.name} (freeze)`,
        kind: 'video',
        // ponytail: stills have no intrinsic length; a huge source duration
        // makes trim limits a non-issue with zero special cases.
        duration: 3600,
        width: res.width,
        height: res.height,
        hasAudio: false,
      },
      s.playhead,
    )
  } catch (e) {
    await message(`Couldn't extract frame:\n${e}`, { title: 'Freeze frame failed', kind: 'error' })
  }
}

// Add an image as a still clip at the playhead (session 9, Phase 3 Add menu).
export async function importImageNative(): Promise<void> {
  const picked = await open({
    title: 'Add image',
    multiple: false,
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
  })
  if (typeof picked !== 'string') return
  try {
    const info = await invoke<ProbeResult>('probe_media', { path: picked })
    const s = useStore.getState()
    const asset: MediaAsset = {
      id: uid('m'),
      path: picked,
      playbackUrl: convertFileSrc(picked),
      name: picked.split('/').pop() ?? picked,
      kind: 'video',
      duration: 3600, // still convention (see freeze frame)
      width: info.width || undefined,
      height: info.height || undefined,
      hasAudio: false,
    }
    s.addMedia(asset)
    s.insertClipAt(asset.id, null, s.playhead)
  } catch (e) {
    await message(`Couldn't add image:\n${e}`, { title: 'Add image failed', kind: 'error' })
  }
}

// Native media import: real file paths that survive reloads, probed by ffprobe.
export async function importMediaNative(): Promise<void> {
  const picked = await open({
    title: 'Import media',
    multiple: true,
    filters: [
      {
        name: 'Media',
        extensions: ['mp4', 'mov', 'webm', 'mkv', 'm4v', 'mp3', 'wav', 'm4a', 'aac', 'flac'],
      },
    ],
  })
  if (!picked) return
  const paths = Array.isArray(picked) ? picked : [picked]
  for (const path of paths) {
    try {
      const info = await invoke<ProbeResult>('probe_media', { path })
      const asset: MediaAsset = {
        id: uid('m'),
        path,
        playbackUrl: convertFileSrc(path),
        name: path.split('/').pop() ?? path,
        kind: info.width > 0 ? 'video' : 'audio',
        duration: info.duration,
        width: info.width || undefined,
        height: info.height || undefined,
        fps: info.fps || undefined,
        hasAudio: info.hasAudio,
      }
      const { addMedia, appendMediaClip } = useStore.getState()
      addMedia(asset)
      appendMediaClip(asset.id)
    } catch (e) {
      await message(`Couldn't import ${path}:\n${e}`, { title: 'Import failed', kind: 'error' })
    }
  }
}
