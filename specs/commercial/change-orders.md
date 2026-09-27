# commercial/change-orders — additive changes to scope

**Status:** signed with defaults (D23, D-CO-1) · **Sprint:** S3 · **Quotation refs:** Q-04 · **Invariants:** INV-03, INV-05

## Rules

| ID        | Rule                                                                                                                                                                                                                         | Error code                           |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| COM-CO-01 | A change order belongs to a project with a scope; its lines are **additive only**: quantity > 0 and price ≥ 0 (also a DB CHECK). A reduction is a Finance credit, never a CO.                                                | `CHANGE_ORDER_NOT_ADDITIVE` (422)    |
| COM-CO-02 | Margin floor on the CO's **own lines** (D23): below the engagement type's floor → `margin_review` and a `margin_floor` approval bound to the CO's content hash; send needs that approval.                                    | `MARGIN_BELOW_FLOOR`                 |
| COM-CO-03 | States: draft → (margin_review) → ready → sent → accepted / rejected; void from draft/ready. Sent COs are locked. For a retainer, a CO targets one period.                                                                   | `INVALID_TRANSITION`, `QUOTE_LOCKED` |
| COM-CO-04 | Accepting a CO appends its lines to the scope (never changes existing items) and creates one task per fee line (owner: the project PM; estimate: the line's quoted minutes, else 60; due: 7 days after acceptance — D-CO-1). | —                                    |
| COM-CO-05 | Scope value = accepted quote + accepted COs, and never decreases over any sequence of CO actions (property).                                                                                                                 | —                                    |
| COM-CO-06 | COs are managed by the project's account lead (own), its PM (assigned) or ops_lead (any); audited.                                                                                                                           | `FORBIDDEN`                          |

## Commands

`change_order.create`, `change_order.save`, `change_order.submit`, `change_order.send`, `change_order.accept`, `change_order.reject`, `change_order.void` (`change_order.manage`); `change_order.get`, `change_order.list` (`project.view`, costs redacted as COM-QB-04).
