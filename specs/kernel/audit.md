# kernel/audit — append-only, by name

**Status:** ADR-0010 · **Sprint:** S1 · **Invariant:** INV-14

## Rules

| ID     | Rule                                                                                                                           |
| ------ | ------------------------------------------------------------------------------------------------------------------------------ |
| AUD-01 | The `app` role can INSERT and SELECT audit rows, never UPDATE, DELETE or TRUNCATE.                                             |
| AUD-02 | A trigger refuses UPDATE/DELETE/TRUNCATE on audit tables even for the schema owner.                                            |
| AUD-03 | Every business-table row change is captured in `audit_changes` with the actor name, channel and request id set by the command. |
| AUD-05 | The row-change trigger works for any key type (uuid, bigint, text, `key`); configuration tables (`settings`) are audited too.  |
| AUD-04 | `audit.timeline` shows, newest first, who did what to a record and on which channel; only `audit.view` holders may read it.    |
