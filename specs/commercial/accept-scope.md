# commercial/accept-scope — accepting a quote turns it into scope, a project and tasks

**Status:** signed with defaults (D20, D21, D22, D-AC-1) · **Sprint:** S3 · **Quotation refs:** Q-01, Q-04, Q-05, Q-10 · **Invariants:** INV-01, INV-04, INV-05

## Rules

| ID        | Rule                                                                                                                                                                                                                                                           | Error code                                                                |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| COM-AC-01 | `quote.accept` works only on a `sent` quote, needs an active **win** reason, a planned start date and (default: the quote owner) a project manager.                                                                                                            | `WIN_REASON_REQUIRED` (422), `CLOSE_REASON_INVALID`, `INVALID_TRANSITION` |
| COM-AC-02 | In one transaction: the quote becomes `accepted` (final), other open versions of the deal become `superseded`, and the deal closes as **Won** with the win reason (stage history records it).                                                                  | —                                                                         |
| COM-AC-03 | The accepted quote becomes the scope: one scope row, and one insert-only scope item per quote line (kind, description, qty, price, quoted minutes). For a retainer, per-period lines go into the first monthly period and one-off lines into the scope itself. | —                                                                         |
| COM-AC-04 | A client project is created with the quote's project type (or the one given), engagement type, planned start and PM, in status `gated`, with five gates; `scope` and `quote` are satisfied by the acceptance itself.                                           | —                                                                         |
| COM-AC-05 | **DB backstop:** scope items can never be updated or deleted by the app role.                                                                                                                                                                                  | —                                                                         |
| COM-AC-06 | Only the deal owner (account lead, own) or ops_lead (any) accepts; it is audited by name with the win reason.                                                                                                                                                  | `FORBIDDEN`                                                               |

## Commands

| Name           | Permission     | exposeTo |
| -------------- | -------------- | -------- |
| `quote.accept` | `quote.accept` | web, mcp |
| `scope.get`    | `project.view` | web, mcp |
