# ADR-0014 · Conventions new in this project (vs dina-pos)

**Status:** accepted. Carried over: plain `.sql` migrations in one transaction each; `set_config(..., true)` context; bigint money; `pg_trgm`; never a superuser app role. New: separate migrator/app roles with default privileges; advisory lock + checksums in the runner; DB-enforced append-only audit; pnpm workspaces, Kysely, Vitest with template-cloned DBs, Playwright; timestamped migration names.
