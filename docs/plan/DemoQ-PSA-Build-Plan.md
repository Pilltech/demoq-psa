# DemoQ PSA: Master Build Plan (built in-house with Claude Code, 16 weeks)

**Owner:** Program Director · **Version:** 2.0 (revised after review) · **Date:** 2026-09-25 · **Proposed W1:** Mon 19 Oct 2026 · **Target go-live:** Mon 11 Jan 2027 · **Sign-off needed from:** DemoQ CEO, Product Owner (Ops head), Finance rep, Tech lead

This plan merges the architecture, delivery, Claude Code and QA/security/ops drafts into one plan. Where the drafts disagreed, one option was chosen and the reason is given (**Appendix A**). Business questions DemoQ still has to answer are in **Appendix B**, each with a due week and the default we ship if the answer is late.

**What changed in v2.** The review found ten critical and many major problems. The main changes:

- **Scope.** Every sentence of the quotation is Must, traced to spec rules (§7.6). The cut list now holds only things we added ourselves. A quoted clause can only be removed by a re-baseline the CEO signs.
- **Capacity.** Re-estimated bottom-up, with review, specs, meetings and the real 2026–27 holiday sub-decree included. The team is now **three engineers**. The plan states its confidence: about 50% for go-live on 11 Jan and about 85% for 25 Jan using a pre-approved reserve (§1, §7.1).
- **Calendar.** W1 is fixed at 19 Oct 2026, so cutover avoids 1 and 7 January. The pilot starts in W10, so its exit criteria can measure two confirmed weeks.
- **Domain gaps closed.** Time is split into attendance and allocations. Retainers and project types are modelled. Margin is split into fee margin and pass-through markup. Out-of-scope work is detected beyond round 4. The PO gate is on by default. Influencer work is gated.
- **Approvals.** Escalation only reaches people who are allowed to decide. Finance approving a quote no longer requires Finance to hold `quote.send`.
- **MCP.** Built on the current SDK line with a maintained OAuth library, in W7–8 so the pen test covers it. High-risk approvals cannot be decided from chat.
- **Gold-plating removed.** Audit seal chain, partitions, HA standby, Backblaze, Terraform, stateful-model tests, the NBC scraper, client share links and a payouts module are all out.
- **Claude Code set-up fixed.** The Stop hook is phase-aware. The test lock is enforced mechanically. Reviewers can see the diff. The CI review workflow has the permissions it needs. Managed settings are used. Real client data never enters a Claude session.
- **Commercials.** Contractor-style payment milestones are replaced by internal stage gates. The plan now shows a 12-month total cost next to the $20k quote.

---

## 1. Executive summary

**What we are building.** DemoQ PSA covers the whole agency workflow in one system:

- the client pipeline, and a quote with live fee margin and pass-through markup
- accepted scope (one-off or monthly retainer periods), gated project activation, tasks and revisions
- attendance and time allocation, capacity, and influencer work logs
- one approval inbox you can use from Telegram
- one number per role
- an MCP server, so staff can work the same data from Claude Cowork and Claude Code under the same permissions and gates as the screens

It works in English and Khmer and in USD and KHR. It is hosted in Singapore and replaces Airtable at go-live. **Every clause of the quotation is Must** (§7.6).

**How we will build it.**

- **People.** Three engineers build it, and Claude Code writes most of the code. Humans own the specs, the invariants, the permission matrix, the money formulas, the migrations and production.
- **One service layer.** The package `@demoq/core` holds every business rule. Web, Telegram, MCP, jobs and influencer links are thin adapters generated from one command registry. Each command declares the channels it is exposed on (`exposeTo`). The permission matrix that DemoQ signs is committed as a CSV, and CI checks the code against it (§5.8).
- **Invariants enforced twice.** In TypeScript, and again in Postgres constraints and triggers.
- **How each feature is built:** a spec with numbered rules, then failing tests (locked by a hook), then implementation, then reviewer subagents, then human review, then staging. A vertical slice ships every two weeks.
- **Repository.** A **new repository**. It carries over some conventions from the team's existing Fastify 5 / `pg` / `tsx` repo (`dina-pos`) and adds others. We checked the existing repo; the table below is accurate.

