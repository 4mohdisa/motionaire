// ChatProvider trait (Run 1, Phase 2 skeleton; Phase 3 fills send_turn).
// Same seam pattern as LicenseValidator: the rest of the app talks to the
// trait and never knows which provider is behind it.

use serde_json::{json, Value};

pub trait ChatProvider: Send + Sync {
    fn id(&self) -> &'static str;
    /// Minimal REAL call proving the key + model work. Returns a short
    /// human-readable success string; errors surface the provider's actual
    /// message (rate limit, invalid key, quota) — never a generic failure.
    fn test_connection(&self, model: &str) -> Result<String, String>;
}

pub fn provider_for(id: &str) -> Result<Box<dyn ChatProvider>, String> {
    match id {
        "anthropic" => Ok(Box::new(Anthropic)),
        "openai" => Ok(Box::new(OpenAi)),
        "mock" => Ok(Box::new(Mock)),
        _ => Err(format!("unknown chat provider '{id}'")),
    }
}

fn http() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .expect("http client")
}

/// Consume a failed response into the REAL reason (shared with videogen).
pub fn explain_status(resp: reqwest::blocking::Response) -> String {
    let status = resp.status();
    let body = resp.text().unwrap_or_default();
    explain(status, &body)
}

/// Map an HTTP failure to the REAL reason (PLAN_RUN_1 2c: never generic).
fn explain(status: reqwest::StatusCode, body: &str) -> String {
    // Providers put the useful message in error.message; fall back to body.
    let msg = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|v| {
            v.pointer("/error/message")
                .and_then(|m| m.as_str())
                .map(String::from)
        })
        .unwrap_or_else(|| body.chars().take(200).collect());
    match status.as_u16() {
        401 | 403 => format!("Invalid API key ({msg})"),
        404 => format!("Model not available ({msg})"),
        429 => format!("Rate limited or out of quota ({msg})"),
        s if s >= 500 => format!("Provider outage (HTTP {s}: {msg})"),
        s => format!("HTTP {s}: {msg}"),
    }
}

pub struct Anthropic;

impl ChatProvider for Anthropic {
    fn id(&self) -> &'static str {
        "anthropic"
    }
    fn test_connection(&self, model: &str) -> Result<String, String> {
        let key = super::keys::get("anthropic").ok_or("No API key saved for Anthropic")?;
        let resp = http()
            .post("https://api.anthropic.com/v1/messages")
            .header("x-api-key", key)
            .header("anthropic-version", "2023-06-01")
            .json(&json!({
                "model": model,
                "max_tokens": 8,
                "messages": [{"role": "user", "content": "Reply with OK"}]
            }))
            .send()
            .map_err(|e| format!("No network: {e}"))?;
        let status = resp.status();
        let body = resp.text().unwrap_or_default();
        if status.is_success() {
            Ok(format!("Connected — {model} responded"))
        } else {
            Err(explain(status, &body))
        }
    }
}

pub struct OpenAi;

impl ChatProvider for OpenAi {
    fn id(&self) -> &'static str {
        "openai"
    }
    fn test_connection(&self, model: &str) -> Result<String, String> {
        let key = super::keys::get("openai").ok_or("No API key saved for OpenAI")?;
        // GET /v1/models/{model} verifies both the key and the model id in
        // one cheap call (no token spend).
        let resp = http()
            .get(format!("https://api.openai.com/v1/models/{model}"))
            .bearer_auth(key)
            .send()
            .map_err(|e| format!("No network: {e}"))?;
        let status = resp.status();
        let body = resp.text().unwrap_or_default();
        if status.is_success() {
            Ok(format!("Connected — {model} available"))
        } else {
            Err(explain(status, &body))
        }
    }
}

/// Deterministic offline provider: lets every AI surface be exercised by
/// the suite (and demoed) with zero keys and zero network. Selected like a
/// real provider; never a hidden fallback.
pub struct Mock;

impl ChatProvider for Mock {
    fn id(&self) -> &'static str {
        "mock"
    }
    fn test_connection(&self, _model: &str) -> Result<String, String> {
        Ok("Connected — mock provider (offline)".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explain_maps_the_real_reason() {
        let s = |c: u16| reqwest::StatusCode::from_u16(c).unwrap();
        let body = r#"{"error":{"message":"invalid x-api-key"}}"#;
        assert!(explain(s(401), body).contains("Invalid API key"));
        assert!(explain(s(401), body).contains("invalid x-api-key"));
        assert!(explain(s(429), "{}").contains("Rate limited"));
        assert!(explain(s(500), "boom").contains("outage"));
        assert!(explain(s(418), "teapot").contains("418"));
    }

    #[test]
    fn providers_resolve_and_mock_needs_nothing() {
        assert!(provider_for("anthropic").is_ok());
        assert!(provider_for("openai").is_ok());
        assert!(provider_for("nope").is_err());
        assert_eq!(provider_for("mock").unwrap().test_connection("x").unwrap(),
            "Connected — mock provider (offline)");
    }
}
