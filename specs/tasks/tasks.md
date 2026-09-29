# tasks/tasks — one owner, estimate, due date, dependencies; Kanban per project and per person

**Status:** signed with defaults · **Sprint:** S3 (review/QC/revisions in S4: `specs/tasks/delivery.md`) · **Quotation refs:** Q-08, Q-09 · **Invariants:** INV-06, INV-08, INV-20

## Rules

| ID        | Rule                                                                                                                                                                                                                                            | Error code                              |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| TSK-TK-01 | A task belongs to a project and always has a title, exactly one owner (active user), an estimate in minutes (> 0) and a due date (DB NOT NULL/CHECK).                                                                                           | `TASK_INCOMPLETE` (422)                 |
| TSK-TK-02 | On a client project a task links a scope item of that project, or is marked `non_deliverable`, or carries an out-of-scope request that creates an `out_of_scope` approval; it cannot start until that approval is granted. DB trigger backstop. | `OUT_OF_SCOPE_REQUIRED` (422)           |
| TSK-TK-03 | The owner moves todo → in_progress → done (done directly only when not client-facing) and in_progress → todo; any open state → cancelled. Review, sent and revision states: `tasks/delivery` (TSK-DL-01).                                       | `INVALID_TRANSITION`                    |
| TSK-TK-04 | Starting needs the project's gates (PRJ-GT-04) and all dependencies done.                                                                                                                                                                       | `GATE_BLOCKED`, `DEPENDENCY_OPEN` (409) |
| TSK-TK-05 | Dependencies stay within one project and never form a cycle (checked with a recursive query); a task cannot depend on itself (DB CHECK).                                                                                                        | `DEPENDENCY_CYCLE` (422)                |
| TSK-TK-06 | The project's PM (assigned) or a team lead for the owner's team creates, edits, reassigns and cancels tasks; an owner moves their own task. Others are refused.                                                                                 | `FORBIDDEN`                             |
| TSK-TK-07 | Kanban per project (all its tasks by state) and per person (my open tasks across projects); every task change is audited.                                                                                                                       | —                                       |

# tasks/templates

| ID        | Rule                                                                                                                                                                                                                                                                                                  |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TSK-TP-01 | Each project type has a template of items: title (EN/KM), role hint, offset days from the planned start, estimate, dependencies on earlier items. Admin edits templates.                                                                                                                              |
| TSK-TP-02 | A new project gets its type's template tasks: owner = the member whose project role matches the hint, else the PM; estimate from the item; due = planned start + offset; dependencies copied; each linked to the first matching scope item by service code when there is one, else `non_deliverable`. |
| TSK-TP-03 | Four starter templates are seeded, one per starter project type (D22).                                                                                                                                                                                                                                |
