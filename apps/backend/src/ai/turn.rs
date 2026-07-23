// The streamed AI turn loop (Run 1, Phase 3).
//
// Split across the IPC boundary BY DESIGN: providers are called from Rust
// (keys never leave here), but tools execute in the WEBVIEW because the
// zustand store is the single mutation authority (no second-class AI).
//
//   frontend ai_chat_send ─▶ [thread: provider round]
//        ◀─ ai:delta {text}            (streamed prose)
//        ◀─ ai:tool_call {id,name,args}  … frontend runs the tool on the store
//   frontend ai_tool_result ─▶ (channel) ─▶ next provider round
//        ◀─ ai:done {stop} / ai:error {message}
//
// A turn ends when the model stops without tool calls, errs, or hits
// MAX_ROUNDS (runaway guard — surfaced honestly, never silent).

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::Mutex;
use tauri::Emitter;

pub const MAX_ROUNDS: usize = 12;

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct ToolSpec {
    pub name: String,
    pub description: String,
    pub schema: Value,
}

#[derive(Clone, Serialize, Deserialize, Debug, Default)]
pub struct NeutralMsg {
    pub role: String, // user | assistant
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub tool_calls: Vec<NeutralCall>,
    #[serde(default)]
    pub tool_results: Vec<NeutralResult>,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct NeutralCall {
    pub id: String,
    pub name: String,
    pub args: Value,
}

#[derive(Clone, Serialize, Deserialize, Debug)]
pub struct NeutralResult {
    pub call_id: String,
    pub content: String,
}

/// One provider round: stream, emitting deltas via `emit`; return the
/// assistant message (text + any complete tool calls).
pub trait TurnProvider: Send {
    fn round(
        &self,
        model: &str,
        system: &str,
        messages: &[NeutralMsg],
        tools: &[ToolSpec],
        emit: &mut dyn FnMut(&str),
    ) -> Result<NeutralMsg, String>;
}

// Turns parked waiting for tool results from the webview.
pub struct TurnHub {
    waiting: Mutex<HashMap<String, Sender<Vec<NeutralResult>>>>,
    cancelled: Mutex<HashMap<String, bool>>,
}

impl Default for TurnHub {
    fn default() -> Self {
        Self {
            waiting: Mutex::new(HashMap::new()),
            cancelled: Mutex::new(HashMap::new()),
        }
    }
}

impl TurnHub {
    pub fn park(&self, turn_id: &str) -> Receiver<Vec<NeutralResult>> {
        let (tx, rx) = channel();
        self.waiting.lock().unwrap().insert(turn_id.to_string(), tx);
        rx
    }
    pub fn deliver(&self, turn_id: &str, results: Vec<NeutralResult>) -> Result<(), String> {
        let tx = self
            .waiting
            .lock()
            .unwrap()
            .remove(turn_id)
            .ok_or_else(|| format!("no turn '{turn_id}' awaiting results"))?;
        tx.send(results).map_err(|e| e.to_string())
    }
    pub fn cancel(&self, turn_id: &str) {
        self.cancelled
            .lock()
            .unwrap()
            .insert(turn_id.to_string(), true);
        // Unpark with empty results so the thread can observe the flag.
        let _ = self.deliver(turn_id, Vec::new());
    }
    fn is_cancelled(&self, turn_id: &str) -> bool {
        self.cancelled
            .lock()
            .unwrap()
            .remove(turn_id)
            .unwrap_or(false)
    }
}

#[allow(clippy::too_many_arguments)]
pub fn run_turn(
    app: tauri::AppHandle,
    hub: std::sync::Arc<TurnHub>,
    turn_id: String,
    provider_id: String,
    model: String,
    system: String,
    mut messages: Vec<NeutralMsg>,
    tools: Vec<ToolSpec>,
) {
    std::thread::Builder::new()
        .name("ai-turn".into())
        .spawn(move || {
            let provider: Box<dyn TurnProvider> = match provider_id.as_str() {
                "anthropic" => Box::new(AnthropicTurn),
                "openai" => Box::new(OpenAiTurn),
                "mock" => Box::new(MockTurn),
                other => {
                    let _ = app.emit(
                        "ai:error",
                        json!({ "turnId": turn_id, "message": format!("unknown provider {other}") }),
                    );
                    return;
                }
            };
            for _round in 0..MAX_ROUNDS {
                let mut emit_delta = |text: &str| {
                    let _ = app.emit("ai:delta", json!({ "turnId": turn_id, "text": text }));
                };
                let assistant =
                    match provider.round(&model, &system, &messages, &tools, &mut emit_delta) {
                        Ok(m) => m,
                        Err(e) => {
                            let _ = app
                                .emit("ai:error", json!({ "turnId": turn_id, "message": e }));
                            return;
                        }
                    };
                if assistant.tool_calls.is_empty() {
                    messages.push(assistant);
                    let _ = app.emit("ai:done", json!({ "turnId": turn_id, "stop": "end" }));
                    return;
                }
                // Ask the webview to run the tools against the store — ONE
                // batched event so the frontend knows the round is complete.
                let rx = hub.park(&turn_id);
                let _ = app.emit(
                    "ai:tool_calls",
                    json!({ "turnId": turn_id, "calls": assistant.tool_calls.iter().map(|c| json!({
                        "callId": c.id, "name": c.name, "args": c.args
                    })).collect::<Vec<_>>() }),
                );
                messages.push(assistant);
                let results = match rx.recv_timeout(std::time::Duration::from_secs(120)) {
                    Ok(r) => r,
                    Err(_) => {
                        let _ = app.emit(
                            "ai:error",
                            json!({ "turnId": turn_id, "message": "tool execution timed out" }),
                        );
                        return;
                    }
                };
                if hub.is_cancelled(&turn_id) {
                    let _ = app.emit("ai:done", json!({ "turnId": turn_id, "stop": "cancelled" }));
                    return;
                }
                messages.push(NeutralMsg {
                    role: "user".into(),
                    tool_results: results,
                    ..Default::default()
                });
            }
            let _ = app.emit(
                "ai:error",
                json!({ "turnId": turn_id, "message": format!("stopped after {MAX_ROUNDS} tool rounds (runaway guard)") }),
            );
        })
        .expect("spawn ai turn");
}

fn http() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .expect("http client")
}

