import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { beginAiTransaction, endAiTransaction, useStore } from '../state/store'
import { uid } from '../types/project'
import { buildTimelineContext, runTool, toolSpecs } from './tools'
import { installGenerateTool, installLayoutTool } from './layouts'

installLayoutTool() // set_layout registers alongside the core tools
installGenerateTool() // generate_video (Phase 6c)
import type { NeutralMsg, TurnEvents, TurnOutcome } from './types'

// The streamed AI turn, frontend side (Run 1, Phase 3).
// ONE PROMPT = ONE UNDO STEP: the whole turn runs inside an AI transaction;
// every tool the model calls coalesces into a single history entry, and the
// per-turn undo affordance in the chat is plain undo().

const SYSTEM = `You are the editing assistant inside Motionaire, a desktop video editor.
You edit the TIMELINE by calling tools — you never produce video frames.
Rules:
- Times are SECONDS on the timeline. "0:45" means 45.0.
- Use the timeline context for clip ids; call get_timeline if unsure.
- Make the edit immediately with tools, then summarize in ONE short sentence.
- Everything you do lands as one undo step; the user can revert instantly.
- If a request is impossible (no such clip, locked track), say why briefly.
- Never ask for confirmation; the edit itself is the answer.`

let history: NeutralMsg[] = []

export function resetSession(): void {
  history = []
}

export function sessionHistory(): NeutralMsg[] {
  return history
}

export function restoreSession(msgs: NeutralMsg[]): void {
  history = msgs
}

export async function startTurn(userText: string, events: TurnEvents): Promise<TurnOutcome> {
  const s = useStore.getState()
  const turnId = uid('turn')
  const provider = s.prefs.aiChatProvider
  const model = s.prefs.aiChatModel
  const context = buildTimelineContext()
  const userMsg: NeutralMsg = {
    role: 'user',
    text: `${userText}\n\n<timeline>\n${context}\n</timeline>`,
  }
  const outcome: TurnOutcome = { text: '', diffs: [], toolCalls: [], error: null, edited: false }

  beginAiTransaction()
  const unlisteners: UnlistenFn[] = []
  try {
    await new Promise<void>((resolve) => {
      let settled = false
      const settle = () => {
        if (!settled) {
          settled = true
          resolve()
        }
      }
      // Listeners registered BEFORE the send so no event can race past us.
      void Promise.all([
        listen<{ turnId: string; text: string }>('ai:delta', (e) => {
          if (e.payload.turnId !== turnId) return
          outcome.text += e.payload.text
          events.onDelta?.(e.payload.text)
        }),
        listen<{ turnId: string; calls: { callId: string; name: string; args: Record<string, unknown> }[] }>(
          'ai:tool_calls',
          (e) => {
            if (e.payload.turnId !== turnId) return
            const results = e.payload.calls.map((c) => {
              const r = runTool(c.name, c.args)
              outcome.toolCalls.push({ name: c.name, args: c.args, result: r })
              if (r.ok && r.diff) outcome.diffs.push(r.diff)
              events.onTool?.(c.name, r)
              return {
                call_id: c.callId,
                content: JSON.stringify({
                  ok: r.ok,
                  diff: r.diff,
                  warnings: r.warnings,
                  data: r.data,
                  error: r.error,
                }),
              }
            })
            void invoke('ai_tool_result', { turnId, results })
          },
        ),
        listen<{ turnId: string }>('ai:done', (e) => {
          if (e.payload.turnId === turnId) settle()
        }),
        listen<{ turnId: string; message: string }>('ai:error', (e) => {
          if (e.payload.turnId !== turnId) return
          outcome.error = e.payload.message
          settle()
        }),
      ]).then((fns) => {
        unlisteners.push(...fns)
        void invoke('ai_chat_send', {
          turnId,
          provider,
          model,
          system: SYSTEM,
          messages: [...history, userMsg],
          tools: toolSpecs(),
        }).catch((err) => {
          outcome.error = String(err)
          settle()
        })
      })
    })
  } finally {
    for (const un of unlisteners) un()
    outcome.edited = endAiTransaction()
  }

  // History keeps the RAW user text (context is rebuilt fresh each turn).
  history.push({ role: 'user', text: userText })
  history.push({ role: 'assistant', text: outcome.text || '(edited the timeline)' })
  return outcome
}

export function cancelTurn(turnId: string): void {
  void invoke('ai_cancel_turn', { turnId })
}
