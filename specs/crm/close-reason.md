# crm/close-reason — the golden slice

**Status:** draft for PO sign-off · **Sprint:** S1 · **Quotation refs:** Q-01 ("a pipeline with a required close reason")
**Invariant:** INV-01

## Why

DemoQ cannot learn why it wins and loses if deals are closed without a reason. The pipeline must make
"closed without a reason" impossible on every channel — web, MCP and, later, Telegram — and the DB must refuse it
even if a bug slips through. This slice is also the reference implementation that every scaffold skill copies:
spec → failing tests → command → policy → audit → REST → UI (EN/KM) → E2E.

## Rules

| ID        | Rule                                                                                                                                                                                                | Error code                                                                    |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| CRM-CR-01 | Moving a deal to **Lost** requires a close reason.                                                                                                                                                  | `CLOSE_REASON_REQUIRED` (422)                                                 |
| CRM-CR-02 | The reason must exist, be active, be of kind `lost` for Lost (`won` for Won), and not be import-only (`legacy_only`) unless the actor is the import job.                                            | `CLOSE_REASON_INVALID` (422)                                                  |
| CRM-CR-03 | A deal cannot be moved to **Won** by dragging. Won comes from accepting its quote with a win reason (`quote.accept`, S3).                                                                           | `WIN_REQUIRES_QUOTE` (409)                                                    |
| CRM-CR-04 | Won and Lost are closed. A closed deal does not move. **Lost → Qualified** only via `deal.reopen`, with a reason of at least 10 characters and the `deal.reopen` permission. Won is terminal.       | `INVALID_TRANSITION` (409), `REOPEN_REASON_REQUIRED` (422), `FORBIDDEN` (403) |
| CRM-CR-05 | Every stage change (including creation, close and reopen) appends a `deal_stage_history` row naming the user, the reason code and note. History is insert-only.                                     | —                                                                             |
| CRM-CR-06 | **DB backstop:** the `app` role cannot write a Won/Lost deal without a reason of the matching kind, nor an open deal carrying a reason.                                                             | `CLOSE_REASON_REQUIRED` via constraint `deals_close_reason_required`          |
| CRM-CR-07 | Every error code this slice raises has an English and a Khmer message; the API answers in the caller's locale.                                                                                      | —                                                                             |
| CRM-CR-08 | Every successful move writes exactly one `audit_events` row with the action `deal.move`, the actor's name and the channel; a refused attempt for lack of permission writes an `outcome=denied` row. | —                                                                             |
| CRM-CR-09 | Open stages (lead, qualified, proposal, negotiation) move freely forwards and backwards. Moving to the same stage is refused.                                                                       | `INVALID_TRANSITION`                                                          |
| CRM-CR-10 | Only the deal's owner (account lead scope `own`), or ops_lead / director / ceo (`any`), may move a deal. Everyone else is refused, on every channel.                                                | `FORBIDDEN` (403)                                                             |
| CRM-CR-11 | Moves carry `expectedVersion`; a stale version is refused so two people dragging at once cannot silently overwrite each other.                                                                      | `STALE_VERSION` (409)                                                         |
| CRM-CR-12 | Only active, non-legacy reasons are offered in the picker (`close_reason.list`), with English and Khmer labels.                                                                                     | —                                                                             |

## Commands and queries

| Name                                   | Permission                              | exposeTo | Risk   | Audit subject               |
| -------------------------------------- | --------------------------------------- | -------- | ------ | --------------------------- |
| `deal.create`                          | `deal.manage` (own = you are the owner) | web, mcp | normal | deal                        |
| `deal.move`                            | `deal.manage`                           | web, mcp | normal | deal                        |
| `deal.reopen`                          | `deal.reopen`                           | web, mcp | normal | deal                        |
| `deal.list`, `deal.get`, `deal.stages` | `deal.view`                             | web, mcp | —      | deal (reads audited on MCP) |
| `close_reason.list`                    | `close_reason.view`                     | web, mcp | —      | —                           |

Telegram exposure: none in v1 (plan §5.2: Telegram carries attendance, timesheets and approvals only).

## Permission matrix delta

`deal.view`, `deal.manage`, `deal.reopen`, `close_reason.view`, `close_reason.manage` — see the CSV (since S1).

## Data

`deals.stage`, `close_reason_code`, `close_reason_kind`, `closed_at`; composite FK to `close_reasons(code, kind)`;
CHECK `deals_close_reason_required`; `deal_stage_history` (UPDATE revoked from `app`).

## Events

`deal.created`, `deal.stage_changed`, `deal.lost`, `deal.reopened`.

## UI

Pipeline Kanban (drag between columns). Dropping on **Lost** opens a reason picker (required) with an optional note;
cancelling puts the card back. Dropping on **Won** shows the `WIN_REQUIRES_QUOTE` message. Deal drawer shows history
and the audit timeline (for `audit.view` holders). All strings in EN and KM.

## Edge cases

- Two users drag the same card: second gets `STALE_VERSION`, the board reloads.
- A reason is deactivated after a deal was closed with it: history keeps the code; the picker no longer offers it.
- Reopen clears the current close reason; the reason stays in history.

## Open questions

- **D-CR-1** Should Won be possible without a quote for legacy/one-off work? _Default:_ no (CRM-CR-03); Airtable imports use the job channel.
- **D-CR-2** Who may reopen a Lost deal? _Default:_ ops_lead, director, ceo.
- **D-CR-3** Final Khmer wording for reasons — Khmer reviewer (strings marked `KM-DRAFT:`).