// ---------------------------------------------------------------------------
// Anthropic (Messages API, anthropic-version 2023-06-01 — live docs
// 2026-07-18; see ai/mod.rs header).
// ---------------------------------------------------------------------------
struct AnthropicTurn;

impl TurnProvider for AnthropicTurn {
    fn round(
        &self,
        model: &str,
        system: &str,
        messages: &[NeutralMsg],
        tools: &[ToolSpec],
        emit: &mut dyn FnMut(&str),
    ) -> Result<NeutralMsg, String> {
        let key = super::keys::get("anthropic").ok_or("No Anthropic API key saved")?;
        let wire_msgs: Vec<Value> = messages.iter().map(anthropic_msg).collect();
        let wire_tools: Vec<Value> = tools
            .iter()
            .map(|t| json!({ "name": t.name, "description": t.description, "input_schema": t.schema }))
            .collect();
        let resp = http()
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
            .json(&json!({
                "model": model,
                "max_tokens": 4096,
                "system": system,
                "messages": wire_msgs,
                "tools": wire_tools,
                "stream": true
            }))
            .send()
            .map_err(|e| format!("No network: {e}"))?;
        if !resp.status().is_success() {
            return Err(super::chat::explain_status(resp));
        }

        let mut out = NeutralMsg {
            role: "assistant".into(),
            ..Default::default()
        };
        let mut text = String::new();
        // In-flight tool_use block: (id, name, partial_json)
        let mut open_call: Option<(String, String, String)> = None;
        let reader = BufReader::new(resp);
        for line in reader.lines() {
            let line = line.map_err(|e| e.to_string())?;
            let Some(data) = line.strip_prefix("data: ") else {
                continue;
            };
            let Ok(ev) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            match ev["type"].as_str().unwrap_or("") {
                "content_block_start" => {
                    let block = &ev["content_block"];
                    if block["type"] == "tool_use" {
                        open_call = Some((
                            block["id"].as_str().unwrap_or_default().to_string(),
                            block["name"].as_str().unwrap_or_default().to_string(),
                            String::new(),
                        ));
                    }
                }
                "content_block_delta" => {
                    let delta = &ev["delta"];
                    match delta["type"].as_str().unwrap_or("") {
                        "text_delta" => {
                            let t = delta["text"].as_str().unwrap_or_default();
                            text.push_str(t);
                            emit(t);
                        }
                        "input_json_delta" => {
                            if let Some((_, _, buf)) = open_call.as_mut() {
                                buf.push_str(delta["partial_json"].as_str().unwrap_or_default());
                            }
                        }
                        _ => {}
                    }
                }
                "content_block_stop" => {
                    if let Some((id, name, buf)) = open_call.take() {
                        let args = if buf.trim().is_empty() {
                            json!({})
                        } else {
                            serde_json::from_str(&buf)
                                .map_err(|e| format!("bad tool args from model: {e}"))?
                        };
                        out.tool_calls.push(NeutralCall { id, name, args });
                    }
                }
                "error" => {
                    return Err(ev["error"]["message"]
                        .as_str()
                        .unwrap_or("provider stream error")
                        .to_string());
                }
                _ => {}
            }
        }
        out.text = (!text.is_empty()).then_some(text);
        Ok(out)
    }
}

