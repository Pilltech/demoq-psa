# Delivery backlog — S1 to S8

Each story is one vertical slice: spec → failing tests → command/policy/audit → migration → REST (+ Telegram/MCP per
`exposeTo`) → EN/KM UI → E2E → staging. Story IDs are stable; rule IDs are assigned in each spec by `/spec`.
Sizes are engineer-days **with** Claude Code (plan §7.1). "Q" = quotation clause (`docs/scope.md`).
Calendar: W1 = Mon 19 Oct 2026 (D18). Owners: A = tech lead, B = web/Telegram, C = platform/QA/MCP/migration.

Legend: ✅ done · 🟡 partly · ⬜ not started

---

## S1 · W1–2 (19–30 Oct) · Foundations — ✅ core done in this repo

| ID    | Story                                                                                                  | Q      | Size | Owner | Status                                   |
| ----- | ------------------------------------------------------------------------------------------------------ | ------ | ---- | ----- | ---------------------------------------- |
| S1-01 | Repo, pnpm workspaces, TS strict, ESLint + boundary rules, Prettier, CI                                | —      | 2    | C     | ✅                                       |
| S1-02 | DB roles (`migrator`, `app`), migration runner with advisory lock + checksum, template-DB test harness | —      | 2    | A     | ✅                                       |
| S1-03 | Kernel: `defineCommand/Query`, `execute()` pipeline, errors (RFC 9457, EN/KM), state machines, outbox  | Q-28   | 3    | A     | ✅                                       |
| S1-04 | Append-only audit (grants + trigger), row-change capture, audit timeline                               | Q-29   | 2    | A     | ✅                                       |
| S1-05 | Permission matrix as code = signed CSV (CI check); policy with own/team/assigned scopes                | Q-28   | 1    | A     | ✅ (PO signature pending)                |
| S1-06 | Identity: argon2id, sessions, lockout, TOTP for privileged roles (replay-safe), admin users/teams      | —      | 3    | A     | ✅                                       |
| S1-07 | Money core (bigint minor units, half-up, USD/KHR, parse/format) with property tests                    | INV-15 | 1    | A     | ✅                                       |
| S1-08 | CRM: clients + contacts (EN/KM search, archive, primary contact)                                       | Q-01   | 2    | B     | ✅                                       |
| S1-09 | **Golden slice** `crm/close-reason`: pipeline Kanban, Lost needs reason, reopen, history, audit        | Q-01   | 3    | A+B   | ✅                                       |
| S1-10 | PWA shell: login, TOTP enrol/verify, EN/KM toggle, pipeline, clients, admin                            | —      | 3    | B     | ✅                                       |
| S1-11 | Claude Code operating model: CLAUDE.md, hooks, skills, reviewer subagents, spec template, trace check  | —      | 2    | A     | ✅                                       |
| S1-12 | Staging on DO App Platform SGP1 from `.do/app.yaml`; nightly backups                                   | Q-31   | 2    | C     | ⬜ needs DemoQ cloud accounts (D16, D26) |
| S1-13 | Spike: MCP SDK + Cowork OAuth (confirm package line, ADR-0012)                                         | Q-27   | 1    | C     | ⬜                                       |
| S1-14 | Spike: accounting export sample (D9)                                                                   | Q-25   | 0.5  | C     | ⬜ needs DemoQ sample                    |
| S1-15 | Airtable inventory + profiling (aggregates only)                                                       | Q-31   | 2    | C     | ⬜ needs Airtable token in vault         |
| S1-16 | Specs signed: time model (ADR-0013), retainers (D21), pricing floors (D3)                              | —      | 1    | PO+A  | ⬜                                       |

**Demo (Fri 30 Oct):** TOTP login · deal dragged to Lost without reason is blocked (EN + KM) · reason saves it ·
audit timeline shows name + channel · staff get 403 on the pipeline. _All automated in `tests/e2e/golden-slice.spec.ts`._

---

## S2 · W3–4 (2–13 Nov) · Channels and selling — SG1 re-baseline Fri 13 Nov — 🟡 built ahead of schedule with defaults (2026-09-27)

