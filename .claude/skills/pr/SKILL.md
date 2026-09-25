---
name: pr
description: Final checks, reviewer subagents, and a PR description with the rule-to-test table.
disable-model-invocation: true
---

# /pr

1. Refuse if `.claude/state/RED` exists — fix the checks first.
2. Run `pnpm check` and, if UI changed, `pnpm test:e2e`. All green or stop.
3. Write the diff for reviewers: `git diff origin/main...HEAD > .claude/tmp/review.diff` and
   `git diff --name-only origin/main...HEAD > .claude/tmp/changed.txt` (mkdir -p .claude/tmp).
4. Run the `security-reviewer`, `money-reviewer` (if money/pricing touched) and `schema-reviewer` (if migrations
   touched) subagents in parallel. Fix every BLOCKER; list SHOULDs you did not fix and why.
5. Draft the PR body: spec link, quotation refs, rule → test table (from `pnpm trace:check` data), migrations,
   permission-matrix delta (needs PO approval), screenshots for UI, and a **"Human must check"** list
   (money math, permissions, migrations, Khmer text).
6. `echo free > .claude/state/phase`. Push only when the developer confirms.
