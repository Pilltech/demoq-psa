---
name: add-command
description: Scaffold a new command or query in packages/core that mirrors the golden slice, with its contract, registry entry and test file.
argument-hint: <module>.<action>
---

# /add-command $ARGUMENTS

Mirror `packages/core/src/crm/deals.ts` (`dealMove`) exactly. Checklist:

- [ ] Input schema in `packages/shared/src/contracts/<module>.ts` (zod; money as `minorUnits`; text via `requiredText`/`optionalText`; `expectedVersion` for updates).
- [ ] `defineCommand({ name: "$ARGUMENTS", summary, permission, input, exposeTo, load, scope, run, subject })` in `packages/core/src/<module>/`.
  - `permission` must already exist in `kernel/permissions.ts`; if it does not, STOP and propose the CSV row (humans own the matrix).
  - `load` locks with `.forUpdate()` and uses `notFoundIfMissing`.
  - `scope` returns `ownerIds`/`teamIds`/`assigneeIds` for own/team/assigned grants.
  - Guard transitions with the module's `defineMachine`; call `assertVersion`.
  - Use `ctx.now`, never `new Date()`. Emit an outbox event with `ctx.emit`.
- [ ] Export from the module `index.ts`; the registry picks it up (`core/src/registry.ts` lists modules).
- [ ] Tests citing the spec's rule IDs, on every channel in `exposeTo` and one outside it.
- [ ] `pnpm check`.
