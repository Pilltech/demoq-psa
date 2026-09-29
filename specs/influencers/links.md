# influencers/links — roster, assignments, expiring work-log links, submissions and approvals

**Status:** signed with defaults (D13, D-IN-1, D-IN-2) · **Sprint:** S4 (S4-07) · **Quotation refs:** Q-16, Q-19 · **Invariants:** INV-06, INV-13, INV-19
**Owner (dev):** Dev B · **Reviewer:** security (pen-test scope, plan §9.1)

## Why

DemoQ runs influencer campaigns: each influencer is contracted for a number of posts on a deliverable of the client's
quote. Today posts are chased over Telegram and tallied in Airtable, with no proof trail and no check that the
project was allowed to start. Influencers will not create accounts. So DemoQ sends each influencer a link that expires,
reaches only that influencer's assignment, and lets them log each post with proof. Nothing an influencer sends counts
until a DemoQ person approves it, and a post beyond the contract is caught as out-of-scope work (absorb, change order
or reject), so the CEO's "value given away" number sees it.

## Rules

| ID        | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Error code                                 |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| INF-RS-01 | The roster holds each influencer's name (required), up to 10 platform handles, optional phone, Telegram and notes, and an active flag. `influencer.manage` (influencer manager, ops lead) adds and edits; everyone who may issue links (`influencer.link.issue`) reads the roster, but contact details are shown to roster managers only. Edits carry `expectedVersion`.                                                                                                                                                                                                                                                                                        | `FORBIDDEN`, `STALE_VERSION`               |
| INF-RS-02 | An assignment puts one influencer on one deliverable (scope item) of a project with `contracted_posts` (1–1000), an optional per-post pass-through value (minor units, in the project's scope currency) and notes. Influencer managers (any project) and the project's PMs (assigned) create and edit them; others are refused. One assignment per project, deliverable and influencer.                                                                                                                                                                                                                                                                         | `FORBIDDEN`, `CONFLICT`, `VALIDATION`      |
| INF-RS-03 | The deliverable must belong to the project's scope, and an assignment's project, deliverable and influencer never change. **DB backstop:** trigger `influencer_assignments_guard`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `VALIDATION` (422)                         |
| INF-RS-04 | Deactivating an assignment or an influencer revokes their live links at once.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | —                                          |
| INF-RS-05 | INV-16: the per-post pass-through is a cost. Lists and DTOs (`influencer.assignment.list`, web and MCP) show it and its currency only to holders of `finance.view_costs` in the project's scope; others get `null` with `costsHidden: true`. Those who may create and edit assignments still set it.                                                                                                                                                                                                                                                                                                                                                            | —                                          |
| INF-LK-01 | A link is a 256-bit random token (32 bytes, base64url, 43 characters) returned once by `influencer.link.issue`; only its SHA-256 is stored (`work_log_links.token_hash`, unique). The token never appears in the database, the audit trail, the outbox or the request logs (the API's request serializer masks the token segment of `/api/v1/link/<token>…` and `/l/<token>`, and the value of any secret-looking query parameter).                                                                                                                                                                                                                             | —                                          |
| INF-LK-02 | Issuing needs `influencer.link.issue` in scope (influencer manager any, the project's PMs) on an active assignment of an active influencer, and INV-06: a gated project is refused. **DB backstop:** trigger on `work_log_links`.                                                                                                                                                                                                                                                                                                                                                                                                                               | `GATE_BLOCKED` (409), `INVALID_TRANSITION` |
| INF-LK-03 | D13 defaults: a link expires 7 days after issue and takes 10 submissions. Staff may choose 1–30 days and 1–50 submissions. **DB CHECK** on both bounds.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `VALIDATION` (422)                         |
| INF-LK-04 | States: `active` → `expired` (time), `revoked` (staff, at once) or `exhausted` (cap reached). A dead link never comes back and its terms (token, assignment, expiry, cap, issuer) never change (**DB trigger**). The per-request check is authoritative: an overdue link is dead before the job marks it.                                                                                                                                                                                                                                                                                                                                                       | `INVALID_TRANSITION`                       |
| INF-LK-05 | Staff list an assignment's links with state, submissions used and left, expiry and issuer — never the token. An hourly job (job actor with `influencer.jobs` only) marks overdue links `expired`; running it twice changes nothing.                                                                                                                                                                                                                                                                                                                                                                                                                             | —                                          |
| INF-LK-06 | The public link works with no account: the token alone resolves (by hash) to a link pseudo-actor `link:<assignment id>` that holds only `influencer.link.use` on channel `link`, and it only ever reaches its own assignment. Staff sessions and cookies are never read on these routes; staff cannot call `link.*`; an unknown or malformed token answers 404 with no detail; link problems carry no project internals.                                                                                                                                                                                                                                        | `NOT_FOUND` (404), `FORBIDDEN`             |
| INF-LK-07 | A dead link answers **410** `LINK_EXPIRED` with the reason (`expired`, `revoked`, `exhausted`) on view and on submit. The submission cap holds under concurrency. **DB backstop:** trigger on `influencer_work_logs` (live link of its own assignment, within the cap).                                                                                                                                                                                                                                                                                                                                                                                         | `LINK_EXPIRED` (410)                       |
| INF-LK-08 | A submission has a post URL (required; absolute http/https, no credentials, ≤ 2000), the date posted (a real date, not in the future), optional metrics (views, likes, comments, shares, saves, reach — whole numbers), up to 5 proof links (D-IN-1) and a note ≤ 1000. Unknown fields are refused; the body is ≤ 16 KB. The same post counts once per assignment (unless rejected). IP and user agent are stored. Text is stored as sent and only ever returned as JSON.                                                                                                                                                                                       | `VALIDATION` (422), `CONFLICT` (409)       |
| INF-LK-09 | INV-06 on submission: a gated project refuses it (without listing the gates to the influencer). **DB backstop:** trigger on `influencer_work_logs`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `GATE_BLOCKED` (409)                       |
| INF-LK-10 | INV-13: every submission starts `submitted` and raises an `influencer_work` approval (`influencer.work.approve`: influencer managers, the project's PMs), requested in the name of the staff member who issued the link — who therefore cannot approve it. Approve → `approved`, reject → `rejected`. Only approved work counts: `v_influencer_work_approved` and `influencer.work.summary` (approved vs contracted). **DB backstop:** a submission becomes approved only through its approved `influencer_work` approval.                                                                                                                                      | `SELF_APPROVAL`                            |
| INF-LK-11 | D-IN-2: a submission beyond `contracted_posts` (counting everything not rejected) is flagged `over_quantity` and also raises an `out_of_scope` approval (`scope.oos.decide`); its outcome (absorb, change order, reject — APR-EN-13) is recorded on the submission.                                                                                                                                                                                                                                                                                                                                                                                             | —                                          |
| INF-LK-12 | INV-13: one `influencer_extra_unbilled` giveaway row is written when the extra post is **both** absorbed (out-of-scope outcome) **and** approved (`influencer_work`), by whichever decision comes second, in the month of that decision, and never twice: the assignment's per-post pass-through converted to US cents at the project scope's frozen rate; with no per-post value, 0 and note `valuation_pending`. Absorbing a post that is then rejected gives nothing away; rejecting the work first cancels a pending out-of-scope approval. **DB backstop:** trigger `giveaway_entries_extra_post_guard` (approved and absorbed) and a unique index (once). | —                                          |
| INF-LK-13 | INV-19: `influencer_work` decisions (and "absorb") are never made over MCP.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `DECIDE_IN_APP` (403)                      |
| INF-LK-14 | Link routes allow 20 requests per minute per IP and per token (§9.1), then 429 with `Retry-After`. Responses carry `Cache-Control: no-store`, `X-Robots-Tag: noindex` and `Referrer-Policy: no-referrer`.                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `RATE_LIMITED` (429)                       |
| INF-LK-15 | Every link view and submission is audited with actor type `influencer_link`, actor name `link:<assignment id>` and channel `link`; the token is redacted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | —                                          |
| INF-LK-16 | The link and submission backstops judge a row at its own `issued_at` / `submitted_at`, so those must be the database's current time: a value more than `app_clock_policy.max_skew_seconds` (5 minutes) from `now()` is refused (triggers `work_log_links_clock`, `influencer_work_logs_clock`), and a backdated submission cannot slip in before a link's expiry or a bypass's end. The app role only reads the policy.                                                                                                                                                                                                                                         | `VALIDATION`                               |

## Commands and queries

| Name                           | Permission                | exposeTo       | Risk   | Audit subject         |
| ------------------------------ | ------------------------- | -------------- | ------ | --------------------- |
| `influencer.create`            | `influencer.manage`       | web            | normal | influencer            |
| `influencer.update`            | `influencer.manage`       | web            | normal | influencer            |
| `influencer.list` (query)      | `influencer.link.issue`   | web, mcp       | —      | —                     |
| `influencer.assignment.create` | `influencer.link.issue`   | web            | normal | influencer_assignment |
| `influencer.assignment.update` | `influencer.link.issue`   | web            | normal | influencer_assignment |
| `influencer.assignment.list`   | `influencer.link.issue`   | web, mcp       | —      | —                     |
| `influencer.link.issue`        | `influencer.link.issue`   | web            | normal | work_log_link         |
| `influencer.link.revoke`       | `influencer.link.issue`   | web, mcp       | normal | work_log_link         |
| `influencer.link.list` (query) | `influencer.link.issue`   | web, mcp       | —      | —                     |
| `influencer.link.expire_due`   | `influencer.jobs`         | job            | normal | —                     |
| `influencer.work.list` (query) | `influencer.work.approve` | web, mcp       | —      | —                     |
| `influencer.work.summary`      | `project.view`            | web, mcp       | —      | —                     |
| `link.view` (query)            | `influencer.link.use`     | link (audited) | —      | —                     |
| `link.submit`                  | `influencer.link.use`     | link           | normal | influencer_work_log   |

Link issue is web only so a token never lands in a chat or MCP transcript. Decisions go through `approval.decide`
(kinds `influencer_work` and `out_of_scope`, subject types `influencer_work_log` and `influencer_extra_post`).

### HTTP (public, no account)

| Route                                  | Op            | Success                           | Errors                                                                                       |
| -------------------------------------- | ------------- | --------------------------------- | -------------------------------------------------------------------------------------------- |
| `GET /api/v1/link/:token`              | `link.view`   | 200 link info (below)             | 404 `NOT_FOUND`, 410 `LINK_EXPIRED` (`params.reason`), 429 `RATE_LIMITED`                    |
| `POST /api/v1/link/:token/submissions` | `link.submit` | 201 `{ id, status, submissions }` | 404, 409 `GATE_BLOCKED` / `CONFLICT`, 410, 413, 415, 422 `VALIDATION` (`params.issues`), 429 |

No cookie, no CSRF header. `Accept-Language: km` gives Khmer problem titles. Errors are `application/problem+json`;
on these routes only `issues` (validation) and `reason` (for `LINK_EXPIRED`, `CONFLICT`) are ever included.

`GET` response:

```json
{
  "locale": "en",
  "state": "active",
  "influencer": { "displayName": "Srey Pich" },
  "project": { "name": "Launch campaign" },
  "deliverable": { "en": "TikTok posts", "km": "…" },
  "contractedPosts": 3,
  "submissions": { "used": 1, "max": 10, "remaining": 9 },
  "expiresAt": "2026-12-07T02:00:00.000Z",
  "accepts": {
    "metrics": ["views", "likes", "comments", "shares", "saves", "reach"],
    "maxProofUrls": 5,
    "noteMaxLength": 1000,
    "urlMaxLength": 2000
  },
  "mine": [
    { "postUrl": "https://www.tiktok.com/@sreypich/video/1", "postedOn": "2026-11-30", "status": "submitted", "submittedAt": "…" }
  ],
  "texts": { "en": { "title": "Log your posts for DemoQ", "…": "…" }, "km": { "title": "…" } }
}
```

`POST` body (`LinkSubmissionInput` in `@demoq/shared`):

```json
{
  "postUrl": "https://www.tiktok.com/@sreypich/video/2",
  "postedOn": "2026-12-01",
  "metrics": { "views": 12000, "likes": 900 },
  "proofUrls": ["https://drive.example.com/s/insights-2"],
  "note": "Posted at 7pm"
}
```

Text keys (`LINK_TEXTS_EN` / `LINK_TEXTS_KM` in `@demoq/shared`, Khmer marked `KM-DRAFT:` until reviewed; the API
returns both locales with the marker stripped): `title`, `intro`, `deliverable`, `contractedPosts`, `postUrl`,
`postUrlHint`, `postedOn`, `metrics`, `metricViews` … `metricReach`, `proofUrls`, `proofUrlsHint`, `note`, `submit`,
`submitted`, `remaining` (`{remaining}`, `{max}`), `expiresOn` (`{date}`), `yourSubmissions`, `statusSubmitted`,
`statusApproved`, `statusRejected`, `privacyNotice`.

## Permission matrix delta

No row of `docs/permission-matrix.signed.csv` changes. One code-only permission is added, `influencer.link.use`,
granted to **no role** (like `approval.escalate` and `influencer.jobs`): only the link pseudo-actor holds it, so the
signed CSV has no row for it.

## Data

Migration `20261130_0016_influencers.sql`:

- `influencers` (roster; `handles jsonb` array ≤ 10), `influencer_assignments` (`contracted_posts`,
  `per_post_passthrough_minor` + `currency`, unique per project/deliverable/influencer; trigger: deliverable in the
  project's scope, keys immutable).
- `work_log_links`: `token_hash` (hex SHA-256, unique), `status`, `issued_by/at`, `expires_at` (CHECK ≤ 30 days),
  `max_submissions` (1–50), `revoked_by/at/reason`. Trigger: INV-06 on insert (gates at `issued_at`, open bypasses
  count), dead links terminal, terms immutable.
- `influencer_work_logs`: `post_url` (CHECK http(s)), `posted_on`, `metrics jsonb` object, `proof_urls text[]` (≤ 5,
  http(s)), `note`, `status`, `over_quantity`, `approval_id`, `oos_approval_id`, `oos_outcome`, `ip inet`,
  `user_agent`, `submitted_at`, `decided_by/at`. Partial unique `(assignment_id, post_url)` where not rejected.
  Trigger: live link of its own assignment, within the cap, INV-06 at `submitted_at`; content immutable; status moves
  once, and to `approved` only through the approved `influencer_work` approval (INV-13).
- View `v_influencer_work_approved` (INV-13): approved submissions only; counts and reports read it.
- `token_hash` is already masked by `audit_row_change`. The app role has no DELETE on any of these tables.
- Migration `20261130_0018_s4_hardening.sql`: `app_clock_policy(max_skew_seconds)` (migrator-owned, app role reads
  only) and the `*_clock` triggers (INF-LK-16); `giveaway_entries_extra_post_guard` and the unique index
  `giveaway_entries_one_extra_post` (INF-LK-12).
- `proof_file_ids` (plan §4.2) follows with R2 (D-IN-1); there is no payouts table (billing ledger).

## Events (outbox)

`influencer.link_issued`, `influencer.link_revoked`, `influencer.work_submitted`, `influencer.work_approved`,
`influencer.work_rejected`, `influencer.extra_post_decided` (none carry the token). Approval assignment emits the usual
`approval.assigned` (Telegram card).

## UI

Staff screens (later step): roster, assignments per project, links per assignment (issue shows the link once with a
copy button; revoke), submissions list, approved-vs-contracted summary. Public page `/l/:token` in the PWA: renders
`texts` in the viewer's locale (EN/KM switch), the privacy notice, the form (fields as in `accepts`), "your
submissions" with their status, and the 410/404/429 problems as friendly states. Influencer-supplied text is rendered as
text, never HTML (the API never renders it). `noindex`, `no-referrer`.

## Edge cases

- A link issued while a bypass is open keeps working only while the project stays ungated (INF-LK-09 re-checks).
- Rejecting a submission frees a contracted slot: the next one is not over quantity.
- Two submissions racing for the last slot: one wins, the other gets 410 `exhausted`.
- The link issuer leaves DemoQ: the approval still routes (any other influencer manager or PM).
- A project put on hold or closed refuses issue and submission (`INVALID_TRANSITION`).

## Open questions

- Should influencer managers approve the posts on links they issued themselves? Default shipped: **no** (the issuer is
  the approval's requester; segregation of duties). DemoQ may relax it.
- D-IN-2 values an absorbed extra post at the per-post pass-through only (plan §4.2 also mentions "+ fee rate").
  Default shipped: pass-through only, as D-IN-2 states.
- INF-LK-12 (PO decision, S4 hardening): when is an absorbed extra post given away? Default shipped (INV-13-safe): only
  once DemoQ has also approved the post, whichever decision is second. The PO may choose to count it at the absorb
  decision instead (then a rejected post needs a correcting row, as before).
- INF-RS-05 (PO decision, S4 hardening): who sees the per-post pass-through? Default shipped (INV-16-safe): only
  `finance.view_costs` holders; influencer managers and PMs may still set it but read it back as hidden.
- The clock bound (INF-LK-16) compares with the database clock, because the command clock is the caller's word. The
  test suite runs on a fake clock, so the test template widens `max_skew_seconds`; tests of the bound narrow it again.
- Multi-IP alert on one link (plan §8, "should"): data (ip, user agent) is stored; the alert is not built.
