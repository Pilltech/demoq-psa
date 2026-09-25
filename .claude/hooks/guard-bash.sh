#!/usr/bin/env bash
# PreToolUse Bash: the same protections for shell writes (a speed bump; branch protection and CI are the real controls).
source "$(dirname "$0")/lib.sh"
cmd="$(jq -r '.tool_input.command // empty')"
[ -z "$cmd" ] && exit 0
if echo "$cmd" | grep -Eq '(DATABASE_URL|MIGRATOR_DATABASE_URL)=[^ ]*(staging|prod|ondigitalocean|amazonaws)'; then
  block "No commands against staging/prod from a Claude session. Those run only from CI."
fi
if echo "$cmd" | grep -Eq '(sed -i|tee|>|mv |cp ).*(packages/db/src/types\.ts|schema\.sql|permission-matrix\.signed\.csv|kernel/permissions\.ts|\.claude/settings\.json)'; then
  block "That file is generated or human-owned. See CLAUDE.md."
fi
if [ "$(phase)" = "impl" ] && echo "$cmd" | grep -Eq '(sed -i|tee|>|mv |cp ).*\.(test|spec)\.tsx?'; then
  block "Phase impl: tests are locked."
fi
exit 0
