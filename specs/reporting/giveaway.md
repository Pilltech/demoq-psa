# reporting/giveaway — value given away (ledger, S3 part)

**Status:** signed with defaults (D10) · **Sprint:** S3 (CEO drill-down in S5) · **Quotation refs:** Q-24

## Rules

| ID        | Rule                                                                                                                                                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| REP-GV-01 | `giveaway_entries` is insert-only (no UPDATE/DELETE for the app role); corrections are new rows. Each row has an attributed month (Asia/Phnom_Penh), client, project, kind, amount in USD cents, the FX used and its source.  |
| REP-GV-02 | Accepting a quote or change order writes one `discount_vs_ratecard` row per fee line priced below its rate-card list price (list × qty − line price), converted to USD at the frozen rate; nothing when there is no discount. |
