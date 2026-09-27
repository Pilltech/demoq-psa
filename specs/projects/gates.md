# projects/gates — no work before scope, contract, quote, PO and deposit terms

**Status:** signed with defaults (D8, D20) · **Sprint:** S3 · **Quotation refs:** Q-06 · **Invariants:** INV-06, INV-21

## Rules

| ID        | Rule                                                                                                                                                                                                                                                       | Error code                |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| PRJ-GT-01 | Every client project has five gates: scope, contract, quote, purchase_order, deposit_terms. Scope and quote are satisfied by the acceptance.                                                                                                               | —                         |
| PRJ-GT-02 | A gate is satisfied with evidence (a reference of at least 3 characters, e.g. the signed contract's file name or number) by the PM (assigned) or ops_lead; who and when are recorded. Deposit terms = terms agreed with evidence, not cash received (D20). | `VALIDATION`, `FORBIDDEN` |
| PRJ-GT-03 | The PO gate is required for every client (D8) unless Finance or Ops records a client exemption with a reason; then it is `not_applicable`. The DB refuses `not_applicable` without an exemption.                                                           | `GATE_EXEMPTION_REQUIRED` |
| PRJ-GT-04 | **No work before the gates** (INV-06): starting a task on a client project needs every gate met, or an open approved bypass covering each missing gate. Refusals list the missing gates. Same on every channel.                                            | `GATE_BLOCKED` (409)      |
| PRJ-GT-05 | **DB backstop:** a task on a client project cannot enter `in_progress` while a gate is missing and no open bypass covers it.                                                                                                                               | `GATE_BLOCKED`            |
