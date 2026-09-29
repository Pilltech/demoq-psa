# time/timesheets — allocations and the weekly confirmation, pre-filled, under two minutes

**Status:** signed with defaults (D-TM-1, D-TM-2, D-TM-3, D15) · **Sprint:** S4 · **Quotation refs:** Q-15 · **Invariants:** INV-06, INV-12

## Why

DemoQ needs to know where time goes (client work, pitches, internal) without a weekly timesheet chore. The system
pre-fills each person's week from attendance and last week's pattern; the person confirms in one tap (web or Telegram),
or edits a few cells first. A confirmed week is locked.

## Rules

| ID        | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Error code                        |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| TIM-TS-01 | D-TM-1: an allocation is minutes > 0 per (user, day, target); a target is a task, a project, a deal, or an internal activity code (seeded: admin, internal_meeting, training, pitch, recruitment, leave_admin; admin edits them with `admin.config`, everyone lists them). `time.allocate` (MCP `time_allocate`, the plan's `log_time`) sets my minutes on one target and day; 0 removes the row; days in the future are refused. The row's source is `manual` (web), `mcp` or `telegram`.                                                                    | `VALIDATION`, `NOT_FOUND`         |
| TIM-TS-02 | A day's allocations never exceed 24 h (command and trigger `time_allocations_guard`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `VALIDATION`                      |
| TIM-TS-03 | INV-06: allocating to a task or project on a client project needs its gates (`assertWorkAllowed`, open bypasses count) on every channel; deal and internal targets never do. Trigger backstop on `time_allocations` for rows with a project.                                                                                                                                                                                                                                                                                                                  | `GATE_BLOCKED` (409)              |
| TIM-TS-04 | D-TM-2 pre-fill, per working day of the week (user's `working_days` − holidays − full days of approved leave): the day's attended minutes, else the daily capacity (`weekly_capacity_minutes / #working_days`, halved on a half day of leave), rounded to 15 min, minus what I already logged that day, is split across last week's confirmed targets in the same proportions (targets no longer workable are dropped), else evenly across my started, unfinished tasks on workable projects, else the `admin` code; in 15-minute slots by largest remainder. | —                                 |
| TIM-TS-05 | `timesheet.week` returns the week (Monday–Sunday, D-TM-3): days with attendance, capacity, holiday, leave and flags; targets × days; rows with their source and status; totals; the pre-fill basis; a hash of the draft. `timesheet.confirm` accepts the draft as-is (one tap) or the full list of rows with edits; rows equal to a draft row keep its source (`prefill` for pre-filled ones), others take the channel's source. A given `draftHash` that no longer matches → `STALE_VERSION`. Future weeks and non-Mondays are refused.                      | `STALE_VERSION`, `VALIDATION`     |
| TIM-TS-06 | INV-12: confirming locks the week. Triggers refuse any insert, update or delete of that week's allocations, and any change to attendance sessions that started before the confirmation (a session still running at confirmation may only be closed; sessions started after it are new attendance).                                                                                                                                                                                                                                                            | `TIMESHEET_CONFIRMED`             |
| TIM-TS-07 | `timesheet.reopen` needs `time.reopen` in scope (team lead of the person's team, ops_lead), a reason (≥ 3 characters; DB CHECK), and never on one's own week. The week's allocations return to draft; `first_confirmed_at` is kept; reopen count, who and why are recorded.                                                                                                                                                                                                                                                                                   | `FORBIDDEN`, `INVALID_TRANSITION` |
| TIM-TS-08 | `timesheet.team` (`time.view_team`): a team lead sees their team, ops_lead and director everyone: status, opened/confirmed times, attended and allocated minutes, flagged sessions, and the week's metrics.                                                                                                                                                                                                                                                                                                                                                   | `FORBIDDEN`                       |
| TIM-TS-09 | Telegram `/week` opens the week and sends the pre-filled summary with a one-tap Confirm: a `telegram_actions` row (`kind = timesheet_confirm`, payload = user, week, draft hash), single use, bound to the Telegram user, 24 h expiry, one live button per person and week. Pressing it runs `timesheet.confirm` with that hash on the `telegram` channel; a changed draft is refused and the card says so.                                                                                                                                                   | —                                 |
| TIM-TS-10 | Metrics (M2 #9–10): `opened_at` is the first time the person opened the pre-filled week (web or `/week`; not the reminder), `first_confirmed_at` the first confirmation; `prefill_minutes` and allocation sources give the share of confirmed minutes taken from the pre-fill unchanged. On fixture F-01 (5 people) that share is ≥ 90 % and the median confirmation time < 120 s.                                                                                                                                                                            | —                                 |
| TIM-TS-11 | `timesheet.remind` (job, `time.jobs`): from 14:00 on each person's last working day of the week (catching up later in the week), once per week (`reminded_at`), never for a confirmed week; the Telegram message is the week card with Confirm.                                                                                                                                                                                                                                                                                                               | —                                 |
| TIM-TS-12 | `timesheet.due_escalate` (job, `time.jobs`): from 12:00 on the person's first working day of the next week, an unconfirmed previous week (that had working days) is escalated once (`escalated_at`) to the team leads of their team, else their manager.                                                                                                                                                                                                                                                                                                      | —                                 |

## Commands and queries

| Name                     | Permission          | exposeTo           | Risk   | Audit subject   |
| ------------------------ | ------------------- | ------------------ | ------ | --------------- |
| `time.allocate`          | `time.allocate_own` | web, mcp           | normal | time_allocation |
| `timesheet.week`         | `time.allocate_own` | web, telegram, mcp | query  | —               |
| `timesheet.open`         | `time.allocate_own` | web, telegram      | normal | timesheet_week  |
| `timesheet.confirm`      | `time.allocate_own` | web, telegram      | normal | timesheet_week  |
| `timesheet.reopen`       | `time.reopen`       | web                | normal | timesheet_week  |
| `timesheet.team`         | `time.view_team`    | web, mcp           | query  | —               |
| `timesheet.remind`       | `time.jobs`         | job                | normal | —               |
| `timesheet.due_escalate` | `time.jobs`         | job                | normal | —               |
| `activity_code.list`     | `user.directory`    | web, mcp           | query  | —               |
| `activity_code.upsert`   | `admin.config`      | web                | normal | —               |

## Permission matrix delta

None.

## Data

- `activity_codes(code, label_en, label_km, active, position, version)`.
- `time_allocations(user_id, work_date, minutes, target_type, task_id, project_id, deal_id, activity_code, target_key
(generated), source, status, note, version)`; a task target also stores its project. Unique on (user, day, type,
  target). CHECK on the target shape. Triggers: `time_allocations_guard` (task ↔ project, day ≤ 24 h, INV-06 gates),
  `time_allocations_week_lock` (INV-12). The app role may DELETE (drafts are replaced at confirmation; the lock
  trigger refuses deletes in a confirmed week).
- `timesheet_weeks(user_id, week_start Monday, status open|confirmed, opened_at, reminded_at, escalated_at,
confirmed_at, first_confirmed_at, confirmed_channel, draft_hash, prefill_minutes, reopened_at, reopened_by,
reopen_reason, reopen_count, version)`, unique on (user, week).

## Events (outbox)

`timesheet.confirmed`, `timesheet.reopened`, `timesheet.reminder` (→ Telegram week card), `timesheet.overdue` (→
Telegram note to the lead).

## UI

Week grid (days × targets) from `timesheet.week`/`timesheet.open`: pre-filled cells marked, holiday/leave days greyed,
attendance per day, flagged sessions, one Confirm button (sends `draftHash`, and `rows` only when edited). Team view
from `timesheet.team`. Telegram strings (EN + KM draft) in `apps/api/src/adapters/telegram/time.ts`.

## Edge cases

- A day where I logged some time keeps my rows; only the remaining minutes are pre-filled, on targets I have not used
  that day (else `admin`).
- Stored rows on a project that has since become gated block confirmation with `GATE_BLOCKED` until changed.
- Confirming on the last working day while clocked in is allowed; the running session may still be closed.
- Once a person has touched a day (logged ≥ the day's base), that day has no pre-fill.

## Open questions

- Should "open tasks" for the fallback include not-yet-started tasks? Default: no — only started, unfinished tasks.
- Should confirming via MCP be allowed? Default: no (web and Telegram); MCP logs time and reads the week.
