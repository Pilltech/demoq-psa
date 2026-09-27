# projects/bypass — named, reasoned, reviewed monthly

**Status:** signed with defaults (D12, D29) · **Sprint:** S3 · **Quotation refs:** Q-07 · **Invariants:** INV-07

## Rules

| ID        | Rule                                                                                                                                                                                                                                                                     | Error code                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| PRJ-BP-01 | A bypass request names the missing gates it covers, a named owner (an active user), a reason of at least 30 characters and an expiry at most 30 days away; it creates a `gate_bypass` approval (ops_lead → director).                                                    | `BYPASS_INVALID` (422)           |
| PRJ-BP-02 | Only an eligible person decides (never the requester, never a job); approval opens the bypass, rejection closes it. Telegram needs two taps; MCP cannot decide it.                                                                                                       | `SELF_APPROVAL`, `DECIDE_IN_APP` |
| PRJ-BP-03 | An open bypass lets work start on the gates it covers until it expires.                                                                                                                                                                                                  | —                                |
| PRJ-BP-04 | An hourly job closes open bypasses that expired (`expired`) or whose gates are now all met (`gates_met`).                                                                                                                                                                | —                                |
| PRJ-BP-05 | On the first working day of each month a job creates one `bypass_review` approval for directors listing every bypass and PO exemption of the previous month; the review report shows them; the decision records the review outcome. Running it twice creates one review. | —                                |
| PRJ-BP-06 | **DB backstop:** reason ≥ 30 characters, expiry ≤ 30 days after approval (legacy ≤ 60), a named owner and a human approver are CHECKed.                                                                                                                                  | —                                |
