#!/bin/bash
# THE one command (pro-editor session, Phase 0): frontend unit, backend unit,
# e2e (incl. the smoke critical path), visual regression. Every phase gate
# runs exactly this. Exit 0 = green suite.
set -u
cd "$(dirname "$0")/.."
source scripts/lib.sh
overall=0
was_running=0
app_running && was_running=1

echo "━━ 1/4 frontend unit (vitest)"
out=$(cd apps/frontend && npx vitest run 2>&1); rc=$?
echo "$out" | tail -3
[ $rc -ne 0 ] && overall=1

echo "━━ 2/4 backend unit (cargo test)"
out=$(cd apps/backend && cargo test 2>&1); rc=$?
echo "$out" | grep -E "test result" | head -2
[ $rc -ne 0 ] && { overall=1; echo "$out" | grep -E "FAILED|error" | head -10; }

echo "━━ 3/4 e2e (dev-remote runner, incl. smoke)"
scripts/e2e.sh --keep || overall=1

echo "━━ 4/4 visual regression"
scripts/visual.sh || overall=1

# Leave the machine as we found it.
[ $was_running -eq 0 ] && kill_app

echo
if [ $overall -eq 0 ]; then echo "SUITE GREEN"; else echo "SUITE RED"; fi
exit $overall
