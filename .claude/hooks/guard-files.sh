#!/usr/bin/env bash
# PreToolUse Edit/Write: protect applied migrations, generated files and (in phase impl) the tests.
source "$(dirname "$0")/lib.sh"
f="$(jq -r '.tool_input.file_path // .tool_input.path // empty')"
[ -z "$f" ] && exit 0
r="$(rel "$f")"
case "$r" in
  packages/db/src/types.ts|packages/db/schema.sql)
    block "Generated file: run 'pnpm db:migrate && pnpm db:types' instead of editing $r." ;;
  packages/db/migrations/*.sql)
    if git -C "$ROOT" cat-file -e "origin/main:$r" 2>/dev/null; then
      block "$r is already on origin/main. Migrations are immutable once merged: add a new timestamped migration."
    fi ;;
  .claude/settings.json|.claude/hooks/*|.github/*|docs/permission-matrix.signed.csv|packages/core/src/kernel/permissions.ts)
    block "$r is human-owned (CLAUDE.md 'Humans own'). Propose the change in chat or the PR description instead." ;;
esac
if [ "$(phase)" = "impl" ]; then
  case "$r" in
    *.test.ts|*.test.tsx|*.spec.ts|tests/*)
      block "Phase impl: tests are locked. If $r is wrong, stop and say so with QUESTION: — do not change the test to pass." ;;
  esac
fi
exit 0
