#!/bin/bash
# Motionaire e2e runner (pro-editor session, Phase 0).
#
# WHY NOT tauri-driver: the official Tauri v2 WebDriver path (tauri-driver +
# WebdriverIO) does not support macOS — WKWebView has no WebDriver endpoint.
# The dev-remote pattern (file trigger -> real app -> WEBVIEW-TEST log lines)
# has verified five sessions of work against the real compositor, so this
# script formalizes THAT into the one-command runner the plan requires.
#
# Usage: scripts/e2e.sh [--keep] [test ...]
#   --keep   leave the app running afterwards
#   test     dev-case names without the "dev:" prefix (default: full list)
set -u
cd "$(dirname "$0")/.."
source scripts/lib.sh

KEEP=0
[ "${1:-}" = "--keep" ] && { KEEP=1; shift; }

# Full regression list. smoke first: if the critical path is broken, fail
# fast. Every entry prints exactly one WEBVIEW-TEST PASS/FAIL line.
DEFAULT_TESTS=(
  smoke
  p1_shell_test p5_export_test p5_cancel_test f8_restore_test
  p2_bin_test p3_tracks_test p4_text_test p6_safety_test p7_test
  p5_select_test p5_marker_test p5_freeze_test p5_thumb_test
  f0_popover_test f0_ctx_test f1_parity_test f2_edit_test f3_audio_test
  f5_proxy_test f6_export_test f7_test f8_test
  r1p2_keys_test
  p1_mixer_test p2_fx_test p2_migration_test p3_graph_test p4_trim_test p5_color_test p6_audio_test p7_motion_test p8_org_test
)
if [ $# -gt 0 ]; then TESTS=("$@"); else TESTS=("${DEFAULT_TESTS[@]}"); fi

STARTED=0
if app_running; then
  LOG=$(find_live_log)
  echo "▸ reusing running app (log: $LOG)"
else
  boot_app || exit 2
  STARTED=1
fi

pass=0; fail=0; failed_names=()
for t in "${TESTS[@]}"; do
  # Fresh webview per test: each dev case was written against clean boot
  # state, and the first suite run proved cross-test contamination (f7 saw
  # media a previous test imported). Isolation costs ~5s/test and buys
  # honest results.
  reload_webview
  MARK=$(grep -c "" "$LOG" 2>/dev/null || echo 0)
  rm -f "$DONE"; echo "menu:dev:$t" > "$TRIG"
  # Poll for the report line (house rule: poll, never sleep-and-hope).
  # f5/f6/smoke run transcodes/exports — generous per-test ceiling.
  RES=""
  for i in $(seq 1 240); do
    RES=$(awk "NR>$MARK" "$LOG" 2>/dev/null | grep -m1 "WEBVIEW-TEST" || true)
    [ -n "$RES" ] && break
    sleep 1
  done
  if echo "$RES" | grep -q "WEBVIEW-TEST PASS"; then
    echo "  PASS $t"
    pass=$((pass+1))
  else
    echo "  FAIL $t"
    echo "       ${RES:-<no report within 240s>}"
    fail=$((fail+1)); failed_names+=("$t")
  fi
done

[ "$STARTED" = 1 ] && [ "$KEEP" = 0 ] && kill_app

echo
echo "e2e: $pass passed, $fail failed (of ${#TESTS[@]})"
[ $fail -gt 0 ] && { echo "failed: ${failed_names[*]}"; exit 1; }
exit 0
