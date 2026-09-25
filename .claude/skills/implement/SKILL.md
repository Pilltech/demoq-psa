---
name: implement
description: Implement the current spec until its red tests pass, without touching the tests.
disable-model-invocation: true
---

# /implement

1. `echo impl > .claude/state/phase`. Test files are now locked by a hook.
2. Implement in `packages/core/src/<module>/` following the golden slice (`crm/deals.ts`):
   `defineCommand` with `permission`, zod `input` from `@demoq/shared/contracts`, `exposeTo`, `load` (lock with
   `forUpdate`), `scope` (own/team/assigned), `run` (state machine guard, `assertVersion`, mutation, history,
   `ctx.emit`), `subject`. Register the module in `core/src/registry.ts`.
3. DB changes: `/migration`. Add the DB backstop for each invariant and its constraint→error mapping in
   `kernel/command.ts` (`CONSTRAINT_ERRORS`).
4. New error codes: `packages/shared/src/errors.ts` + both `i18n/errors.*.json` (Khmer as `KM-DRAFT:`).
5. UI in `apps/web/src/pages/` with `data-testid`s used by the E2E tests; strings in `apps/web/src/i18n.tsx` (EN + KM).
6. Loop until `pnpm check` is green. If a test looks wrong, stop with `QUESTION:` — never weaken it.
