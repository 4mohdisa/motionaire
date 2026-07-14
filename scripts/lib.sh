# Shared helpers for the test scripts (sourced, not executed).
# The "live log" is whichever candidate the running app instance writes to —
# picked by freshest mtime, because a stale log from an older session must
# never win (WEBVIEW-TEST polling would silently hang).

TRIG="${TMPDIR%/}/motionaire-dev-trigger"
DONE="${TMPDIR%/}/motionaire-dev-done"

find_live_log() {
  local best="" best_m=0 m
  for cand in /tmp/tauri-f0.log /tmp/motionaire-e2e.log; do
    [ -f "$cand" ] || continue
    m=$(stat -f %m "$cand" 2>/dev/null || echo 0)
    [ "$m" -gt "$best_m" ] && { best="$cand"; best_m=$m; }
  done
  echo "${best:-/tmp/motionaire-e2e.log}"
}

app_running() { pgrep -f "target/debug/motionaire" > /dev/null; }

boot_app() { # sets LOG; returns 0 on ready
  LOG=/tmp/motionaire-e2e.log
  : > "$LOG"
  echo "▸ booting app under tauri dev (log: $LOG)"
  (npm run tauri dev > "$LOG" 2>&1 &)
  for i in $(seq 1 180); do
    grep -q "compositor ws: listening" "$LOG" 2>/dev/null && { sleep 3; return 0; }
    sleep 1
  done
  echo "FATAL: app did not boot within 180s"; tail -5 "$LOG"; return 1
}

kill_app() {
  pkill -f "target/debug/motionaire" 2>/dev/null
  pkill -f "tauri dev" 2>/dev/null
  sleep 1
}

reload_webview() {
  rm -f "$DONE"; echo "menu:dev:reload" > "$TRIG"
  for i in $(seq 1 20); do [ -f "$DONE" ] && break; sleep 0.5; done
  sleep 2
}
