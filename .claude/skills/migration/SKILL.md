---
name: migration
description: Add a new Postgres migration safely (timestamped, backstops, grants, audit triggers) and regenerate types.
argument-hint: <short_name>
---

# /migration $ARGUMENTS

1. Create `packages/db/migrations/<YYYYMMDD>_<NNNN>_$ARGUMENTS.sql` (next number; never edit an existing file that is on origin/main — the runner rejects changed checksums and a hook blocks it).
2. Conventions (plan §4.1): `id uuid pk default gen_random_uuid()`, `created_at`, `updated_at`, `version int` on mutable aggregates; money `*_minor bigint` + `currency char(3)`; `qty_milli int`; `*_bp int`; `label_en`/`label_km`; index every FK; no `ON DELETE CASCADE` on financial/audit data.
3. Every business table: `CREATE TRIGGER <t>_updated_at … set_updated_at()` and `CREATE TRIGGER <t>_audit … audit_row_change()`.
4. Grants come from default privileges (SELECT/INSERT/UPDATE for `demoq_app`). Add `GRANT DELETE` only if the spec says rows are truly deleted; `REVOKE UPDATE` for insert-only tables.
5. Each invariant in the spec gets its DB backstop (CHECK, trigger, exclusion constraint) and a `.db.test.ts` proving it holds as the `app` role.
6. Run `pnpm db:migrate && pnpm db:types` (local DB only) and commit the regenerated `types.ts` + `schema.sql`.
7. Zero-downtime: expand → migrate code → contract, in separate releases, for anything prod already uses.
