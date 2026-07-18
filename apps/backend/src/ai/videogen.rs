// VideoGenProvider seam (Run 1, Phase 2 stub; Phase 6 implements
// generation). test_connection exists now so the settings panel is honest
// about key validity from day one.

pub trait VideoGenProvider: Send + Sync {
    fn id(&self) -> &'static str;
    fn test_connection(&self) -> Result<String, String>;
}

pub fn provider_for(id: &str) -> Result<Box<dyn VideoGenProvider>, String> {
    match id {
        "seedance" => Ok(Box::new(Seedance)),
        "gemini" => Ok(Box::new(Gemini)),
        _ => Err(format!("unknown video provider '{id}'")),
    }
}

fn http() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .expect("http client")
}

pub struct Seedance;

impl VideoGenProvider for Seedance {
    fn id(&self) -> &'static str {
        "seedance"
    }
    fn test_connection(&self) -> Result<String, String> {
        let key = super::keys::get("seedance").ok_or("No API key saved for Seedance")?;
        // BytePlus ModelArk exposes an OpenAI-compatible surface; listing
        // models is the cheapest authenticated call. (Endpoint re-verified
        // against live docs in Phase 6 before generation is implemented.)
        let resp = http()
            .get("https://ark.ap-southeast.bytepluses.com/api/v3/models")
            .bearer_auth(key)
            .send()
            .map_err(|e| format!("No network: {e}"))?;
        if resp.status().is_success() {
            Ok("Connected — Seedance key accepted".into())
        } else {
            Err(super::chat::explain_status(resp))
        }
    }
}

pub struct Gemini;

impl VideoGenProvider for Gemini {
    fn id(&self) -> &'static str {
        "gemini"
    }
    fn test_connection(&self) -> Result<String, String> {
        let key = super::keys::get("gemini").ok_or("No API key saved for Google")?;
        let resp = http()
            .get(format!(
                "https://generativelanguage.googleapis.com/v1beta/models?key={key}"
            ))
            .send()
            .map_err(|e| format!("No network: {e}"))?;
        if resp.status().is_success() {
            Ok("Connected — Google key accepted".into())
        } else {
            Err(super::chat::explain_status(resp))
        }
    }
}
