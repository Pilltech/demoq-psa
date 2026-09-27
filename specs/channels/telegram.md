# channels/telegram — link, inbox, approve from the phone

**Status:** signed with defaults · **Sprint:** S2 · **Quotation refs:** Q-20 · **Invariants:** INV-16, INV-17

## Rules

| ID    | Rule                                                                                                                                                                                                                                | Error code |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| TG-01 | The webhook accepts updates only with the configured `X-Telegram-Bot-Api-Secret-Token`; anything else is 401 and ignored. Only private chats are served.                                                                            | —          |
| TG-02 | Linking: the web app issues a one-time code (10 minutes, stored hashed); `/start <code>` links that Telegram user id to the staff account. A code works once. Unlinked users get only a "link your account" reply.                  | —          |
| TG-03 | `/inbox` lists the linked user's pending approvals as cards with Approve / Reject buttons.                                                                                                                                          | —          |
| TG-04 | Buttons carry an opaque single-use token (`a:<id>`) bound to the intended user, approval, decision, subject version and expiry (24 h). A press by anyone else, a reused or expired token is refused and nothing is decided.         | —          |
| TG-05 | `margin_floor` approvals need two taps (Approve → Confirm).                                                                                                                                                                         | —          |
| TG-06 | Decisions from Telegram run the same `approval.decide` command (channel `telegram`, audited by name); the card is edited in place with the outcome. Names and titles are HTML-escaped; button tokens never appear in the audit log. | —          |
| TG-07 | Cards show decision figures (margin, floor, total) only to holders of `finance.view_costs`.                                                                                                                                         | —          |
| TG-08 | When an approval is assigned or escalated to a linked user, the worker sends them a card.                                                                                                                                           | —          |
