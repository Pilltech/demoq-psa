# ADR-0003 · Outbox + SKIP LOCKED worker (revised in S2; pg-boss deferred)

**Status:** accepted (revised 2026-09-27). **Context:** jobs are few (Telegram cards, send-when-approved, escalation,
soon PDFs and digests) and must be enqueued in the same transaction as the change. **Decision:** `execute()` writes
domain events to `outbox`; `apps/api/src/worker.ts` claims due rows with a lease (`UPDATE … WHERE id IN (SELECT …
FOR UPDATE SKIP LOCKED)`), dispatches, and marks them delivered, with exponential backoff and a dead-letter after 8
attempts. Periodic jobs (escalation) tick in the same loop. **Consequences:** one datastore, safe with several workers,
no Redis. Revisit pg-boss when we need cron expressions, per-queue concurrency or many job types (S5 digests).
