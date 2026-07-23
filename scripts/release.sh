#!/bin/bash
# One-command release build: .app + .dmg.
#
# The DMG is assembled with plain hdiutil rather than Tauri's dmg bundler:
# the bundler styles the DMG window by scripting Finder, which requires a
# live GUI session and fails/hangs headless (and adds nothing functional).
#
# Signing/notarization (when an Apple Developer account exists):
#   export APPLE_SIGNING_IDENTITY="Developer ID Application: Mohammed Isa (TEAMID)"
#   export APPLE_ID=...  APPLE_PASSWORD=<app-specific>  APPLE_TEAM_ID=...
# Tauri picks these up automatically. Without them the app is ad-hoc signed
# and downloaders must clear the Gatekeeper quarantine (see README).
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(python3 -c "import json;print(json.load(open('apps/backend/tauri.conf.json'))['version'])")

echo "▸ release build (frontend production bundle + Rust release profile)"
npm run tauri build -- --bundles app

APP=apps/backend/target/release/bundle/macos/Motionaire.app
OUT=apps/backend/target/release/bundle/Motionaire_${VERSION}_aarch64.dmg

echo "▸ packaging DMG"
STAGE=$(mktemp -d)
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "Motionaire" -srcfolder "$STAGE" -ov -format UDZO "$OUT"
rm -rf "$STAGE"

echo
echo "▸ artifacts:"
ls -d "$APP" "$OUT"
