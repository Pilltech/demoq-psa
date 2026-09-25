#!/usr/bin/env bash
# SessionStart: print the context Claude should know before doing anything.
source "$(dirname "$0")/lib.sh"
cd "$ROOT" || exit 0
echo "Branch: $(git branch --show-current 2>/dev/null)  Phase: $(phase)  Spec: $(cat "$STATE/spec" 2>/dev/null || echo none)"
git status -s 2>/dev/null | head -20
[ -f "$STATE/RED" ] && echo "WARNING: last Stop gate failed 3x (.claude/state/RED). Fix checks before /pr."
if [ -f "$ROOT/.claude/VERSION" ] && command -v claude >/dev/null; then
  want="$(cat "$ROOT/.claude/VERSION")"; have="$(claude --version 2>/dev/null | awk '{print $1}')"
  [ -n "$have" ] && [ "$have" != "$want" ] && echo "NOTE: Claude Code $have differs from pinned $want (.claude/VERSION)."
fi
exit 0
