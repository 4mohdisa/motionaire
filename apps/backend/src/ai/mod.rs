// AI layer (Run 1, Phase 2+3). THE RULES (PLAN_RUN_1):
// - API keys live in the OS keychain and are read ONLY by Rust. They never
//   enter the webview, never appear in logs, never touch SQLite/plaintext.
//   Same discipline as the license key.
// - All provider HTTP happens here; the frontend sends intent and receives
//   streamed results over Tauri events.
//
// Built against live docs on 2026-07-18 (both fetched, not remembered):
// - Anthropic Messages API: POST https://api.anthropic.com/v1/messages,
//   headers x-api-key + anthropic-version: 2023-06-01; tools carry
//   input_schema (JSON Schema); tool_use / tool_result content blocks;
//   SSE: message_start / content_block_start / content_block_delta /
//   content_block_stop / message_delta / message_stop.
// - OpenAI Chat Completions: POST https://api.openai.com/v1/chat/completions,
//   Authorization: Bearer; tools [{type:"function",function:{name,
//   description,parameters}}]; assistant tool_calls carry JSON-STRING
//   arguments; results go back as role:"tool" messages; stream:true SSE
//   with choices[].delta chunks.

pub mod chat;
pub mod keys;
pub mod videogen;

// Providers the settings UI can select. Keys are stored per provider id.
pub const CHAT_PROVIDERS: [&str; 2] = ["anthropic", "openai"];
pub const VIDEO_PROVIDERS: [&str; 2] = ["seedance", "gemini"];

pub fn valid_provider(id: &str) -> bool {
    CHAT_PROVIDERS.contains(&id) || VIDEO_PROVIDERS.contains(&id) || id == "ai-test"
}
