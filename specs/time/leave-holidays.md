# time/holidays-leave — Cambodian public holidays and leave

**Status:** signed with defaults (D15, D-HD-1, D-LV-1) · **Sprint:** S4 · **Quotation refs:** Q-18 · **Invariants:** INV-18

## Why

Capacity, the timesheet pre-fill and approval routing all need to know who is not working on a given day: Cambodian
public holidays (set each year by sub-decree) and approved leave. Leave is requested in the app and approved by an
eligible manager through the one approval inbox (web or Telegram).

## Rules

| ID        | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Error code                   |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| TIM-LV-01 | D-HD-1: public holidays for 2026 and 2027 are seeded with EN and KM names and a source, all `verified = false` until admin checks them against the official sub-decree. Everyone (`user.directory`) lists them by year.                                                                                                                                                                                                                                                                                                    | —                            |
| TIM-LV-02 | Only admin (`admin.config`) adds, edits, verifies (records who and when) and removes holidays; edits need `expectedVersion`.                                                                                                                                                                                                                                                                                                                                                                                               | `FORBIDDEN`, `STALE_VERSION` |
| TIM-LV-03 | `leave.request` (`leave.request_own`, for oneself) records a request (type, dates, optional half day am/pm, reason) and creates a `leave` approval (`leave.approve`; scope = the requester's team, so their team lead, any ops_lead or director can decide; chain team_lead → ops_lead → director). Approve/reject sets the request's status in the same transaction. DB backstop: a request becomes approved only with its approved `leave` approval decided by the same person; its person, type and dates never change. | `SELF_APPROVAL`, `FORBIDDEN` |
| TIM-LV-04 | No two requested/approved leave requests of one person overlap (DB `EXCLUDE USING gist` on the date range).                                                                                                                                                                                                                                                                                                                                                                                                                | `LEAVE_OVERLAP`              |
| TIM-LV-05 | I cancel my own leave while it is requested (its pending approval is cancelled) or approved and not yet started.                                                                                                                                                                                                                                                                                                                                                                                                           | `INVALID_TRANSITION`         |
| TIM-LV-06 | INV-18: approval routing and escalation skip candidates who are on approved leave that day (business date in Phnom Penh); the next eligible holder gets it, else the fallback / no-eligible path.                                                                                                                                                                                                                                                                                                                          | —                            |
| TIM-LV-07 | Working-day helper (`workingCalendar`, `workingDays`; query `time.calendar` for my own days, ≤ 92 days): a day is a working day when it is in my `working_days`, not a holiday and not a full day of approved leave; a half day of leave halves the day's capacity. The timesheet pre-fill uses it; capacity (S5) will too.                                                                                                                                                                                                | `VALIDATION`                 |
| TIM-LV-08 | D-LV-1: leave types seeded — annual, sick, special, maternity (no half days), unpaid (not paid); whole days or a half day; no balances or accrual in v1 (Finance/HR keep balances).                                                                                                                                                                                                                                                                                                                                        | `VALIDATION`                 |

## Commands and queries

| Name             | Permission          | exposeTo | Risk   | Audit subject |
| ---------------- | ------------------- | -------- | ------ | ------------- |
| `leave.request`  | `leave.request_own` | web      | normal | leave_request |
| `leave.cancel`   | `leave.request_own` | web      | normal | leave_request |
| `leave.mine`     | `leave.request_own` | web, mcp | query  | —             |
| `leave.types`    | `user.directory`    | web, mcp | query  | —             |
| `holiday.list`   | `user.directory`    | web, mcp | query  | —             |
| `holiday.upsert` | `admin.config`      | web      | normal | —             |
| `holiday.remove` | `admin.config`      | web      | normal | —             |
| `time.calendar`  | `time.allocate_own` | web, mcp | query  | —             |

Decisions use `approval.decide` (web, Telegram one tap, MCP per the `leave` policy).

## Permission matrix delta

None.

## Data

- `holidays(holiday_date unique, name_en, name_km, source, verified, verified_by, verified_at, version)`; app role may
  DELETE (admin removal, audited by the row trigger).
- `leave_types(code, label_en, label_km, paid, half_day_allowed, active, position)`.
- `leave_requests(user_id, leave_type, start_date, end_date, half_day, reason, status, approval_id, decided_by,
decided_at, cancelled_at, version)`; CHECKs on dates, half days, decision fields; EXCLUDE on overlap; trigger
  `leave_requests_guard`.

### Holiday seed sources (D-HD-1)

- **2026** — Sub-Decree No. 167 of 18 Sep 2025 on public holidays for 2026 (21 days), transcribed from its public
  summaries (Agence Kampuchea Presse, akp.gov.kh/post/detail/347356; the Cambodian embassy in Berlin; the National Bank
  of Cambodia holiday page). The official PDF was not reachable from the build environment. Secondary sources disagree
  on the Water Festival (23–25 vs 24–26 Nov); the sub-decree summaries give 23–25 Nov.
- **2027** — no sub-decree was published at build time. Fixed-date holidays repeat 2026; lunar ones (Visak Bochea
  20 May, Royal Ploughing 24 May, Pchum Ben 29 Sep–1 Oct, Water Festival 12–14 Nov) are estimates.
- **Admin must verify every row against the official sub-decree before go-live** and load the 2027 sub-decree when it
  is published (job `holidays.next_year_reminder`, S5).

## Events (outbox)

`leave.requested`, `leave.approved`, `leave.rejected`, `leave.cancelled`.

## UI

Leave form (type, dates, half day, reason) with "My leave"; holiday calendar (unverified badge); admin holiday editor.

## Edge cases

- A half day in the morning and another in the afternoon of the same day overlap (request a full day instead).
- Leave in the past can be requested (e.g. sick leave) and approved; it does not change a confirmed timesheet.
- The fallback approver of a kind is used as configured even if on leave (last resort; plan §5.4).

## Open questions

- Should a half-day of leave also exclude an approver from routing? Default: yes — any approved leave that day.
- Leave balances: out of scope in v1 (D-LV-1).
