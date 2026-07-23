import { invoke } from '@tauri-apps/api/core'
import { useStore, type ChatEntry } from '../state/store'
import { uid } from '../types/project'
import { restoreSession, startTurn } from './chatSession'
import type { NeutralMsg } from './types'

// Chat controller (Run 1, Phase 4): drives startTurn, mirrors progress into
// the store's chatLog, and persists each completed exchange to the bundle's
// history.jsonl (one JSON object per line, replayed in order on load).

export async function sendChat(userText: string): Promise<void> {
  const s = useStore.getState()
  if (s.chatBusy || !userText.trim()) return
  s.setChatBusy(true)
  s.pushChatEntry({ id: uid('m'), role: 'user', text: userText })
  const asstId = uid('m')
  s.pushChatEntry({ id: asstId, role: 'assistant', text: '', streaming: true })

  try {
    const outcome = await startTurn(userText, {
      onDelta: (t) => {
        const cur = useStore.getState().chatLog.find((e) => e.id === asstId)
        useStore.getState().updateChatEntry(asstId, { text: (cur?.text ?? '') + t })
      },
      onTool: (name, r) => {
        const cur = useStore.getState().chatLog.find((e) => e.id === asstId)
        useStore.getState().updateChatEntry(asstId, {
          toolCalls: [
            ...(cur?.toolCalls ?? []),
            { name, ok: r.ok, detail: r.ok ? r.diff : r.error },
          ],
        })
      },
    })
    // Re-getState after the turn (house rule).
    const st2 = useStore.getState()
    st2.updateChatEntry(asstId, {
      streaming: false,
      text: st2.chatLog.find((e) => e.id === asstId)?.text || (outcome.error ? '' : 'Done.'),
      diffs: outcome.diffs,
      error: outcome.error ?? undefined,
      edited: outcome.edited,
      undoDepth: outcome.edited ? st2.past.length : undefined,
    })
    await persistExchange(
      userText,
      st2.chatLog.find((e) => e.id === asstId)!,
    )
  } catch (e) {
    useStore.getState().updateChatEntry(asstId, { streaming: false, error: String(e) })
  } finally {
    useStore.getState().setChatBusy(false)
  }
}

async function persistExchange(userText: string, assistant: ChatEntry): Promise<void> {
  const path = useStore.getState().projectPath
  if (!path) return // untitled projects persist on first save via replay below
  const line = JSON.stringify({
    at: Date.now(),
    user: userText,
    assistant: assistant.text,
    diffs: assistant.diffs ?? [],
    error: assistant.error ?? null,
  })
  await invoke('ai_history_append', { bundlePath: path, line }).catch(() => {})
}

/// Rebuild the chat log + model session from the bundle's history.jsonl.
export async function loadChatHistory(bundlePath: string): Promise<void> {
  const lines = await invoke<string[]>('ai_history_read', { bundlePath }).catch(() => [])
  const log: ChatEntry[] = []
  const session: NeutralMsg[] = []
  for (const line of lines) {
    try {
      const j = JSON.parse(line) as {
        user?: string
        assistant?: string
        diffs?: string[]
        error?: string | null
      }
      if (typeof j.user === 'string') {
        log.push({ id: uid('m'), role: 'user', text: j.user })
        session.push({ role: 'user', text: j.user })
      }
      if (typeof j.assistant === 'string') {
        log.push({
          id: uid('m'),
          role: 'assistant',
          text: j.assistant,
          diffs: j.diffs,
          error: j.error ?? undefined,
        })
        session.push({ role: 'assistant', text: j.assistant })
      }
    } catch {
      // A corrupt line must never break project load.
    }
  }
  useStore.getState().setChatLog(log)
  restoreSession(session)
}

export function clearChat(): void {
  useStore.getState().setChatLog([])
  restoreSession([])
}
