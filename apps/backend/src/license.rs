// Activation (session 9, Phase 1a). Validation sits behind a trait so real
// server validation later is a config change, not a rewrite — the same seam
// CONTEXT.md §7 prescribes for the AI provider.

pub trait LicenseValidator: Send + Sync {
    fn validate(&self, key: &str) -> Result<(), String>;
}

pub const TEST_KEY: &str = "MOTIONAIRE-TEST-0000-0000";

pub struct TestValidator;

impl LicenseValidator for TestValidator {
    fn validate(&self, key: &str) -> Result<(), String> {
        if key.trim().eq_ignore_ascii_case(TEST_KEY) {
            Ok(())
        } else {
            Err("Invalid activation key. Check the key from your account and try again.".into())
        }
    }
}

// Will POST to the web activation API once it exists.
pub struct RemoteValidator;

impl LicenseValidator for RemoteValidator {
    fn validate(&self, _key: &str) -> Result<(), String> {
        Err("Online activation isn't available yet.".into())
    }
}

pub fn validator() -> Box<dyn LicenseValidator> {
    // The config seam: swap for RemoteValidator when the web side ships.
    Box::new(TestValidator)
}

// Release builds: OS keychain, per CONTEXT.md §8.2 (never SQLite plaintext).
// Debug builds: a marker file instead — an ad-hoc-signed dev binary changes
// identity on every rebuild, so keychain reads trigger blocking permission
// dialogs, which would hang every unattended test run. The only key a debug
// build ever stores is the public TEST key, so nothing secret is on disk.
#[cfg(debug_assertions)]
mod store {
    fn marker() -> std::path::PathBuf {
        std::env::temp_dir().join("motionaire-dev-license")
    }
    pub fn get() -> Option<String> {
        std::fs::read_to_string(marker()).ok()
    }
    pub fn set(key: &str) -> Result<(), String> {
        std::fs::write(marker(), key).map_err(|e| e.to_string())
    }
    pub fn clear() -> Result<(), String> {
        match std::fs::remove_file(marker()) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(not(debug_assertions))]
mod store {
    const SERVICE: &str = "com.motionaire.app";
    const ACCOUNT: &str = "license-key";

    fn entry() -> Result<keyring::Entry, String> {
        keyring::Entry::new(SERVICE, ACCOUNT).map_err(|e| e.to_string())
    }
    pub fn get() -> Option<String> {
        entry().ok()?.get_password().ok()
    }
    pub fn set(key: &str) -> Result<(), String> {
        entry()?.set_password(key).map_err(|e| e.to_string())
    }
    pub fn clear() -> Result<(), String> {
        match entry()?.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

pub fn is_activated() -> bool {
    store::get()
        .map(|k| validator().validate(&k).is_ok())
        .unwrap_or(false)
}

pub fn activate(key: &str) -> Result<(), String> {
    validator().validate(key)?;
    store::set(key.trim())
}

pub fn deactivate() -> Result<(), String> {
    store::clear()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_edges() {
        let v = TestValidator;
        assert!(v.validate(TEST_KEY).is_ok());
        assert!(v.validate(&TEST_KEY.to_lowercase()).is_ok()); // case-insensitive
        assert!(v.validate(&format!("  {TEST_KEY}  ")).is_ok()); // trimmed
        assert!(v.validate("MOTIONAIRE-TEST-0000-0001").is_err());
        assert!(v.validate("").is_err());
        // The remote validator refuses everything until the server exists.
        assert!(RemoteValidator.validate(TEST_KEY).is_err());
    }

    #[test]
    fn test_key_round_trip() {
        assert!(TestValidator.validate(TEST_KEY).is_ok());
        assert!(TestValidator
            .validate(" motionaire-test-0000-0000 ")
            .is_ok());
        assert!(TestValidator.validate("MOTIONAIRE-REAL-1111-2222").is_err());
        assert!(TestValidator.validate("").is_err());
    }

    #[test]
    fn activate_deactivate_cycle() {
        deactivate().unwrap();
        assert!(!is_activated());
        assert!(activate("wrong-key").is_err());
        assert!(!is_activated());
        activate(TEST_KEY).unwrap();
        assert!(is_activated());
        deactivate().unwrap();
        assert!(!is_activated());
    }
}
