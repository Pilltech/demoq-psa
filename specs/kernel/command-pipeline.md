# kernel/command-pipeline — one pipeline for every channel

**Status:** ADR-backed kernel plumbing · **Sprint:** S1 · **Invariants:** INV-14, principle 3

## Rules

| ID     | Rule                                                                                                                                                                                                     |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| KER-01 | Every mutation is a named command executed by `execute()`: validate → transaction + actor context → load (FOR UPDATE) → authorize → run → audit → outbox → commit.                                       |
| KER-02 | A command is only reachable on the channels in its `exposeTo`; other channels get `FORBIDDEN`.                                                                                                           |
| KER-03 | Invalid input is refused with `VALIDATION` and the list of field issues, before any DB work.                                                                                                             |
| KER-04 | If anything fails, nothing is written: not the change, not the audit row, not the outbox event.                                                                                                          |
| KER-05 | A permission or channel refusal is audited with `outcome = denied` (and the target record when the input names one) even though nothing was written.                                                     |
| KER-06 | Audit input is redacted: keys that look like passwords, secrets, tokens or codes are masked, and bigints are strings.                                                                                    |
| KER-07 | Domain events emitted by a command reach the outbox in the same transaction.                                                                                                                             |
| KER-08 | Queries run in read-only transactions; reads are audited on the MCP channel ("every action audited by name").                                                                                            |
| KER-09 | The permission matrix in code equals `docs/permission-matrix.signed.csv`, and every operation's permission exists in it.                                                                                 |
| KER-10 | Every registered operation has a unique name, a summary, and at least one channel.                                                                                                                       |
| KER-11 | A query with no `scope` fails closed: an actor holding only own/team/assigned grants is refused unless the query declares `rowFiltered` and filters rows itself.                                         |
| KER-12 | Jobs hold no roles; each job actor carries an explicit list of permissions (any scope) and is audited by its name. Deadlocks and serialization failures surface as `STALE_VERSION` (retry), never a 500. |
