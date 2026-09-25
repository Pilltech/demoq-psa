# DemoQ PSA — rules for Claude

Agency operations system for DemoQ (Phnom Penh): pipeline → quote → scope → gated projects → tasks →
time → one approval inbox (web + Telegram) → one number per role → MCP for Claude. EN + KM, USD + KHR.
The full plan is `docs/plan/DemoQ-PSA-Build-Plan.md`. The quotation is the contract: `docs/scope.md`.

## Commands

- `pnpm check` — typecheck, lint (ESLint + boundary rules), matrix check, spec-trace check, all tests. Must pass before a PR.
- `pnpm test:unit` · `pnpm test:db` (needs local Postgres; clones `psa_template`) · `pnpm test:e2e` (Playwright; set `PW_CHROMIUM` in cloud sessions)
- `pnpm db:migrate` then `pnpm db:types` after every new migration (regenerates `packages/db/src/types.ts` + `schema.sql`; never hand-edit them)
- `pnpm seed` (synthetic demo data) · `pnpm dev:api` + `pnpm dev:web`
- First time: `sudo -u postgres bash scripts/db-setup.sh && cp .env.example .env` (set `TOTP_ENC_KEY` with `openssl rand -base64 32`)

## Data rule (non-negotiable)

Real client data never enters a Claude session. Work from schemas, aggregates and synthetic fixtures
(`packages/testkit`). Never ask for, paste, or query production/staging data. No prod credentials exist here.

## Architecture (non-negotiable)

- **Only `packages/core` touches the database.** `apps/*` are thin adapters generated from `core/src/registry.ts`.
  `packages/shared` is pure (runs in the browser). dependency-cruiser enforces this (`pnpm lint`).
- **Every mutation is a command** (`defineCommand` in `core/src/<module>/`): validate → tx + actor context →
  `load` (FOR UPDATE) → authorize via `scope` → `run` → audit → outbox, all in `execute()`. Never write to the DB
  outside `execute()` except auth bootstrap (`identity/auth.ts`) and the seed.
- **Command name = permission-checked action = audit action = future MCP tool.** Declare `exposeTo` from the spec.
  Telegram carries only attendance, timesheets and approvals (plan §5.2).
- **Permissions:** `core/src/kernel/permissions.ts` MUST equal `docs/permission-matrix.signed.csv` (`pnpm matrix:check`).
  Changing either is a PO decision — do not edit them to make a test pass; ask.
- **Invariants twice:** a TypeScript guard with a stable error code AND a Postgres backstop (CHECK/trigger/grant),
  with a test that the backstop holds when running as the `app` role.
- **Money:** `bigint` minor units + currency (`@demoq/shared/money`). Never floats, never `parseFloat`, never sum
  USD with KHR (INV-15). Money crosses JSON as a digit string.
- **Time:** core never calls `new Date()`/`Date.now()` — use `ctx.now` / `kernel.clock()`. Store `timestamptz` (UTC);
  business rules run in `Asia/Phnom_Penh`; calendar dates are `date` strings.
- **Errors:** throw `DomainError(code)`; every code has `en` and `km` text in `packages/shared/src/i18n/errors.*.json`.
  New Khmer text is prefixed `KM-DRAFT:` until the Khmer reviewer approves it.
- **Optimistic concurrency:** mutable aggregates carry `version`; commands take `expectedVersion`.
- **Migrations:** new timestamped `.sql` file in `packages/db/migrations/`. NEVER edit one that exists on `origin/main`
  (the runner refuses edited checksums). Every business table gets `set_updated_at` and `audit_row_change` triggers.
  The `app` role gets no DELETE unless the spec says so. Never run migrations against anything but local/test DBs.
- **Golden slice:** `core/src/crm/deals.ts` + `specs/crm/close-reason.md` + its tests are the pattern to copy.

## Workflow and phases

1. `/spec <module>/<feature>` — spec with numbered rules (`MOD-FEAT-NN`) from `specs/_template.md`. Ask; never guess
   business rules. Unanswered questions go to "Open questions" with the default that ships.
2. `/red` — failing tests that cite rule IDs in their names (`it("[CRM-CR-01] …")`). Commit them.
3. `/implement` — make them pass. **Do not edit test files in this phase** (a hook blocks it). If a test is wrong, stop and say so.
4. `/pr` — `pnpm check`, reviewer subagents (security, money, schema), then a PR with the rule→test table.

- Every rule in a spec needs a test (`pnpm trace:check`). Every UI string needs EN + KM.
- Prefix a question you need a human to answer with `QUESTION:` so the Stop hook lets you stop.

## Humans own (never do these unasked)

Permission matrix changes · money/pricing formulas · migrations on shared environments · anything touching
staging/prod · secrets · CI/branch protection · `.claude/` config. Propose; do not apply.