| ID | Story | Q | Size | Owner | Depends on |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ---- | ----- | ------------ |---|
| S2-01 | Prod provisioned (SGP1) with nightly `pg_dump` → R2 backup bucket in a separate account | Q-31 | 2 | C | S1-12 | ⬜ needs DemoQ cloud accounts |
| S2-02 | **Telegram shell**: grammY webhook (secret header), `/start` account linking via one-time code, private chats only | Q-20 | 2 | B | S1-03 | ✅ |
| S2-03 | **MCP shell**: stateless `/mcp` handler, PAT auth (hashed, ≤30 d, read-only for privileged roles), tools generated from registry where `exposeTo ∋ mcp`, audit with client name | Q-27, Q-28, Q-29 | 3 | C | S1-13 | ✅ (PAT auth; OAuth S4) |
| S2-04 | Extract scaffold skills from the golden slice (`/add-command` templates, `/add-gate`), weekly headless drift check | — | 1 | A | S1-09 | ⬜ |
| S2-05 | Rate cards, engagement types (fee floor, markup floor), **project types** — admin screens | Q-03, Q-05 | 2 | B | — | ✅ |
| S2-06 | Manual FX rates (Finance; ≤ 5 days old at send) | INV-15 | 1 | A | — | ✅ |
| S2-07 | **Quote builder**: fee + pass-through lines, live fee margin and markup (one pure function in `shared/pricing`, INV-02), cost redaction (INV-16) | Q-02 | 4 | A+B | S2-05 | ✅ |
| S2-08 | **Approval engine v1**: policies per kind, permission-aware routing (INV-18), SoD (no self-approval), single-winner decide (INV-17), supersede on content-hash change, web inbox | Q-19, Q-21 | 5 | A | S1-05 | ✅ |
| S2-09 | **Margin floor**: submit → `margin_review` + `margin_floor` approval bound to `content_sha256`; Finance/Ops approve; "send when approved" | Q-03 | 2 | A | S2-07, S2-08 | ✅ |
| S2-10 | **Telegram approval cards**: approve/reject from the phone, card edited in place, idempotent callbacks, cost figures only for `finance.view_costs` | Q-20 | 2 | B | S2-02, S2-08 | ✅ |
| S2-11 | Escalation job (pg-boss, `Asia/Phnom_Penh`): overdue → next eligible approver up the chain | Q-21 | 1.5 | A | S2-08 | ✅ |
| S2-12 | Send: FX freeze, content hash, lock trigger (INV-04), async EN/KM PDF (Chromium in worker); revise → v2 supersedes v1 | Q-02 | 3 | A+B | S2-07 | 🟡 send/lock/revise ✅; PDF render deferred (needs Chromium in the worker image) |
| S2-13 | Files on R2 (presigned upload/download, sha256, size/MIME limits) | Q-13 | 2 | C | — | ⬜ needs Cloudflare R2 credentials |

**Demo (Fri 13 Nov):** 18% fee-margin quote vs 25% floor → "Request approval" → Finance approves on Telegram → quote
sent and locked within 10 s, audit names both people · edit returns `QUOTE_LOCKED` · overdue approval escalates to
ops_lead (never a director without the permission) · `client.list` from Claude Code matches the screen and is audited.

---

## S3 · W5–6 (16–28 Nov; Water Festival) · Scope and start of work — M1 / SG2 Fri 27 Nov

| ID    | Story                                                                                                             | Q          | Size | Depends on |
| ----- | ----------------------------------------------------------------------------------------------------------------- | ---------- | ---- | ---------- |
| S3-01 | `quote.accept` with win reason → scope (+ first retainer period); deal → Won (closes CRM-CR-03 path)              | Q-01, Q-04 | 2    | S2-12      |
| S3-02 | Change orders: additive only (INV-05), own floor (D23), accept appends scope items + tasks                        | Q-04       | 2    | S3-01      |
| S3-03 | Retainer periods (monthly, generated 7 days ahead)                                                                | Q-04       | 1.5  | S3-01      |
| S3-04 | Projects from accepted quote: project type, `planned_start`, members                                              | Q-05       | 1.5  | S3-01      |
| S3-05 | **Five gates** with R2 evidence; PO required by default; client exemptions (INV-21); `assertWorkAllowed` (INV-06) | Q-06       | 3    | S2-13      |
| S3-06 | **Bypass**: request, two-tap Telegram approve, expiry ≤ 30 d, auto-close, monthly review report + approval        | Q-07       | 2    | S2-08      |
| S3-07 | Task templates per project type; tasks with one owner, estimate, due date; dependencies with cycle check (INV-08) | Q-09, Q-10 | 3    | S3-04      |
| S3-08 | **Kanban per project and per person**                                                                             | Q-08       | 2    | S3-07      |
| S3-09 | Scope link rule for tasks (INV-20); giveaway ledger rows for discounts                                            | Q-24       | 1.5  | S3-07      |
| S3-10 | Airtable DR1 (rehearsal DB, SGP1)                                                                                 | Q-31       | 2    | S1-15      |