fn anthropic_msg(m: &NeutralMsg) -> Value {
    if !m.tool_results.is_empty() {
        return json!({
            "role": "user",
            "content": m.tool_results.iter().map(|r| json!({
                "type": "tool_result",
                "tool_use_id": r.call_id,
                "content": r.content
            })).collect::<Vec<_>>()
        });
    }
    if !m.tool_calls.is_empty() {
        let mut content = Vec::new();
        if let Some(t) = &m.text {
            content.push(json!({ "type": "text", "text": t }));
        }
        for c in &m.tool_calls {
            content
                .push(json!({ "type": "tool_use", "id": c.id, "name": c.name, "input": c.args }));
        }
        return json!({ "role": m.role, "content": content });
    }
    json!({ "role": m.role, "content": m.text.clone().unwrap_or_default() })
}

// ---------------------------------------------------------------------------
// OpenAI (Chat Completions — live docs 2026-07-18; tool_calls arguments are
// JSON STRINGS, streamed in fragments keyed by index).
// ---------------------------------------------------------------------------
struct OpenAiTurn;

impl TurnProvider for OpenAiTurn {
    fn round(
        &self,
        model: &str,
        system: &str,
        messages: &[NeutralMsg],
        tools: &[ToolSpec],
        emit: &mut dyn FnMut(&str),
    ) -> Result<NeutralMsg, String> {
        let key = super::keys::get("openai").ok_or("No OpenAI API key saved")?;
        let mut wire_msgs = vec![json!({ "role": "system", "content": system })];
        for m in messages {
            openai_push(&mut wire_msgs, m);
        }
        let wire_tools: Vec<Value> = tools
            .iter()
            .map(|t| {
                json!({ "type": "function", "function": {
                "name": t.name, "description": t.description, "parameters": t.schema } })
            })
            .collect();
        let resp = http()
            .post("https://api.openai.com/v1/chat/completions")
            .bearer_auth(key)
            .json(&json!({
                "model": model,
                "messages": wire_msgs,
                "tools": wire_tools,
                "stream": true
            }))
            .send()
            .map_err(|e| format!("No network: {e}"))?;
        if !resp.status().is_success() {
            return Err(super::chat::explain_status(resp));
        }

        let mut out = NeutralMsg {
            role: "assistant".into(),
            ..Default::default()
        };
        let mut text = String::new();
        // index → (id, name, arguments-buffer)
        let mut calls: Vec<(String, String, String)> = Vec::new();
        let reader = BufReader::new(resp);
        for line in reader.lines() {
            let line = line.map_err(|e| e.to_string())?;
            let Some(data) = line.strip_prefix("data: ") else {
                continue;
            };
            if data.trim() == "[DONE]" {
                break;
            }
            let Ok(ev) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            let delta = &ev["choices"][0]["delta"];
            if let Some(t) = delta["content"].as_str() {
                text.push_str(t);
                emit(t);
            }
            if let Some(tcs) = delta["tool_calls"].as_array() {
                for tc in tcs {
                    let idx = tc["index"].as_u64().unwrap_or(0) as usize;
                    while calls.len() <= idx {
                        calls.push((String::new(), String::new(), String::new()));
                    }
                    if let Some(id) = tc["id"].as_str() {
                        calls[idx].0 = id.to_string();
                    }
                    if let Some(n) = tc["function"]["name"].as_str() {
                        calls[idx].1.push_str(n);
                    }
                    if let Some(a) = tc["function"]["arguments"].as_str() {
                        calls[idx].2.push_str(a);
                    }
                }
            }
        }
        for (id, name, buf) in calls {
            if name.is_empty() {
                continue;
            }
            let args = if buf.trim().is_empty() {
                json!({})
            } else {
                serde_json::from_str(&buf).map_err(|e| format!("bad tool args from model: {e}"))?
            };
            out.tool_calls.push(NeutralCall { id, name, args });
        }
        out.text = (!text.is_empty()).then_some(text);
        Ok(out)
    }
}

