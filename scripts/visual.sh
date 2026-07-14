#!/bin/bash
# Visual regression (pro-editor session, Phase 0). Reuses the WKWebView
# self-capture tooling: build a deterministic scene, snapshot, compare
# against committed baselines with ffmpeg SSIM (tolerates AA noise, fails on
# real layout/render changes).
#
# Usage: scripts/visual.sh [--update]
#   --update   re-baseline every screen from the current build
set -u
cd "$(dirname "$0")/.."
source scripts/lib.sh

BASE=tests/visual
OUT=/tmp/motionaire-vr
SSIM_MIN=0.97
UPDATE=0
[ "${1:-}" = "--update" ] && UPDATE=1
mkdir -p "$BASE" "$OUT"

STARTED=0
if app_running; then
  LOG=$(find_live_log)
else
  boot_app || exit 2
  STARTED=1
fi

trigger_and_wait() { # $1 = dev case, $2 = report name
  local MARK; MARK=$(grep -c "" "$LOG" 2>/dev/null || echo 0)
  rm -f "$DONE"; echo "menu:dev:$1" > "$TRIG"
  for i in $(seq 1 60); do
    awk "NR>$MARK" "$LOG" 2>/dev/null | grep -q "WEBVIEW-TEST.*\[$2\]" && return 0
    sleep 1
  done
  return 1
}

capture() { # $1 = output png
  rm -f "$DONE"; echo "capture:$1" > "$TRIG"
  for i in $(seq 1 30); do [ -f "$DONE" ] && break; sleep 0.5; done
  [ -f "$1" ]
}

ssim_of() { # $1 candidate, $2 baseline
  ffmpeg -i "$1" -i "$2" -filter_complex ssim -f null - 2>&1 |
    grep -o "All:[0-9.]*" | tail -1 | cut -d: -f2
}

fail=0
shoot() { # $1 = screen name, $2 = dev case, $3 = report name
  local name=$1 cand="$OUT/$1.png" base="$BASE/$1.png"
  if ! trigger_and_wait "$2" "$3"; then echo "  FAIL $name (scene did not settle)"; fail=1; return; fi
  sleep 1
  if ! capture "$cand"; then echo "  FAIL $name (capture failed)"; fail=1; return; fi
  if [ "$UPDATE" = 1 ] || [ ! -f "$base" ]; then
    cp "$cand" "$base"
    echo "  BASE $name (baseline written)"
    return
  fi
  local ssim; ssim=$(ssim_of "$cand" "$base")
  if awk -v s="${ssim:-0}" -v m="$SSIM_MIN" 'BEGIN{exit !(s>=m)}'; then
    echo "  PASS $name (ssim $ssim)"
  else
    echo "  FAIL $name (ssim ${ssim:-n/a} < $SSIM_MIN) — candidate: $cand"
    fail=1
  fi
}

# Same isolation rule the e2e runner learned: the scene must start from a
# fresh webview or leftover media/title/edit-mode contaminate the pixels
# (the first committed baseline had six media entries from a prior test).
reload_webview
shoot vr_editor vr_scene vr-scene
# vr_sheet deliberately stacks the dialog on the settled scene — no reload.
shoot vr_sheet vr_sheet vr-sheet

# Leave no dialog open for whoever runs next.
reload_webview
[ "$STARTED" = 1 ] && kill_app

[ $fail -gt 0 ] && { echo "visual: FAIL"; exit 1; }
echo "visual: all screens match"
exit 0
