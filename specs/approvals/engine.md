# approvals/engine — one inbox, routing, escalation, single winner

**Status:** DRAFT for S2 (needs D4, D5, D24, D27) · **Sprint:** S2 · **Quotation refs:** Q-19, Q-20, Q-21
**Invariants:** INV-17, INV-18, INV-19

> Draft rule IDs use the `PROPOSED-` prefix; renamed to `APR-EN-NN` at sign-off.

## Proposed rules

| ID          | Rule                                                                                                                                                                                                                       | Error code                     |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| PROPOSED-01 | Every approval has a kind, subject (type, id, version, content hash), requester, assignee, `required_permission`, status, `due_at`, escalation level and a snapshot of what was asked.                                     | —                              |
| PROPOSED-02 | Kinds and their permission, chain, SLA and allowed channels come from `approval_policies` (admin-editable data), seeded per plan §5.4.                                                                                     | —                              |
| PROPOSED-03 | Every assignee — initial or escalated — holds `required_permission` in scope, is not the requester, and is not on approved leave that day. If nobody qualifies, the policy's fallback approver gets it and an alert fires. | `NO_ELIGIBLE_APPROVER` (alert) |
| PROPOSED-04 | The requester can never decide their own approval, on any channel.                                                                                                                                                         | `SELF_APPROVAL`                |
| PROPOSED-05 | Decisions have a single winner: a conditional update on `status = 'pending'`; the loser gets `ALREADY_DECIDED`. Retried Telegram callbacks are idempotent.                                                                 | `ALREADY_DECIDED`              |
| PROPOSED-06 | A change to the subject's version or hash supersedes a pending approval.                                                                                                                                                   | —                              |
| PROPOSED-07 | When overdue, the approval escalates to the next eligible candidate up the manager line; earlier assignees may still decide; each hop is audited.                                                                          | —                              |
| PROPOSED-08 | `margin_floor`, `gate_bypass`, `bypass_review`, `influencer_work` and OOS "absorb" cannot be decided over MCP.                                                                                                             | `DECIDE_IN_APP`                |
| PROPOSED-09 | The decision handler for the kind runs in the same transaction as the decision.                                                                                                                                            | —                              |
| PROPOSED-10 | The inbox lists only approvals the viewer may decide or has requested; Telegram cards show cost figures only to `finance.view_costs` holders.                                                                              | —                              |
| PROPOSED-11 | Every create, hop, decision and supersede is audited with actor name and channel.                                                                                                                                          | —                              |

## Tests to write at /red (beyond one per rule)

- Requester is the only holder of the permission → fallback + alert.
- Manager-line target lacks the permission → skipped.
- Two approvers decide at the same instant (parallel transactions) → exactly one wins.
- Escalation job runs twice for the same overdue item → one hop (idempotent singleton key).

## Open questions

- **D4** SLAs per kind. _Default:_ plan §5.4 (24 h margin floor, 8 business hours QC/bypass, 48 h influencer/leave).
- **D5** Org chart and chains. _Default:_ plan §5.4.
- **D27** Digest recipients. _Default:_ daily for team_lead/PM/account_lead/ops_lead; weekly for director/ceo.
