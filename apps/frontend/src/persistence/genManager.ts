import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { useStore } from '../state/store'
import { isTauri } from '../compositor/bridge'

// AI video generation, frontend side (Run 1, Phase 6). Jobs run in Rust
// (minutes-long, proxy-pattern); completions run the FULL import pipeline
// (VFR normalize, probe, proxy) and land in the bin flagged aiGenerated.

const GEN_TOAST = 'videogen-job'

export interface GenParams {
  prompt: string
  durationSecs: number
  aspect: string
  placeAt?: number
}

export async function startGeneration(params: GenParams): Promise<void> {
  const s = useStore.getState()
  const provider =
    s.prefs.aiVideoProvider === 'none' ? 'mockgen' : s.prefs.aiVideoProvider
  s.pushToast('progress', `Generating video — "${params.prompt.slice(0, 40)}…"`, GEN_TOAST)
  await invoke('ai_generate_video', {
    req: {
      provider,
      prompt: params.prompt,
      duration_secs: params.durationSecs,
      aspect: params.aspect,
      place_at: params.placeAt ?? null,
    },
  }).catch((e) => {
    s.dismissToast(GEN_TOAST)
    s.pushToast('error', `Couldn't start generation: ${e}`)
  })
}

let started = false
export function startGenListeners(): void {
  if (!isTauri || started) return
  started = true
  void listen<{ state: string; secs?: number }>('videogen:progress', (e) => {
    useStore
      .getState()
      .updateToast(GEN_TOAST, {
        text: `Generating video — ${e.payload.state}${e.payload.secs ? ` (${e.payload.secs}s)` : ''}`,
      })
  })
  void listen<{ path: string; prompt: string; placeAt: number | null }>(
    'videogen:done',
    (e) => {
      void (async () => {
        const s = useStore.getState()
        s.dismissToast(GEN_TOAST)
        const { importPathAsAsset } = await import('./projectIO')
        const asset = await importPathAsAsset(e.payload.path, { aiGenerated: true })
        if (!asset) return
        const s2 = useStore.getState() // re-getState after the import wrote
        if (e.payload.placeAt !== null && e.payload.placeAt !== undefined) {
          s2.insertClipAt(asset.id, null, e.payload.placeAt)
          s2.pushToast('success', `AI clip placed at ${e.payload.placeAt.toFixed(1)}s`)
        } else {
          s2.pushToast('success', `AI clip ready — ${asset.name}`, undefined, {
            label: 'Add at playhead',
            onClick: () => {
              const s3 = useStore.getState()
              s3.insertClipAt(asset.id, null, s3.playhead)
            },
          })
        }
      })()
    },
  )
  void listen<{ error: string; prompt: string }>('videogen:failed', (e) => {
    const s = useStore.getState()
    s.dismissToast(GEN_TOAST)
    // The real error, and the prompt survives in the panel for retry.
    s.pushToast('error', `Generation failed: ${e.payload.error}`)
    s.setLastGenPrompt(e.payload.prompt)
  })
}
