# ADR-0010 · Append-only audit by grants plus trigger

**Status:** accepted (S1, implemented). `audit_events` (one semantic row per command, named actor, channel, redacted input) and `audit_changes` (row-level capture by trigger with actor context from `set_config`). The `app` role has INSERT/SELECT only; a trigger refuses UPDATE/DELETE/TRUNCATE even for the owner. No seal chain or partitioning until ~10M rows or an auditor asks.
