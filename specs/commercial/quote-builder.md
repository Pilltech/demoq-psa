# commercial/quote-builder — live margin, margin floor, send and lock

**Status:** signed with defaults (D3, D6, D12, D23, D24, D-QB-1) · **Sprint:** S2 · **Quotation refs:** Q-02, Q-03
**Invariants:** INV-02, INV-03, INV-04, INV-15, INV-16

## Why

Account leads price work in Airtable with no margin discipline. DemoQ wants the margin visible **as you type**, a floor
that only Finance or Ops can waive, and a quote that cannot change once the client has it.

## Rules

| ID        | Rule                                                                                                                                                                                                                                                                                                                                      | Error code                              |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| COM-QB-01 | A quote belongs to an open deal and its client; it has one currency (USD or KHR), an engagement type, a billing model (one_off or retainer, with months for retainers) and lines of kind `fee` or `pass_through` with qty (thousandths), unit price and unit cost in minor units. Only the deal's owner (own) or ops_lead (any) edits it. | `VALIDATION`, `FORBIDDEN`               |
| COM-QB-02 | **Fee margin** = (fee price − fee cost) / fee price and **pass-through markup** = (pass-through price − cost) / cost, in basis points, from ONE pure function (`shared/pricing`) used live in the browser and on every server save; the server's figures are stored and win.                                                              | —                                       |
| COM-QB-03 | Line price = qty × unit price, less the line discount, each step rounded half-up; totals are sums of rounded lines (ADR-0007). Fees and pass-through are never netted.                                                                                                                                                                    | —                                       |
| COM-QB-04 | Unit costs, cost totals, margin, markup and the below-floor flag are returned only to actors holding `finance.view_costs` for that quote (account lead: own quotes). Others get prices only, on every channel.                                                                                                                            | —                                       |
| COM-QB-05 | **Submit**: a quote at or above its engagement type's floors goes to `ready`. Below the fee floor (or below a set markup floor) it goes to `margin_review` and a `margin_floor` approval is created, bound to the quote's version and content hash.                                                                                       | `QUOTE_EMPTY`                           |
| COM-QB-06 | A below-floor quote cannot be sent without an **approved** `margin_floor` approval for its **current** content hash, decided by someone other than the requester. No role is exempt.                                                                                                                                                      | `MARGIN_BELOW_FLOOR`                    |
| COM-QB-07 | Any edit after submit returns the quote to `draft`, changes the hash, and supersedes a pending approval; an old approval never covers new content.                                                                                                                                                                                        | —                                       |
| COM-QB-08 | "Send when approved": if the requester ticked it, approval triggers `quote.send` **as the requester** (re-authorised; audit `on_behalf_of` = the approval).                                                                                                                                                                               | —                                       |
| COM-QB-09 | **Send** (from `ready`): freezes FX (USD quotes: 1; KHR quotes: the current USD→KHR rate, COM-CF-06), records the hash, sender and time, and **locks** the quote. Sending v2 supersedes the deal's earlier sent version. A deal still in lead/qualified moves to proposal.                                                                | `FX_RATE_MISSING`, `INVALID_TRANSITION` |
| COM-QB-10 | **DB backstop:** lines and money columns cannot change unless the quote is draft, margin_review or ready; `accepted` never changes status.                                                                                                                                                                                                | `QUOTE_LOCKED`                          |
| COM-QB-11 | **Revise** from sent, rejected or expired creates version n+1 as a draft copy; `quote.mark_rejected` records the client's refusal on a sent quote.                                                                                                                                                                                        | `INVALID_TRANSITION`                    |
| COM-QB-12 | Every quote action is audited by name and channel.                                                                                                                                                                                                                                                                                        | —                                       |
| COM-QB-13 | Lines may be priced from a rate-card item: its price becomes the line's list price (for the discount/giveaway ledger) and its cost the default cost.                                                                                                                                                                                      | —                                       |

## Commands and queries

| Name                                                         | Permission                   | exposeTo | Risk   |
| ------------------------------------------------------------ | ---------------------------- | -------- | ------ |
| `quote.create`, `quote.save` (lines + terms), `quote.revise` | `quote.edit`                 | web, mcp | normal |
| `quote.submit`                                               | `quote.submit`               | web, mcp | normal |
| `quote.send`                                                 | `quote.send`                 | web, job | normal |
| `quote.mark_rejected`                                        | `quote.edit`                 | web      | normal |
| `quote.get`, `quote.list`                                    | `deal.view` + cost redaction | web, mcp | —      |

## Data

`engagement_types`, `project_types`, `rate_cards`, `rate_card_items`, `fx_rates`, `quotes`, `quote_lines` (plan §4.2). Lock trigger on both (COM-QB-10).

## Deferred within S2

Async EN/KM PDF (ADR-0009) is emitted as `quote.sent` with `pdf_status = pending`; the renderer lands with staging (needs Chromium in the worker image).
