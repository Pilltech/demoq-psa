# ADR-0005 · No Postgres RLS for authorization

**Status:** accepted. DemoQ is single-tenant; row visibility depends on business scopes (own/team/assigned) evaluated in `core/kernel/policy.ts`. The `dina-pos` repo uses RLS for multi-tenant isolation — a different problem. DB-level protection here is by grants (e.g. no DELETE, append-only audit) and constraints.
