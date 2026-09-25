# ADR-0003 · pg-boss, not Redis

**Status:** accepted (to implement in S2). Jobs (escalation, digests, send-on-approval, PDF) are enqueued transactionally from the `outbox` table written by `execute()`; a worker drains it into pg-boss. One datastore to back up and restore.
