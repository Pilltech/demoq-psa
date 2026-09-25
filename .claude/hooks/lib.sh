# Shared helpers for hooks. Hooks receive the event as JSON on stdin.
ROOT="${CLAUDE_PROJECT_DIR:-$(git rev-parse --show-toplevel)}"
STATE="$ROOT/.claude/state"
mkdir -p "$STATE"
phase() { cat "$STATE/phase" 2>/dev/null || echo "free"; }
# Normalise (//, .., symlinks) before comparing, so odd spellings cannot slip past the guards.
rel() { local p; p="$(realpath -m -- "$1")"; local r; r="$(realpath -m -- "$ROOT")"; echo "${p#"$r"/}"; }
# The base to compare against: origin/main when it exists, else the repo's first commit (never "nothing changed").
base_ref() {
  if git -C "$ROOT" rev-parse -q --verify origin/main >/dev/null; then echo origin/main
  else git -C "$ROOT" rev-list --max-parents=0 HEAD 2>/dev/null | tail -1; fi
}
block() { echo "$1" >&2; exit 2; }  # exit 2 = block the action and show the message to Claude
