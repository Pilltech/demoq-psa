# commercial/retainers — monthly periods

**Status:** signed with defaults (D21) · **Sprint:** S3 · **Quotation refs:** Q-04

## Rules

| ID        | Rule                                                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| COM-RT-01 | Accepting a retainer quote creates its first monthly period (from the planned start's month) with scope items from the quote's per-period lines.                                      |
| COM-RT-02 | A daily job opens the next period 7 days before it starts, with its scope items, until the contracted number of months is reached; it is idempotent (one period per month per scope). |
| COM-RT-03 | The same job moves periods upcoming → active on their first day and active → closed after their last day.                                                                             |

Deferred (D21 default): per-period PO/deposit gates only for clients that require them — flag stored, enforcement in S4.
