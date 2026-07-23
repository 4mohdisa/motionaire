#!/bin/bash
# One-command release build: .app + .dmg into apps/backend/target/release/bundle/.
#
# Signing/notarization (when an Apple Developer account exists):
#   export APPLE_SIGNING_IDENTITY="Developer ID Application: Mohammed Isa (TEAMID)"
#   export APPLE_ID=...  APPLE_PASSWORD=<app-specific>  APPLE_TEAM_ID=...
# Tauri picks these up automatically (bundle > macOS > signingIdentity may also
# be set in tauri.conf.json). Without them the app is ad-hoc signed and
# downloaders must clear the Gatekeeper quarantine (see README).
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▸ release build (frontend production bundle + Rust release profile)"
npm run tauri build

BUNDLE=apps/backend/target/release/bundle
echo
echo "▸ artifacts:"
ls -d "$BUNDLE"/macos/*.app "$BUNDLE"/dmg/*.dmg 2>/dev/null || true
