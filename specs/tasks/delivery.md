# tasks/delivery — internal QC, mark sent, client revision rounds, out-of-scope rounds

**Status:** signed with defaults (D1, D2, D-RV-1, D-RV-2, D-RV-3, D-QC-1, D-OS-1 adopted for build, Vireak Chea, 2026-09-29) · **Sprint:** S4 · **Quotation refs:** Q-11, Q-12 · **Invariants:** INV-09, INV-10, INV-19, INV-20
**Owner (dev):** · **Reviewer:**

## Why

DemoQ loses money in two places on delivery: work reaches a client before anyone else in the agency has looked at it,
and clients ask for "one more round" until the fee is gone. The quotation promises that nothing goes to a client
without an internal approval (Q-12), and that the fourth revision round is flagged as out of scope and the fifth is
impossible (Q-11). When DemoQ chooses to absorb a round, the value given away is recorded, so the CEO sees it.

## Rules

| ID        | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Error code                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| TSK-DL-01 | States: todo → in_progress → internal_review → client_ready → client_review → done, plus cancelled (from any open state; pending QC and round-4 requests are superseded). A client-facing task reaches done only through internal_review → client_ready → client_review → done; `task.move` to done is refused for it. A non-client-facing task goes in_progress → done, or through internal_review → done. Anything else is refused.                                                                                                                                                                                                                                                            | `INVALID_TRANSITION` (409), `QC_REQUIRED` (409)     |
| TSK-DL-02 | Submitting for QC, marking sent, recording a client revision request and recording client acceptance are done by the task owner (`task.move_own`) or by someone who manages the task (the project's PM, or a team lead of the owner's team). Others are refused. Every delivery command takes `expectedVersion`.                                                                                                                                                                                                                                                                                                                                                                                 | `FORBIDDEN` (403), `STALE_VERSION` (409)            |
| TSK-DL-03 | Submit for QC (in_progress → internal_review) creates a `quality_check` approval for the task's current round (required permission `task.quality_approve`; scope: the project's PMs as assignees and the owner's team, so a PM, a team lead of the owner's team or ops_lead decides). It is never routed to or offered to the owner. Each submission is recorded in `task_rounds` (kind `internal`, the round, the approval).                                                                                                                                                                                                                                                                    | `INVALID_TRANSITION`                                |
| TSK-DL-04 | The task owner can never decide their task's QC, even when they hold `task.quality_approve` (the requester is refused too, APR-EN-04): neither the owner at submission (named in the approval's `excludeDeciders`, checked by `approval.decide` even after a reassignment) nor the current owner (checked by the QC handler). An approved QC moves the task to client_ready (client-facing) or done (not client-facing).                                                                                                                                                                                                                                                                         | `SELF_APPROVAL` (403)                               |
| TSK-DL-05 | A rejected QC returns the task to in_progress **without changing `revision_round`**. Internal QC loops never count as revision rounds (INV-09, D-RV-1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | —                                                   |
| TSK-DL-06 | Mark sent (client_ready → client_review) needs an approved `quality_check` for the **current** round, decided by someone other than the owner (INV-10). It records `sent_to_client_at` and a sent reference (free text: the file and version sent, until files have versions). DB backstop: a trigger refuses `client_review` without that approval, and a CHECK needs the sent time and reference.                                                                                                                                                                                                                                                                                              | `QC_REQUIRED` (409)                                 |
| TSK-DL-07 | A client revision request (client_review → in_progress) starts rounds 1–3 at once, `revision_round + 1`, recorded in `task_rounds` (kind `client`). A request that would start round 4 does not start it (D2): it needs a rework estimate in minutes (> 0) and a note (D-RV-2), creates an `out_of_scope` approval whose subject is the task revision, and the task stays in client_review. A second round-4 request while one is pending is refused.                                                                                                                                                                                                                                            | `VALIDATION` (422), `OOS_DECISION_REQUIRED` (409)   |
| TSK-DL-08 | The round-4 decision carries an outcome (APR-EN-13). **Absorb**: round 4 begins (in_progress, `revision_round = 4`, `oos_decision = absorb`, a `task_rounds` row with the approval and rework minutes). **Change order**: the task stays in client_review; the outcome is recorded and an accepted change order creates the new task with its own rounds (COM-CO-04). **Reject**: the task stays in client_review; the decision note is kept for the client. Absorb is never decided over MCP (INV-19).                                                                                                                                                                                          | `DECIDE_IN_APP` (403)                               |
| TSK-DL-09 | Deciding **absorb** on an out-of-scope request writes one immutable `absorbed_out_of_scope` giveaway row (D10, D-RV-3): minutes × the linked scope item's implied rate (unit price ÷ quoted minutes), converted to USD cents at the scope's frozen FX, rounded once half-up, attributed to the month of the decision (Asia/Phnom_Penh), source = the approval. Minutes are the round's rework estimate, or the task estimate for an absorbed out-of-scope task. With no scope item or no quoted minutes the row is written at 0 with note `valuation_pending`.                                                                                                                                   | —                                                   |
| TSK-DL-10 | A request for round 5 is refused with `REVISION_HARD_STOP` (409) on every channel (web and MCP); more work needs an accepted change order (D1). DB backstops (INV-09): `CHECK (revision_round BETWEEN 0 AND 4)`, `CHECK (revision_round < 4 OR oos_decision = 'absorb')`, a trigger that moves the round only by one, only on client_review → in_progress, and (S4 hardening) round 4 only with `revision_oos_approval_id` naming this task's `out_of_scope` approval (`subject_type = 'task_revision'`, `subject_version = 4`) approved with outcome `absorb` — writing `oos_decision = 'absorb'` by hand is not enough.                                                                        | `REVISION_HARD_STOP` (409)                          |
| TSK-DL-11 | Over-quantity (D-OS-1, S4-03): creating a client-facing task on a client project, or re-linking one, to a scope item that already has as many client-facing, non-cancelled tasks as its quantity (rounded up) needs an out-of-scope reason and creates an `out_of_scope` approval exactly like an unscoped task (TSK-TK-02); the task keeps its scope link and cannot start until the approval is granted. A re-link is only possible before the task starts.                                                                                                                                                                                                                                    | `OUT_OF_SCOPE_REQUIRED` (422), `INVALID_TRANSITION` |
| TSK-DL-12 | The client's acceptance moves client_review → done and supersedes a pending round-4 request (it leaves the inbox; deciding it is `ALREADY_DECIDED`). A round-4 decision on a request the task no longer waits for is refused (`INVALID_TRANSITION`), so "absorb" is never recorded without its round. The project board, "my tasks" and the task view return every state, the current `revision_round`, the current round's QC (status, approval, whether I may decide it), the latest round-4 request (status, outcome, decision note), what a revision request would do next (`normal`, `out_of_scope`, `hard_stop`) and the actions the viewer may take; the task view also lists its rounds. | —                                                   |
| TSK-DL-13 | On Telegram, out-of-scope cards (task requests and round-4 requests) carry three single-use buttons — Absorb, Change order, Reject — each deciding with its outcome; quality-check cards keep Approve / Reject. Buttons stay single-use and bound to one user (TG-04).                                                                                                                                                                                                                                                                                                                                                                                                                           | —                                                   |
| TSK-DL-14 | Every delivery command is audited by name with the task as subject, and every row change of `tasks` and `task_rounds` is in the row audit. `task_rounds` is insert-only for the app role.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | —                                                   |

## Commands and queries

| Name                                  | Permission                                        | exposeTo                             | Risk   | Audit subject |
| ------------------------------------- | ------------------------------------------------- | ------------------------------------ | ------ | ------------- |
| `task.submit_qc`                      | task.move_own (owner, or a task manager)          | web, mcp                             | normal | task          |
| `task.mark_sent`                      | task.move_own (owner, or a task manager)          | web, mcp                             | normal | task          |
| `task.request_revision`               | task.move_own (owner, or a task manager)          | web, mcp                             | normal | task          |
| `task.client_accept`                  | task.move_own (owner, or a task manager)          | web, mcp                             | normal | task          |
| `approval.decide` (QC)                | approval.view; decider needs task.quality_approve | web, telegram, mcp                   | high   | approval      |
| `approval.decide` (OOS)               | approval.view; decider needs scope.oos.decide     | web, telegram, mcp (absorb: not mcp) | high   | approval      |
| `task.board`, `task.mine`, `task.get` | project.view                                      | web, mcp                             | —      | project/task  |

"Owner, or a task manager": the command checks `task.move_own` with the task owner as `own`, and also counts as `own`
a caller who holds `task.manage` over the task (every PM and team lead holds `task.move_own`).

## Permission matrix delta

None. `task.quality_approve` (S4) and `scope.oos.decide` (S3) are already signed.

## Data

Migration `20261130_0014_delivery.sql`:

- `tasks.status` gains `internal_review`, `client_ready`, `client_review`.
- `tasks`: `revision_round int NOT NULL DEFAULT 0`, `oos_decision` (absorb, change_order, reject — the latest round-4
  decision), `revision_oos_approval_id`, `quality_approval_id` (latest QC), `sent_to_client_at`, `sent_reference`.
- INV-09: `tasks_revision_round_max` `CHECK (revision_round BETWEEN 0 AND 4)`, `tasks_revision_round_absorb`
  `CHECK (revision_round < 4 OR oos_decision = 'absorb')`; trigger `tasks_delivery_guard` (`tasks_revision_step`):
  a new task starts at 0; the round moves by exactly one and only on client_review → in_progress; round 4 needs the
  task's own approved round-4 `absorb` approval (`tasks_revision_oos_approval`, migration `20261130_0018`).
- INV-10: trigger `tasks_delivery_guard` (`tasks_qc_required`): entering `client_review` needs an approved
  `quality_check` on the task with `subject_version = revision_round` decided by someone other than the owner.
  `tasks_sent_recorded`: client_review needs `sent_to_client_at` and `sent_reference`. `tasks_client_states`: only
  client-facing tasks are client_ready or client_review.
- `task_rounds(task_id, round, kind internal|client, quality_approval_id, oos_approval_id, rework_minutes, note,
requested_by)`: insert-only; one client row per round; round 4 only with its out-of-scope approval.
- `tasks_guard` (TSK-TK-02 / PRJ-GT-05) checks gates and a pending task out-of-scope request when work begins (from
  todo), not on moves between delivery states.
- Approvals: QC — `subject_type = 'task'`, `subject_version` = the round. Round 4 — `kind = out_of_scope`,
  `subject_type = 'task_revision'`, `subject_id` = the task, `subject_version = 4`.

## Events (outbox)

`task.qc_submitted`, `task.qc_approved`, `task.qc_rejected`, `task.sent_to_client`, `task.revision_started`,
`task.revision_oos_requested`, `task.revision_oos_decided`, `task.client_accepted`; `approval.assigned` sends the
Telegram card.

## UI

Backend only in this step. The board DTO carries `status`, `revision_round`, `qc`, `qcStatus`, `revisionRequest`,
`nextRevision` and `actions` so the board can render the new columns and buttons.

## Edge cases

- A QC loop in round 2 keeps round 2; the next QC is for round 2 again.
- Reassigning a task to the person who approved its QC makes mark-sent refuse (the approval is now the owner's).
- A round-4 request decided change_order or reject can be asked again later (a new approval); round 4 still starts
  only on absorb.
- Tasks spawned by an accepted change order start at round 0 with their own rounds.
- Template tasks created at acceptance count towards a scope item's quantity but are not themselves checked.

## Open questions

- D-RV-3 says "unit price ÷ quoted minutes". Scope items carry quoted minutes per line, so for a line with quantity > 1
  the implied rate may be meant as line price ÷ quoted minutes. Default shipped: unit price ÷ quoted minutes, as
  written. Finance to confirm.
- Legacy import (plan §8, INV-09/INV-10 rows) — `legacy` flags and the importer exemption come with the import step.
