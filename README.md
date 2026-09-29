# DemoQ PSA

The agency operations system for DemoQ (Phnom Penh). It covers pipeline → quote with live margin → scope →
gated projects → tasks and revisions → time → one approval inbox (web + Telegram) → one number per role, plus an MCP
server so staff can use it from Claude. It works in English and Khmer, and in USD and KHR.

- **The contract:** [`docs/scope.md`](docs/scope.md) (quotation, clause IDs Q-01…Q-31)
- **The plan:** [`docs/plan/DemoQ-PSA-Build-Plan.md`](docs/plan/DemoQ-PSA-Build-Plan.md)
- **Where we are:** [`docs/scope-trace.md`](docs/scope-trace.md) · [`docs/backlog.md`](docs/backlog.md) · [`docs/decision-log.md`](docs/decision-log.md)
- **How we build with Claude Code:** [`CLAUDE.md`](CLAUDE.md), `.claude/` (hooks, skills, reviewer subagents)

## Status: Sprint 4 built (stacked branch), Sprints 2–3 in review, Sprint 1 foundations done

|             |                                                                                                                                                                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kernel      | One command pipeline for every channel: validate → transaction → authorize (own/team/assigned) → run → audit → outbox                                                                                                                                                     |
| Audit       | Append-only at the DB level (grants + trigger); every command and denial is recorded by name and channel; MCP reads are audited too                                                                                                                                       |
| Identity    | argon2id, server-side sessions, lockout, TOTP for ceo/director/ops_lead/finance/admin (replay-safe)                                                                                                                                                                       |
| CRM         | Clients and contacts (EN/KM search), and the pipeline with a **required close reason**, enforced in TypeScript and Postgres                                                                                                                                               |
| Web         | PWA with login, TOTP, pipeline Kanban (drag or stage menu on phones), clients, admin; EN ⇄ ខ្មែរ                                                                                                                                                                          |
| Quotes      | Quote builder with live fee margin and pass-through markup (one pricing function in browser and server), margin floor → Finance/Ops approval, send freezes FX and locks, revise                                                                                           |
| Approvals   | One approval engine and inbox (web + Telegram): permission-aware routing, escalation, single winner, step-up for far-below-floor approvals                                                                                                                                |
| Channels    | Telegram bot (link, /inbox, single-use buttons, two taps for margin approvals); MCP server for Claude Code/Cowork with personal access tokens; outbox worker                                                                                                              |
| Projects    | Accepting a quote wins the deal, freezes the scope (insert-only) and opens a gated project with five gates; **no work before the gates** (app + DB), named and reviewed bypasses; additive change orders with their own margin floor; retainer months                     |
| Tasks       | One owner, estimate and due date; dependencies without cycles; templates per project type; Kanban per project and per person; out-of-scope work needs approval                                                                                                            |
| Delivery    | Internal QC by a non-owner before anything is marked sent; client revision rounds 1–3, round 4 only after an out-of-scope "absorb" (Absorb / Change order / Reject, also on Telegram), round 5 refused; over-quantity tasks need approval                                 |
| Time        | Clock in/out on phone, desktop and Telegram (`/in`, `/out`), auto-close at 23:59 or 12 h; allocations with the work gates; a pre-filled week confirmed in one tap (web and `/week`) that locks; holidays 2026–27 (unverified) and leave                                   |
| Influencers | Roster and assignments; expiring 256-bit links with a public EN/KM page (no account); submissions stay pending until DemoQ approves; posts beyond the contract need an out-of-scope decision                                                                              |
| MCP login   | OAuth 2.1 for Claude Code (client metadata documents) and Cowork (pre-registered client), PKCE, audience-bound tokens, TOTP at login; writes behind the `mcp.writes` switch (off by default); approvals over MCP in two steps, high-risk kinds decided in the app         |
| Quality     | 319 unit/DB/API tests + 49 Playwright E2E. 225 spec rules, each cited by a test. Independent reviews of S1 (12 findings), S2 (15), S3 (8) and S4 (15); all fixed with regression tests. The permission matrix is checked against the signed CSV; weekly ZAP baseline scan |

## Run it locally

Needs Node 22+, pnpm 10 and PostgreSQL 16.

```bash
pnpm install
sudo -u postgres bash scripts/db-setup.sh      # roles demoq_migrator + demoq_app, db demoq_dev, extensions
cp .env.example .env                           # then set TOTP_ENC_KEY=$(openssl rand -base64 32)
pnpm db:migrate && pnpm seed                   # synthetic demo data; password for all: demoq-demo-2026
pnpm dev:api                                   # http://localhost:3000
pnpm dev:web                                   # http://localhost:5173 (proxies /api)
```

Demo accounts: `sokha@demoq.test` (account lead, no TOTP), `ops@demoq.test` (ops lead: you will be asked to set
up TOTP), `bopha@demoq.test` (staff), `admin@demoq.test`.

## Checks

```bash
pnpm check        # typecheck · ESLint + boundary rules · permission matrix · spec→test trace · all tests
pnpm test:e2e     # Playwright (in cloud sessions: PW_CHROMIUM=/opt/pw-browsers/chromium)
```

## Layout

```
apps/api        Fastify: /api/v1/auth/*, /api/v1/ops/<name> (generated from the core registry)
apps/web        React PWA
packages/core   the service layer: kernel/, identity/, crm/, commercial/, approvals/, projects/, tasks/, reporting/ — the only package that touches the DB
packages/shared money, zod contracts, i18n (pure; runs in the browser too)
packages/db     migrations, runner (migrator role, advisory lock, checksums), generated Kysely types
packages/testkit template-cloned test DBs, factories, synthetic seed
specs/          one spec per feature, rules with IDs cited by tests
docs/           scope, plan, backlog, decisions, ADRs, permission matrix (signed CSV)
```
