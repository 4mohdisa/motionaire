import { invoke, convertFileSrc } from '@tauri-apps/api/core'
import { open, save, message } from '@tauri-apps/plugin-dialog'
import { useStore } from '../state/store'
import type { MediaAsset, Project } from '../types/project'
import { uid } from '../types/project'
import { isTauri } from '../compositor/bridge'

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
    })
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
    const { projectJson, missingMedia } = await invoke<{
      projectJson: string
      missingMedia: string[]
    }>('load_project', { bundlePath: path, name: bundleName(path) })
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
