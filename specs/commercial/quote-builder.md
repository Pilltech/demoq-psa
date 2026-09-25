# commercial/quote-builder — live margin, margin floor, send and lock

**Status:** DRAFT for S2 (needs PO answers to D3, D12, D23, D24) · **Sprint:** S2 · **Quotation refs:** Q-02, Q-03
**Invariants:** INV-02, INV-03, INV-04, INV-15, INV-16

> Draft rule IDs use the `PROPOSED-` prefix so `pnpm trace:check` does not require tests yet. `/spec` renames them
> to `COM-QB-NN` once the PO signs, and `/red` then writes the tests.

## Why

Account leads price work in Airtable with no margin discipline. DemoQ wants the margin visible **as you type**, a floor
that only Finance or Ops can waive, and a quote that cannot change once the client has it.

## Proposed rules

| ID          | Rule                                                                                                                                                                                                                                                                            | Error code                            |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| PROPOSED-01 | A quote has one currency (USD or KHR) and lines of kind `fee` or `pass_through`, each with qty (milli), unit price and unit cost in minor units.                                                                                                                                | `VALIDATION`                          |
| PROPOSED-02 | **Fee margin** = (fee price − fee cost) / fee price; **pass-through markup** = (pass-through price − cost) / cost; both in basis points, computed by ONE pure function in `shared/pricing` used by the browser (live) and the server (on every save). Server totals always win. | —                                     |
| PROPOSED-03 | Lines round half-up; totals are sums of rounded lines (ADR-0007).                                                                                                                                                                                                               | —                                     |
| PROPOSED-04 | Cost fields and margins are only returned to actors with `finance.view_costs` (own = the quote's account lead). Others see prices only, on every channel.                                                                                                                       | —                                     |
| PROPOSED-05 | Submitting a quote whose fee margin is below its engagement type's floor (or markup below a set markup floor) moves it to `margin_review` and creates a `margin_floor` approval bound to the quote's `content_sha256`.                                                          | —                                     |
| PROPOSED-06 | A below-floor quote cannot be sent without an **approved** `margin_floor` approval for the **current** hash, decided by Finance or Ops who is not the requester. **No role is exempt.**                                                                                         | `MARGIN_BELOW_FLOOR`, `SELF_APPROVAL` |
| PROPOSED-07 | Editing the quote after approval changes the hash and supersedes the approval.                                                                                                                                                                                                  | —                                     |
| PROPOSED-08 | "Send when approved": on approval, a job sends the quote **as the requester** (re-authorised; audit `on_behalf_of` = approval id).                                                                                                                                              | —                                     |
| PROPOSED-09 | Send freezes FX (latest Finance rate ≤ 5 calendar days old; date printed), stores the hash, and locks the quote. Lines and money columns cannot change after send (DB trigger).                                                                                                 | `FX_RATE_MISSING`, `QUOTE_LOCKED`     |
| PROPOSED-10 | Revise is allowed only from sent/rejected/expired; it clones to version n+1 as a draft; sending v2 supersedes v1. `accepted` is terminal.                                                                                                                                       | `INVALID_TRANSITION`                  |
| PROPOSED-11 | EN and KM PDFs render asynchronously after send; delivery waits for `pdf_status = ready`.                                                                                                                                                                                       | —                                     |
| PROPOSED-12 | Every step (create, edit, submit, approve, send, revise) is audited by name and channel.                                                                                                                                                                                        | —                                     |

## Commands and queries (proposed)

| Name                                              | Permission                     | exposeTo | Risk   |
| ------------------------------------------------- | ------------------------------ | -------- | ------ |
| `quote.create`, `quote.update_lines`              | `quote.edit`                   | web, mcp | normal |
| `quote.submit`                                    | `quote.submit`                 | web, mcp | normal |
| `quote.send`                                      | `quote.send`                   | web, job | normal |
| `quote.revise`                                    | `quote.edit`                   | web, mcp | normal |
| `quote.get`, `quote.list`, `quote.preview_margin` | `deal.view` (+ cost redaction) | web, mcp | —      |

## Data (proposed)

`rate_cards`, `rate_card_items`, `engagement_types (fee_margin_floor_bp, passthrough_markup_floor_bp null, co_floor_basis)`,
`project_types`, `quotes`, `quote_lines`, `fx_rates` — as plan §4.2. Lock trigger on `quotes`/`quote_lines` (INV-04).

## Open questions

- **D3** Floors per engagement type. _Default:_ 25% fee margin; no markup floor (warning below 10%).
- **D12** Step-up threshold. _Default:_ margin more than 10 points below the floor needs step-up on web.
- **D24** Does the CEO count as Ops? _Default:_ no.
- **D-QB-1** Should discounts be a line field (`discount_bp`) or a separate line? _Default:_ `discount_bp` per line, feeding the giveaway ledger on acceptance.
