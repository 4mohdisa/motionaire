import type { ToolResult } from './tools'

// Neutral message model — mirrors ai/turn.rs NeutralMsg (serde camel/snake
// note: field names match exactly; both sides use snake_case keys here).
export interface NeutralMsg {
  role: 'user' | 'assistant'
  text?: string
  tool_calls?: { id: string; name: string; args: Record<string, unknown> }[]
  tool_results?: { call_id: string; content: string }[]
}

export interface TurnEvents {
  onDelta?: (text: string) => void
  onTool?: (name: string, result: ToolResult) => void
}

export interface TurnOutcome {
  text: string
  diffs: string[]
  toolCalls: { name: string; args: Record<string, unknown>; result: ToolResult }[]
  error: string | null
  edited: boolean
}
