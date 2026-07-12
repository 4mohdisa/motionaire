import type { MediaAsset } from '../types/project'
import { uid } from '../types/project'
import { useStore } from '../state/store'
import { getWaveform } from '../engine/waveform'

// Media import without the Rust side: <input type="file"> → object URL.
// Real file-path import (Tauri dialog + fs) arrives with the native session.

function probeMetadata(url: string): Promise<{ duration: number; width?: number; height?: number }> {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video')
    v.preload = 'metadata'
    v.src = url
    const fail = setTimeout(() => reject(new Error('metadata timeout')), 15000)
    v.onerror = () => {
      clearTimeout(fail)
      reject(new Error('unsupported media'))
    }
    v.onloadedmetadata = () => {
      if (Number.isFinite(v.duration)) {
        clearTimeout(fail)
        resolve({ duration: v.duration, width: v.videoWidth || undefined, height: v.videoHeight || undefined })
        return
      }
      // MediaRecorder-produced webm (screen recordings) reports Infinity until
      // seeked far past the end — the standard workaround.
      v.currentTime = 1e101
      v.ontimeupdate = () => {
        v.ontimeupdate = null
        clearTimeout(fail)
        resolve({ duration: v.duration, width: v.videoWidth || undefined, height: v.videoHeight || undefined })
      }
    }
  })
}

export async function importFile(file: File): Promise<MediaAsset> {
  const url = URL.createObjectURL(file)
  const meta = await probeMetadata(url)
  const asset: MediaAsset = {
    id: uid('m'),
    path: url,
    name: file.name,
    kind: file.type.startsWith('audio/') ? 'audio' : 'video',
    duration: meta.duration,
    width: meta.width,
    height: meta.height,
    hasAudio: true, // optimistic; corrected below once decode finishes
  }
  const { addMedia, appendMediaClip, updateMedia } = useStore.getState()
  addMedia(asset)
  appendMediaClip(asset.id)
  // Waveform decode doubles as audio detection; runs in the background, cached.
  void getWaveform(asset).then((wf) => updateMedia(asset.id, { hasAudio: wf !== null }))
  return asset
}

// Dev-only: lets scripted browser tests import generated Files directly.
if (import.meta.env.DEV) {
  const w = window as unknown as { __motionaire?: Record<string, unknown> }
  w.__motionaire = { ...w.__motionaire, importFile }
}

export function openImportDialog() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'video/*,audio/*'
  input.multiple = true
  input.onchange = async () => {
    for (const file of Array.from(input.files ?? [])) {
      try {
        await importFile(file)
      } catch (e) {
        console.error(`Failed to import ${file.name}:`, e)
      }
    }
  }
  input.click()
}
