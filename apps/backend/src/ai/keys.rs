// API-key storage: OS keychain via the keyring crate, BOTH build profiles.
// Unlike the license key (debug uses a marker file because the only debug
// key is the public TEST key), AI keys are the user's REAL credentials —
// a plaintext dev fallback is not acceptable. The debug-build cost: an
// ad-hoc-signed binary changes identity per rebuild, so the first READ of
// an item created by an older build pops one macOS confirm dialog. Tests
// avoid it by creating and deleting their own "ai-test" entry in-process;
// the mock chat provider needs no key at all.

const SERVICE: &str = "com.motionaire.app.ai";

fn entry(provider: &str) -> Result<keyring::Entry, String> {
    if !super::valid_provider(provider) {
        return Err(format!("unknown provider '{provider}'"));
    }
    keyring::Entry::new(SERVICE, provider).map_err(|e| e.to_string())
}

pub fn set(provider: &str, key: &str) -> Result<(), String> {
    let k = key.trim();
    if k.is_empty() {
        return Err("empty key".into());
    }
    entry(provider)?.set_password(k).map_err(|e| e.to_string())
}

/// Read a key for PROVIDER USE ONLY. Never returned to the webview, never
/// formatted into logs or error strings.
pub fn get(provider: &str) -> Option<String> {
    entry(provider).ok()?.get_password().ok()
}

pub fn has(provider: &str) -> bool {
    get(provider).is_some()
}

pub fn clear(provider: &str) -> Result<(), String> {
    match entry(provider)?.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_hygiene() {
        // Created + read + deleted by THIS binary → no keychain prompt.
        let p = "ai-test";
        let _ = clear(p);
        assert!(!has(p));
        set(p, "  sk-test-123  ").unwrap();
        assert!(has(p));
        assert_eq!(get(p).unwrap(), "sk-test-123"); // trimmed on write
        clear(p).unwrap();
        assert!(!has(p));
        // Unknown providers refused — no arbitrary keychain writes.
        assert!(set("evil", "x").is_err());
        assert!(set(p, "   ").is_err());
    }
}
