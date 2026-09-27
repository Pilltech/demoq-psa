# projects/projects — client and internal projects

**Status:** signed with defaults · **Sprint:** S3 · **Quotation refs:** Q-05, Q-06

## Rules

| ID        | Rule                                                                                                                                                                                                     | Error code                           |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| PRJ-PJ-01 | A project has a client (or is internal), a project type, an engagement type, a planned start (required), a PM and members with a project role (e.g. designer, editor, copywriter).                       | `VALIDATION`                         |
| PRJ-PJ-02 | Machine: gated → active only when every gate is satisfied or not applicable; active ⇄ on_hold; active/on_hold → completed; any open state → cancelled. Internal projects have no gates and start active. | `GATE_BLOCKED`, `INVALID_TRANSITION` |
| PRJ-PJ-03 | Changing the planned start before activation moves the due dates of template tasks by the same number of days.                                                                                           | —                                    |
| PRJ-PJ-04 | The project's PM (assigned) or ops_lead (any) manages members, planned start and status; every internal role can view projects.                                                                          | `FORBIDDEN`                          |