fn openai_push(wire: &mut Vec<Value>, m: &NeutralMsg) {
    if !m.tool_results.is_empty() {
        for r in &m.tool_results {
            wire.push(json!({ "role": "tool", "tool_call_id": r.call_id, "content": r.content }));
        }
        return;
    }
    if !m.tool_calls.is_empty() {
        wire.push(json!({
            "role": "assistant",
            "content": m.text,
            "tool_calls": m.tool_calls.iter().map(|c| json!({
                "id": c.id, "type": "function",
                "function": { "name": c.name, "arguments": c.args.to_string() }
            })).collect::<Vec<_>>()
        }));
        return;
    }
    wire.push(json!({ "role": m.role, "content": m.text.clone().unwrap_or_default() }));
}

// ---------------------------------------------------------------------------
// Mock: deterministic, offline, key-less. Exercises the FULL loop machinery
// (streamed deltas, tool rounds, results) so the suite and a key-less demo
// prove everything except the LLM itself.
// ---------------------------------------------------------------------------
struct MockTurn;

impl TurnProvider for MockTurn {
    fn round(
        &self,
        _model: &str,
        _system: &str,
        messages: &[NeutralMsg],
        _tools: &[ToolSpec],
        emit: &mut dyn FnMut(&str),
    ) -> Result<NeutralMsg, String> {
        // Round 2+: after tool results, close politely.
        if messages.iter().any(|m| !m.tool_results.is_empty()) {
            let closing = "Done — the edit is on the timeline. Undo reverts it in one step.";
            for w in closing.split_inclusive(' ') {
                emit(w);
                std::thread::sleep(std::time::Duration::from_millis(8));
            }
            return Ok(NeutralMsg {
                role: "assistant".into(),
                text: Some(closing.into()),
                ..Default::default()
            });
        }
        let prompt = messages
            .iter()
            .rev()
            .find(|m| m.role == "user")
            .and_then(|m| m.text.clone())
            .unwrap_or_default()
            .to_lowercase();
        let mut out = NeutralMsg {
            role: "assistant".into(),
            ..Default::default()
        };
        let say = |emit: &mut dyn FnMut(&str), s: &str| {
            for w in s.split_inclusive(' ') {
                emit(w);
                std::thread::sleep(std::time::Duration::from_millis(8));
            }
        };
        let mut idn = 0;
        let mut call = |name: &str, args: Value| {
            idn += 1;
            NeutralCall {
                id: format!("mock_{idn}"),
                name: name.into(),
                args,
            }
        };
        // Deterministic scripts for the demo-family prompts.
        if prompt.contains("shrink") && (prompt.contains("face") || prompt.contains("webcam")) {
            // The flagship shape: pip window then back to fullscreen.
            let from = extract_time(&prompt, 0).unwrap_or(10.0);
            let to = extract_time(&prompt, 1).unwrap_or(45.0);
            say(
                emit,
                "Shrinking the webcam into a corner for that window, then back. ",
            );
            out.tool_calls.push(call(
                "set_layout",
                json!({ "layout": "pip", "track": "auto-cam", "corner": "bottom_right",
                        "scale": extract_pct(&prompt).unwrap_or(0.10),
                        "radius": if prompt.contains("round") { 24.0 } else { 0.0 },
                        "margin": 32, "at": from, "duration": 1.0 }),
            ));
            out.tool_calls.push(call(
                "set_layout",
                json!({ "layout": "fullscreen", "track": "auto-cam", "at": to, "duration": 1.0 }),
            ));
        } else if prompt.contains("cut") && prompt.contains("first") {
            let secs = extract_time(&prompt, 0).unwrap_or(3.0);
            say(emit, "Cutting the opening and closing the gap. ");
            out.tool_calls.push(call(
                "delete_range",
                json!({ "track_id": "all", "start": 0.0, "end": secs, "ripple": true }),
            ));
        } else if prompt.contains("title") || prompt.contains("text") {
            let quoted = prompt.split('"').nth(1).map(str::to_string);
            let content = quoted.unwrap_or_else(|| "Title".into());
            say(emit, "Adding the title. ");
            out.tool_calls.push(call(
                "add_text",
                json!({ "content": content, "start": 0.5, "duration": 3.0, "size": 72 }),
            ));
        } else {
            say(emit, "Mock provider: I can shrink the webcam ('shrink my face…'), cut openings ('cut the first 3 seconds'), or add titles ('add a title that says \"Hi\"'). ");
        }
        out.text = Some("(mock plan)".into());
        Ok(out)
    }
}

