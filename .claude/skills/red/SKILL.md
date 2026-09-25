---
name: red
description: Write failing tests for the current spec's rules (TDD red phase). Use after /spec is agreed.
disable-model-invocation: true
---

# /red

1. `echo red > .claude/state/phase`. The spec is `$(cat .claude/state/spec)`.
2. Delegate to the `test-writer` subagent: one or more tests per rule ID, named `[RULE-ID] …`, in the right layer:
   - pure logic → `*.unit.test.ts` next to the code;
   - commands/queries/DB backstops → `*.db.test.ts` using `@demoq/testkit` (`createTestDb`, `makeUser`, `meta`);
   - permission rules → every channel in `exposeTo`, plus one channel outside it;
   - UI flows in the spec's demo → `tests/e2e/*.spec.ts`.
     Mirror `packages/core/src/crm/deals.db.test.ts` (the golden slice).
3. Stub just enough (empty command with the right name/input) that tests **compile and fail on assertions**.
   The Stop hook checks this.
4. `pnpm trace:check` must list no uncovered rule for this spec.
5. Commit: `test: <spec> (red)`.