---

## S4 · W7–8 (30 Nov – 11 Dec) · Delivery, time, influencers, MCP auth — pilot-critical code complete

| ID    | Story                                                                                                                                           | Q          | Size |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ---- |
| S4-01 | Revision rounds; round-4 OOS approval (absorb / change order / reject); hard stop at 5 (INV-09)                                                 | Q-11       | 2    |
| S4-02 | Internal QC by a non-owner before "mark sent" (INV-10)                                                                                          | Q-12       | 1.5  |
| S4-03 | Out-of-scope detection: unscoped tasks, over-quantity                                                                                           | Q-11       | 1    |
| S4-04 | **Attendance**: clock in/out on PWA and Telegram `/in` `/out`; one open session; auto-close (INV-11)                                            | Q-14       | 2    |
| S4-05 | **Allocations + weekly confirmation**: pre-filled, `/week` one tap, locks the week (INV-12); timed < 2 min                                      | Q-15       | 3    |
| S4-06 | Holidays 2026–27 (sub-decree), leave types and approvals; per-user working week                                                                 | Q-18       | 2    |
| S4-07 | **Influencer**: roster, assignments, expiring links (hash, max submissions), public EN/KM page, approval (INV-13)                               | Q-16       | 3    |
| S4-08 | **MCP OAuth** (`oidc-provider`, CIMD + pre-registered Cowork client, TOTP at consent), channel policy (INV-19), write tools behind `mcp.writes` | Q-27, Q-28 | 4    |
| S4-09 | ZAP baseline scan                                                                                                                               | Q-31       | 0.5  |

## S5 · W9–10 (14–26 Dec) · Pilot-ready → code complete (freeze Fri 25 Dec)

| ID    | Story                                                                                                                 | Q          | Size |
| ----- | --------------------------------------------------------------------------------------------------------------------- | ---------- | ---- |
| S5-01 | Pen test (W9), ASVS L2 hardening, restore test #1 witnessed, rollback rehearsal, DR2                                  | Q-31       | 4    |
| S5-02 | Pilot live Mon 21 Dec (one team, 3–5 exclusive clients, D28)                                                          | Q-31       | —    |
| S5-03 | Capacity 4–6 weeks out (holiday- and leave-aware)                                                                     | Q-17       | 2    |
| S5-04 | Daily digest (leads) 07:45, weekly digest (directors)                                                                 | Q-22       | 1.5  |
| S5-05 | Billing-ledger import with Finance mapping queue                                                                      | Q-25, Q-26 | 3    |
| S5-06 | Reporting: giveaway ledger + CEO drill-down, fees vs billings apart, float with aging, one number per role (D10, D11) | Q-23–Q-26  | 5    |

## S6 · W11–12 (28 Dec – 10 Jan) · Pilot and cutover — no new features

Pen-test fixes + retest · DR3 on a prod clone · train-the-trainer (Mon 28 Dec) · **MCP pilot walkthrough (Tue 5 Jan,
recorded) + set-up guide (Q-30)** · pilot go/no-go (Wed 6 Jan) · cutover Sat 9 – Sun 10 Jan.

## S7–S8 · W13–16 (11 Jan – 6 Feb) · Hypercare ("first month supported", Q-31)

All teams live Mon 11 Jan · daily triage · M3 Fri 15 Jan · MCP walkthrough for power users · restore test #2 ·
first monthly bypass review (Mon 1 Feb) · CEO validates January numbers · handover · M4 Fri 5 Feb.
Reserve W17–18 only if triggered at SG1/SG2.