/// Pull the nth time in seconds from "0:10", "1:05" or bare "12(s)".
fn extract_time(s: &str, n: usize) -> Option<f64> {
    let mut found = Vec::new();
    let bytes: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i].is_ascii_digit() {
            let start = i;
            while i < bytes.len() && (bytes[i].is_ascii_digit() || bytes[i] == ':') {
                i += 1;
            }
            let tok: String = bytes[start..i].iter().collect();
            if let Some((m, sec)) = tok.split_once(':') {
                if let (Ok(m), Ok(sec)) = (m.parse::<f64>(), sec.parse::<f64>()) {
                    found.push(m * 60.0 + sec);
                }
            } else if let Ok(v) = tok.parse::<f64>() {
                // bare numbers: skip percentages (handled by extract_pct)
                let next = bytes.get(i).copied().unwrap_or(' ');
                if next != '%' {
                    found.push(v);
                }
            }
        } else {
            i += 1;
        }
    }
    found.get(n).copied()
}

fn extract_pct(s: &str) -> Option<f64> {
    let idx = s.find('%')?;
    let head: String = s[..idx]
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    let v: f64 = head.chars().rev().collect::<String>().parse().ok()?;
    Some(v / 100.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn time_and_pct_extraction() {
        assert_eq!(extract_time("from 0:10 to 0:45 shrink", 0), Some(10.0));
        assert_eq!(extract_time("from 0:10 to 0:45 shrink", 1), Some(45.0));
        assert_eq!(extract_time("cut the first 3 seconds", 0), Some(3.0));
        assert_eq!(extract_pct("shrink my face to 10%, rounded"), Some(0.10));
        assert_eq!(extract_time("shrink to 10% at 1:05", 0), Some(65.0));
    }

    #[test]
    fn mock_scripts_the_flagship_prompt() {
        let mock = MockTurn;
        let msgs = vec![NeutralMsg {
            role: "user".into(),
            text: Some(
                "From 0:10 to 0:45 shrink my face to 10%, rounded corners, bottom right, screen share fills the rest, then back to fullscreen.".into(),
            ),
            ..Default::default()
        }];
        let mut streamed = String::new();
        let out = mock
            .round("mock", "", &msgs, &[], &mut |t| streamed.push_str(t))
            .unwrap();
        assert_eq!(out.tool_calls.len(), 2);
        assert_eq!(out.tool_calls[0].name, "set_layout");
        assert_eq!(out.tool_calls[0].args["at"], 10.0);
        assert_eq!(out.tool_calls[0].args["scale"], 0.10);
        assert_eq!(out.tool_calls[1].args["layout"], "fullscreen");
        assert_eq!(out.tool_calls[1].args["at"], 45.0);
        assert!(!streamed.is_empty());
    }

    #[test]
    fn wire_mapping_round_trips_both_providers() {
        let m = NeutralMsg {
            role: "assistant".into(),
            text: Some("doing it".into()),
            tool_calls: vec![NeutralCall {
                id: "t1".into(),
                name: "split_clip".into(),
                args: serde_json::json!({"clip_id":"c1","at":2.5}),
            }],
            ..Default::default()
        };
        let a = anthropic_msg(&m);
        assert_eq!(a["content"][1]["type"], "tool_use");
        assert_eq!(a["content"][1]["input"]["at"], 2.5);
        let mut w = Vec::new();
        openai_push(&mut w, &m);
        // OpenAI carries arguments as a JSON STRING (the live-docs gotcha).
        assert!(w[0]["tool_calls"][0]["function"]["arguments"].is_string());
        let r = NeutralMsg {
            role: "user".into(),
            tool_results: vec![NeutralResult {
                call_id: "t1".into(),
                content: "{\"ok\":true}".into(),
            }],
            ..Default::default()
        };
        let ar = anthropic_msg(&r);
        assert_eq!(ar["content"][0]["type"], "tool_result");
        let mut w2 = Vec::new();
        openai_push(&mut w2, &r);
        assert_eq!(w2[0]["role"], "tool");
    }
}
