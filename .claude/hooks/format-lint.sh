#!/usr/bin/env bash
# PostToolUse Edit/Write: format and lint just the edited file; report problems back to Claude (non-blocking).
source "$(dirname "$0")/lib.sh"
f="$(jq -r '.tool_input.file_path // empty')"
case "$f" in *.ts|*.tsx|*.js|*.json|*.css|*.md) ;; *) exit 0 ;; esac
[ -f "$f" ] || exit 0
cd "$ROOT" || exit 0
npx --no-install prettier --write --log-level warn "$f" >/dev/null 2>&1 || true
case "$f" in
  *.ts|*.tsx)
    out="$(npx --no-install eslint --no-warn-ignored "$f" 2>&1)" || { echo "$out" | tail -20 >&2; exit 2; } ;;
esac
exit 0
