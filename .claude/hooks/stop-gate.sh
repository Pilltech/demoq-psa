#!/usr/bin/env bash
# Stop: do not let Claude declare victory while checks are red. Phase-aware:
#   red  → typecheck green, and the new tests FAIL (on assertions, not on imports/compile)
#   impl → typecheck, lint and tests green
#   spec/free → typecheck only if code changed
# Stops are always allowed on a QUESTION: to a human. After 3 blocks the stop is allowed and
# .claude/state/RED is written (the /pr skill and pre-push refuse while it exists).
source "$(dirname "$0")/lib.sh"
input="$(cat)"
sid="$(echo "$input" | jq -r '.session_id // "none"')"
last="$(echo "$input" | jq -r '.last_assistant_message // empty' 2>/dev/null)"
if [ -z "$last" ]; then
  tp="$(echo "$input" | jq -r '.transcript_path // empty')"
  [ -f "$tp" ] && last="$(tail -c 20000 "$tp")"
fi
echo "$last" | grep -q "QUESTION:" && exit 0
cd "$ROOT" || exit 0
base="$(base_ref)"
changed="$( { git diff --name-only "$(git merge-base "$base" HEAD 2>/dev/null || echo "$base")" 2>/dev/null; git ls-files --others --exclude-standard; } | sort -u)"
echo "$changed" | grep -Eq '\.(ts|tsx|sql)$' || exit 0

counter="$STATE/stop-$sid"
n="$(cat "$counter" 2>/dev/null || echo 0)"
fail() {
  n=$((n + 1)); echo "$n" > "$counter"
  if [ "$n" -ge 3 ]; then
    touch "$STATE/RED"
    echo '{"systemMessage":"Stop gate failed 3 times; stopping anyway. .claude/state/RED is set — fix checks before /pr."}'
    exit 0
  fi
  block "$1"
}
tc="$(pnpm -s typecheck 2>&1)" || fail "Typecheck is red:
$(echo "$tc" | tail -25)"
case "$(phase)" in
  red)
    out="$(npx vitest run --changed "$base" 2>&1)"
    echo "$out" | grep -Eq "Error: (Cannot find module|Failed to load)|SyntaxError" && fail "Phase red: tests must fail on assertions, not imports:
$(echo "$out" | tail -25)"
    echo "$out" | grep -Eq "Tests +[0-9]+ failed" || fail "Phase red: the new tests should fail before implementation. They pass — are they testing the rule?" ;;
  impl)
    lint="$(pnpm -s lint 2>&1)" || fail "Lint/boundaries are red:
$(echo "$lint" | tail -25)"
    out="$(npx vitest run 2>&1)" || fail "Tests are red:
$(echo "$out" | grep -E "FAIL|✗|×|AssertionError|Expected|Received" | head -30)" ;;
esac
rm -f "$counter" "$STATE/RED"
exit 0
