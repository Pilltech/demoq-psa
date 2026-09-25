# Shared helpers for hooks. Hooks receive the event as JSON on stdin.
ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
STATE="$ROOT/.claude/state"
mkdir -p "$STATE"
phase() { cat "$STATE/phase" 2>/dev/null || echo "free"; }
rel() { local p="$1"; p="${p#"$ROOT"/}"; echo "$p"; }
block() { echo "$1" >&2; exit 2; }  # exit 2 = block the action and show the message to Claude
