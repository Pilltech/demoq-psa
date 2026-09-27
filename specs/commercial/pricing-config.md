# commercial/pricing-config — engagement types, project types, rate cards, FX

**Status:** signed with defaults (D3, D7, D25) · **Sprint:** S2 · **Quotation refs:** Q-03, Q-05 · **Invariants:** INV-15

## Rules

| ID        | Rule                                                                                                                                                                                                                                                                                               | Error code               |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| COM-CF-01 | An engagement type has a code, EN/KM labels, a commercial model (retainer, campaign, one_off, influencer_program), a **fee margin floor** in basis points (default 2500 = 25%), an optional **pass-through markup floor**, and a markup warning level (default 1000 = 10%). Floors are 0–10000 bp. | `VALIDATION`             |
| COM-CF-02 | Project types (e.g. TikTok campaign, video production) have a code, EN/KM labels and a default engagement type.                                                                                                                                                                                    | `VALIDATION`             |
| COM-CF-03 | A rate card has one currency; its items have a unique service code, a kind (fee or pass_through), a unit, a unit price and a unit cost in minor units (≥ 0).                                                                                                                                       | `VALIDATION`, `CONFLICT` |
| COM-CF-04 | Only admin edits engagement types, project types and rate cards; only Finance enters FX rates. Everyone who can see the pipeline can read types and card prices; **costs are visible only with `finance.view_costs`**.                                                                             | `FORBIDDEN`              |
| COM-CF-05 | FX rates are USD→KHR, one per date, stored as an exact integer (riel per USD × 10⁶); a later correction for the same date replaces it and is audited.                                                                                                                                              | `VALIDATION`             |
| COM-CF-06 | "Current rate" = the latest rate dated no more than 5 calendar days before the given day (weekends and holidays work). Older than that → none.                                                                                                                                                     | `FX_RATE_MISSING`        |

## Commands and queries

| Name                                                                                           | Permission            | exposeTo |
| ---------------------------------------------------------------------------------------------- | --------------------- | -------- |
| `engagement_type.upsert`, `project_type.upsert`, `rate_card.upsert`, `rate_card.item_upsert`   | `admin.config`        | web      |
| `fx_rate.set`                                                                                  | `fx.manage` (finance) | web      |
| `engagement_type.list`, `project_type.list`, `rate_card.list`, `rate_card.get`, `fx_rate.list` | `pricing.view`        | web, mcp |

## Permission matrix delta (applied with the defaults; PO to countersign)

`pricing.view`: every role that holds `deal.view` (ceo, director, ops_lead, finance, account_lead, viewer) plus admin · `fx.manage`: finance.
