import { invoke } from '@tauri-apps/api/core'
import { useStore } from '../state/store'

// AI settings helpers (Run 1, Phase 2). Keys go straight to Rust
// (ai_set_key) and are never held in JS state — the ONLY thing the webview
// ever learns is a boolean.

export const CHAT_MODELS: Record<string, string[]> = {
  // Verified against live provider docs 2026-07-18 (see ai/mod.rs header).
  anthropic: ['claude-sonnet-4-5', 'claude-opus-4-6', 'claude-haiku-4-5'],
  openai: ['gpt-5.4', 'gpt-5.6-sol', 'gpt-5-mini', 'gpt-4o'],
  mock: ['mock'],
}

export async function refreshAiConfigured(): Promise<void> {
  const s = useStore.getState()
  const p = s.prefs.aiChatProvider
  if (p === 'mock') {
    s.setAiConfigured(true)
    return
  }
  const has = await invoke<boolean>('ai_has_key', { provider: p }).catch(() => false)
  s.setAiConfigured(has)
}

export async function saveAiKey(provider: string, key: string): Promise<void> {
  await invoke('ai_set_key', { provider, key })
  await refreshAiConfigured()
}

export async function clearAiKey(provider: string): Promise<void> {
  await invoke('ai_clear_key', { provider })
  await refreshAiConfigured()
}

export async function testConnection(provider: string, model?: string): Promise<string> {
  return invoke<string>('ai_test_connection', { provider, model: model ?? null })
}