| Carried over from `dina-pos`                                         | New in this project (not existing conventions)                                                                                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Plain `.sql` migrations; one transaction per file (`src/migrate.ts`) | A separate `migrator` role and `MIGRATOR_DATABASE_URL`. Today the runner uses the app's own pool, and the app role **owns** the database (`createdb -O dina_app`). |
| `set_config(..., true)` transaction context (`withTenant`)           | `pg_advisory_lock` around migration runs; `ALTER DEFAULT PRIVILEGES` so the `app` role gets grants automatically                                                   |
| Money as `bigint` minor units                                        | Append-only enforced **at DB level** (grants + trigger). Today it is only a code convention.                                                                       |
| `pg_trgm` search                                                     | pnpm workspaces (the team uses npm today), Kysely, Vitest, Testcontainers, pg-boss, grammY, TanStack, Playwright                                                   |
| Not a superuser (the README's lesson: superusers bypass RLS)         | Timestamped migration names (the existing repo uses `001_`)                                                                                                        |

**Timeline**

| Phase                                                                  | Weeks (dates)            | Ends with                                                                                               |
| ---------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------- |
| Build: four 2-week sprints                                             | W1–8 (19 Oct – 12 Dec)   | **M1** Sell-to-start (Fri 27 Nov). Pilot-critical scope code-complete (Fri 11 Dec).                     |
| Pilot readiness, then remaining quoted features                        | W9–10 (14–26 Dec)        | **M2** Pilot-ready (Fri 18 Dec). Pilot starts Mon 21 Dec. **CC** Code-complete and freeze (Fri 25 Dec). |
| Pilot, fixes, migration rehearsal, training; no new features           | W11–12 (28 Dec – 10 Jan) | Pilot go/no-go Wed 6 Jan. Cutover Sat 9 – Sun 10 Jan.                                                   |
| All teams live, then hypercare (the quoted "first month supported")    | W13–16 (11 Jan – 6 Feb)  | **M3** Live (Fri 15 Jan). **M4** Hypercare exit (Fri 5 Feb).                                            |
| Reserve (pre-approved; used only if stage gate SG1 or SG2 triggers it) | W17–18 (8–20 Feb)        | Go-live moves to 25 Jan; hypercare runs to 19 Feb                                                       |

**Team**

| Who                                                | Commitment                                                                                                       | Owns                                                                                                                                                                                  |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dev A, tech lead                                   | Full time                                                                                                        | Kernel, authz and policy, audit, money and pricing, the commercial domain (quotes, scope, change orders, retainers), gates, the approval engine core, the reporting backend, security |
| Dev B                                              | Full time                                                                                                        | Web PWA and design system, admin screens, CRM and pipeline UI, tasks and Kanban, time UX, Telegram bot, influencer page, capacity, digests, reporting UI                              |
| **Dev C** (third engineer: full-stack platform/QA) | Full time **from W1**                                                                                            | **Formal owner of infra and ops**, CI, test infrastructure, the MCP server and OAuth (Dev A reviews as security owner), the Airtable migration track, the billing import              |
| DemoQ PO (Ops head)                                | **50% in W1–12**, 20% in hypercare, plus a **named deputy with decision rights**; answers within 2 business days | Spec sign-off, permission matrix, priorities, pilot, go/no-go                                                                                                                         |
| DemoQ Finance rep                                  | **4–6 h/week; 1 day/week in W8–12**                                                                              | Money rules, formulas, accounting export, reconciliation sign-off                                                                                                                     |
| Khmer reviewer                                     | **1 day/week from W4**, plus a **paid translator** for the bulk string pass in W5–9                              | Every `km` string, PDFs, Telegram texts                                                                                                                                               |
| Champions (one per team)                           | **2–4 h/week, released by their managers** from W4                                                               | UAT scripts, data spot-checks, role cards and videos (with the PO)                                                                                                                    |
| Pilot team (5–8 people)                            | W10–12 on production                                                                                             | Real-use evidence                                                                                                                                                                     |
| External pen tester                                | Booked W2; test W9; retest W12                                                                                   | Independent security check ($2.5–5k including retest)                                                                                                                                 |

**Honest capacity check (details in §7.1).**

- **Need.** About **171 engineer-days**: 137 of build plus 34 of review, specs and meetings. About **159** of that falls before go-live.
- **Available with three engineers.** About **150** before go-live, after 7 weekday public holidays each, 1 personal day each and pilot support. About **36** more in hypercare.
- **The gap.** Before go-live we are about **9 days (6%) short with no buffer**. The cut list of our own additions (about 8 days, §7.6) closes that to break-even. So **11 Jan is roughly a 50% date**. The pre-approved **W17–18 reserve** (two engineers) makes **25 Jan roughly an 85% date**.
- **When we decide.** We re-baseline at **SG1 (end W4)** using S2 feature velocity. S1 is foundation work and does not predict feature speed. The reserve is triggered at SG1 or SG2, never in W12.
- **Other team sizes.** Two engineers: about **24 weeks** (go-live around early March 2027). One engineer: about **40+ weeks**, with a bus factor of one; not recommended.
- **If the third engineer cannot start on 19 Oct**, SG0 fails. DemoQ then either contracts the third seat for named slices (for example migration and ops, under an IP assignment, possibly the incumbent contractor) or accepts the two-engineer date.

**Cost (12 months, details in §9.12).**

- **Cash:** about **$54–87k**, most of it engineering labour at illustrative Phnom Penh loaded rates that DemoQ replaces with actual figures. The rest is Claude seats and usage, infrastructure of about **$120–250/month**, the pen test and 0.25 FTE of maintenance after go-live.
- **DemoQ staff time** comes on top, and is needed whoever builds the system.
- **Against the contractor.** The contractor's $20k covers 4 months of build only. It says nothing about maintenance, and depends on a base we have not seen. Our bottom-up need is about 8 engineer-months even with Claude Code. We treat $20k as a warning about their estimate, not as our benchmark.

**The contractor's claimed base (decision D17, W1 Wed 21 Oct).**

- We ask for the code, the 250 tests and a signed IP assignment, and **budget a purchase price if DemoQ wants it**. A contractor losing a $20k deal is unlikely to hand it over for free in 48 hours.
- We adopt it only if a one-day audit passes all of these:
  - **Security:** every route has an authz check; the audit log is append-only at DB level; migrations rebuild from an empty DB; the tests run green in our CI; the IP assignment is signed.
  - **Fit:** the schema maps to §4.2 with less than 3 days of change, and the business logic can be separated from the routes.
- Otherwise we use its schema, screens and tests only as reference for specs (with the IP assigned), or ignore it. **The plan does not depend on it.**

**Biggest risks:** capacity and scope (§7.1); DemoQ decision latency; Airtable data breaking our invariants; the accounting export lacking the fee/pass-through split; a permission leak through Telegram or MCP; AI-written code that looks right but is wrong. Each has a mechanical mitigation and a named owner (§10).

---

## 2. Guiding principles and non-negotiable invariants

### 2.1 Principles

1. **The quotation is the contract.** Every quoted sentence has an ID (Q-01 to Q-31), spec rules and tests (§7.6). Anything we add is Could until it is proven cheap.
2. **One service layer, several surfaces.** Only `packages/core` imports the database. Web, Telegram, MCP, jobs and influencer links call named commands and queries. dependency-cruiser enforces this in CI and at Stop.
3. **Every mutation is a named command.** One pipeline, one transaction: `validate → load FOR UPDATE → authorize → state-machine guard → mutate → audit → outbox → commit`. The command name is the permission key and the audit action. Each command declares `exposeTo` in its spec.
4. **Invariants are enforced twice.** TypeScript is authoritative and gives good error messages. Postgres constraints and triggers are the backstop.
5. **Money is integers.** `bigint` minor units plus a currency code; basis points for percentages; no floats anywhere, including the browser.
6. **Time.** Timestamps are UTC `timestamptz`. Business rules run in `Asia/Phnom_Penh`, using each user's working days and the holiday table. Core never calls `new Date()`; it uses `ctx.now`.
7. **Configuration is data.** Margin floors, SLAs, approval chains, holidays, templates, project types, activity codes, close reasons and flags are admin-editable tables.
8. **Spec before code.** Every rule has an ID and at least one test. CI fails if a rule has none. The exception is kernel plumbing in W1, where an ADR plus tests is enough.
9. **Claude writes most of the code; humans own the invariants.** Sensitive paths are protected by CODEOWNERS, hooks, managed settings and CI checks. **We never rely on Claude remembering an instruction.**
10. **Real client data never enters a Claude session.** Claude sees schemas, aggregates and synthetic or masked fixtures only (§6.1).
11. **Vertical slices, always deployable.** Every merge to `main` deploys to staging. A prod release is a tagged release that a human approves.
12. **DemoQ owns everything:** accounts, code, bot, data, CLAUDE.md, prompts and runbooks, each with at least two company admins.

### 2.2 Invariants (each has a named test; the DB backstop is proven by a test that runs as the `app` role)

| ID     | Invariant                                                                                                                                                                                                                                                                                                | Core guard                                            | DB backstop                                                                                                                                   | Error                                               |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| INV-01 | A deal cannot be Won or Lost without a close reason. Accepting a quote requires a **win reason** on every channel, and that reason closes the deal as Won.                                                                                                                                               | deal machine; `quote.accept` input                    | `CHECK (stage NOT IN ('won','lost') OR close_reason_code IS NOT NULL)`                                                                        | `CLOSE_REASON_REQUIRED` / `WIN_REASON_REQUIRED` 422 |
| INV-02 | Fee margin and pass-through markup are computed by one pure function, the same in browser and server                                                                                                                                                                                                     | `@demoq/shared/pricing`                               | Server recomputes all totals on save                                                                                                          | —                                                   |
| INV-03 | A below-floor quote or change order cannot be sent without an approved `margin_floor` approval from Finance or Ops who is not the requester, bound to the content hash. **No role is exempt.**                                                                                                           | margin gate inside `quote.send` / `change_order.send` | `approvals.subject_hash`; `CHECK decided_by <> requested_by`; trigger on `quotes` going to `sent`                                             | `MARGIN_BELOW_FLOOR`, `SELF_APPROVAL`               |
| INV-04 | A sent quote is immutable. `accepted` is terminal. Revise is allowed only from sent, rejected or expired.                                                                                                                                                                                                | quote machine                                         | Trigger rejects edits to lines and money columns unless draft, margin_review or ready; trigger rejects any status change away from `accepted` | `QUOTE_LOCKED` 409                                  |
| INV-05 | Scope = the accepted quote plus accepted change orders (plus generated retainer periods). Insert-only. Change orders only add.                                                                                                                                                                           | scope service                                         | `scope_items` insert-only trigger; `CHECK qty_milli > 0 AND unit_price_minor >= 0` on CO lines                                                | `CHANGE_ORDER_NOT_ADDITIVE` 422                     |
| INV-06 | No work before the scope, contract, quote, PO and deposit-terms gates are met, unless an approved bypass is open. Applies to `task.start`, **time allocations to client projects**, **influencer link issue** and **influencer submission**. Attendance, deal/pitch and internal allocations are exempt. | `assertWorkAllowed()`                                 | Triggers on `tasks` (going to in_progress), `time_allocations` (project target), `work_log_links`, `influencer_work_logs`                     | `GATE_BLOCKED` 409, lists missing gates             |
| INV-07 | A bypass has a named owner, a reason of at least 30 characters, an approval by an eligible human (never the requester, never a job), an expiry of at most 30 days (legacy imports: at most 60, D29) and a monthly review                                                                                 | bypass commands                                       | CHECKs on `gate_bypasses`; `approved_by` must be a user                                                                                       | `BYPASS_INVALID` 422                                |
| INV-08 | A task has exactly one owner, an estimate and a due date. Template tasks get an owner from the role hint (else the PM) and a due date of `planned_start + offset`. Dependencies have no cycles.                                                                                                          | task commands; recursive-CTE cycle check              | `NOT NULL`s; `projects.planned_start NOT NULL`; `CHECK task_id <> depends_on_id`                                                              | `TASK_INCOMPLETE`, `DEPENDENCY_CYCLE`               |
| INV-09 | Round 4 exists only after an "absorb" out-of-scope decision. Round 5 is impossible. Internal QC loops never count as rounds.                                                                                                                                                                             | `REVISION_FLAG_ROUND=4`, `REVISION_HARD_STOP=5`       | `CHECK (revision_round BETWEEN 0 AND 4) AND (revision_round < 4 OR oos_decision = 'absorb')`                                                  | `OOS_DECISION_REQUIRED`, `REVISION_HARD_STOP` 409   |
| INV-10 | Nothing is marked sent to a client before internal QC is approved, for the current round, by someone other than the task owner                                                                                                                                                                           | task machine (`task.mark_sent`)                       | Trigger: `client_review` needs an approved `quality_check` for the current round                                                              | `QC_REQUIRED`, `SELF_APPROVAL`                      |
| INV-11 | One open attendance session per user, and sessions never overlap                                                                                                                                                                                                                                         | attendance commands                                   | Partial unique index on `(user_id) WHERE ended_at IS NULL`; `EXCLUDE USING gist` on `tstzrange` (needs `btree_gist`)                          | `CLOCK_RUNNING`, `TIME_OVERLAP`                     |
| INV-12 | A confirmed week locks its allocations and attendance sessions                                                                                                                                                                                                                                           | timesheet machine                                     | Trigger on both tables for rows in a confirmed week                                                                                           | `TIMESHEET_CONFIRMED`                               |
| INV-13 | Influencer submissions affect nothing until DemoQ approves them                                                                                                                                                                                                                                          | influencer service                                    | Report views filter `status='approved'`                                                                                                       | —                                                   |
| INV-14 | Every mutation on any channel writes exactly one semantic audit row naming the actor, in the same transaction. Audit is append-only.                                                                                                                                                                     | `executeCommand`                                      | `app` role has INSERT and SELECT only; a trigger raises on UPDATE/DELETE; a row-change trigger covers every business table                    | —                                                   |
| INV-15 | Currencies are never summed without a stored FX rate. Fees and pass-through are never netted.                                                                                                                                                                                                            | `Money` throws on mixed currencies; report views      | `fx_rate_to_usd NOT NULL` once a quote is sent                                                                                                | `CURRENCY_MISMATCH`                                 |
| INV-16 | Cost rates, unit costs and margin never reach an unauthorized actor on any channel. Telegram shows decision figures only to holders of `finance.view_costs`.                                                                                                                                             | DTO projectors check `finance.view_costs`             | `reporting_ro` reads through views without cost columns                                                                                       | Matrix tests assert no leak in bodies or errors     |
| INV-17 | Approval decisions have a single winner, are idempotent, and are never made by the requester                                                                                                                                                                                                             | conditional `UPDATE … WHERE status='pending'`         | CHECK above; unique single-use action tokens                                                                                                  | `ALREADY_DECIDED`, `SELF_APPROVAL`                  |
| INV-18 | Every approval assignee, initial or escalated, holds `required_permission` in scope, is not the requester and is not on approved leave. If nobody qualifies, the kind's fallback approver is used and an alert fires.                                                                                    | approval router                                       | `CHECK` on `approval_events.assignee_permission_ok` written by the router, plus a nightly assertion job                                       | `NO_ELIGIBLE_APPROVER` (alert)                      |
| INV-19 | `margin_floor`, `gate_bypass`, `bypass_review`, `influencer_work` and out-of-scope "absorb" decisions cannot be made over MCP                                                                                                                                                                            | channel policy in `approvals.decide`                  | —                                                                                                                                             | `DECIDE_IN_APP` (with a deep link)                  |
| INV-20 | Every task on a client project links to a scope item, or is marked `non_deliverable` (never client-facing), or carries an out-of-scope approval                                                                                                                                                          | task commands                                         | Trigger on `tasks` insert/update for client projects                                                                                          | `OUT_OF_SCOPE_REQUIRED`                             |
| INV-21 | A client's PO gate is required unless Finance or Ops has recorded an exemption with a reason                                                                                                                                                                                                             | gate service                                          | `project_gates` can be `not_applicable` only with a `client_gate_exemptions` row                                                              | `GATE_EXEMPTION_REQUIRED`                           |

---

## 3. Architecture and stack

### 3.1 Topology

```
 Staff browser/phone (PWA)   Telegram      Claude Code (user machine)        Cowork / claude.ai (Anthropic cloud)    Influencer phone
         │ HTTPS               │ webhook       │ MCP + OAuth (CIMD, loopback)      │ MCP + OAuth (pre-registered client)      │ /l/:token
         ▼                     ▼               ▼                                   ▼  from Anthropic's published egress range ▼
   Cloudflare: DNS, TLS 1.2+, WAF managed rules, bot protection on /l/*
               SKIP rule (no challenge/bot fight) for /mcp, /oauth/*, /.well-known/oauth-*  — rate limits stay in the app
         │
   DigitalOcean App Platform, SGP1 (one Docker image; components declared in .do/app.yaml)
   ┌─────────────────────────────────────────────────────────────────────────────────────────┐
   │ api ×2   Fastify 5: /api/v1 · /mcp (stateless per request) · /oauth/* (oidc-provider) ·   │
   │          /telegram/webhook/:secret · /l/:token → adapters → @demoq/core → db              │
   │ worker×1 pg-boss consumers + cron (Asia/Phnom_Penh) · Chromium PDF rendering (async)      │
   │ jobs     restore drill · Airtable ETL/profiling/DR runs (triggered from CI; no Claude)     │
   │ web      static React PWA                                                                 │
   └─────────────────────────────────────────────────────────────────────────────────────────┘
         │                                         │
   Managed Postgres 16, SGP1                  Cloudflare R2 files bucket (private; location per D26)
   prod: single node, PITR 7 days             │  nightly rclone copy
   rehearsal DB: real Airtable data,          ▼
   humans and CI jobs only               Backup bucket in a SEPARATE Cloudflare account
         │ nightly pg_dump -Fc | age ───────►  (bucket lock, write-only token, 35 daily + 12 monthly)
```

Staging holds **synthetic data only**. Real Airtable data lives only in prod and in the SGP1 rehearsal DB (§9.2).

### 3.2 Stack

| Concern                    | Choice                                                                                                                                                                                                                                                                                                                   | Why                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| Runtime                    | Node 22 LTS, TypeScript strict, ESM, **pnpm workspaces** (new; the team uses npm today)                                                                                                                                                                                                                                  | Workspaces let the browser and server share pure code                                                           |
| HTTP                       | Fastify 5, `fastify-type-provider-zod`, `@fastify/swagger`, `helmet`, `rate-limit`, `csrf-protection`, `cookie`, **`@fastify/formbody`** (needed by the OAuth token endpoint)                                                                                                                                            | The team knows Fastify                                                                                          |
| DB access                  | Postgres 16 (`pgcrypto`, `pg_trgm`, `btree_gist`, `citext`, ICU `km-x-icu`). `pg` + **Kysely** + `kysely-codegen`; the `sql` tag for recursive CTEs and reports.                                                                                                                                                         | Typed columns let `tsc` catch Claude's column mistakes (ADR-0001)                                               |
| Migrations                 | Plain `.sql`, timestamp names, the team's runner **ported with `MIGRATOR_DATABASE_URL` and `pg_advisory_lock`**. `schema.sql` is dumped after each migration.                                                                                                                                                            | Easy to review; one file describes the schema                                                                   |
| Validation                 | Zod in `@demoq/shared/contracts`                                                                                                                                                                                                                                                                                         | One input contract for REST, bot and MCP                                                                        |
| Web                        | React 19, Vite, TanStack Router and Query, shadcn/ui + Tailwind, installable PWA                                                                                                                                                                                                                                         | Kanban, live-margin builder and phone clock-in need a real SPA                                                  |
| i18n                       | i18next (`en`, `km`); Kantumruy Pro and Noto Sans Khmer; NFC normalisation; `label_en`/`label_km`                                                                                                                                                                                                                        | Khmer is first-class on every staff-facing surface. Admin and config screens are EN-only in v1 if D25 confirms. |
| Jobs                       | pg-boss (queue + cron with `tz`, singleton keys)                                                                                                                                                                                                                                                                         | Transactional enqueue through the outbox; no Redis                                                              |
| PDF                        | HTML templates rendered by headless Chromium in the worker, **asynchronously after the send commits**                                                                                                                                                                                                                    | Khmer shaping needs a browser engine; no long locks inside the command transaction                              |
| Telegram                   | grammY in webhook mode                                                                                                                                                                                                                                                                                                   | Typed; good with inline keyboards                                                                               |
| MCP                        | **The current TypeScript SDK line**: `@modelcontextprotocol/server` + `@modelcontextprotocol/fastify` with `createMcpHandler`, **stateless per request** (protocol revision 2026-07-28; older clients are served by the same handler). The W1 spike confirms the package is stable; if not, we use v1 in stateless mode. | No sticky sessions needed across 2 api replicas (ADR-0012)                                                      |
| OAuth authorization server | **panva `oidc-provider`**, mounted under `/oauth` through `@fastify/middie`. Our tables are its storage adapter. We do **not** hand-roll one, and do not use the removed SDK auth-router helpers.                                                                                                                        | A maintained, conformance-tested library for the riskiest new surface                                           |
| Files                      | R2 through `@aws-sdk/client-s3` + `s3-request-presigner`                                                                                                                                                                                                                                                                 | S3 API, no egress fees                                                                                          |
| Auth                       | argon2id; server-side sessions; `HttpOnly; Secure; SameSite=Lax`; **TOTP required** for ceo, director, finance, ops_lead and admin, on web login, OAuth login/consent and PAT issuance; step-up for high-risk actions                                                                                                    | No third-party identity dependency                                                                              |
| Tests                      | Vitest, fast-check, Testcontainers (CI), a template-cloned local Postgres (at Stop), Playwright, axe; k6 and OWASP ZAP **once each** before go-live                                                                                                                                                                      | See §8                                                                                                          |
| Observability              | pino JSON logs, Sentry (**region and PII scrubbing set explicitly**, D26), Better Stack logs and uptime, healthchecks.io heartbeats                                                                                                                                                                                      | See §9.3                                                                                                        |
| Infra and secrets          | **DO App Platform spec (`.do/app.yaml`) deployed from CI**; a checked-in Cloudflare config script; a company vault (1Password or Bitwarden); GitHub Environments                                                                                                                                                         | Rebuildable by either of two engineers from the spec plus a runbook, without Terraform                          |
| Email                      | Postmark or Resend                                                                                                                                                                                                                                                                                                       | Password reset; fallback notices                                                                                |

### 3.3 Repository layout (new repo `demoq/demoq-psa` in the company GitHub org)

```
demoq-psa/
  apps/
    api/        src/server.ts (Fastify: /api/v1, /mcp, /oauth/*, /telegram/webhook/:secret, /l/:token, /healthz)
                src/worker.ts (pg-boss consumers + cron; same image, different entrypoint)
                src/adapters/{rest,telegram,mcp,link}/  ← generated from the core registry; no business logic
    web/        React PWA: staff UI + public influencer work-log page; CLAUDE.md (UI rules)
  packages/
    core/       THE service layer; the only package importing @demoq/db
      src/kernel/   command.ts ctx.ts registry.ts policy.ts permissions.ts machine.ts errors.ts audit.ts outbox.ts clock.ts
      src/{identity,crm,commercial,projects,tasks,time,influencers,approvals,files,billing,reporting,notify,migration}/
                    commands.ts queries.ts policy.ts machine.ts repo.ts events.ts dto.ts index.ts CLAUDE.md
      src/crm/close-reason/   ← the hand-reviewed GOLDEN SLICE every scaffold skill mirrors (§6.4)
    shared/     PURE, no I/O: money/ pricing/ contracts/ (zod) i18n/ (en.json, km.json)
    db/         migrations/*.sql · schema.sql · migrate.ts (ported) · roles.sql · generated Kysely types · CLAUDE.md
    testkit/    factories, fixture builders, Testcontainers + template-DB bootstrap, role fixtures, matrix runner, synthetic data generator
  infra/        Dockerfile · .do/app.yaml · cloudflare/ · backup/ · restore-drill/ (verify.sql) · mask/ (record masking)
  specs/        _template.md · <module>/<feature>.md
  docs/         scope.md (quotation verbatim) · scope-trace.md (Q-IDs → rules) · permission-matrix.signed.csv
                decision-log.md · adr/ · runbooks/ · data-dictionary.md · mcp-setup-guide.md
  .claude/      settings.json · VERSION · rules/*.md · hooks/ · skills/ · agents/ · state/ (gitignored) · worktrees/ (gitignored)
  .mcp.json     project MCP servers (Playwright, pinned version)
  lefthook.yml  pre-commit typecheck on staged files; pre-push refuses while .claude/state/RED exists
  .github/      workflows/ · CODEOWNERS
```

**Boundary rules** (dependency-cruiser at Stop and in CI):

1. `apps/*` may import only `@demoq/core` (its public `index.ts`) and `@demoq/shared/*`.
2. `core/<module>` may import another module only through that module's `index.ts`.
3. Only `core` imports `db`.
4. `shared` has no I/O. It cannot import `fs`, `pg`, `fetch` or `process.env`.

### 3.4 Architecture decisions (ADRs in `docs/adr/`, first batch in W1)

- **ADR-0001 Kysely over raw strings or an ORM.**
- **ADR-0002 Four packages (core, shared, db, testkit) plus two apps.**
- **ADR-0003 pg-boss, not Redis.**
- **ADR-0004 PWA, not native apps.**
- **ADR-0005 No Postgres RLS for authorization.** DemoQ is single-tenant. The existing repo uses RLS for multi-tenant isolation, which is a different problem.
- **ADR-0006 KHR exponent 0 (whole riel).**
- **ADR-0007 Rounding is half-up per line, with a two-level reconciliation tolerance.** Stored inputs must match exactly. Recomputed totals may differ from Airtable's floating-point values by at most 1 minor unit per line, and Finance signs the list of differences (§9.7).
- **ADR-0008 Timestamp migration names.**
- **ADR-0009 Chromium PDF rendering, asynchronous after send.**
- **ADR-0010 Append-only audit by grants plus trigger. No seal chain and no partitioning** until audit passes about 10M rows or an auditor asks. If partitioning is added later, 24 months of partitions are pre-created by `migrator`, with a DEFAULT partition and a heartbeat that alerts when fewer than 3 future partitions remain. The `app` role never gets DDL.
- **ADR-0011 D0 contractor-base decision.**
- **ADR-0012 MCP SDK line, stateless transport, `oidc-provider`, and client registration (CIMD plus pre-registered, no open DCR).** Re-checked at the start of S4.
- **ADR-0013 Time model: attendance sessions and allocations are separate.**
- **ADR-0014 Conventions new in this project** (the table in §1), so nobody mistakes them for existing habits.

---

## 4. Domain model and state machines

### 4.1 Conventions

- Every table has `id uuid pk default gen_random_uuid()`, `created_at` and `updated_at`.
- Mutable aggregates carry `version int`. REST sends `If-Match`; MCP tools take `expectedVersion`. A mismatch returns `STALE_VERSION`.
- Imported tables have `airtable_id text unique`, `system_of_record` (`airtable` or `new`) and `legacy bool`.
- Money is always `*_minor bigint` + `currency char(3)`. Quantities are `qty_milli int`. Percentages are `*_bp int`. Labels are `label_en`/`label_km`.
- Every FK is indexed. There is no `ON DELETE CASCADE` on financial or audit tables.
- Every business table gets the `audit_changes` trigger. Grants come automatically through `ALTER DEFAULT PRIVILEGES FOR ROLE migrator`.

### 4.2 Tables by module

| Module                                          | Tables                                                                                                                                                                                                           | Notable columns and constraints                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Identity and org                                | `users`, `teams`, `user_roles`, `sessions`, `api_tokens`, `oidc_payloads`, `oauth_clients`, `telegram_link_codes`                                                                                                | `users`: `email citext unique`, `display_name`/`_km`, `locale`, `manager_id`, `team_id`, `telegram_user_id bigint unique null`, **`working_days smallint[]` (default Mon–Sat, D15)**, `weekly_capacity_minutes`, `cost_rate_minor` (finance only), `totp_secret_enc`. `api_tokens`: `token_hash`, `scopes[]` (**read-only for privileged roles**), `expires_at ≤ 30 d`, `revoked_at`, `last_used_at`. `oidc_payloads(model, id, payload jsonb, grant_id, uid, expires_at, consumed_at)` is the `oidc-provider` adapter. `oauth_clients` holds pre-registered clients and cached CIMD documents.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| CRM                                             | `clients`, `client_gate_exemptions`, `contacts`, `deals`, `close_reasons`, `deal_stage_history`                                                                                                                  | `clients.po_required bool **default true**`. `client_gate_exemptions(client_id, gate, reason, decided_by, decided_at, review_month)`, listed in the monthly gate/bypass review. `close_reasons(kind won or lost, label_en/km, active, legacy_only)` includes `legacy_unrecorded` (import only).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Commercial                                      | `rate_cards`, `rate_card_items`, `engagement_types`, **`project_types`**, `quotes`, `quote_lines`, `scopes`, **`scope_periods`**, `scope_items`, `change_orders`, `change_order_lines`, `fx_rates`, `currencies` | `engagement_types` (commercial model: retainer, campaign, one_off, influencer_program): **`fee_margin_floor_bp`**, **`passthrough_markup_floor_bp` null**, `co_floor_basis` (D23). **`project_types`** (many rows, for example TikTok campaign, video production, event, social management): `default_task_template_id`, `default_engagement_type_id`. `quotes`: `billing_model` (one_off or retainer), `period_months`, `version_no`, status, one `currency`, `fx_rate_to_usd` + `fx_rate_date` frozen at send, fee/pass-through/cost totals, **`fee_margin_bp`, `passthrough_markup_bp`**, `content_sha256`, `pdf_status` (pending, ready, failed), `send_on_approval bool`, `win_reason_code`, `supersedes_quote_id`; one accepted quote per deal. `quote_lines`: `kind` (fee or pass_through), `per_period bool`, `service_code`, description (en/km), `qty_milli`, unit price and cost, `discount_bp`, **`quoted_minutes`**. (`revision_allowance` is dropped; rounds 4 and 5 are fixed by the quotation.) `scope_periods(scope_id, period_start, period_end, status)`. `scope_items` is insert-only, with `scope_period_id` null for one-off scope and `quoted_minutes`. `fx_rates(rate_date, from, to, rate, source manual or nbc, entered_by)`. |
| Projects and gates                              | `projects`, `project_members`, `project_gates`, `contracts`, `purchase_orders`, `deposit_terms`, `gate_bypasses`                                                                                                 | `projects`: `project_type_id`, `engagement_type_id`, **`planned_start date NOT NULL`**, status, `kind` (client or internal). `project_gates` PK `(project_id, scope_period_id null, gate)`: gates scope, contract, quote, purchase_order, deposit_terms; status missing, satisfied or not_applicable (the last only with an exemption). For retainers, PO and deposit gates repeat per period if D21 says so. `deposit_terms` records the meaning chosen in D20. `gate_bypasses`: `gates[]`, `named_owner_id`, `reason` (CHECK ≥ 30 chars), `approval_id` (decided by a user), `expires_at` (CHECK ≤ 30 d; legacy ≤ 60 d), `legacy bool`, `close_cause`, `review_month`, `review_outcome`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Tasks                                           | `task_templates` (per **project type**), `task_template_items`, `tasks`, `task_dependencies`, `task_rounds`, `comments`                                                                                          | `tasks`: `owner_id`, `estimate_minutes`, `due_date` NOT NULL; `estimate_source` (template, manual or legacy); `scope_item_id` null, `non_deliverable bool`, `oos_approval_id` null (INV-20); `revision_round` (INV-09), `oos_decision`, `client_facing`, `sent_to_client_at`, `sent_version_file_id`, `rank`. `task_rounds(round, kind internal or client, quality_approval_id)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Time and capacity                               | **`attendance_sessions`**, **`time_allocations`**, **`activity_codes`**, `timesheet_weeks`, `holidays`, `leave_types`, `leave_requests`, view `v_capacity_week`                                                  | **`attendance_sessions(user_id, started_at, ended_at, channel, auto_closed, flagged)`**: clock in/out, INV-11, no gate check. **`time_allocations(user_id, work_date, minutes, target_type task, project, deal or internal, target_id, activity_code, source prefill, manual, telegram or mcp, status draft or confirmed)`**. INV-06 applies only to client-project targets. `activity_codes`: internal categories (admin, training, pitch, recruitment and so on), admin-editable. `timesheet_weeks` unique on `(user_id, week_start)`. `resource_bookings` is Could (§7.6).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Influencers                                     | `influencers`, `influencer_assignments`, `work_log_links`, `influencer_work_logs`                                                                                                                                | `influencer_assignments(project_id, scope_item_id, contracted_posts)`. `work_log_links`: `token_hash`, `expires_at`, `max_submissions`, `revoked_at`. `influencer_work_logs`: `post_url`, `posted_on`, `metrics jsonb`, `proof_file_ids[]`, status, `over_quantity bool`, `ip`, `user_agent`. **There is no payouts table.** Payment status comes from `vendor_payments` in the billing ledger, which is the single source of truth for influencer payments.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Billing ledger (import only, **not** invoicing) | `invoices`, `invoice_lines`, `payments_received`, `vendor_payments`, **`billing_import_mappings`**                                                                                                               | `invoice_lines(kind fee, pass_through or vat, project_id)`. `vendor_payments(payee influencer or vendor, project_id, kind pass_through)`. `billing_import_mappings(source_key → client, project, line kind, confirmed_by Finance)`. Unmapped rows go to a Finance mapping queue and never into reports.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Approvals and notifications                     | `approvals`, `approval_events`, **`approval_policies`**, `telegram_actions`, `mcp_confirm_tokens`, `notifications`, `digest_runs`, **`digest_subscriptions`**                                                    | `approvals`: kind, subject, `subject_version`, `subject_hash`, `requested_by`, `assignee_id`, `required_permission`, status, `escalation_level`, `due_at`, decided by/at/channel, `decision_note`, `snapshot jsonb`. **`approval_policies(kind, required_permission, chain jsonb, sla, fallback_approver_id, channels_allowed)`**. `approval_events` records each hop with `assignee_permission_ok`. `mcp_confirm_tokens`: user, OAuth grant, approval, subject version and hash, `expires_at` (5 min), `used_at`. `digest_subscriptions(role, digest_kind)` (D27).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Reporting                                       | **`giveaway_entries`** (immutable), views `v_role_metrics`, `v_float_exposure`, `v_fees_vs_billings`                                                                                                             | `giveaway_entries(attributed_month, occurred_on, client, project, kind, amount_usd_minor, fx_rate, source_type, source_id, adjusts_entry_id null, note)`. Rows are never updated. A correction is a new row dated in the current month. **Plain views, not materialized**, so the headline and the drill-down always run the same query.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Platform                                        | `files`, `outbox`, `settings`, `feature_flags`, `audit_events`, `audit_changes`, `import_runs`, `migration_exceptions`, schema `airtable_raw.*` (prod and rehearsal DB only; never staging)                      | `files(r2_key, bucket, original_name, mime, size_bytes, sha256, entity, status, uploaded_by)`. `migration_exceptions(entity, airtable_id, reason, resolved_at)`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

**Giveaway kinds.** Formulas are signed in D10 by W3. Valuation is always in USD at the stored rate.

| Kind                        | Source event                                                                                                     | Valuation                                                                                              | Attributed month                                                                                                        |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `discount_vs_ratecard`      | Quote or change order **accepted** (rejected quotes give nothing away)                                           | Σ (rate-card price − quoted price) over fee lines                                                      | Month of acceptance                                                                                                     |
| `absorbed_out_of_scope`     | Out-of-scope approval decided **absorb**: a round-4 request, an unscoped task, or a time overrun above threshold | The **absorbed round's own rework estimate** (or the unscoped task's estimate) × rate-card hourly rate | Month of decision. When actual minutes are confirmed, the difference is a new adjustment row in the confirmation month. |
| `time_overrun_fixed_fee`    | Timesheet week confirmed                                                                                         | Confirmed minutes beyond a scope item's `quoted_minutes` × rate-card rate, as **delta rows only**      | Month of confirmation. Closed months never change.                                                                      |
| `bypass_unbilled`           | Bypass closed as expired or revoked without its gates met                                                        | Minutes allocated under the bypass × rate-card rate                                                    | Month of closure                                                                                                        |
| `influencer_extra_unbilled` | A submission beyond `contracted_posts` is decided "absorb"                                                       | Pass-through cost of the extra post + fee rate                                                         | Month of decision                                                                                                       |
| `client_credit`             | Entered by Finance (credits given outside the scope ledger)                                                      | Amount entered                                                                                         | Month of entry                                                                                                          |

The drill-down goes month → client → project → source row. "This month" is stable because rows are immutable.

### 4.3 State machines

Machines are declarative transition tables in `core/<module>/machine.ts`. The same tables render Kanban columns and the action buttons on web and Telegram.

| Machine                 | States                                                                                                                                                                                 | Guards and transitions                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Side effects                                                                                                                                                                                                                                                                           |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Deal**                | lead → qualified → proposal → negotiation → won / lost                                                                                                                                 | Won and Lost need a close reason (INV-01). **Won comes from `quote.accept` with the win reason the user gives.** Lost → qualified (reopen) needs `deal.reopen` and a reason. **When a deal's last open quote is rejected or expires**, the account lead gets a task and an inbox prompt: "Close as Lost with a reason, or revise".                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `deal_stage_history`                                                                                                                                                                                                                                                                   |
| **Quote**               | draft → margin_review → ready → **sent (locked)** → accepted / rejected / expired / superseded                                                                                         | **Submit:** if fee margin (or pass-through markup, where a floor exists) is below the engagement-type floor, the quote goes to margin_review and a `margin_floor` approval is created, bound to `content_sha256`. **On approval** it returns to `ready`; if the requester ticked "send when approved", an outbox job runs `quote.send` **as the requester** (re-authorized, audited with `on_behalf_of` = approval id). **Send:** requires the floor rule to hold (INV-03); freezes FX (latest Finance-entered rate at most 5 calendar days old, its date printed on the quote); computes the hash; commits. The EN/KM PDF renders asynchronously and the UI shows "PDF generating". Delivery to the client waits for `pdf_status = ready`. **Revise:** only from sent, rejected or expired; clones to `version_no+1` as a draft; sending v2 supersedes v1. **Accepted is terminal** (DB trigger).                                                                                                                                                    | **Accept** (one transaction, requires a win reason): stores evidence; creates scope and `scope_items` (one-off), or the scope plus the first `scope_period` (retainer); sets the deal to Won with that reason; satisfies the scope and quote gates; writes `discount_vs_ratecard` rows |
| **Change order**        | draft → margin_review → sent → accepted / rejected / void                                                                                                                              | Floor checked on the CO's own lines by default (D23). The builder also shows cumulative scope margin as information. Lines are additive only. For retainers a CO targets one period.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Accept appends `scope_items` and creates tasks. Reductions are Finance credits (`client_credit`), outside the scope ledger.                                                                                                                                                            |
| **Retainer period**     | upcoming → active → closed                                                                                                                                                             | A daily job opens the next period 7 days before it starts. It generates `scope_items` from the `per_period` quote lines. PO and deposit gates repeat per period if D21 says so. Revision rounds count per deliverable within a period.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Overrun per period feeds `time_overrun_fixed_fee`                                                                                                                                                                                                                                      |
| **Project**             | draft → gated → active ⇄ on_hold → completed / cancelled                                                                                                                               | Created from an accepted quote with a project type and `planned_start`. Gated → active requires every gate satisfied, or not_applicable through a recorded exemption (INV-21).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Template tasks are created with owner (role hint → member, else the PM), estimate and `due = planned_start + offset`. Due dates shift if `planned_start` changes before activation. Tasks stay in To Do while gated.                                                                   |
| **Gate bypass**         | requested → open → closed (gates_met, expired or revoked); or rejected                                                                                                                 | The approver is an eligible ops_lead or director, never the requester and never a job. Telegram needs two taps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Hourly expiry job; auto-close when gates are met; a `bypass_review` approval for directors on the **first working day** of each month, listing every bypass and gate exemption from the previous month                                                                                 |
| **Task**                | todo → in_progress → internal_review → client_ready → client_review → done; plus derived `blocked` and `cancelled`. Non-client-facing tasks go in_progress → (internal_review →) done. | **Create** on an active client project: link a scope item, mark `non_deliverable`, or an `out_of_scope` approval is created (INV-20). **Start:** `assertWorkAllowed`, dependencies done, owner, estimate and due date present. **QC:** internal_review → client_ready needs an approved `quality_check` for the current round from a non-owner. A QC rejection returns the task to in_progress **without incrementing the round**. **Mark sent** (client_ready → client_review) records `sent_to_client_at` and the file version. **Client revision request:**<br>• Rounds 1–3 are normal (client_review → in_progress, round+1).<br>• **A request for round 4** creates an `out_of_scope` approval before the round starts. _Absorb_: round 4 begins and a giveaway entry is written. _Change order_: the task returns to client_review, and an accepted CO spawns a new task with its own rounds. _Reject_: the revision is refused, and the task returns to client_review with a note to the client.<br>• **Round 5** throws `REVISION_HARD_STOP`. | No public share links in v1 (Could, §7.6). Staff send files by their usual channel; the system records what was sent and when.                                                                                                                                                         |
| **Approval**            | pending → approved / rejected / cancelled / superseded                                                                                                                                 | One conditional UPDATE. The requester cannot decide. The decider needs `required_permission` and the channel must be allowed for the kind (INV-19). A change to the subject's version or hash supersedes it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `approvalHandlers[kind]` runs in the same transaction. The Telegram card is edited in place.                                                                                                                                                                                           |
| **Attendance session**  | open → closed                                                                                                                                                                          | Clock in/out on PWA or Telegram; no gate check                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Auto-close at 23:59 or after the 12 h cap, flagged for the weekly confirmation                                                                                                                                                                                                         |
| **Timesheet week**      | open → confirmed → reopened → confirmed                                                                                                                                                | The confirmed week is the user's working week (D15). Confirm locks allocations and sessions. Reopen needs `time.reopen` and a reason.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Pre-fill: allocations from task activity and the previous week's pattern, scaled to attendance totals, excluding holidays and leave                                                                                                                                                    |
| **Leave request**       | requested → approved / rejected / cancelled                                                                                                                                            | `leave` approval routed to an eligible manager (INV-18)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Feeds capacity and approver eligibility                                                                                                                                                                                                                                                |
| **Influencer work log** | submitted → approved / rejected                                                                                                                                                        | `influencer_work` approval. INV-06 on submission. Beyond `contracted_posts` → `over_quantity` + an `out_of_scope` approval.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Only approved logs count                                                                                                                                                                                                                                                               |
| **Work-log link**       | active → expired / revoked / exhausted                                                                                                                                                 | Issue requires `assertWorkAllowed`. Checked on every request, plus an hourly job.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | `410 LINK_EXPIRED`                                                                                                                                                                                                                                                                     |

### 4.4 Money and currency

- `currencies`: USD has exponent 2; KHR has exponent 0. `Money {minor: bigint, ccy}` lives in `@demoq/shared/money`. The int8 parser is BigInt, and the API serialises minor amounts as strings.
- **One currency per quote or change order.** `fx_rate_to_usd` and `fx_rate_date` are frozen at send.
- **FX:** Finance enters the National Bank of Cambodia official rate. A send uses the **latest rate no more than 5 calendar days old** (a setting), so Saturdays, Sundays and holidays work. The rate's date is printed on the quote. Finance can override it. A daily 09:30 alert fires if the newest rate is more than 3 days old. The automatic NBC import is Could.
- **Two live figures in the quote builder.** **Fee margin** = (fee price − fee cost) / fee price. **Pass-through markup** = (pass-through price − pass-through cost) / pass-through cost. Each engagement type has a fee floor, and optionally a pass-through markup floor (D3). An influencer quote dominated by pass-through is therefore not flagged just because pass-through is included. Pass-through sold below cost is still caught when a floor is set.
- Fees and pass-through are separated at the source (`quote_lines.kind`), through scope, the billing ledger and reports. VAT is always its own column.
- Rounding: half-up per line; totals are the sum of rounded lines (ADR-0007).

### 4.5 Files on Cloudflare R2

- One private bucket per environment. Keys are `{entity_type}/{entity_id}/{file_id}/{slug}`, random, with no client-supplied path. Objects are immutable.
- **Upload:** presign (authz, `pending` row, PUT valid 5 min, locked to type and length; staff up to 500 MB of video and 50 MB otherwise; influencer links 50 MB), then a direct upload, then `complete` (HEAD check: size, type, magic bytes → `ready`).
- **Download:** always through an app route (`/files/:id`) that checks the session and **issues a 60-second presigned GET at the moment of the click**. Telegram cards link to this route, never to a presigned URL.
- **Cleanup:** `pending` rows older than 24 h are swept; soft-deleted objects are purged after 30 days.

### 4.6 Scheduled jobs (pg-boss; all in `Asia/Phnom_Penh`; idempotent through singletonKey; each has a heartbeat). "Working day" is per user: `working_days` minus holidays.

| Job                              | Schedule                                        | Notes                                                                                    |
| -------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `outbox.dispatch`                | continuous                                      | Telegram and email fan-out; about 25 msg/s globally and 1 msg/s per chat                 |
| `approvals.escalate`             | every 5 min                                     | Permission-aware routing (§5.4)                                                          |
| `quote.render_pdf`               | on event                                        | After `quote.sent`; retries; alerts on failure                                           |
| `digest.daily_leads`             | 07:45 on each recipient's working days          | Recipients by `digest_subscriptions` (D27); visible items only                           |
| `digest.weekly_directors`        | 07:50 on the first working day of the week      | Giveaway month-to-date, float, open bypasses and exemptions, margin exceptions, capacity |
| `timesheet.remind`               | 14:00 on each user's last working day           | Pre-filled summary with one-tap Confirm                                                  |
| `timesheet.due_escalate`         | 12:00 on the first working day of the next week | Unconfirmed weeks escalate to the team lead                                              |
| `attendance.autoclose`           | 23:59                                           | Closes open sessions at 23:59 or after 12 h, whichever comes first, and flags them       |
| `links.expire`, `bypass.expire`  | hourly                                          |                                                                                          |
| `bypass.monthly_review`          | 08:00 on the first working day of each month    |                                                                                          |
| `retainer.open_next_period`      | daily 06:00                                     |                                                                                          |
| `fx.stale_alert`                 | daily 09:30                                     | Alerts Finance                                                                           |
| `legacy_bypass.burndown`         | weekly on the first working day, from cutover   | Evidence still missing per legacy project                                                |
| `backup.dump`, `files.replicate` | nightly 02:00 / 03:00                           | To the separate-account backup bucket                                                    |
| `restore.drill`                  | weekly until go-live, monthly afterwards        | Runs as an SGP1 job, never on GitHub runners (§9.4)                                      |
| `holidays.next_year_reminder`    | first working day on or after 1 Nov             | Admin loads next year's sub-decree                                                       |

---

## 5. Permission, approval and audit design: one service layer, several surfaces

### 5.1 The kernel command pipeline

```ts
type Channel = "web" | "telegram" | "mcp" | "job" | "link";
interface Ctx {
  actor: Actor;
  channel: Channel;
  requestId: string;
  now: Date;
  locale: "en" | "km";
  tx: Kysely<DB>;
  mcp?: { clientId: string; grantId: string; clientInfoName?: string };
  onBehalfOf?: { approvalId: string };
}

export const sendQuote = defineCommand({
  name: "quote.send", // = permission key = audit action = MCP tool name source
  input: SendQuoteInput, // zod, from @demoq/shared/contracts
  exposeTo: ["web", "job"], // declared in the spec; adapters and the MCP tool list are generated from it
  risk: "normal", // 'high' ⇒ step-up on web, two-tap on Telegram, DECIDE_IN_APP on MCP
  async authorize(ctx, input) {
    const q = await repo.quote.lock(ctx, input.quoteId);
    await can(ctx.actor, "quote.send", q);
    return q;
  },
  async run(ctx, input, q) {
    quoteMachine.assert(q.status, "send");
    await marginGate.assert(ctx, q);
    /* … */ ctx.emit("quote.sent", { quoteId: q.id });
  },
});
```

`executeCommand(ctx, cmd, input)` does the following:

1. Opens a transaction and runs `set_config('app.actor_id' | 'app.actor_name' | 'app.channel' | 'app.request_id', …, true)`.
2. Validates the input.
3. Runs `authorize`, then `run`.
4. Writes one `audit_events` row.
5. Flushes domain events to the `outbox`.
6. Commits.

**Errors** are RFC 9457 `application/problem+json` with stable codes. They include `FORBIDDEN`, `GATE_BLOCKED`, `GATE_EXEMPTION_REQUIRED`, `MARGIN_BELOW_FLOOR`, `QUOTE_LOCKED`, `WIN_REASON_REQUIRED`, `OUT_OF_SCOPE_REQUIRED`, `REVISION_HARD_STOP`, `QC_REQUIRED`, `STALE_VERSION`, `SELF_APPROVAL`, `ALREADY_DECIDED`, `STEP_UP_REQUIRED`, `DECIDE_IN_APP`, `FX_RATE_MISSING`, `LINK_EXPIRED` and `RATE_LIMITED`. Every code has `en` and `km` messages. Error bodies never include data the caller cannot read.

### 5.2 The surfaces

| Surface                       | How the actor is resolved                                                                                       | What it exposes                                                                                                                  | Notes                                                                                                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Web (REST `/api/v1`)          | Session cookie; CSRF on mutations                                                                               | Everything with `exposeTo ∋ web`                                                                                                 | Typed client generated from OpenAPI                                                                                                                            |
| Telegram                      | `from.id` → linked user; private chats only                                                                     | `attendance.clockIn/Out` (`/in`, `/out`), `timesheet.confirm` (`/week`), `approvals.list` (`/inbox`), `approvals.decide` (cards) | Webhook verifies `X-Telegram-Bot-Api-Secret-Token`. Task start, quotes and the rest are **not** exposed here, so there are no Telegram parity claims for them. |
| MCP (`/mcp`)                  | OAuth 2.1 access token (audience-checked) or PAT → user; effective permission = user permissions ∩ token scopes | Commands and queries with `exposeTo ∋ mcp` (§5.6)                                                                                | Channel policy INV-19                                                                                                                                          |
| Influencer link (`/l/:token`) | Token hash → assignment                                                                                         | `link.*` only                                                                                                                    | No account; rate limited                                                                                                                                       |
| Jobs                          | `job:<name>`, optionally `on_behalf_of`                                                                         | `system.*`, escalation, digests, send-on-approval, `import.*`                                                                    | Import runs under the dedicated `importer` DB role (§9.7)                                                                                                      |

### 5.3 Roles and permission matrix

- **Roles:** `ceo`, `director`, `ops_lead`, `finance`, `account_lead`, `project_manager`, `team_lead`, `staff`, `influencer_manager`, `admin` (system configuration only, no business approvals), `viewer`. Pseudo-actors: `influencer_link`, `job`, `anonymous`. DemoQ confirms the list and the org chart in W2.
- **Model:** typed `resource.action` keys; each grant carries a scope (`any`, `team`, `assigned` or `own`); segregation-of-duties rules (no self-approval; admin makes no business approvals).
- **Source of truth:** DemoQ signs **`docs/permission-matrix.signed.csv`**. The typed constant `permissions.ts` must equal it (CI check). Changing either needs a PR with the PO's GitHub approval (label check, §6.9).

| Permission                                                  | Granted to (scope)                                                                                                                                                                          |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deal.manage`                                               | account_lead:own, ops_lead:any, director:any, ceo:any                                                                                                                                       |
| `quote.edit`, `quote.submit`                                | account_lead:own, ops_lead:any                                                                                                                                                              |
| `quote.send`                                                | account_lead:own, ops_lead:any, director:any. **Always subject to the margin gate: below floor requires an approved `margin_floor` approval bound to the current hash; no role is exempt.** |
| `quote.approve_below_floor`                                 | finance:any, ops_lead:any; ceo only if D24 says the CEO counts as Ops; never the requester                                                                                                  |
| `quote.accept`, `change_order.manage`                       | account_lead:own, ops_lead:any; project_manager:assigned for COs                                                                                                                            |
| `client.gate_exemption`                                     | finance:any, ops_lead:any                                                                                                                                                                   |
| `project.activate`, `gate.satisfy`                          | project_manager:assigned, ops_lead:any                                                                                                                                                      |
| `project.bypass.request` / `.approve` / `.review`           | pm:assigned, account_lead:own / ops_lead:any, director:any / director, ceo                                                                                                                  |
| `task.manage` / `task.move_own`                             | project_manager:assigned, team_lead:team / staff:own                                                                                                                                        |
| `task.quality_approve`                                      | team_lead:team, project_manager:assigned, ops_lead:any (never the task owner)                                                                                                               |
| `scope.oos.decide`                                          | account_lead:own, ops_lead:any, director:any                                                                                                                                                |
| `attendance.clock_own`, `time.allocate_own` / `time.reopen` | everyone:own / team_lead:team, ops_lead:any                                                                                                                                                 |
| `leave.approve`                                             | team_lead:team, ops_lead:any, director:any                                                                                                                                                  |
| `influencer.link.issue`, `influencer.work.approve`          | influencer_manager:any, project_manager:assigned                                                                                                                                            |
| `approval.override`                                         | director, ceo: every kind **except `margin_floor`** (the quotation says Finance or Ops); needs a reason and step-up; audited                                                                |
| `finance.view_costs`                                        | finance, ops_lead, director, ceo, account_lead:own                                                                                                                                          |
| `billing.import`                                            | finance                                                                                                                                                                                     |
| `report.ceo` / `report.finance`                             | ceo, director / finance, director, ceo                                                                                                                                                      |
| `audit.view`                                                | ceo, director, ops_lead, admin                                                                                                                                                              |
| `admin.config`                                              | admin                                                                                                                                                                                       |

**Field-level redaction.** `cost_rate_minor`, `unit_cost_minor`, `cost_total_minor`, `fee_margin_bp` and `passthrough_markup_bp` are stripped by DTO projectors in core.

### 5.4 Approval engine (one inbox)

| Kind              | Required permission       | Chain (each hop filtered by INV-18)                        | Default SLA  | Telegram                                                                                                                                    | MCP                                                                      |
| ----------------- | ------------------------- | ---------------------------------------------------------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `margin_floor`    | quote.approve_below_floor | Finance → ops_lead → named fallback (D24) → alert          | 24 h         | Two taps. Card shows fee margin, floor and total to `finance.view_costs` holders. PWA step-up if more than 10 points below the floor (D12). | `DECIDE_IN_APP`                                                          |
| `out_of_scope`    | scope.oos.decide          | Client's account lead → ops_lead → director                | 24 h         | Absorb / Change order / Reject                                                                                                              | Change order or Reject via prepare/confirm; **Absorb → `DECIDE_IN_APP`** |
| `quality_check`   | task.quality_approve      | Owner's team lead or the PM → ops_lead                     | 8 business h | One tap, with an app file link                                                                                                              | prepare/confirm                                                          |
| `gate_bypass`     | project.bypass.approve    | ops_lead → director                                        | 8 business h | Two taps; step-up if longer than 14 days                                                                                                    | `DECIDE_IN_APP`                                                          |
| `bypass_review`   | project.bypass.review     | Directors → CEO                                            | 5 days       | Opens the PWA report                                                                                                                        | `DECIDE_IN_APP`                                                          |
| `influencer_work` | influencer.work.approve   | influencer_manager → PM → ops_lead                         | 48 h         | One tap, with proof links                                                                                                                   | `DECIDE_IN_APP` (the subject is attacker-supplied)                       |
| `leave`           | leave.approve             | Manager, if they hold the permission → ops_lead → director | 48 h         | One tap                                                                                                                                     | prepare/confirm                                                          |

- **Routing and escalation.** Candidates for each hop are users who hold `required_permission` in scope, are not the requester and are not on approved leave that day, ordered along the manager line. When `now() > due_at`, the approval moves to the next eligible candidate: `escalation_level++`, reset `due_at`, notify, audit the hop. Earlier assignees keep the right to decide. If no candidate remains, the kind's `fallback_approver_id` is used and the ops group gets an alert. Matrix tests cover two cases: the requester is the only permission holder, and the manager-line target lacks the permission.
- **Idempotent decisions.** `UPDATE approvals SET status=… WHERE id=$1 AND status='pending' RETURNING *`. The loser gets `ALREADY_DECIDED`.
- **Superseding.** Any change to the subject's version or hash supersedes a pending approval.
- **Digests.** Leads (D27 roles) get a daily digest; directors and the CEO a weekly one. A digest never includes items the recipient cannot see.

### 5.5 Telegram specifics

- **Linking.** A one-time code from the web app (10 min), then `/start <code>`. Offboarding unlinks automatically. Staff without Telegram use the PWA inbox plus email notices.
- **Callback security.** `callback_data` is limited to 64 bytes, so it carries an opaque single-use token `a:<12-char id>` that points to a `telegram_actions` row (approval, intended user, decision, subject version, expiry, used_at). When a button is pressed, the server:
  1. looks up the token
  2. checks that `from.id` equals the intended user
  3. checks expiry
  4. marks the token used with a conditional update
  5. re-checks the policy and the subject version
  6. runs `approvals.decide` with `channel = telegram`
  7. edits the message in place
- **Data on cards.** By default, no client financials. **Decision figures** (fee margin, floor, total) appear only on `margin_floor` cards sent to holders of `finance.view_costs`. That is an accepted risk, recorded in the decision log, because the approver cannot decide without them. Bot chats are not end-to-end encrypted.
- **Fallback.** The PWA inbox. The `telegram.approvals` flag switches the surface off without a deploy.

### 5.6 MCP specifics (Claude Cowork and Claude Code)

- **Transport.** SDK `createMcpHandler` with the Fastify adapter, **stateless per request**. Two api replicas need no sticky sessions.
- **Authorization server (`oidc-provider` under `/oauth`).** These details are checked by conformance tests; the W1 spike confirms each one against current Claude clients:
  - **Clients.** Claude Code identifies itself with a **Client ID Metadata Document**. The server advertises `client_id_metadata_document_supported: true` and `token_endpoint_auth_methods_supported` including `none`, and accepts loopback redirects on `localhost` and `127.0.0.1` with any port. **Cowork/claude.ai** uses a **pre-registered client**, added by a DemoQ org Owner as a custom connector with the DemoQ-issued client ID, redirecting to the Claude callback URL. **Dynamic client registration is off.**
  - **PKCE.** `code_challenge_methods_supported: ["S256"]`.
  - **Discovery.** On 401 the server returns `WWW-Authenticate: Bearer resource_metadata=…, scope="read"`. Putting `read` in the challenge stops clients from requesting every advertised scope. Protected-resource metadata has `resource` equal to `https://app.demoq.com.kh/mcp` exactly. Discovery and token endpoints answer in under 10 s.
  - **Tokens.** The token endpoint accepts `application/x-www-form-urlencoded` (`@fastify/formbody`). Refresh tokens for public clients rotate. Errors follow RFC 6749 (`invalid_grant`). **Audience is validated per RFC 8707**; tokens for any other resource are rejected.
  - **Login and consent.** TOTP is required for privileged roles. The consent screen shows the redirect host and the scopes.
  - **Never** use the org-wide `static_headers` connector type: it is one shared credential and breaks "audited by name".
- **PATs** are for headless `claude -p` and CI only; interactive Claude Code uses OAuth through `/mcp`. PATs are scoped, last at most 30 days and can be revoked from the profile page. **Privileged roles get read-only PATs**, and TOTP is required to issue one. The setup guide uses env expansion in a project `.mcp.json`, never a literal token in the command:
  ```json
  {
    "mcpServers": {
      "demoq": { "type": "http", "url": "https://app.demoq.com.kh/mcp", "headers": { "Authorization": "Bearer ${DEMOQ_PAT}" } }
    }
  }
  ```
  A `headersHelper` that reads the token from the vault CLI (`op read op://demoq/mcp-pat/token`) is preferred where available. gitleaks has a rule for the PAT prefix.
- **Scopes.** `read` is the default. `write` and `approvals:decide` must be requested explicitly per grant.
- **Tools.** Generated from the registry wherever `exposeTo ∋ mcp`. The list is fixed in the W3 spec `mcp/tools.md`, and CI fails if the spec list and the registry differ.
  - **Read:** `search_clients`, `get_client`, `list_deals`, `get_quote`, `get_project` (with gate status), `list_my_tasks`, `list_project_tasks`, `my_timesheet`, `team_capacity`, `my_approvals`, `get_my_number`, `giveaway_breakdown`.
  - **Write (Must, cheap through the registry, behind the `mcp.writes` flag):** `log_time` (allocations), `move_task`, `create_task`, `request_change_order`. Single call, `expectedVersion` required, `destructiveHint` set as appropriate.
  - **Approvals:** `prepare_decide_approval` returns a diff and a one-time token bound to user, OAuth grant, approval and subject version/hash (single use, 5-minute TTL). `confirm_decide_approval` (`destructiveHint: true`) executes. For INV-19 kinds, prepare returns `DECIDE_IN_APP` with a PWA or Telegram deep link.
  - **Human in the loop.** The repo's `.claude/settings.json` has an `ask` rule for `mcp__demoq__confirm_*`; explicit ask rules still prompt in auto mode. The setup guide tells Cowork users to keep write tools on "ask".
- **`mcp.writes` stays off in prod until the pen-test retest passes (W12).** Then it is turned on for pilot users, and for everyone after the W13 stability check.
- **Safety.**
  - No bulk-export or raw-SQL tools. Responses are capped at 100 rows per page.
  - 60 calls per minute per user. Over the limit: **HTTP 429 with `Retry-After`** and a clear tool error, so agents back off instead of retrying blindly.
  - Client- and user-supplied text is returned in delimited `untrusted_content` fields. This blunts injection but is not relied on: the decisions it could steer are blocked by INV-19.
- **Audit.** Every call, reads included, is audited as `mcp.<tool>` with the user's name. The **trusted client identity is the OAuth `client_id`** (the CIMD URL or pre-registered ID) plus the grant ID. `clientInfo` is kept only as a secondary field. Rows also store redacted, normalised arguments, an argument hash, the decision and the row count. An alert fires on per-user hourly read volume.
- **Network.** A Cloudflare skip rule for `/mcp`, `/oauth/*` and `/.well-known/oauth-*` lets through Anthropic's **published outbound range** (the platform docs currently list `160.79.104.0/21`; the rule is refreshed from the docs, not hard-coded from memory). An uptime check runs the full discovery chain: 401, then protected-resource metadata, then authorization-server metadata.
- **Data handling.** Data returned to Claude is processed by Anthropic under DemoQ's commercial terms and transits Anthropic's infrastructure. D16 (plan type and client NDA review) is due **before W1**.

### 5.7 Audit log

1. **`audit_events`** (semantic, written by the kernel for every command and every MCP read). Columns:
   - `id bigserial`, `occurred_at`
   - `actor_type`, `actor_id`, **`actor_name`**, `actor_role_at_time`
   - `channel`, `on_behalf_of`, `mcp_client_id`, `mcp_grant_id`, `tool`
   - `action`, `entity_type`/`id`, `reason`
   - the redacted input and the result
   - `request_id`, `ip`, `user_agent`
2. **`audit_changes`** (row level): a generic trigger on every business table records before and after values, with secrets redacted. The actor comes from `current_setting('app.actor_id', true)`; if that is missing, the row records `db:<current_user>`, which flags out-of-band edits.
3. **Integrity:** the `app` role has INSERT and SELECT only, and a trigger raises on UPDATE or DELETE (ADR-0010). The Postgres admin credential (`doadmin`) is held by 2 named people in the vault, and its use is logged in the account register.
4. **UI:** a timeline per entity, and a search by person, action, channel and date.

### 5.8 How "same permissions and gates as the screens" is proven

1. **Signed matrix as the oracle.** Expected allow/deny outcomes come from `docs/permission-matrix.signed.csv`, not from `permissions.ts`. CI fails if the two differ. So the test checks the grants DemoQ signed, not just that `can()` is called.
2. **Full matrix, in-process.** Every role × command × {own object, other team's object} runs through `executeCommand`, with no transport: about 10 roles × 80 commands × 2 ≈ 1,600 cases on per-test transactions, in under 2 minutes. Each case asserts the outcome, **no data leak in the body or error**, and a correct audit row. Fixture builders for each command's preconditions are budgeted (§7.1).
3. **Transport tests, per channel.** Actor resolution, authentication, CSRF/secret/OAuth checks, token scopes, and the no-leak error projection.
4. **Parity scenarios, about 12, only on channels where the command is exposed.** Examples: below-floor send (web/job); work gate on `task.start` (web, MCP); allocation to a gated project (web, Telegram `/week`, MCP `log_time`); revision 5 (web, MCP `move_task`); QC before mark-sent (web, MCP); double approval (web + Telegram); forwarded or replayed Telegram card; MCP `DECIDE_IN_APP` for high-risk kinds; MCP step-up refusal; influencer submission on a gated project. Each must produce identical outcomes and `audit_events` rows apart from `channel`.
5. **Completeness.** Enumerates Fastify routes (`onRoute`), MCP tools and Telegram handlers. Any not mapped to a registry command, or any MCP tool not in `mcp/tools.md`, fails the build.

---

## 6. Claude Code operating model

### 6.1 Setup principles

- **Accounts and managed settings.** A company Anthropic Team or Enterprise workspace with Claude Code seats. An org Owner sets **server-managed settings**:
  - `permissions.disableBypassPermissionsMode: "disable"`
  - the minimum Claude Code version (setting name as documented for the pinned release)
  - `autoUpdatesChannel: "stable"`
- **Version pinning.** CI pins the CLI version for `claude -p` and the Action. `.claude/VERSION` records the pinned version, and `session-context.sh` warns when `claude --version` differs. Upgrades are deliberate, in the weekly retro. Feature flags and setting names are verified with `claude --help` and `/permissions` on the pinned version.
- **Permission mode policy.** `/spec`, planning and **all kernel work run in plan mode**. Implementation may run in accept-edits or auto mode. The `/spec` and `/add-gate` skills say plainly that they depend on asking questions, and the Stop hook allows a stop on a `QUESTION:` marker. Explicit `ask` rules still prompt in auto mode.
- **No production credentials anywhere Claude runs.** Deploys, migrations, ETL and restore drills against staging, rehearsal and prod run only from GitHub Actions or SGP1 jobs, behind environment protection.
- **Real client data never enters a Claude session:**
  - Claude sees Airtable **schemas (Metadata API), profiling aggregates** (null rates, cardinality, format patterns) and **synthetic or masked fixtures** only.
  - Staging runs on a **synthetic data generator**.
  - `/triage` reproduces locally against deterministic seeds, plus a masked export of the failing record. A human runs the mask script.
  - The Airtable token lives in the vault and CI secrets, never in a developer's `.env`.
- **Everything under `.claude/` is committed and reviewed like production code**, except `.claude/state/` and `.claude/worktrees/` (gitignored) and `settings.local.json`.

### 6.2 Root `CLAUDE.md` (committed; under about 120 lines; big documents are referenced, not imported)

```markdown
# DemoQ PSA — rules for Claude

Agency operations system for DemoQ (Phnom Penh). EN + KM. USD + KHR. Replaces Airtable.
Scope: `docs/scope.md` + `docs/scope-trace.md` · Decisions: `docs/decision-log.md` · Specs: `specs/<module>/<feature>.md`
Open these files when you need them; they are not loaded automatically.
Reference module: packages/core/src/crm/close-reason/* — mirror its structure for every new command.

## Commands

pnpm typecheck · pnpm lint · pnpm test · pnpm test:e2e · pnpm db:migrate (LOCAL only) · pnpm db:types · pnpm matrix:export
scripts/wt.sh --reset-db ← run after /rewind or after switching branches (drops, migrates, seeds your worktree DB)

## Data rule

You never see real client data. Use seeds and synthetic fixtures. If you need a real record, ask a human for a masked export.

## Architecture (non-negotiable)

- Only packages/core imports packages/db. apps/* call @demoq/core. No SQL, db, or business rules in routes,
  Telegram handlers, MCP tools, jobs or React.
- Every mutation = defineCommand({name, input, exposeTo, risk, authorize, run}); exposeTo comes from the spec.
- Permission key = command name. Grants: core/src/kernel/permissions.ts must equal docs/permission-matrix.signed.csv.
  Do NOT edit either; propose the change in the PR description.
- Status changes only via machine.ts. Gates are pure fns → {ok:true} | {ok:false, code, missing[]}.
- Approvals route only to holders of required_permission; never hard-code approvers.
- Cost/margin leave core only through dto.ts projectors that check finance.view_costs.
- Throw DomainError(code); new codes need en + km messages.

## Time

- Attendance (clock) and allocations (time on tasks/projects/deals/internal codes) are separate tables.
- Work gates apply to client-project allocations, never to attendance, deals or internal codes.
- Business rules in Asia/Phnom_Penh via ctx.now and each user's working_days; never `new Date()` in core.

## Workflow and phases

- Phase is in .claude/state/phase (spec | red | impl). In `red`, write failing tests only. In `impl`, test files are
  locked by a hook — if a test looks wrong, STOP and write `QUESTION:` followed by your reasoning.
- If a business rule, threshold or formula is not in the spec, write `QUESTION:` and stop. Never invent one.
- PRs ≤ 400 changed non-generated lines. No new dependency without asking. You have no staging/prod access.
- Module rules: nested CLAUDE.md files and .claude/rules/*.md (loaded by path).
```

**Path-scoped rules** (`.claude/rules/*.md` with `paths:` frontmatter; verified on the pinned version):

- `migrations.md` for `packages/db/migrations/**`: forward-only; never edit a merged file; timestamp names; expand → backfill → contract; no `CREATE INDEX CONCURRENTLY`; FK indexes; no cascades on financial or audit tables; run `pnpm db:types`.
- `money.md` for `packages/shared/src/{money,pricing}/**` and `**/commercial/**`: bigint only; `money.round()` only; fee margin and pass-through markup only via pricing; never sum mixed currencies.
- `tests.md` for `**/*.test.ts` and `tests/**`: rule-ID prefixes; never mock the DB, policy, audit or clock; real Postgres.
- `i18n.md` for `**/*.tsx` and `**/{en,km}.json`: no literals; the `KM-DRAFT:` prefix for drafts.

Nested files live in each module (for example `core/src/commercial/CLAUDE.md`), plus `apps/web/CLAUDE.md` and `packages/db/CLAUDE.md`. Because a nested file loads only when Claude reads something in that folder, `/new-module` and `/add-command` **read the module's CLAUDE.md before writing anything**. **Rule:** if Claude makes the same mistake twice, a line goes into the relevant rules file in the same PR.

### 6.3 `.claude/settings.json`

```json
{
  "permissions": {
    "allow": [
      "Bash(pnpm typecheck)",
      "Bash(pnpm lint:*)",
      "Bash(pnpm test:*)",
      "Bash(pnpm vitest:*)",
      "Bash(pnpm exec playwright test:*)",
      "Bash(pnpm db:migrate)",
      "Bash(pnpm db:types)",
      "Bash(pnpm matrix:export)",
      "Bash(scripts/wt.sh --reset-db)",
      "Bash(git status)",
      "Bash(git diff:*)",
      "Bash(git log:*)",
      "Bash(git add:*)",
      "Bash(git commit:*)",
      "Bash(gh pr view:*)",
      "Bash(gh pr diff:*)",
      "Bash(gh run view:*)"
    ],
    "ask": [
      "Bash(git push:*)",
      "Bash(gh pr create:*)",
      "Bash(pnpm add:*)",
      "Bash(pnpm install:*)",
      "Bash(psql:*)",
      "Edit(/packages/core/src/kernel/permissions.ts)",
      "Edit(/packages/core/src/kernel/audit.ts)",
      "Edit(/packages/shared/src/money/**)",
      "Edit(/packages/shared/src/pricing/**)",
      "Edit(/docs/permission-matrix.signed.csv)",
      "Edit(/.claude/**)",
      "Edit(/.github/**)",
      "Edit(/infra/**)",
      "mcp__demoq__confirm_decide_approval",
      "mcp__demoq-staging__confirm_decide_approval"
    ],
    "deny": [
      "Read(/**/.env.staging)",
      "Read(/**/.env.production)",
      "Read(/**/*.pem)",
      "Bash(git push --force:*)",
      "Bash(git push -f:*)",
      "Bash(rm -rf:*)",
      "Bash(ssh:*)",
      "Bash(doctl:*)"
    ]
  },
  "sandbox": { "enabled": true },
  "hooks": {
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/session-context.sh", "timeout": 10 }] }
    ],
    "PreToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/guard-files.sh", "timeout": 10 }]
      },
      {
        "matcher": "Bash",
        "hooks": [{ "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/guard-bash.sh", "timeout": 10 }]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write",
        "hooks": [{ "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/format-lint.sh", "timeout": 10 }]
      }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/stop-gate.sh", "timeout": 180 }] }
    ],
    "SubagentStop": [
      { "hooks": [{ "type": "command", "command": "\"$CLAUDE_PROJECT_DIR\"/.claude/hooks/red-run-check.sh", "timeout": 10 }] }
    ]
  }
}
```

- **Paths are anchored at the project root with a leading `/`**, so the rules still match when Claude starts in `apps/web`. The meanings of `//`, `~/`, `/` and `./` differ, so the effective rules are checked with `/permissions` on the pinned version.
- **Bash deny rules are speed bumps only.** The real controls are branch protection (no force-push), the sandbox, and having no credentials. `MultiEdit` has been removed from the matchers.

**Hooks** (in `.claude/hooks/`, `chmod +x`, reviewed like production code). For PreToolUse and Stop, exit code 2 blocks the action and returns stderr to Claude.

| Hook                 | Event                  | What it does                                                                                                                                                                                                        | Budget  |
| -------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `session-context.sh` | SessionStart           | Prints the branch, the worktree DB and port, the spec from **`.claude/state/spec`** (not guessed from the branch name), the current phase, `git status -s`, and a warning if `claude --version` ≠ `.claude/VERSION` | < 1 s   |
| `guard-files.sh`     | PreToolUse Edit/Write  | Blocks edits to migrations that already exist on `origin/main`, and to generated files ("run the generator instead"). **In phase `impl`, blocks `**/*.test.ts`, `**/*.spec.ts` and `tests/**`.**                    | < 1 s   |
| `guard-bash.sh`      | PreToolUse Bash        | The same protected paths, against Bash writes (`sed -i`, `tee`, `>`, `mv`, `cp` onto them)                                                                                                                          | < 1 s   |
| `format-lint.sh`     | PostToolUse Edit/Write | prettier plus **non-type-aware** ESLint through `eslint_d`, on the edited file only. dependency-cruiser moved to Stop and CI.                                                                                       | < 2 s   |
| `stop-gate.sh`       | Stop                   | Phase-aware (details below the table)                                                                                                                                                                               | < 180 s |
| `red-run-check.sh`   | SubagentStop           | When the finishing agent is `test-writer`, requires `.claude/state/red-run.json` to show failing tests with assertion errors only                                                                                   | < 1 s   |

`stop-gate.sh` in detail:

- **Allow the stop** if the last assistant message (from the hook input, or the transcript on versions without that field) contains `QUESTION:`, or if the session is in plan mode.
- **Changed files** = `git diff --name-only $(git merge-base origin/main HEAD)` plus the working tree. Committing therefore does not bypass the gate.
- **Phase `red`:** typecheck must be green, and the new tests must fail with **assertion errors only**, never compile or import errors.
- **Phase `impl`:** typecheck, dependency-cruiser and `vitest related` must pass. **If any migration changed, the DB integration suite runs too.** Tests run against the worktree's own Postgres, cloned from a migrated template database (`CREATE DATABASE … TEMPLATE psa_template`), not a fresh container at every Stop.
- **Loop guard:** a per-`session_id` counter allows 3 blocks. After that the stop is allowed, a `systemMessage` is emitted, and `.claude/state/RED` is written. `/pr` and the lefthook pre-push hook refuse while that file exists. We do not rely on Claude Code's built-in loop limit.

**lefthook:** pre-commit runs an incremental typecheck on staged files; pre-push refuses while `.claude/state/RED` exists.

### 6.4 Skills and slash commands (`.claude/skills/<name>/SKILL.md`; user-only skills set `disable-model-invocation: true`)

| Command                                                  | Written                                        | What it does                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/spec <module>/<feature>`                               | W1                                             | Copies `specs/_template.md` and interviews the developer; **never guesses**. Output: rules with IDs, the Q-IDs covered, `exposeTo` per command, the matrix delta, gates and approval kinds, audit events, i18n keys, edge cases and open questions. Sets `.claude/state/spec` and phase `spec`.           |
| `/red`                                                   | W1                                             | Sets phase `red`. Delegates to `test-writer`. Requires a recorded red run. Commits `test: <spec> (red)`.                                                                                                                                                                                                  |
| `/implement`                                             | W1                                             | Sets phase `impl` (test files locked)                                                                                                                                                                                                                                                                     |
| `/pr`                                                    | W1                                             | Writes `.claude/tmp/review.diff` and `changed.txt` for the reviewers. Runs checks and `spec-coverage.ts`. Refuses while `RED` exists. Drafts the PR body: spec link, Q-IDs, rule-to-test table, migrations, screenshots, and a "human must check" list.                                                   |
| `/new-module`, `/add-command`, `/add-gate`, `/migration` | **End of W3, extracted from the golden slice** | Each says "mirror `packages/core/src/crm/close-reason/*`" and keeps its templates as supporting files in the skill folder. A weekly CI job runs each one headless on a scratch branch (`claude -p '/add-command demo.noop'`) and checks the typecheck passes, so the skills cannot drift from the kernel. |
| `/i18n-sync`                                             | W3                                             | Finds literals, adds keys to both locales, marks Khmer drafts `KM-DRAFT:`                                                                                                                                                                                                                                 |
| `/airtable-map <table>`                                  | W3                                             | Works **only** from the Metadata API schema, profiling aggregates and synthetic fixtures. Writes a pure transform module plus tests. Humans run the real extract and load in SGP1. Claude sees only reconciliation aggregates.                                                                            |
| `/release`                                               | W8                                             | Changelog, migration list, confirms the last restore drill is under 7 days old, prints the checklist. **Does not deploy.**                                                                                                                                                                                |
| `/triage <ticket>`                                       | W12                                            | Reproduces locally with seeds and a masked record export, writes a failing regression test named after the rule ID, and proposes a fix. **Never browses staging or prod.**                                                                                                                                |

**Day 1 is deliberately minimal** (§12). The code-generating skills wait for a real kernel, so they cannot encode a guessed API.

### 6.5 Subagents (`.claude/agents/*.md`; each runs in its own context)

| Agent               | Tools                                                           | Model  | Focus                                                                                                                                                                                                                                                                                                                                               |
| ------------------- | --------------------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `spec-reviewer`     | Read, Grep, Glob                                                | opus   | Ambiguity, rules without tests, conflicts with the quotation and Q-IDs, missing matrix rows, unanswered questions                                                                                                                                                                                                                                   |
| `schema-reviewer`   | Read, Grep, Glob                                                | opus   | Reads `.claude/tmp/review.diff`. Constraints, FK indexes, bigint money, timestamptz, locks, expand/contract, audit and immutability triggers, default privileges                                                                                                                                                                                    |
| `security-reviewer` | Read, Grep, Glob                                                | opus   | Reads `.claude/tmp/review.diff` and `changed.txt`. For every mutation path: the correct `can()` action, the gate called, audit inside the transaction, no db import in adapters, IDOR scoping, parameterised SQL, tokens hashed and expiring, Telegram callback re-checks, the MCP channel policy. Output is BLOCKER / SHOULD / NIT with file:line. |
| `money-reviewer`    | Read, Grep, Glob                                                | opus   | Reads the diff files. Floats, cross-currency sums, rounding outside `money.round`, fee and pass-through mixing, cost redaction                                                                                                                                                                                                                      |
| `test-writer`       | Read, Grep, Glob, Edit, Write, Bash                             | sonnet | Writes failing tests from rule IDs, runs them, and writes `.claude/state/red-run.json` (checked by SubagentStop)                                                                                                                                                                                                                                    |
| `e2e-writer`        | Read, Grep, Glob, Edit, Write, Bash; `mcpServers: [playwright]` | sonnet | Walks the flow on **local seeded data**, then writes a deterministic `@playwright/test` spec using `data-testid`                                                                                                                                                                                                                                    |

The reviewers stay without Bash. The main session produces the diff files they read. Putting a pattern such as `Bash(git diff:*)` in a subagent's tool list does not narrow Bash, so we do not rely on it.

### 6.6 Spec template (`specs/_template.md`)

A spec is merged in its own PR before any code. For money, gates and permissions, the PR needs the PO's or Finance rep's GitHub approval (label check, §6.9). The sections are:

1. Story, and the **Q-IDs covered**
2. Rules (R-IDs)
3. `exposeTo` per command
4. Permission matrix delta
5. Gates and approval kinds, with their channel policy
6. Audit events
7. Acceptance tests (Given/When/Then, one per rule)
8. UI states (empty, loading, error, locked; EN and KM)
9. Telegram and MCP surface
10. Out of scope
11. Open questions, which **must be empty to merge**

### 6.7 The per-feature loop (one developer, one worktree, one feature)

```bash
scripts/wt.sh quotes-margin-floor   # git worktree add ../psa-quotes-margin-floor -b feat/quotes-margin-floor
                                    # createdb … TEMPLATE psa_template; .env.local (DB, PORT=31xx); writes .claude/state/spec
cd ../psa-quotes-margin-floor && claude
```

1. **Spec** (plan mode): run `/spec commercial/margin-floor`, answer its questions, edit by hand, open the spec PR.
2. **Plan** in plan mode with Opus:
   > Read `specs/commercial/margin-floor.md` and `packages/core/src/commercial/CLAUDE.md`. Plan the migration, gate, commands, policy keys and exposeTo, the Telegram card, MCP exposure and UI. List every file in order with the rule ID each change satisfies. Flag anything touching money, permissions.ts or audit. Don't write code.
3. **Red tests:** run `/red`. The test-writer writes failing unit, integration and parity tests for MF-01 to MF-07. The Stop hook checks they fail for the right reason. **A human reads the tests** before implementation starts.
4. **Implement:** run `/implement` (test files are now locked).

   > Implement the plan until all margin-floor tests pass. If a test seems wrong, write `QUESTION:` and stop.

   If Claude goes off course, use `/rewind`, then `scripts/wt.sh --reset-db`, because a rewind does not undo migrations already applied to the worktree DB.

5. **Review:** run `/pr` to write the diff files, then run schema-, security- and money-reviewer in parallel. Fix BLOCKERs. Then run the built-in `/security-review`.
6. **Browser** (local seeds only):
   > Start the app on $PORT. With Playwright MCP, log in as sales@demoq.test, build a quote under the fee floor, confirm Send becomes "Request approval" in EN and KM; log in as finance@demoq.test and approve. Convert this into tests/e2e/commercial/margin-floor.spec.ts with data-testid selectors.
7. **PR:** pushing is an `ask` rule. The developer reads the whole diff. CI checks that tests committed in the `(red)` commit have not changed since, unless the `test-change-approved` label was applied by a non-author code owner.
8. **Reset:** run `/clear` before the next feature.

### 6.8 Worktrees and parallelism

- **One mechanism: `scripts/wt.sh`.** It creates the worktree and branch, clones the template DB, sets the port, writes `.env.local` and `.claude/state/spec`, and supports `--reset-db`. We do not use `claude --worktree`, which uses different branch names and skips the DB set-up. `.claude/worktrees/` is gitignored in case someone uses it anyway.
- Seeds are deterministic, with one seed user per role (`sales@`, `finance@`, `ops@`, `lead@`, `staff@`, `ceo@`, all `demoq.test`).
- **W1–2:** Dev A builds the kernel serially, in plan mode, with heavy human review. Dev B builds the web shell and Dev C builds CI, infra and test infrastructure in parallel.
- **W3:** the golden slice is extended to Telegram and MCP, and the scaffold skills are extracted from it. **Module fan-out starts in W4**, with at most 2–3 Claude sessions and at most 3 open PRs per developer.
- Shared hot files (`permissions.ts`, registries, locale JSON) are kept sorted and append-only. Everyone rebases daily.

### 6.9 CI and Claude in GitHub

- **`ci.yml` (required checks, ≤ 12 min, sharded):**
  - `pnpm i --frozen-lockfile --ignore-scripts`, typecheck, lint, dependency-cruiser
  - Vitest with Testcontainers Postgres 16: unit, property, integration, the **in-process matrix against the signed CSV**, transport tests, parity and completeness
  - migrations applied to an empty DB, plus the no-edit-to-merged-migrations guard
  - `schema.sql` and generated types up to date
  - `spec-coverage.ts` and the **Q-ID trace** (every Q-ID has at least one rule with a passing test)
  - i18n key parity
  - the **red-commit test lock** check
  - the **label check** (§6.10) for `permissions.ts`, the signed CSV, `shared/{money,pricing}` and formula specs
  - Playwright smoke (en and km, one mobile project)
  - gitleaks (including the PAT-prefix rule), Semgrep, `pnpm audit --audit-level high`
- **`nightly.yml`:** the full Playwright suite on staging (synthetic data), and the scaffold-skill drift job (weekly).
- **Restore drills and the weekly migrate-onto-scrubbed-dump test run as SGP1 jobs**, triggered from Actions. Only pass/fail and aggregates come back. Real data never touches GitHub runners.
- **`claude-review.yml`:** `anthropics/claude-code-action`, **pinned by SHA**, on `pull_request: [opened, synchronize]`.
  - `permissions: { contents: read, pull-requests: write, id-token: write }`
  - `claude_args: '--allowedTools "mcp__github_inline_comment__create_inline_comment" --max-turns 20'`
  - Reviews against CLAUDE.md and the reviewer checklists. **Advisory, not a required check.**
  - In W1 we also evaluate the managed Code Review service in the Team/Enterprise plan (a research preview; check availability and data-retention terms). If adopted, the checklists move to `REVIEW.md` and the workflow is removed.
- **`claude-mention.yml`** (`@claude` fix-ups): `contents: write, pull-requests: write, issues: write, id-token: write`. Because of "approval of the most recent push", commits Claude pushes after a human approval must be reviewed again.
- **Deploy:** a merge to `main` builds the image (tagged by SHA), migrates staging as `migrator` and deploys to staging with smoke tests. **Prod deploys from a tag** through a GitHub Environment with required reviewers. The tag workflow runs the **`KM-DRAFT:` check as a required gate** before prod approval.
- Renovate runs with a 7-day minimum release age. New dependencies need human approval. The Playwright MCP server is **pinned** in `.mcp.json` (`npx -y @playwright/mcp@<x.y.z>`) and managed by Renovate under the same rule.

### 6.10 Branch protection and what humans own

- **Branch protection on `main`** (achievable with three engineers):
  - 1 approval, with "require review from Code Owners"
  - stale approvals dismissed; approval of the most recent push required
  - required checks; no direct pushes; no force-push
  - admin bypass only through a logged break-glass procedure
- **CODEOWNERS:** Dev A and Dev C own `packages/core/src/kernel/**`, `*/machine.ts`, `packages/shared/src/{money,pricing}/**`, `packages/db/migrations/**`, `apps/api/src/adapters/{telegram,mcp}/**`, `/oauth` config, `.claude/**` and `.github/**`. Dev C and Dev A own `infra/**`. So a code owner who is not the author is always available.
- **Second pair of eyes on business rules.** PRs that touch `permissions.ts`, the signed CSV, money or pricing, or formula specs also need the **`po-approved` or `finance-approved` label, applied by the PO's or Finance rep's GitHub account** (enforced by a CI check).

Humans own:

1. Auth and sessions, TOTP and step-up, link tokens, Telegram linking and webhook verification, **MCP OAuth configuration and PATs**.
2. The permission matrix and approval chains (DemoQ signs them).
3. Money maths and the formula definitions. Claude writes property tests to attack them.
4. Migrations against staging and prod, ETL runs, reconciliation sign-off.
5. Infrastructure, secrets, backups and restore drills.
6. Any change to a locked test, every merge to `main`, every prod release.
7. Khmer copy, approved by the native reviewer.

### 6.11 Cadence, metrics and model choice

- **Weekly 30-minute Claude retro** (Fridays). Add repeated mistakes to the rules; tune the reviewer prompts; prune permission prompts; bump the pinned version deliberately. Track:
  - PR cycle time and escaped defects per module
  - how often the Stop hook blocked, and how often `RED` was written
  - **test-file churn per PR**
  - Claude usage cost per engineer against the cap set in S1
- **Models:** Opus for planning, the kernel, specs and reviewers. Sonnet for scaffolding, UI and tests.
- **Throughput assumptions:** about 2–3× on CRUD, UI, i18n and test scaffolding; about 1× on integrations (Telegram, OAuth, R2, PDF, pg-boss, Airtable), data cleanup and stakeholder decisions. Most of this system is the second kind, and §7.1 reflects that.
- **Playwright has two roles.** The MCP server is for local exploration and never a CI gate. `@playwright/test` specs are the committed checks.

---

## 7. The 16-week plan

### 7.1 Calendar and capacity

**Calendar** (W1 = Mon 19 Oct 2026; engineers work Mon–Fri; DemoQ works Mon–Sat by default, D15)

| Week    | Dates           | Weekday public holidays (2026 sub-decree; lunar dates confirmed on the Friday before W1) |
| ------- | --------------- | ---------------------------------------------------------------------------------------- |
| W1      | 19–24 Oct       | — (Pchum Ben 10–12 Oct and 15 Oct fall before W1)                                        |
| W2      | 26–31 Oct       | Thu 29 Oct (King's Coronation Day)                                                       |
| W3      | 2–7 Nov         | —                                                                                        |
| W4      | 9–14 Nov        | Mon 9 Nov (Independence Day)                                                             |
| W5      | 16–21 Nov       | —                                                                                        |
| W6      | 23–28 Nov       | Water Festival, 3 days (listed as 23–25 or 24–26 Nov)                                    |
| W7–W10  | 30 Nov – 26 Dec | — (25 Dec is not a Cambodian public holiday)                                             |
| W11     | 28 Dec – 2 Jan  | Fri 1 Jan (International New Year)                                                       |
| W12     | 4–9 Jan         | Thu 7 Jan (Victory over Genocide Day)                                                    |
| W13–W16 | 11 Jan – 6 Feb  | — (Chinese New Year is Sat 6 Feb; not official, but expect absences)                     |

Cutover (Sat 9 – Sun 10 Jan) is clear of 1 and 7 January. Go-live is Mon 11 Jan. Finance's year-end close happens during the pilot, not during cutover, so the Finance rep's time is raised for W8–12.

**Effort budget** (engineer-days, with Claude Code multipliers applied; re-baselined at SG1, end W4)

| #   | Area                                                                                                                                                                                                  | Days    | Lead          |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------- |
| 1   | Foundations: repo, CI, kernel pipeline, identity/TOTP, append-only audit, REST + OpenAPI, golden slice                                                                                                | 12      | A (C for CI)  |
| 2   | Toolchain ramp-up (pnpm workspaces, Kysely, Testcontainers, pg-boss, grammY, TanStack, Playwright)                                                                                                    | 3       | all           |
| 3   | PWA shell, design system, i18n plumbing                                                                                                                                                               | 4       | B             |
| 4   | Admin and config screens (users/roles, teams, rate cards, engagement and project types, floors, template editor, SLAs and chains, holidays, activity codes, flags) plus the audit timeline and search | 6       | B             |
| 5   | CRM and pipeline (Kanban, close reasons, Khmer/English search)                                                                                                                                        | 4       | B             |
| 6   | Rate cards, quote builder (live fee margin and markup), send/lock/revise, async PDF, manual FX                                                                                                        | 8       | A + B         |
| 7   | Approval engine (routing, escalation, SoD), web inbox, Telegram bot, linking, cards                                                                                                                   | 9       | A + B         |
| 8   | Scope, change orders, retainer periods                                                                                                                                                                | 6       | A             |
| 9   | Projects, project types, planned start, 5 gates, PO exemptions, bypass, R2 files                                                                                                                      | 7       | A + B         |
| 10  | Tasks, templates, Kanban per project and per person, dependencies                                                                                                                                     | 7       | B             |
| 11  | Revisions, QC, mark sent, out-of-scope detection                                                                                                                                                      | 5       | A + B         |
| 12  | Time: attendance, allocations, pre-fill, weekly confirmation, Telegram `/in` `/out` `/week`, holidays, leave                                                                                          | 9       | B + A         |
| 13  | Influencer roster, assignments, expiring links, public page, approvals                                                                                                                                | 4       | B             |
| 14  | Capacity 4–6 weeks out; digests                                                                                                                                                                       | 5       | B             |
| 15  | Billing-ledger import, including export mapping                                                                                                                                                       | 3       | C             |
| 16  | Reporting: giveaway ledger, CEO drill-down, fees vs billings, float, one number per role                                                                                                              | 7       | A + B         |
| 17  | MCP: SDK server, OAuth (`oidc-provider`, CIMD, pre-registered client), tools, channel policy, guide                                                                                                   | 9       | C (A reviews) |
| 18  | Airtable migration: inventory, profiling, ETL, legacy rules, two-level reconciliation, DR1–3, pilot boundary, cutover                                                                                 | 12      | C             |
| 19  | Test infrastructure: matrix and fixture builders, transport tests, parity, about 40 journeys × 2 locales, one k6 and one ZAP run                                                                      | 7       | C             |
| 20  | Ops: app spec, backups, restore-drill automation, observability, heartbeats, 6 executed runbooks                                                                                                      | 5       | C             |
| 21  | Security hardening, pen-test support, fixes, retest                                                                                                                                                   | 5       | A             |
|     | **Build subtotal** (includes about 8 days of Could items, §7.6)                                                                                                                                       | **137** |               |
|     | Human review of Claude PRs (~15% of build)                                                                                                                                                            | 20      | all           |
|     | Specs, decision workshops, W1–2 spikes                                                                                                                                                                | 5       | all           |
|     | Ceremonies: Monday check-in, Friday walkthrough or demo, retro, status (~2 h/engineer/week)                                                                                                           | 9       | all           |
|     | **Total need**                                                                                                                                                                                        | **171** |               |
|     | of which planned in W13–16 (CEO validation of January numbers, MCP rollout, handover, tuning)                                                                                                         | 12      |               |
|     | **Need before go-live**                                                                                                                                                                               | **159** |               |

**Availability**

| Item                                                          | Days    |
| ------------------------------------------------------------- | ------- |
| W1–W12: 3 engineers × 60 days                                 | 180     |
| − weekday public holidays (7 each)                            | −21     |
| − personal leave (1 each; year-end leave frozen by agreement) | −3      |
| − pilot support W10–W12                                       | −6      |
| **Available before go-live**                                  | **150** |
| W13–W16, after about 40% hypercare support                    | 36      |
| **Total available**                                           | **186** |

**Reading it honestly.**

- Before go-live: **159 needed vs 150 available**. Cutting the Could items inside the estimate (§7.6) brings that to about break-even. **There is no buffer, so 11 Jan is a roughly 50% date.**
- The **pre-approved W17–18 reserve** (2 engineers, about 20 days) makes **25 Jan a roughly 85% date**. It is triggered only at SG1 or SG2 (§11.4).
- **Two engineers:** about 24 weeks in total (go-live around early March 2027). **One engineer:** about 40+ weeks.
- DemoQ's own capacity is budgeted too (§1 Team table). Decision latency is a named risk with defaults that ship.

### 7.2 Dependency network (three tracks that meet at the go/no-go)

```
PRODUCT TRACK
 W1–2   Kernel · identity/TOTP · audit · REST · web shell · clients/contacts · golden slice (web)
 W3–4   Telegram + MCP shells · golden slice on all channels → scaffold skills · pipeline · rate cards/types · quotes · approval engine
 W5–6   Accept → scope · COs · retainer periods · projects/gates/bypass · files · tasks/Kanban/deps · unscoped-task rule   ─► M1 (Fri 27 Nov)
 W7–8   ┌ Revisions/QC/mark-sent/OOS ┐ ┌ Time: attendance + allocations + confirm + leave ┐ ┌ Influencer links ┐ ┌ MCP OAuth ┐  (parallel branches)
        └────────────────────────────┴─┴─────────────────────────────────────────────────┴─┴──────────────────┴─┴───────────┘ pilot-critical complete (Fri 11 Dec)
 W9     Hardening · pen test on staging · restore #1 · DR2 → pilot load Sat 19 Dec                                          ─► M2 (Fri 18 Dec)
 W10    Capacity · digests · billing import · reporting (join the pilot mid-way)                                             ─► CC freeze (Fri 25 Dec)
 W11–12 Fixes only: pen-test fixes, pilot defects, DR3, training
MIGRATION TRACK
 W1 inventory → W2 profiling (aggregates, SGP1) → W3–6 extract/transform → DR1 Fri 27 Nov → legacy rules W7–8 → DR2 W9
 → pilot load Sat 19 Dec → DR3 Mon 4 – Tue 5 Jan (timed, with rollback) → cutover Sat 9 – Sun 10 Jan
READINESS TRACK
 Before W1: D16, capacity option, third engineer → W1 accounts, accounting export sample, MCP spike → W2 pen test booked
 → W3 D10 formulas signed → W4 champions, pilot team and pilot clients → W7 champion session 1 → W8 ZAP baseline
 → W9 pen test, restore #1, champion session 2 → W10 pilot → W11 train-the-trainer, team sessions → W12 retest, MCP pilot walkthrough
 ═► Pilot go/no-go Wed 6 Jan ═► Cutover go/no-go Sun 10 Jan 18:00 ═► Live Mon 11 Jan
```

- **Critical paths:** the product track up to "pilot-critical complete" (W8); the migration track from DR2 to the pilot load (W9); and **reporting to CC (W10)**, because reporting is quoted Must and in the go-live gate. D10 at W3 feeds it.
- Time and influencer work are **parallel branches** from W5 onward, not links in a chain.
- The feature **freeze is honest:**
  - pilot-critical Must scope is code-complete at the end of W8
  - W9–10 builds only the remaining quoted items listed above
  - **nothing new starts after Fri 25 Dec**

### 7.3 Sprint plan (every slice ships its migration, command, policy, audit, exposure per `exposeTo`, EN/KM UI, tests and staging deploy)

| Sprint                                  | Goal                                    | Deliverables                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Demo (45 min, PO + Finance + champions)                                                                                                                                                                                                                                                                                                                                                                                          | Acceptance                                  |
| --------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| **S1** W1–2 (19–30 Oct)                 | Foundations                             | Repo, CI, lefthook, **minimal** Claude config, CODEOWNERS, branch protection. Kernel (ctx, `executeCommand`, registry, errors, machines, outbox). Append-only audit; DB roles `migrator`, `app`, `reporting_ro`, `importer`. Money and pricing core. i18n plumbing. Identity (argon2id, sessions, TOTP, minimal users/teams/roles admin). REST adapter and OpenAPI client. Web shell with login. Clients and contacts CRUD. **Golden slice `crm/close-reason`** on web. Staging from the app spec, with nightly backups. **Specs:** time model, retainers, pricing floors. **Spikes:** MCP/Cowork auth; accounting export sample. Airtable inventory and profiling in SGP1. **Pen test booked** (by Fri 30 Oct).                                                                                                                                     | Log in with TOTP. A deal dragged to Lost without a reason is blocked, with the message in KM and EN; adding a reason saves it. The audit timeline shows the name, channel and action. A staff user from another team gets 403. CI green; staging backups present.                                                                                                                                                                | M1 #2–4 (partial)                           |
| **S2** W3–4 (2–13 Nov)                  | Channels and sell                       | **Prod provisioned in W3** with nightly backups. Telegram shell and linking. MCP shell (SDK, PAT, generated read tools, `exposeTo` completeness). Golden slice on all channels, then **scaffold skills extracted**. Pipeline Kanban and close reasons. Rate cards; engagement types (fee floor, markup floor); **project types**. Manual FX with a 5-day window. Quote builder with **live fee margin and pass-through markup**. Submit and margin_review. **Approval engine v1**: policies per kind, permission-aware routing and escalation, SoD, inbox, Telegram cards, idempotent decisions, supersede. Send: hash, FX freeze, **async PDF**. Lock trigger; revise rules.                                                                                                                                                                        | An 18% fee-margin quote against a 25% floor becomes "Request approval". Finance approves on the phone and, with "send when approved", the quote is sent and locked within 10 s, with the audit naming both people. An edit returns 409; revise creates v2. An overdue approval escalates to ops_lead, not to a director without the permission. `search_clients` from Claude Code matches the screen and is audited.             | M1 #5–10. **SG1 re-baseline (Fri 13 Nov).** |
| **S3** W5–6 (16–28 Nov; Water Festival) | Scope and start work                    | Accept (with win reason) → scope, or monthly periods for retainers. Deal won; last-quote-rejected prompt. Additive COs with the floor basis from D23. Discount giveaway rows. Projects from the accepted quote (project type, `planned_start`). 5 gates with evidence on R2: **PO required by default**, client exemptions recorded, deposit gate per D20. Bypass (request, two-tap Telegram, expiry, auto-close) and the monthly review report. Files module. Templates per project type. Tasks (owner, estimate, due date, dependencies with cycle check). **Kanban per project and per person.** Comments and attachments. INV-20 rule. **DR1 Fri 27 Nov.**                                                                                                                                                                                       | Accepting a quote with a win reason creates the project and template tasks with owners and due dates. Starting a task on a gated project returns 409 with the missing gates on web and MCP. Uploading the signed contract satisfies that gate. Ops approves a bypass on Telegram and it shows on the monthly report. An accepted retainer creates the November and December periods.                                             | M1 #11–17. **M1 accepted (SG2).**           |
| **S4** W7–8 (30 Nov – 11 Dec)           | Deliver, time, influencers, MCP auth    | Revision rounds; round-4 out-of-scope approval (absorb, change order, reject); hard stop at 5. QC (reviewer ≠ owner). Mark sent. Out-of-scope detection for unscoped tasks and over-quantity. **Attendance** (PWA and Telegram `/in` `/out`, auto-close). **Allocations** with pre-fill. Weekly confirmation (`/week` one tap; per-user working week). Holidays 2026–27; leave types and approvals. **Influencer** roster, assignments, links, public EN/KM page, submissions, approvals (all gate-checked). **MCP OAuth** (`oidc-provider`, CIMD, pre-registered Cowork client, TOTP on login and consent, refresh rotation, audience check), channel policy, `decide_approval` prepare/confirm, write tools behind `mcp.writes`. Legacy mapping rules and the `importer` role. **ZAP baseline (W8).** **Pilot-critical code-complete Fri 11 Dec.** | Clock in on a phone. A week is allocated and confirmed, timed live at under 2 min. A round-4 request pings the Lead on Telegram with Absorb / Change order / Reject. Round 5 is refused on web and MCP. Mark-sent is disabled until a non-owner approves QC. An influencer submits from a phone with no account. Cowork connects through OAuth and lists tools. An MCP attempt to decide a margin_floor returns `DECIDE_IN_APP`. | M2 #1–13                                    |
| **S5** W9–10 (14–26 Dec)                | Pilot-ready, then code-complete         | **W9:** pen test on staging (14–18 Dec); hardening to the ASVS L2 checklist; **restore test #1 witnessed**; app rollback rehearsal; **DR2**; pilot load Sat 19 Dec; champion session 2; **M2 Fri 18 Dec**. **W10:** pilot live Mon 21 Dec. Capacity 4–6 weeks out. Daily and weekly digests. Billing-ledger import with mapping. **Reporting:** giveaway ledger, the CEO number and drill-down, fees and billings apart, float with aging, one number per role. Pen-test fixes start. **Code freeze Fri 25 Dec (CC).**                                                                                                                                                                                                                                                                                                                               | The CEO drills from the headline number to a client, a project and the source row. Float for 2 pilot clients matches Finance's hand reconciliation. Capacity shows a person over 100% in a holiday week. The Lead digest arrived at 07:45.                                                                                                                                                                                       | M2 #14–19; CC #1–6                          |
| **S6** W11–12 (28 Dec – 10 Jan)         | Pilot and cutover (**no new features**) | Pilot continues. Pen-test fixes; **retest Mon 4 – Tue 5 Jan**. **DR3 Mon 4 – Tue 5 Jan**, timed on a prod clone, including rollback of pilot data. Train-the-trainer (Mon 28 Dec) and team sessions (W11–12). **MCP pilot walkthrough Tue 5 Jan** with 2–3 pilot users, recorded. `mcp.writes` on for pilot users after the retest. **Pilot go/no-go Wed 6 Jan.** Legacy bypass list approved. **Cutover Sat 9 – Sun 10 Jan.**                                                                                                                                                                                                                                                                                                                                                                                                                       | Go-live gate review (Sun 10 Jan 18:00)                                                                                                                                                                                                                                                                                                                                                                                           | §11.3                                       |
| **S7** W13–14 (11–23 Jan)               | Hypercare 1                             | All teams live Mon 11 Jan. Daily triage. **M3 Fri 15 Jan.** Digest and SLA tuning. MCP walkthrough with 3–5 power users (W14). `mcp.writes` on for everyone after the W13 stability check.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Go-live metrics                                                                                                                                                                                                                                                                                                                                                                                                                  | **M3**                                      |
| **S8** W15–16 (25 Jan – 6 Feb)          | Hypercare 2                             | Restore test #2 (W15). Monthly bypass review Mon 1 Feb. **CEO validates January's numbers** (W16). Handover pack. Backlog re-prioritised.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Hypercare exit review                                                                                                                                                                                                                                                                                                                                                                                                            | **M4 Fri 5 Feb**                            |

**Parallel tracks by week**

| Week   | Airtable migration (Dev C; real data only in SGP1)                                                                                                  | QA / security / ops                                                              | Change and training (PO + champions)                                 |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| W1     | Token in vault/CI; metadata inventory; **PO adds a Last Modified Time field to every table**                                                        | CI, lefthook, staging app spec, backups; MCP/Cowork spike                        | PO and deputy active; decision workshop; D16 confirmed               |
| W2     | Profiling (aggregates only): nulls, duplicates, free-text money, orphans, invariant breakers; **sample 20 quotes to measure recompute differences** | Pen test booked; accounting export sample checked                                | Roles, org chart, chains, SLAs, digest recipients                    |
| W3–4   | Extractors → `airtable_raw` (CRM, commercial); attachments downloaded immediately; transforms written with `/airtable-map` from aggregates          | Prod live W3; matrix fixtures; parity harness                                    | D10 signed W3; champions, pilot team and **pilot clients** named W4  |
| W5–6   | Projects, tasks and attachments to R2 with sha256; transforms v1; **DR1 Fri 27 Nov (rehearsal DB)**                                                 | First automated restore drill (W5, SGP1)                                         | Champions run UAT scripts; translator starts the bulk pass           |
| W7–8   | Legacy rules for each invariant; DemoQ fixes exceptions **at the source in Airtable**; transforms v2                                                | ZAP baseline W8; one-off Stryker run on money/pricing                            | **Champion session 1 (W7)**; role cards and video scripts drafted    |
| W9–10  | **DR2** (full) Mon–Thu W9; **pilot clients loaded into prod Sat 19 Dec**                                                                            | Pen test W9; restore #1 witnessed; rollback rehearsal; **each engineer deploys** | **Champion session 2 (W9)**; pilot training                          |
| W11–12 | Pilot delta fixes; **DR3 4–5 Jan**; cutover weekend                                                                                                 | k6 on rehearsal data (W11); pen-test retest; go-live gate                        | **Train-the-trainer Mon 28 Dec**; champions run team sessions W11–12 |
| W13–16 | Airtable read-only; legacy bypass burn-down weekly; W16 snapshot archive to R2                                                                      | Daily triage in W13, then 3× weekly; **restore #2 W15**                          | MCP walkthrough W14; FAQ upkeep; handover W16                        |

### 7.4 Milestones and acceptance criteria (each is an automated test, or a timed or witnessed check with evidence; all are Must unless marked (C))

**M1 "Sell-to-start" (Fri 27 Nov, end W6)**

1. `permissions.ts` equals the signed CSV. The in-process matrix is 100% green. Completeness finds 0 unmapped routes, tools or callbacks, and the MCP tool list equals the `exposeTo ∋ mcp` commands.
2. Across the whole matrix run, every successful mutation writes exactly one `audit_events` row plus its `audit_changes` rows.
3. UPDATE and DELETE on audit tables fail as `app`.
4. Won/Lost without a reason returns 422 in the user's locale; `quote.accept` without a win reason returns 422.
5. Server fee margin and markup equal the browser's (fast-check, 10k cases). The UI updates within 300 ms at p95 for a **30-line quote under Playwright with 4× CPU throttling**, on the mobile project profile.
6. One currency per quote. FX is frozen at send. A KHR quote uses the latest rate no more than 5 days old and prints its date. With no rate in the window, the send returns 409 `FX_RATE_MISSING`.
7. Editing a sent quote returns 409, and direct SQL as `app` fails. Revise from accepted returns 409. A status change away from accepted fails at the DB.
8. A below-floor submission routes only to eligible Finance or ops_lead users. The requester cannot approve. Every escalation hop's assignee holds `quote.approve_below_floor` (test).
9. Finance approves on Telegram. With "send when approved" set, the quote is sent within 10 s. The audit shows Finance on `approval.decide` and the requester on `quote.send` with `on_behalf_of`. A forwarded card gets "not permitted" plus an audit row. A replayed callback is rejected.
10. Two simultaneous approvals give exactly one winner.
11. A CO with a negative line returns 422. UPDATE and DELETE on `scope_items` fail at the DB.
12. Scope total = accepted quote + accepted COs (property). After acceptance, scope value never decreases over any sequence of revise, send and accept (property).
13. `task.start` on a gated project returns 409 with the missing gates, on web and MCP (the channels it is exposed on). An approved bypass allows it. The PO gate is required unless an exemption is recorded.
14. A bypass needs a named owner, a reason of at least 30 characters, an approval from a user, and an expiry of at most 30 days, and it appears in the monthly review with the gate exemptions.
15. A project of type X with `planned_start` S gets template X's tasks with owners (role hint → member, else PM), estimates, `due = S + offset`, and dependencies.
16. An accepted retainer quote creates monthly periods, and the job opens the next period with its scope items.
17. A merge to main auto-deploys to staging. At least 7 consecutive nightly prod backups exist. An automated restore drill in SGP1 has passed. All three engineers have deployed to prod.

**M2 "Pilot-ready" (Fri 18 Dec, end W9)**

1. A round-4 request creates an `out_of_scope` approval before the round starts. Absorb starts round 4 and writes a giveaway row valued per D10. Reject returns the task to client_review with a note.
2. Round 5 returns 409. More work happens only through an accepted CO that spawns a new task.
3. QC rejections never increment `revision_round`.
4. Mark-sent is impossible without an approved QC by a non-owner for the current round.
5. Creating an unscoped, non-`non_deliverable` task on an active client project creates an out-of-scope approval.
6. Attendance clock in/out passes on iOS Safari, Android Chrome and desktop (Playwright plus one real-device check per platform).
7. A session open at 23:59 ICT or longer than 12 h is closed and flagged.
8. Allocating to a gated project returns 409. Allocating to a deal or an internal code succeeds.
9. On fixture week **F-01** (5 users), at least 90% of confirmed allocation minutes come from pre-fill unchanged.
10. The median confirmation time on F-01 for 5 champions is under 120 s, measured from timestamps.
11. Influencer link: works with no login, only for its own assignment; revocable; 256-bit; submission cap; rate limited. Issue and submission on a gated project return 409. An expired link returns 410. Submissions stay pending until approved. A submission over quantity raises an out-of-scope approval.
12. An overdue approval escalates to the next eligible holder (not the requester, not on leave). Every hop is audited. With no candidate, the fallback approver is used and an alert fires.
13. MCP OAuth conformance tests pass: CIMD, loopback redirects, pre-registered Cowork client, PKCE S256, 401 with `resource_metadata` and `scope="read"`, form-encoded token endpoint, refresh rotation, audience rejection, TOTP at login. High-risk kinds return `DECIDE_IN_APP`. Privileged PATs are read-only. `mcp.writes` is off in prod.
14. DR2: counts match, or each gap has a `migration_exceptions` row.
15. DR2 money: stored input amounts match exactly after conversion. Recomputed totals are within 1 minor unit per line, and Finance has signed the list of differences.
16. Champion spot-check of 30 records per entity: at most 1 field error per entity (an error is any field that differs from the mapping sheet), each fixed before go-live.
17. Restore test #1, witnessed by DemoQ, run in SGP1: last night's backup restores in under 60 min, and `verify.sql` and the smoke tests pass.
18. The Khmer strings for time, tasks, approvals, Telegram and the influencer page are reviewed (no `KM-DRAFT:` in those namespaces).
19. Khmer renders correctly in quote PDFs, confirmed by approved visual snapshots.

**CC "Code-complete" (Fri 25 Dec, end W10)**

1. Capacity for weeks +1 to +6 per person = contracted hours − holidays − approved leave − remaining estimates **spread evenly over the person's working days from max(today, task start) to the due date** − retainer period allocations. It matches a hand-calculated fixture for 3 people.
2. Digests: the daily one at 07:45 on each recipient's working days to the D27 roles; the weekly one at 07:50 on the first working day to directors and the CEO. Each contains only visible items (test).
3. Billing import: the real sample export maps. Unmapped lines land in the Finance queue. Fee and pass-through are never netted.
4. Reporting: the CEO number equals the sum of its drill-down rows (same query). A contract test shows no report DTO, digest template or MCP output has a combined fee-plus-billing field. Float per client with aging matches Finance's hand reconciliation for 2 pilot clients.
5. One number per role is live for every role in D11.
6. All staff-facing Khmer is reviewed. Admin screens are EN-only if D25 says so.

**M3 "Live" (Fri 15 Jan, W13)**

1. The pilot exit criteria (§9.8) were met, and the go-live gate (§11.3) passed on Sun 10 Jan.
2. Finance and Ops signed the final two-level reconciliation.
3. Airtable permissions were changed to read-only (screenshot), and max(Last Modified Time) across all tables is earlier than the freeze time.
4. 100% of staff **who have a Telegram account** are linked, the rest are on email fallback, and at least 90% of staff logged in during W13.
5. Fees-vs-billings contract tests are green on the release build.
6. Matrix, transport and parity suites are green on the release build.
7. Every MCP call, reads included, is audited with the user's name and OAuth `client_id`.
8. The pen test has 0 open criticals or highs, all retested.
9. There are 0 open P1 or P2 defects.
10. Uptime and error alerts are proven to reach the on-call Telegram group.
11. Legacy bypasses were approved by a named director, their expiries are staggered, and the burn-down report is live.

**M4 "Hypercare exit" (Fri 5 Feb, W16)**

1. 0 open P1s, and no more than 3 open P2s, each with an agreed date.
2. Restore test #2 was run by the second engineer from the app spec and the vault, witnessed by DemoQ, within RTO, and the runbook was updated.
3. The first monthly bypass review was held on Mon 1 Feb using the system report.
4. **The CEO validated January's "value given away" and float for at least 3 clients against hand-reconciled samples, and signed.**
5. The MCP walkthrough was done with at least 3 users, at least one of them not a developer, in addition to the recorded W12 pilot walkthrough.
6. The handover pack is delivered: runbooks, admin guide, ADRs, data dictionary, MCP setup guide and a prioritised backlog.

_Adoption targets, reported but **not** release conditions:_ at least 95% weekly confirmation in 2 consecutive weeks; at least 85% of approvals decided within SLA.

### 7.5 What DemoQ must provide (the PO or deputy answers within 2 business days; if an input is late, the stated default ships)

| Due                        | Input                                                                                                                                                                                                                                                                                                  | Default if late                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Fri 16 Oct (before W1)** | CEO signs the plan and chooses the capacity option (D30). **Third engineer confirmed.** PO at 50% plus a deputy, Finance rep, Khmer reviewer and translator budget (D31). **D16:** Anthropic plan confirmed, client NDAs reviewed, data rule accepted. W1 date confirmed against the sub-decree (D18). | **None: the build does not start (SG0)**                                                                                                       |
| W1                         | Company accounts (§12). Airtable token in the vault. **A sample accounting export** (D9). D1 and D2 (revisions). **D3 floors: fee margin and pass-through markup.** **D8 PO gate policy.** **D20 deposit meaning.** **D21 retainer model.** Contractor code and IP (D17).                              | 25% fee floor, no markup floor; PO required; deposit = terms agreed with evidence; retainers per the D21 default                               |
| W2                         | Roles, org chart, **chains per kind** and fallback approvers (D5, D24). SLAs. Working week. Rounding. **CO floor basis (D23).** **Digest recipients (D27).** **Khmer scope for admin screens (D25).** **Meaning of "Singapore" (D26).**                                                                | §5.4 chains; SLAs as listed; Mon–Sat; half-up; CO checked on its own lines; admin screens EN-only; hosting in SGP1 with data regions as in D26 |
| W3                         | **Formulas signed (D10).** One number per role (D11). Step-up thresholds (D12). **Project-type list (D22).**                                                                                                                                                                                           | The D10 defaults; the D11 list; D12 as listed; four starter project types                                                                      |
| W4                         | Champions released 2–4 h/week. **Pilot team and exclusive pilot clients (D28).** Task templates per project type. Accounting export mapping confirmed by Finance.                                                                                                                                      | One generic template per project type; the PO picks the pilot clients                                                                          |
| W6                         | Leave policy; historic time handling (D19); influencer link defaults (D13); auto-close rule (D14)                                                                                                                                                                                                      | D19 archive; D13 and D14 as listed                                                                                                             |
| W8                         | A data-cleanup owner working exceptions; the legacy bypass approver named (D29)                                                                                                                                                                                                                        | Exceptions are loaded as "needs review"; the Ops lead approves                                                                                 |

### 7.6 Scope traceability and MoSCoW

**Rule.** Every quoted sentence is Must, cannot be cut, and maps to spec rules with passing tests (`docs/scope-trace.md`, checked in CI). If a quoted clause genuinely cannot fit, the answer is a **re-baseline signed by the CEO** (a later date, the reserve, or a bigger team), not a cut agreed in advance.

| Q-ID      | Quoted clause                                                                                                                                      | Spec (rules)                                                | Sprint | Evidence                       |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------ | ------------------------------ |
| Q-01      | Clients, contacts and a pipeline with a required close reason                                                                                      | crm/clients, crm/pipeline (INV-01)                          | S1–S2  | M1 #4                          |
| Q-02      | Quote builder showing gross margin as you type, locked once sent                                                                                   | commercial/quote-builder (INV-02, INV-04)                   | S2     | M1 #5, #7                      |
| Q-03      | Below the margin floor needs Finance or Ops                                                                                                        | commercial/margin-floor (INV-03, INV-18)                    | S2     | M1 #8–9                        |
| Q-04      | The accepted quote becomes the scope; change orders only add                                                                                       | commercial/scope, change-orders, retainers (INV-04, INV-05) | S3     | M1 #11–12, #16                 |
| Q-05      | Engagement type and activation status                                                                                                              | projects/types-activation                                   | S3     | M1 #13, #15                    |
| Q-06      | No work before scope, contract, quote, purchase order and deposit terms                                                                            | projects/gates (INV-06, INV-21)                             | S3–S4  | M1 #13; M2 #8, #11             |
| Q-07      | Bypass is named, reasoned, reviewed monthly                                                                                                        | projects/bypass (INV-07)                                    | S3     | M1 #14; M4 #3                  |
| Q-08      | Kanban per project and per person                                                                                                                  | tasks/kanban                                                | S3     | E2E journeys K-01, K-02        |
| Q-09      | One owner, estimate, due date, dependencies                                                                                                        | tasks/core (INV-08)                                         | S3     | M1 #15                         |
| Q-10      | Templates per project type                                                                                                                         | tasks/templates, project types                              | S3     | M1 #15                         |
| Q-11      | Revision round 4 flags out-of-scope, hard stop at 5                                                                                                | tasks/revisions (INV-09, INV-20)                            | S4     | M2 #1–3, #5                    |
| Q-12      | Internal approval before anything reaches a client                                                                                                 | tasks/qc (INV-10)                                           | S4     | M2 #4                          |
| Q-13      | Files on Cloudflare R2                                                                                                                             | files                                                       | S2–S3  | Integration FILE-01..06        |
| Q-14      | Clock in and out on phone and desktop                                                                                                              | time/attendance (INV-11)                                    | S4     | M2 #6–7                        |
| Q-15      | Weekly confirmation, pre-filled, under two minutes                                                                                                 | time/allocations-confirm (INV-12)                           | S4     | M2 #9–10                       |
| Q-16      | Influencer work log by expiring link, no account, DemoQ approves                                                                                   | influencers/links (INV-13)                                  | S4     | M2 #11                         |
| Q-17      | Capacity 4 to 6 weeks out                                                                                                                          | time/capacity                                               | S5     | CC #1                          |
| Q-18      | Cambodian holidays and leave                                                                                                                       | time/holidays-leave                                         | S4     | Capacity fixtures; leave tests |
| Q-19      | One inbox for out-of-scope, quality checks, bypass, margin floor and influencer work                                                               | approvals/inbox                                             | S2–S4  | E2E I-01                       |
| Q-20      | Telegram, approve from the phone                                                                                                                   | approvals/telegram                                          | S2     | M1 #9                          |
| Q-21      | Overdue escalates up the line                                                                                                                      | approvals/escalation (INV-18)                               | S2     | M2 #12                         |
| Q-22      | Daily digest for leads, weekly for directors                                                                                                       | notify/digests                                              | S5     | CC #2                          |
| Q-23      | One number per role                                                                                                                                | reporting/role-numbers                                      | S5     | CC #5                          |
| Q-24      | For the CEO, value given away this month, drillable                                                                                                | reporting/giveaway                                          | S3–S5  | CC #4; M4 #4                   |
| Q-25      | Fees and billings shown apart                                                                                                                      | reporting/fees-billings (INV-15)                            | S5     | CC #4; M3 #5                   |
| Q-26      | Float exposure per client                                                                                                                          | reporting/float                                             | S5     | CC #4; M4 #4                   |
| Q-27      | MCP server for Claude Cowork and Claude Code                                                                                                       | mcp/server, mcp/oauth, mcp/tools                            | S2, S4 | M2 #13                         |
| Q-28      | Same permissions and gates as the screens                                                                                                          | §5.8 (INV-19)                                               | S1–S4  | M1 #1; M3 #6                   |
| Q-29      | Every action audited by name                                                                                                                       | kernel/audit (INV-14)                                       | S1     | M1 #2; M3 #7                   |
| Q-30      | Set-up guide and pilot walkthrough                                                                                                                 | docs/mcp-setup-guide                                        | S6     | W12 walkthrough; M4 #5         |
| Q-31      | Production and staging in Singapore, nightly backups, tested restore; Airtable migration; champion training, one pilot team, first month supported | ops, migration, training                                    | all    | M1 #17; M2 #14–17; §9.8; M4    |
| (context) | English + Khmer; USD + KHR; Telegram-first                                                                                                         | i18n, money                                                 | all    | M2 #18–19; M1 #6               |

**MoSCoW**

- **Must:** Q-01 to Q-31, plus what makes them true: authz and audit on every channel, the invariants, backups, reconciliation, and Khmer on staff-facing, Telegram, influencer and PDF surfaces.
- **Could, our own additions, cut first in this order if the burn-up projects Must finishing more than 3 days late** (about 8 days are inside the §7.1 estimate):
  1. Resource bookings and heat-map colouring (capacity stays as a numbers table)
  2. An email copy of digests (Telegram and the PWA remain)
  3. The automated monthly bypass PDF pack (the report screen is enough)
  4. The influencer multi-IP alert
  5. Advanced audit search filters
  6. Visual regression beyond PDFs
  7. The one-off Stryker run
  8. Not in the estimate (post-go-live backlog): NBC FX auto-import, a desktop clock widget, an offline clock queue, WebAuthn, client share links (`/s/:token`), an MCP step-up scope so high-risk approvals can be decided from chat, HA Postgres standby
- **Won't (this phase):** client portal, invoice generation or accounting integration (we import a billing ledger instead), payroll, native apps, influencer accounts, an influencer payouts module, an audit seal chain, audit partitioning, a Backblaze copy, Terraform.

**Never cut:** any Q-ID, authz and audit, the invariants, the restore test, reconciliation, Khmer review.

### 7.7 Governance

- **Monday:** 30-minute check-in with the PO or deputy.
- **Friday:** a 20-minute staging walkthrough in odd weeks. In even weeks, the 45-minute sprint demo with written sign-off.
- **Weekly status to the PO on Telegram:**
  - RAG for each of the three tracks
  - the Must burn-up against capacity
  - DemoQ inputs due next week, and any overdue
  - the top 3 risks with owners
  - Claude metrics (cycle time, escaped defects, test churn, cost against cap)
- **Decision log** (`docs/decision-log.md`): every answer gets an ID, a date and the person who decided.
- **Change control:** a one-line change note with a named sponsor and an explicit trade-off ("add X, drop Y from Could"). Anything touching a Q-ID needs the CEO's signature.
- **Stage gates** (§11.4) are the formal points to continue, use the reserve, or re-plan.

---

## 8. Testing and quality strategy

| Layer                    | Tool                                                                                                | What it proves                                                                                                                                                                                                                                                                                      | When                                                                  | Budget          |
| ------------------------ | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------- |
| Traceability             | `spec-coverage.ts` + Q-ID trace                                                                     | Every rule has a test, and every Q-ID has rules with passing tests                                                                                                                                                                                                                                  | Every PR                                                              | < 10 s          |
| Unit                     | Vitest                                                                                              | Machines, gates, pricing and policy as pure functions; each gate has allow, block and bypass cases                                                                                                                                                                                                  | Every PR                                                              | < 1 min         |
| Property                 | fast-check (≥ 10k cases)                                                                            | Quote total = sum of lines; browser = server fee margin and markup; FX round-trip within one unit; floor check is monotonic; scope value never decreases across any CO, revise or accept sequence; fees and pass-through never net; CEO number = sum of drill rows; giveaway rows are never mutated | Every PR                                                              | < 1 min         |
| Integration (per gate)   | Vitest + Testcontainers Postgres 16                                                                 | Activation, margin floor, revisions 4/5, QC, quote lock, CO additivity, bypass, influencer gating, allocation gating, escalation eligibility (with a fake clock). Each has happy, blocked, bypass and **concurrency** cases. DB backstops tested as `app`.                                          | Every PR                                                              | < 4 min sharded |
| Permission matrix        | In-process, oracle = signed CSV (§5.8)                                                              | role × command × own/other; no leak; audit correct                                                                                                                                                                                                                                                  | Every PR                                                              | < 2 min         |
| Transport and parity     | Real adapters                                                                                       | Actor resolution and auth per channel; about 12 parity scenarios on exposed channels; completeness                                                                                                                                                                                                  | Every PR                                                              | < 2 min         |
| MCP OAuth conformance    | Scripted client                                                                                     | CIMD, pre-registered client, PKCE, discovery, 401 challenge, formbody, refresh rotation, audience, TOTP, 429 `Retry-After`                                                                                                                                                                          | Every PR touching `/oauth` or `/mcp`; nightly                         |                 |
| Migrations               | CI + SGP1 job                                                                                       | Apply from empty; no edits to merged files; `schema.sql` and types current; weekly apply onto a **scrubbed prod dump in SGP1**                                                                                                                                                                      | Every PR / weekly                                                     |                 |
| E2E                      | Playwright                                                                                          | About 40 journeys (at least 3 per role), each in `en` and `km`, plus iPhone SE and Pixel viewports for clock-in, allocation and approvals. Includes the timed weekly-confirmation assertion.                                                                                                        | Smoke on every PR and deploy; full suite nightly on synthetic staging | Smoke < 4 min   |
| Khmer and Cambodia       | Golden tests + PDF visual snapshots                                                                 | NFC; `pg_trgm` on unspaced Khmer; `km-x-icu` sorting; +855 phones; `Asia/Phnom_Penh`; capacity and working-day logic across the 2026–27 holiday fixtures                                                                                                                                            | Every PR (golden), nightly (PDF)                                      |                 |
| Mutation (C)             | Stryker                                                                                             | One-off in W8 on `shared/money` and `shared/pricing`; findings become property tests                                                                                                                                                                                                                | W8                                                                    |                 |
| Load                     | k6                                                                                                  | 80 users clocking in within 5 min at 08:00; digest fan-out; report queries. Targets: API p95 < 400 ms, reports < 2 s.                                                                                                                                                                               | **Once, W11**, on production-sized rehearsal data                     |                 |
| Accessibility            | axe                                                                                                 | 0 serious violations on core journeys                                                                                                                                                                                                                                                               | Nightly                                                               |                 |
| Security                 | gitleaks, Semgrep, `pnpm audit`, **one ZAP baseline (W8)**, external pen test (W9) and retest (W12) | ASVS L2 (§9.1)                                                                                                                                                                                                                                                                                      | PR / W8 / W9 / W12                                                    |                 |
| Migration reconciliation | Generated report (SGP1)                                                                             | Counts; **stored inputs exact; recomputed totals ≤ 1 minor unit per line with a signed list**; attachment checksums; 30-record sample                                                                                                                                                               | Every ETL run                                                         |                 |

**Quality rules for AI-written code**

- **Tests before implementation, and locked.** Red tests are written in phase `red`, read by a human and committed separately. In phase `impl` a hook blocks test edits, and CI blocks changes to red-commit tests without a code-owner label.
- **No mocks for what matters.** The DB, policy, audit and clock are never mocked.
- **Small PRs.** At most 400 changed non-generated lines, and at most 3 open PRs per developer.
- **Every escaped defect** gets a regression test named with its rule ID. If Claude caused it, a rules line is added too.
- **We do not chase the contractor's "600 browser checks".** The bar is that every rule with a UI has an e2e test, and every role × critical journey is covered.
- **Data.** Seeds are deterministic. Staging uses a synthetic data generator. Real data exists only in prod and in the rehearsal DB.

---

## 9. Security, operations, backups, go-live, migration, training and hypercare

### 9.1 Security checklist (target: OWASP ASVS Level 2)

- **Auth:**
  - argon2id; server sessions; 12 h idle and 7-day absolute timeouts; all sessions revoked on a role change or offboarding
  - **TOTP required** for privileged roles on web login, **OAuth login and consent**, and **PAT issuance**
  - step-up for high-risk approvals above the D12 thresholds, role changes and data export
- **Rate limits:** login 5/min per IP and per account, with backoff; API 300/min per user; MCP 60/min per user (429 with `Retry-After`); influencer links 20/min per token and IP.
- **Headers and input:** helmet with a strict CSP; CSRF on cookie routes; Zod on every input and **output schemas** on every route; parameterised SQL only (Semgrep bans string-built SQL).
- **DB roles:**
  - `migrator` owns the schema and runs DDL, with default privileges granted to `app`
  - `app` has DML only, and INSERT/SELECT on audit
  - `reporting_ro` reads through views
  - `importer` is NOLOGIN except during DR runs and cutover, and its password is rotated afterwards
  - A test fails if the app's connection role owns any table.
- **R2:** private buckets; presigned PUT for 5 min and GET for 60 s, issued at click time; type and magic-byte checks; random keys.
- **Telegram:** secret header; private chats only; single-use callback tokens; decision figures only for `finance.view_costs` holders; the bot token in the vault with a rotation runbook.
- **MCP / OAuth:** all of §5.6. No DCR. No `static_headers` connectors. INV-19 channel policy. `mcp.writes` off until the pen test is retested. Audience validation. A Cloudflare skip rule scoped to the MCP and OAuth paths, with rate limits kept in the app.
- **Influencer links:** a 256-bit token stored as SHA-256; scoped to one assignment; 7-day default; 10 submissions; 50 MB uploads; `noindex`; `Referrer-Policy: no-referrer`; an EN/KM privacy notice; gated by INV-06.
- **Secrets:** in the vault and GitHub Environments only; gitleaks (including the PAT prefix); prod and staging separate; rotated quarterly and immediately when someone leaves.
- **Supply chain:** Renovate with a 7-day minimum age; `--ignore-scripts`; new dependencies need human approval; MCP servers pinned.
- **Pen test:** booked in W2; runs 14–18 Dec on staging; scope is auth, OAuth/MCP, the matrix, Telegram and influencer links; retest 4–5 Jan; criticals and highs fixed before cutover.

### 9.2 Environments, hosting and data location

- **Prod:** DigitalOcean App Platform SGP1 (api ×2, worker ×1, jobs, static web) and Managed PostgreSQL 16, **single node with 7-day PITR**. The HA standby is dropped; the 99.5% business-hours SLO and 4 h RTO are met by PITR. The environment is declared in `.do/app.yaml` and deployed from CI.
- **Staging:** a full mirror (its own bot, R2 bucket, MCP URL and OAuth clients) running on **synthetic data only**.
- **Rehearsal DB (SGP1):** real Airtable data for DR runs and pilot preparation. Humans and CI jobs only; never Claude; never a GitHub runner.
- **Feature flags** (a DB table): `telegram.approvals`, `mcp.writes`, `influencer.links`, `digests`.
- **"Singapore" (D26).** App and database are in SGP1. R2 takes only an APAC location _hint_, so the actual location is not guaranteed. Sentry and Better Stack hold data in their chosen regions. DemoQ decides whether the requirement means **where the system is hosted** (default: yes, met) or **where every copy of the data lives** (then Sentry and logs get strict PII scrubbing, R2 location is re-evaluated, and any tool that cannot comply is replaced). Sentry runs with `sendDefaultPii: false` and scrubbing rules either way.

### 9.3 Observability

- **Logs:** pino JSON with `reqId` (the same as the audit `request_id`), `userId`, `role` and `channel`; PII redacted; Better Stack with 30-day retention.
- **Errors:** Sentry with source maps and releases tagged by SHA.
- **Dashboards:**
  - API p95 and error rate; Telegram delivery failures
  - approval queue depth and **oldest pending item per kind**; escalations; `NO_ELIGIBLE_APPROVER` alerts
  - pg-boss lag and failed jobs; PDF render failures
  - weekly-confirmation completion and median time
  - MCP calls per user, OAuth failures, 429s
  - backup age; legacy bypasses still open
- **Heartbeats** (healthchecks.io): nightly backup, restore drill, digests, escalation sweep, FX staleness, retainer period job.
- **Uptime:** `/healthz` (app, DB, R2), the Telegram webhook, and **the full MCP discovery chain**.
- **Alert routing:** a private Telegram ops group plus email. P1 pages the on-call engineer and the tech lead; P2 goes to the next business day.
- **SLOs:** 99.5% monthly availability from 07:00 to 20:00 ICT; approval notification delivered within 60 s at p95; 0 audit integrity failures.

### 9.4 Backups and tested restore

- **Layer 1:** managed PITR for 7 days. RPO ≤ 15 min.
- **Layer 2:** a nightly `pg_dump -Fc`, encrypted with `age`, written to a backup bucket in a **separate Cloudflare account**. Write-only token, bucket-lock retention, **35 daily + 12 monthly** copies. RPO ≤ 24 h, independent of DigitalOcean.
- **Layer 3:** the files bucket is copied nightly with `rclone` into the same separate-account backup bucket.
- **Targets:** RTO ≤ 4 h.
- **Automated drill** (weekly until go-live, monthly afterwards), **run as an SGP1 job, never on GitHub runners:**
  1. Restore the latest dump into an ephemeral database.
  2. Run `verify.sql`: row counts within tolerance, money totals per client, the newest audit row less than 26 h old, and grants intact.
  3. Boot the app against it and run the smoke suite.
  4. Record timings, destroy the scratch DB, post the result to the ops group.

  A failed drill is a P1. The first drill runs in W5, and one must have passed within the 14 days before go-live.

- **Witnessed drills:** restore test #1 in W9 (M2). Restore test #2 in W15 (M4), run by the second engineer from the app spec and the vault while the first stays hands-off.

### 9.5 Runbooks (`docs/runbooks/`; format: trigger → checks → steps as commands → verification → who to notify)

**Executed at least once before go-live (6):**

1. Deploy and rollback
2. DB restore (PITR, and from a dump)
3. File restore
4. Staff offboarding: disable the account, kill sessions, unlink Telegram, revoke OAuth grants and PATs, reassign tasks and pending approvals
5. Telegram outage and bot-token rotation, including announcing the web-inbox fallback and switching the flag
6. Go-live rollback, including pilot data

**Written as checklists (not executed):** other secret rotations, influencer link abuse, approval stuck or no eligible approver, Cloudflare or R2 outage, annual holiday update, stale FX, security incident (contain, assess, notify affected clients within 72 h per policy), migration delta re-run, audit anomaly, MCP/OAuth outage (disable `mcp.writes`, revoke grants).

### 9.6 Deploy and rollback

- **App:** immutable images tagged by SHA. Rollback redeploys the previous tag, with a target under 10 minutes, rehearsed in W9.
- **Schema:** expand/contract only; each release supports N−1; destructive drops ship at least one release later.
- **Go-live rollback window: 72 h.**
  - **Triggers:** a data-integrity defect in money or audit; approvals blocked for more than 2 h; a P1 security issue.
  - **Action:** Airtable made editable again; the new system frozen read-only; records created since cutover **and the pilot clients' records from W10–12** exported with the delta script into Airtable import CSVs.
  - Rehearsed in DR3. After 72 h, only forward fixes are allowed. Dual entry is never supported.

### 9.7 Airtable migration

1. **Inventory and profiling (W1–2, SGP1 job):**
   - Metadata API → mapping sheet (field → column, transform, owner, signed by the champion).
   - Formula and rollup fields are recomputed, not migrated.
   - The PO adds a **Last Modified Time** field to every table.
   - Profiling outputs **aggregates only**: nulls, duplicates, free-text currency, orphans, **rows that would break each invariant**, and the recompute-difference rate on 20 sample quotes.
2. **Extract (W3–6):** a re-runnable job pulls into `airtable_raw` on the rehearsal DB at up to 5 requests/s per base. Attachments are downloaded **during extraction** (their URLs expire) and copied to R2 with SHA-256.
3. **Transform and load:** pure TypeScript transforms written from aggregates and synthetic fixtures. Loading goes through **job-only `import.*` commands** with actor `job:airtable-import`, **connected as the `importer` role**. Upserts are keyed on `airtable_id` **`WHERE system_of_record <> 'new'`**. Ambiguous matches go to manual review, failures to `migration_exceptions`. Nothing is dropped silently or hand-edited.
4. **Legacy rule for each invariant** (written W7–8):

   | Invariant hit                                            | Legacy rule                                                                                                                                                                                                                                                                        |
   | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | INV-01 closed deal with no reason                        | `close_reason = legacy_unrecorded` (import-only)                                                                                                                                                                                                                                   |
   | INV-08 task missing owner, estimate or due date          | Owner = the project's PM; estimate filled and flagged `estimate_source = legacy`; due = the Airtable date, else `planned_start + 14 d` flagged for review                                                                                                                          |
   | INV-09 round beyond 4                                    | Capped at 4 with `oos_decision = absorb` and `legacy = true` (no giveaway row)                                                                                                                                                                                                     |
   | INV-10 deliverable already with the client, no QC record | Mapped to `client_review` with `legacy = true`. The trigger accepts this **only when `session_user = 'importer'`**.                                                                                                                                                                |
   | Project with no engagement or project type               | Mapped by the champion in the mapping sheet                                                                                                                                                                                                                                        |
   | Quote with no cost                                       | Imported as "margin unknown": margin shows n/a; no floor check on a locked legacy quote                                                                                                                                                                                            |
   | Sent quote                                               | Imported locked, with the hash computed at import                                                                                                                                                                                                                                  |
   | Active project missing gate evidence                     | Imported active under a **legacy bypass**: named PM, reason "Legacy project imported from Airtable — gate evidence to be attached", **approved in bulk by a named director at the Sunday go/no-go (D29)**, expiries **staggered across 30–60 days**, and a weekly burn-down report |
   | Historic time logs                                       | A read-only archive table (D19). Live allocations start at the pilot or go-live.                                                                                                                                                                                                   |

5. **Reconciliation report** (generated on every run, in SGP1):
   - counts per entity
   - **money at two levels:** stored input amounts (unit prices, quantities, invoiced amounts) must match exactly in minor units; recomputed totals may differ by at most 1 minor unit per line, every difference is listed and Finance signs the list, and anything larger is an exception
   - open deals by stage; active projects by status; attachment checksums; 30 random records per entity for champions

   **Pass bar:** counts match or every gap is explained; stored money exact; recompute list signed; at most 1 field error per entity, all fixed.

6. **Pilot boundary** (so shared data is never edited in two places):
   - The pilot is drawn **by client**: all of a pilot client's records move together, and D28 picks **clients no other team serves**.
   - **Shared master data** (rate cards, influencer roster, close reasons, holidays) is mastered in prod from Sat 19 Dec. Airtable copies become read-only. A rare new record needed by a non-pilot team is created in prod by the Ops lead and mirrored one way to Airtable by a nightly export.
   - DR3 includes a **conflict report**.
7. **Dry runs:**
   - **DR1** Fri 27 Nov: clients, contacts, deals, projects on the rehearsal DB.
   - **DR2** W9: everything; the pilot clients are then loaded into prod on Sat 19 Dec.
   - **DR3** Mon 4 – Tue 5 Jan: a full timed rehearsal on a prod clone, including rollback. The duration measured here sets the cutover window, which must fit in about 30 h.
8. **Cutover** (Saturday is a working day, so the freeze is late Saturday):
   - **Sat 9 Jan 17:00:** Airtable made read-only by permissions (nothing deleted; screenshot kept).
   - **Sat night – Sun:** final load skipping `system_of_record = 'new'`, reconciliation, champion spot-check.
   - **Sun 10 Jan 18:00:** go/no-go with the CEO, PO, Finance and tech lead.
   - **Mon 11 Jan 08:00:** live.
9. **After cutover:** Airtable stays read-only for 90 days. A snapshot archive goes to R2 in W16, and the base is closed at day 90.

### 9.8 Pilot and go-live sequencing

- **Pilot team** (named W4): one account team of 5–8 people with 3–5 **exclusive** clients, at least one influencer campaign, and a Lead who uses Telegram heavily.
- **Schedule:**
  - **Sat 19 Dec:** pilot clients' Airtable records locked at 17:00 and loaded into prod overnight.
  - **Mon 21 Dec (W10):** the pilot goes live on clock, allocations, tasks, QC, approvals, Telegram and influencer links. Capacity, digests and reporting join during W10.
  - Daily 15-minute check-in in a Telegram group. P1s fixed the same day, P2s within 2 days.
- **Pilot exit criteria (go/no-go Wed 6 Jan):**
  - at least 90% of the pilot team's attendance hours allocated for **W10 and W11, two confirmed weeks** (confirmation due Mon 28 Dec and Mon 4 Jan at 12:00)
  - 100% weekly confirmation for both weeks, with a median under 2 minutes
  - at least 80% of approvals actioned from Telegram, with a median time to decision under 4 business hours
  - a below-floor quote, a round-4 flag, a QC and an influencer submission each handled end to end, **naturally or as a champion-run scripted scenario on real pilot records**
  - clock in/out used daily on phones
  - the MCP pilot walkthrough recorded with 2–3 pilot users (Tue 5 Jan)
  - 0 open P1s; the pilot reconciliation passes; the champions sign off
- **If the answer is no-go:** the pilot continues, Airtable stays live for everyone else, and cutover moves to Sat 23 Jan using the reserve. **Hypercare is always 4 weeks from the actual go-live date**, so a slip extends it into W17–18.
- **Go-live:** all remaining teams at once on Mon 11 Jan. At DemoQ's size, a second wave adds reconciliation complexity without reducing risk.

### 9.9 Champion training

- **W4:** champions named, and their managers release 2–4 h/week. From S3, champions attend demos and run UAT scripts on seeded staging.
- **Sessions (2 h each):**
  - **W7:** clients, quotes, projects and gates
  - **W9:** tasks, revisions, attendance and allocations, and the Telegram inbox (before the pilot)
  - **Mon 28 Dec:** train-the-trainer, common fixes, and how to report issues
- **Certification:** each champion completes a scripted end-to-end scenario (quote to confirmed week) without help.
- **Materials (EN/KM), owned by the PO and champions, not the engineers:** a one-page card per role, 2–3 minute videos per workflow, an FAQ. Engineers provide the scripts and screenshots. The Khmer translator and reviewer approve the Khmer.
- **Team sessions W11–12:** 1 h per team, run by the champions, with attendance tracked. Anyone who misses one gets the video plus a 15-minute catch-up.
- **MCP:** the pilot walkthrough in W12 (recorded; the quoted "pilot walkthrough"), then the setup guide and a session for 3–5 power users in W14.

### 9.10 Hypercare (4 weeks from actual go-live; planned W13–16)

- **Support:** engineers on call 08:00–20:00 ICT. A Telegram support channel, where the bot creates a tracker issue with the user's name, role and screen. `/triage` reproduces issues locally with seeds and a masked export.
- **Severity SLAs:**

  | Severity | Definition                                    | Response       | Resolution        |
  | -------- | --------------------------------------------- | -------------- | ----------------- |
  | P1       | Cannot work, or data or permissions are wrong | 1 h            | Workaround in 4 h |
  | P2       | Degraded                                      | 1 business day | Within 5 days     |
  | P3       | Minor                                         | Backlog        | Backlog           |

- **Cadence:** daily 20-minute triage in W13; three times a week in W14–16; a weekly metrics review.
- **Tracked:** active users as a share of staff; share of hours allocated; confirmation completion; median approval time; escalations; open legacy bypasses; error rate; p95; backup success.
- **Weekly plan:**
  - **W14:** tune digests and SLAs; MCP power-user session.
  - **W15:** restore test #2.
  - **W16:** monthly bypass review (Mon 1 Feb); CEO validation of January; handover; M4.

### 9.11 Data ownership, IP and privacy

- **DemoQ the company** owns the GitHub org, DigitalOcean, both Cloudflare accounts, the domain, the Telegram bots (created on a company phone), Sentry, the vault and the Anthropic workspace. Each has at least 2 owners, and the register is reviewed quarterly.
- **IP:** everyone who writes code signs an IP assignment and a confidentiality agreement. No contractor code is reused without a written assignment (and, if bought, a price). Claude Code outputs belong to DemoQ under Anthropic's commercial terms, and inputs are not used for training by default; confirm against the purchased plan in D16.
- **Development data rule** (§6.1): no real client data in any Claude session. Client NDAs are reviewed **before W1**.
- **Personal data** (staff, influencers, client contacts). Cambodia's data-protection law is in draft, so we design to its likely shape:
  - purpose limitation
  - an export and delete path per person
  - retention: time data 7 years for finance; influencer identity data deleted 2 years after their last campaign
  - an influencer privacy notice
  - data locations stated per D26

### 9.12 Cost

**Monthly running cost (infrastructure; approximate list prices, to be confirmed with vendors)**

| Item                                                                                     | Prod                   | Staging |
| ---------------------------------------------------------------------------------------- | ---------------------- | ------- |
| App hosting, SGP1 (2 api containers, 1 worker with Chromium, jobs, static web)           | $40–60                 | $12     |
| Managed Postgres 16 (2 vCPU / 4 GB, single node, PITR) plus the rehearsal DB when in use | $60–75                 | $15     |
| Cloudflare (DNS, TLS, WAF; Free or Pro)                                                  | $0–25                  | —       |
| R2 files plus backup bucket                                                              | $3–6                   | $1      |
| Sentry Team                                                                              | $26                    | shared  |
| Better Stack                                                                             | $0–30                  | shared  |
| Email                                                                                    | $15                    | —       |
| **Infrastructure total**                                                                 | **≈ $120–250 / month** |         |

**12-month total cost of ownership.** Labour rates are **illustrative Phnom Penh loaded costs; DemoQ replaces them with actual figures before SG0.**

| Line                              | Basis                                                                                                                 | 12-month range                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------- |
| Engineers (build)                 | 3 × 4 months × $3.0–4.5k loaded/month                                                                                 | $36–54k                                     |
| Reserve (only if triggered)       | 2 engineers × 0.5 month                                                                                               | $3–4.5k                                     |
| Maintenance after W16             | 0.25 FTE × 8 months (dependencies, holiday loads, fixes, support)                                                     | $6–9k                                       |
| Khmer translator (bulk pass)      | about 2,000 strings                                                                                                   | $0.5–1.5k                                   |
| Claude Code seats and usage       | 3 seats × $150–250/month × 4 months, then 1 seat; usage measured in S1 and capped                                     | $2.5–4.5k                                   |
| Claude PR review (API)            | $50–150/month                                                                                                         | $0.6–1.8k                                   |
| Claude seats for Cowork/MCP users | 5–10 users on the company plan (check current price) × 11 months                                                      | $1.5–4k                                     |
| Infrastructure                    | $120–250/month (prod from W3)                                                                                         | $1.5–3k                                     |
| Pen test and retest               | one-off                                                                                                               | $2.5–5k                                     |
| **Cash total**                    |                                                                                                                       | **≈ $54–87k**                               |
| DemoQ staff time (not cash)       | PO 50% × 3 months + 20% × 1; Finance about 100 h; Khmer reviewer about 12 days; champions 2–4 h/week each; pilot team | Insert loaded cost; the same whoever builds |

**Against the contractor's quote.** The quote is $20k for 4 months of build, and names no maintenance, infrastructure or support after the first month. It depends on a claimed base we have not verified, and leaves IP and bus-factor risk outside DemoQ. The same PO, Finance and champion time is needed either way. At about 8 engineer-months of need, $20k implies about $2.5k per engineer-month. That is plausible only at junior-to-mid local rates, or if their base is real and fits, which D0 tests.

---

## 10. Risk register (top 12)

| #   | Risk                                                                                                                  | L / I        | Early warning                                                                           | Mitigation                                                                                                                                                      | Owner                       |
| --- | --------------------------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| 1   | **Capacity and overrun.** Need ≈ 171 against 186; no buffer before go-live.                                           | H / H        | SG1 velocity < 90%; Must burn-up flat for 2 weeks                                       | Third engineer from W1; honest confidence dates; reserve pre-approved; cut list of our own additions only; the SG1 re-baseline uses feature sprints             | Tech lead + CEO             |
| 2   | **DemoQ decision latency** (formulas, matrix, floors, retainers, templates)                                           | H / H        | An input more than 2 business days overdue                                              | PO at 50% with a deputy; input calendar with shipping defaults; key decisions moved to W1–W3; W1 inputs escalate to the CEO                                     | PO                          |
| 3   | **Legacy data breaks invariants** (reasons, owners, rounds, QC, gates) or the migration stalls                        | H / H        | Profiling invariant-breaker counts; exception counts not falling across DRs             | One legacy rule per invariant; `importer` role; fixes at the source; 3 DRs; bulk legacy-bypass approval with staggered expiry; burn-down report                 | Dev C + DemoQ cleanup owner |
| 4   | **Accounting export lacks the fee/pass-through split or project tags**, so fees vs billings and float cannot be built | M / H        | The W1 sample has no line kinds or project references                                   | Sample in W1; `billing_import_mappings` with a Finance queue; the ledger is the single source for influencer payments                                           | Finance rep + Dev C         |
| 5   | **Permission leak through a secondary channel**                                                                       | M / Critical | A route, tool or callback not in the registry; an escalation to an ineligible user      | One registry; signed-CSV oracle; in-process matrix; parity; INV-18; INV-19; security-reviewer; pen test including OAuth                                         | Dev A                       |
| 6   | **AI code that looks right but is wrong**                                                                             | H / H        | Test-file churn; RED flags; PRs over 400 lines                                          | Spec-first; red tests locked by hook and CI; phase-aware Stop; CODEOWNERS; business-rule labels; property tests; weekly retro                                   | Dev A                       |
| 7   | **MCP OAuth or Cowork incompatibility** (client registration, WAF blocking Anthropic egress, SDK churn)               | M / H        | The W1 spike fails; discovery-chain uptime check red                                    | W1 spike; `oidc-provider`; CIMD plus pre-registered client; WAF skip rule refreshed from the docs; built in W7–8 and pen-tested; PAT fallback for Claude Code   | Dev C                       |
| 8   | **MCP exfiltration or prompt-injected decisions**                                                                     | M / H        | Read volume per user; writes outside hours                                              | Per-user OAuth; read default; INV-19; bound confirm tokens; `ask` rules; `mcp.writes` flag; audit with `client_id`; NDA review before W1                        | Dev C + CEO                 |
| 9   | **Money errors** (FX, rounding, fee/pass-through mixing)                                                              | M / H        | Displayed ≠ stored margin; reconciliation diffs                                         | Integers; one pricing function; two figures; FX window; property tests; money-reviewer; Finance labels on money PRs                                             | Dev A + Finance rep         |
| 10  | **Adoption failure**                                                                                                  | M / H        | Pilot confirmation < 80%; low daily use                                                 | Telegram-first; attendance/allocation split with pre-fill; champions with released time; two-week pilot evidence; Airtable read-only at cutover                 | PO + champions              |
| 11  | **Year-end and holiday calendar** (Water Festival in the M1 week; 1 and 7 Jan; Finance year-end close)                | M / M        | Holiday dates differ from the plan                                                      | W1 fixed at 19 Oct; cutover 9–10 Jan; Finance time raised W8–12; first-working-day scheduling                                                                   | PO                          |
| 12  | **Bus factor and real data leaking into AI tooling**                                                                  | M / H        | Only one person has deployed or restored in 30 days; real data found in a fixture or PR | Three engineers; every engineer deploys and restores; the second-engineer drill in W15; the data rule enforced by synthetic staging, SGP1-only ETL and gitleaks | Dev C                       |

**Watch list:** Khmer rendering and search; influencer link abuse; a DigitalOcean or Cloudflare outage; Claude usage cost against the cap; Chinese New Year absences in W16.

---

## 11. Definition of done and stage gates

### 11.1 Per story (PR)

- The spec's rules (with Q-IDs) have tests that a human reviewed in phase `red`, and they were not edited afterwards without a code-owner label.
- Commands are registered with `exposeTo`, and the matrix rows (from the signed CSV) are green.
- The story works on every channel it declares, and is audited.
- `en` and `km` strings are present, with Khmer reviewed or tracked as `KM-DRAFT:`.
- The PR has at most 400 changed non-generated lines, with code-owner review and a business label where required.
- It is deployed to staging and the smoke tests pass.

### 11.2 Per sprint

- The demo was given on staging, and the PO or deputy signed off in writing.
- The sprint's acceptance criteria are green in CI, with a link to the run.
- The Q-ID trace was updated.
- There are no open P1s.
- The burn-up was reported against capacity.

### 11.3 System go-live gate (Sun 10 Jan 18:00; every item needs evidence, not assertion)

1. **Traceability:** Q-01 to Q-31 → rules → passing tests, at 100%.
2. **Gates:** enforced server-side; proven in-process for all roles, and by parity scenarios on each exposed channel, including bypass and concurrent approvals.
3. **Permission matrix:** `permissions.ts` equals the signed CSV; 100% of cases pass; completeness finds 0 gaps.
4. **Money:** property suites green; reconciliation shows stored inputs exact and recomputed differences ≤ 1 minor unit per line, with the list signed by Finance; Khmer PDF snapshots approved.
5. **Security:** the ASVS L2 checklist is complete; the pen test has 0 open criticals or highs after retest; TOTP is enforced on web, OAuth and PAT issuance; Telegram replay and forwarding tests pass; the MCP OAuth conformance suite passes; **Cowork connects through the WAF from Anthropic's range**.
6. **Audit:** append-only proven; every write names a person; MCP rows carry the OAuth `client_id`.
7. **Resilience:** a restore drill in SGP1 passed within RTO in the last 14 days; rollback rehearsed in DR3, including pilot data; heartbeats fire.
8. **Operations:** the 6 core runbooks have been executed; each engineer has deployed, rolled back and restored; all accounts are company-owned with at least 2 admins.
9. **Pilot evidence:** the §9.8 exit criteria were met.
10. **Adoption readiness:** champions certified; the MCP guide worked for at least one non-developer in the W12 walkthrough; the 2027 holiday calendar is loaded.
11. **Performance and accessibility:** the one k6 run met its targets on production-sized data; axe shows 0 serious issues.
12. **Reporting:** CC #4–5 are green on pilot data. CEO validation of a full live month is M4 #4.
13. **Legacy:** the legacy bypass list is approved by a named director; the exceptions list is signed.
14. **Sign-off:** the CEO, Finance, Ops and the tech lead. **If any one is missing, the answer is no-go.**

### 11.4 Stage gates (replaces contractor-style payment milestones)

The build is in-house, so there is no "deemed accepted" clause and no retention. Each gate is a decision with thresholds, and releases the next tranche of internal budget.

| Gate                   | When                                            | Decision                                            | Thresholds                                                                                                                                                                                                                                                                                   |
| ---------------------- | ----------------------------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **SG0 Mobilise**       | Fri 16 Oct                                      | Start, or not                                       | Plan signed; capacity option chosen (D30); third engineer confirmed; D16 done; PO and deputy named; accounts in progress                                                                                                                                                                     |
| **SG1 Re-baseline**    | Fri 13 Nov (end W4)                             | Stay on 11 Jan, use the reserve, or change the team | S2 feature velocity against plan: **≥ 90%** stay; **75–90%** trigger the reserve (go-live 25 Jan); **< 75%** the CEO chooses between contracting named slices (migration, ops or the influencer page, under IP assignment, possibly from the incumbent contractor) and the two-engineer date |
| **SG2 M1**             | Fri 27 Nov                                      | Continue                                            | M1 accepted; Must burn-up within 5 days of plan; no more than 3 overdue DemoQ inputs                                                                                                                                                                                                         |
| **SG3 Pilot start**    | Fri 18 Dec                                      | Start the pilot?                                    | M2 accepted                                                                                                                                                                                                                                                                                  |
| **SG4 Pilot go/no-go** | Wed 6 Jan                                       | Proceed to cutover?                                 | §9.8 exit criteria                                                                                                                                                                                                                                                                           |
| **SG5 Go-live**        | Sun 10 Jan                                      | Cut over?                                           | §11.3                                                                                                                                                                                                                                                                                        |
| **SG6 Hypercare exit** | Fri 5 Feb (or 4 weeks after the actual go-live) | Hand over to maintenance                            | M4                                                                                                                                                                                                                                                                                           |

---

## 12. Week-1 checklist (exact first actions)

**Before Monday (by Fri 16 Oct): SG0**

- [ ] CEO signs this plan, chooses the capacity option (D30) and confirms the **third engineer** starts on 19 Oct.
- [ ] CEO names the PO (50%) and a **deputy with decision rights**, the Finance rep, the Khmer reviewer and translator budget, and a data-cleanup owner.
- [ ] **D16:** confirm the Anthropic plan type and its data terms; review client NDAs; accept the development data rule (§6.1).
- [ ] Confirm the lunar holiday dates (Water Festival) against the 2026 sub-decree and record them in D18.
- [ ] Anthropic org Owner: create the workspace, seats for 3 engineers, and **managed settings** (bypass mode disabled, minimum version, stable channel).

**Day 1 (Mon 19 Oct)**

- [ ] **CEO/PO: company-owned accounts**, each with at least 2 owners, credentials in the vault:
  - GitHub org `demoq`
  - DigitalOcean team (SGP1)
  - Cloudflare account A (DNS, R2 files buckets) and account B (backup bucket with bucket lock)
  - Sentry (region per D26), Better Stack, Postmark or Resend
  - Telegram bots (prod and staging) through BotFather on a **company phone**
- [ ] **PO:** create a read-only Airtable token, stored **in the vault and CI secrets only**; list the base IDs; **add a Last Modified Time field to every table**; request a **sample accounting export** from Finance.
- [ ] **PO:** email the contractor asking for code, tests and a signed IP assignment by Wed 12:00, and whether they would sell it.
- [ ] **Dev A:** create `demoq/demoq-psa`:
  - pnpm workspace skeleton, Node 22, strict `tsconfig`
  - **port `src/migrate.ts` with `MIGRATOR_DATABASE_URL`, `pg_advisory_lock` and timestamp names**; port the `set_config` helper
  - `docs/scope.md` (the quotation verbatim), `docs/scope-trace.md` with Q-01 to Q-31, `docs/decision-log.md` holding D1–D31
- [ ] **Dev C (minimal Claude and CI set-up only):**
  - pin Claude Code and write `.claude/VERSION`
  - skeleton CLAUDE.md (§6.2)
  - `settings.json` with `guard-files.sh`, `guard-bash.sh` and `format-lint.sh` (not the full Stop gate yet)
  - `.mcp.json` with a **pinned** Playwright MCP
  - CODEOWNERS and branch protection (§6.10)
  - `ci.yml` skeleton and lefthook
  - `.do/app.yaml` for staging
- [ ] **Dev B:** web shell (Vite, React, TanStack), i18n plumbing, login page, design tokens.

**Day 2 (Tue 20 Oct)**

- [ ] **2-hour decision workshop** (PO, deputy, Finance, all engineers), with decisions recorded or defaults accepted:
  - D1/D2 revisions
  - **D3 fee and pass-through floors**
  - **D8 PO gate**
  - **D20 deposit meaning**
  - **D21 retainer model**
  - a first pass at roles and chains
  - **time model walkthrough** (attendance vs allocations, activity codes)
- [ ] **Dev A** (plan mode, Opus): ADR-0013 and the kernel ADRs; kernel tests; the `executeCommand` pipeline. Spec-first is relaxed for plumbing (ADR plus tests).
- [ ] **Dev C:** staging deploy of `/healthz` (app, DB, R2); **MCP/Cowork auth spike** (half a day): stub `/mcp` on staging; Claude Code over a PAT header; Cowork as a custom connector. Record what the current spec and clients require (ADR-0012).
- [ ] **Dev B:** clients list and form against a stub API; the Playwright smoke harness.

**Day 3 (Wed 21 Oct)**

- [ ] **D0 contractor audit** (time-boxed to 1 day, only if code and IP arrived): the security and fit criteria in §1. Record in ADR-0011. If nothing arrived by 12:00, the decision is "reference only or ignore".
- [ ] **Dev A:** migration `…_foundation.sql`:
  - extensions; roles `migrator`, `app`, `reporting_ro`, `importer`; default privileges
  - `users` (with `working_days`), `teams`, `user_roles`, `sessions`, `settings`, `feature_flags`, `audit_events`, `audit_changes` with triggers, `outbox`
  - tests: UPDATE/DELETE on audit fail as `app`, and `app` owns no table
- [ ] **Dev C:** nightly `backup.dump` on staging to the account-B bucket; first dump verified by hand; Airtable **metadata inventory job** in SGP1.

**Day 4 (Thu 22 Oct)**

- [ ] **Dev A:** identity (argon2id, sessions, TOTP enrolment for privileged roles); `permissions.ts` v0; `pnpm matrix:export` → CSV to the PO for review (it becomes `permission-matrix.signed.csv` in W2).
- [ ] **Dev B:** login with TOTP and the clients/contacts CRUD UI against the REST adapter.
- [ ] **Dev C:** in-process matrix runner skeleton reading the CSV; completeness test; **profiling job (aggregates only)** in SGP1.
- [ ] **PO:** approve the spec PRs for `crm/clients-contacts` and `crm/close-reason`.
- [ ] **Finance:** accounting export sample received and checked for line kinds and project references (D9).

**Day 5 (Fri 23 Oct)**

- [ ] **20-minute staging walkthrough with the PO:** log in with TOTP as a director; create a user, and the audit timeline shows the actor's name; a staff user gets 403 on admin; the clients list works in EN and KM; last night's staging backup exists; CI is green.
- [ ] **Weekly Claude retro #1:** rules fixes; permission-prompt pruning; baseline metrics; the Claude usage cost cap per engineer.
- [ ] **Weekly status to the PO:** RAG per track; W2 inputs due (org chart, chains, SLAs, working week, digest recipients, D23–D27); top 3 risks; **pen test vendor shortlist, to be booked by Fri 30 Oct**.

**Week-1 exit criteria:**

- The repo, CI, lefthook, minimal hooks, managed settings and CODEOWNERS are in place.
- Staging runs in SGP1 from the app spec, and a nightly backup has been verified.
- The kernel pipeline and the foundation migration are green, with append-only and "app owns no table" proven at DB level.
- Login with TOTP and clients CRUD work on staging.
- The MCP/Cowork spike is recorded in ADR-0012.
- The Airtable inventory is done, with profiling aggregates started.
- D0 is decided.
- The day-2 workshop decisions are logged, or their defaults accepted.
- Every W1 input has been received, or escalated to the CEO.

---

## Appendix A: Decisions (where the drafts or the review disagreed, and what this plan picks)

| Topic                       | Options                                                          | Decision                                                                                                                                                                                                                                                   | Why                                                                                 |
| --------------------------- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Scope commitment            | Should/Could for some quoted clauses vs all quoted clauses Must  | **All 31 quoted clauses Must; cut list only from our own additions**                                                                                                                                                                                       | The quotation is the benchmark; cutting quoted scope in advance hides a shortfall   |
| Team size                   | 2 devs + 0.5 FTE later vs 3 from W1 vs longer timeline           | **3 engineers from W1, plus a pre-approved W17–18 reserve**                                                                                                                                                                                                | A mid-project hire costs the core team time; honest confidence dates                |
| W1 date                     | 5 Oct vs 12 Oct vs 19 Oct                                        | **19 Oct** (cutover 9–10 Jan)                                                                                                                                                                                                                              | Clears 1 and 7 Jan; Pchum Ben falls before W1                                       |
| Repo shape                  | 8 packages vs single package                                     | **4 packages + 2 apps**                                                                                                                                                                                                                                    | Browser and server share pricing                                                    |
| Query layer / validation    | Kysely vs raw; Zod vs TypeBox                                    | **Kysely; Zod**                                                                                                                                                                                                                                            | Typecheck catches column errors; one contract for all channels                      |
| Permission source of truth  | TS const vs signed file                                          | **Signed CSV is the oracle; the TS const must equal it**                                                                                                                                                                                                   | Otherwise the matrix test checks itself                                             |
| Matrix execution            | All cases through real transports vs in-process                  | **In-process full matrix + transport tests + about 12 parity scenarios**                                                                                                                                                                                   | Same assurance, far cheaper; parity only where a command is exposed                 |
| Rounding and reconciliation | Exact money match vs tolerance                                   | **Half-up per line; stored inputs exact; recomputed totals ≤ 1 minor unit per line with a signed list**                                                                                                                                                    | Airtable stores floats; exact recomputed matches are unreachable                    |
| Margin                      | One blended figure vs split                                      | **Fee margin + pass-through markup, separate floors**                                                                                                                                                                                                      | Pass-through dominates influencer quotes                                            |
| FX                          | Daily rate required vs latest-rate window; NBC scraper vs manual | **Finance enters rates; latest within 5 days, dated on the quote; scraper is Could**                                                                                                                                                                       | NBC publishes nothing on weekends or holidays; less to build                        |
| Time model                  | Project-bound clock entries vs attendance + allocations          | **Attendance + allocations**                                                                                                                                                                                                                               | Clocking is attendance; gates apply only to project time                            |
| Retainers                   | Unmodelled vs monthly periods                                    | **`scope_periods` generated from `per_period` lines**                                                                                                                                                                                                      | Retainers are core revenue and must migrate                                         |
| Engagement vs project type  | One template per engagement type vs separate project types       | **Separate `project_types`, each with its own template**                                                                                                                                                                                                   | The quotation lists both; the agency needs many templates                           |
| PO gate default             | Off vs on                                                        | **On; exemption is a recorded Finance/Ops decision reviewed monthly**                                                                                                                                                                                      | The quotation names PO as a gate                                                    |
| Accept → Won                | System close reason vs user's win reason                         | **Win reason required on accept, on every channel**                                                                                                                                                                                                        | "Required close reason" must mean a real reason                                     |
| Revise after accept         | Allowed vs blocked                                               | **Blocked; accepted is terminal; changes only through COs**                                                                                                                                                                                                | "Change orders only add"                                                            |
| Revision rounds             | Per-line allowance vs fixed 4/5                                  | **Fixed 4/5; QC loops don't count; round 4 starts only on absorb**                                                                                                                                                                                         | Matches the quotation; removes a conflicting field                                  |
| Out-of-scope detection      | Round 4 only vs broader                                          | **Round 4, unscoped tasks, influencer over-quantity, time overrun**                                                                                                                                                                                        | One inbox and the CEO number depend on catching them                                |
| Client share links          | Built vs QC-gated "mark sent"                                    | **Mark sent (Must); share links Could**                                                                                                                                                                                                                    | Cheaper; share links drift towards a client portal                                  |
| Escalation                  | Manager line vs permission-aware                                 | **Permission-aware chains per kind, fallback approver, alert**                                                                                                                                                                                             | Overdue items must reach someone who can decide                                     |
| Finance approval → send     | Finance sends vs requester sends                                 | **Approval → ready; optional auto-send as the requester, audited on-behalf-of**                                                                                                                                                                            | Finance has no `quote.send`; the audit stays truthful                               |
| Director override           | All kinds vs all except margin floor                             | **All except `margin_floor`**                                                                                                                                                                                                                              | The quotation says margin floor needs Finance or Ops                                |
| MCP stack                   | SDK v1 + auth router vs current SDK + `oidc-provider`            | **Current SDK line, stateless; `oidc-provider`; spike confirms versions**                                                                                                                                                                                  | The v1 auth helpers were removed and were Express-only; replicas need statelessness |
| MCP client registration     | Open DCR vs CIMD + pre-registered                                | **CIMD (Claude Code) + pre-registered (Cowork); DCR off**                                                                                                                                                                                                  | Less attack surface; matches Claude clients                                         |
| MCP timing                  | OAuth W11–12 vs W7–8                                             | **Shell W3–4; OAuth W7–8; pen test W9; retest W12**                                                                                                                                                                                                        | The riskiest auth surface must be pen-tested                                        |
| MCP high-risk decisions     | prepare/confirm vs route to app                                  | **DECIDE_IN_APP for margin floor, bypass, bypass review, influencer work and absorb**                                                                                                                                                                      | The model can confirm alone; no MCP step-up yet                                     |
| MCP write tools             | Could vs Must                                                    | **Must (generated), behind `mcp.writes` until retest**                                                                                                                                                                                                     | Cheap through the registry; "every action audited" implies actions                  |
| Pilot start                 | W11 vs W10                                                       | **W10 (Mon 21 Dec)**                                                                                                                                                                                                                                       | Two confirmed weeks before the go/no-go                                             |
| Pilot boundary              | By team vs by client                                             | **By exclusive clients; shared masters mastered in prod**                                                                                                                                                                                                  | Prevents split-brain edits                                                          |
| Cutover timing              | Fri 18:00 freeze vs Sat 17:00                                    | **Sat 17:00 freeze; go/no-go Sun 18:00**                                                                                                                                                                                                                   | Saturday is a working day                                                           |
| Reporting timing            | W11–12 vs W9–10                                                  | **Built S5 (used in the pilot); CEO validates January in M4**                                                                                                                                                                                              | Pilot use; a month of live data is needed to validate "this month"                  |
| Giveaway ledger             | Recomputed nightly vs immutable with adjustments                 | **Immutable; adjustments dated in the current month; `client_credit` kind**                                                                                                                                                                                | Stable "this month"; auditable                                                      |
| Influencer payments         | In-system payouts vs ledger                                      | **Billing-ledger `vendor_payments` is the single source**                                                                                                                                                                                                  | Avoids double counting in float                                                     |
| Audit tamper evidence       | Seal chain + partitions vs grants + trigger                      | **Grants + trigger; seals and partitions deferred (ADR-0010)**                                                                                                                                                                                             | Enough for this size; avoids partition DDL by `app`                                 |
| Infra as code               | Terraform vs DO app spec                                         | **App spec + Cloudflare script + runbook**                                                                                                                                                                                                                 | Less to build; still rebuildable                                                    |
| Backups                     | Separate-account R2 + B2 + HA standby vs one off-provider copy   | **PITR + separate-account R2 (dumps and files); no B2; no standby**                                                                                                                                                                                        | Meets RPO and RTO at lower cost                                                     |
| Test extras                 | Stryker gate, stateful model, weekly k6 and ZAP vs one-offs      | **Stryker once (W8); no stateful model; k6 once; ZAP once plus the pen test**                                                                                                                                                                              | Keeps the money and permission controls; saves days                                 |
| Runbooks                    | 16 executed vs 6 executed + checklists                           | **6 executed + checklists**                                                                                                                                                                                                                                | Covers the scenarios most likely at go-live                                         |
| Stop hook                   | Always require green vs phase-aware                              | **Phase-aware (spec/red/impl), counter, QUESTION marker, merge-base diff**                                                                                                                                                                                 | The red step and "ask first" must work                                              |
| Test lock                   | Prompt instruction vs mechanical                                 | **PreToolUse hooks + CI red-commit check**                                                                                                                                                                                                                 | Principle 9                                                                         |
| Reviewer subagents          | Read-only with a diff prompt vs diff files                       | **Diff files written by `/pr`**                                                                                                                                                                                                                            | Reviewers had no way to see the diff                                                |
| Branch protection           | Two approvals on paths vs code owners + labels                   | **1 approval + code-owner review + PO/Finance labels**                                                                                                                                                                                                     | GitHub has no per-path approval counts; business eyes on rules                      |
| Skills timing               | Day 1 vs after the golden slice                                  | **Minimal Day 1; scaffolds from the golden slice in W3 + drift CI**                                                                                                                                                                                        | Avoids encoding a guessed kernel API                                                |
| Real data and Claude        | Allowed for mapping/triage vs never                              | **Never; aggregates, synthetic and masked data only**                                                                                                                                                                                                      | Client confidentiality; D16 before W1                                               |
| Payment milestones          | Contractor terms vs stage gates                                  | **Internal stage gates (§11.4)**                                                                                                                                                                                                                           | The build is in-house                                                               |
| Kept from v1                | —                                                                | pg-boss; PWA; no RLS for authz; KHR exponent 0; one currency per quote; single-use Telegram tokens; two taps for high-risk Telegram; 72 h rollback; `airtable_raw`; `airtable_id` column; 256-bit link tokens; 23:59 or 12 h auto-close; digest sent 07:45 | Unchanged reasoning                                                                 |

## Appendix B: Open decisions for DemoQ (defaults ship if unanswered by the due date)

| ID  | Decision                                                                       | Default                                                                                                                                                                                                                                                                                                                                             | Due           |
| --- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| D1  | What "hard stop at 5" means                                                    | Round 5 blocked; more work only through an accepted CO (new task)                                                                                                                                                                                                                                                                                   | W1 Tue        |
| D2  | Does round-4 work wait for the decision?                                       | Yes; round 4 starts only on "absorb"                                                                                                                                                                                                                                                                                                                | W1 Tue        |
| D3  | Floors per engagement type: fee margin, and pass-through markup                | 25% fee margin; no markup floor (warning below 10%)                                                                                                                                                                                                                                                                                                 | W1 Tue        |
| D4  | Approval SLAs per kind                                                         | As in §5.4                                                                                                                                                                                                                                                                                                                                          | W2            |
| D5  | Org chart and escalation chains per kind                                       | As in §5.4                                                                                                                                                                                                                                                                                                                                          | W2            |
| D6  | Rounding                                                                       | Half-up per line                                                                                                                                                                                                                                                                                                                                    | W2            |
| D7  | KHR handling                                                                   | Whole riel, no cash rounding                                                                                                                                                                                                                                                                                                                        | W2            |
| D8  | PO gate policy                                                                 | Required for every client; not_applicable only through a recorded Finance/Ops exemption                                                                                                                                                                                                                                                             | W1 Tue        |
| D9  | Accounting tool and export (sample W1; mapping W4)                             | Weekly CSV import by Finance through `billing_import_mappings`                                                                                                                                                                                                                                                                                      | W1 / W4       |
| D10 | Formulas: value given away (each kind, §4.2), float exposure, fees vs billings | Kinds and valuations as in §4.2; float = pass-through paid out − pass-through collected per client, aged 0–30/31–60/61–90/90+; fees = fee lines, billings = everything invoiced, always shown apart                                                                                                                                                 | **W3**        |
| D11 | One number per role                                                            | CEO: value given away this month. Director: fee margin month-to-date. Finance: float exposure. Ops lead: gate-blocked and bypassed projects. Account lead: weighted pipeline. PM: on-time task %. Team lead: team utilisation for the next 4 weeks. Staff: hours confirmed vs capacity this week. Influencer manager: pending influencer approvals. | W3            |
| D12 | Step-up thresholds                                                             | Margin more than 10 points below the floor; bypass longer than 14 days                                                                                                                                                                                                                                                                              | W3            |
| D13 | Influencer link defaults                                                       | 7 days, 10 submissions, 50 MB per file                                                                                                                                                                                                                                                                                                              | W6            |
| D14 | Attendance auto-close                                                          | 23:59 or 12 h, flagged                                                                                                                                                                                                                                                                                                                              | W6            |
| D15 | Working week                                                                   | Mon–Sat, overridable per user                                                                                                                                                                                                                                                                                                                       | W2            |
| D16 | Anthropic plan and data terms; client NDA review; development data rule        | Team or Enterprise plan; NDAs reviewed; rule as in §6.1                                                                                                                                                                                                                                                                                             | **Before W1** |
| D17 | Adopt the contractor's base?                                                   | Reference only or ignore, unless the D0 audit (security + fit) and the IP assignment pass                                                                                                                                                                                                                                                           | W1 Wed        |
| D18 | W1 date and cutover                                                            | W1 = 19 Oct 2026; cutover 9–10 Jan 2027                                                                                                                                                                                                                                                                                                             | Before W1     |
| D19 | Historic Airtable time logs                                                    | Read-only archive table                                                                                                                                                                                                                                                                                                                             | W6            |
| D20 | Deposit gate meaning                                                           | Terms agreed, with recorded evidence (not cash received)                                                                                                                                                                                                                                                                                            | W1 Tue        |
| D21 | Retainer model                                                                 | Monthly periods from `per_period` lines; contract and scope gates once; PO and deposit per period only if the client requires them; revisions per deliverable per period                                                                                                                                                                            | W1 Tue        |
| D22 | Project types and their templates                                              | Four starter types (campaign, content/video production, social management, influencer program), one template each                                                                                                                                                                                                                                   | W3 / W4       |
| D23 | Change-order floor basis                                                       | The CO's own lines; cumulative scope margin shown as information                                                                                                                                                                                                                                                                                    | W2            |
| D24 | Does the CEO count as "Ops" for margin-floor fallback?                         | No; the fallback is the Ops lead's named deputy                                                                                                                                                                                                                                                                                                     | W2            |
| D25 | Khmer on admin and config screens in v1                                        | EN-only for admin/config; Khmer everywhere staff-facing                                                                                                                                                                                                                                                                                             | W2            |
| D26 | Meaning of "Singapore"                                                         | Hosting in SGP1 (met); Sentry and log regions chosen with PII scrubbing; R2 location hint APAC                                                                                                                                                                                                                                                      | W2            |
| D27 | Digest recipients                                                              | Daily: team_lead, project_manager, account_lead, ops_lead. Weekly: director, ceo.                                                                                                                                                                                                                                                                   | W2            |
| D28 | Pilot team and exclusive pilot clients                                         | The PO picks one account team with 3–5 clients no other team serves                                                                                                                                                                                                                                                                                 | W4            |
| D29 | Legacy bypass approver and expiry                                              | A named director approves in bulk at the go/no-go; expiries staggered across 30–60 days                                                                                                                                                                                                                                                             | W8            |
| D30 | Capacity option                                                                | 3 engineers, 16 weeks, W17–18 reserve pre-approved                                                                                                                                                                                                                                                                                                  | Before W1     |
| D31 | DemoQ time commitments                                                         | PO 50% + deputy; Finance 4–6 h/week (1 day/week in W8–12); Khmer reviewer 1 day/week + translator; champions 2–4 h/week                                                                                                                                                                                                                             | Before W1     |
