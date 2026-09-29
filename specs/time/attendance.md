# time/attendance — clock in and out on phone and desktop

**Status:** signed with defaults (D14, D15) · **Sprint:** S4 · **Quotation refs:** Q-14 · **Invariants:** INV-11, INV-12

## Why

Staff record when they work, from the phone (Telegram) or the desktop, so the weekly timesheet can be pre-filled from
real attendance and leads can see who worked when. Attendance is not work on a client project, so it never needs the
project gates.

## Rules

| ID        | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Error code                           |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| TIM-AT-01 | Anyone who works (`attendance.clock_own`, every role but viewer) clocks in and out for themselves only, on web and Telegram. There is no gate check. Each clock-in/out is audited with its channel; MCP cannot clock.                                                                                                                                                                                                                                                                                                                                                                                          | `FORBIDDEN`                          |
| TIM-AT-02 | One open session per person: clocking in while one is open → `CLOCK_RUNNING`; clocking out with none → `CLOCK_NOT_RUNNING`. DB backstop: partial unique index `attendance_sessions_one_open` on `(user_id) WHERE ended_at IS NULL`.                                                                                                                                                                                                                                                                                                                                                                            | `CLOCK_RUNNING`, `CLOCK_NOT_RUNNING` |
| TIM-AT-03 | A person's sessions never overlap (touching is fine). DB backstop: `EXCLUDE USING gist (user_id WITH =, tstzrange(started_at, ended_at, '[)') WITH &&)` (an open session reaches to infinity).                                                                                                                                                                                                                                                                                                                                                                                                                 | `TIME_OVERLAP`                       |
| TIM-AT-04 | Telegram `/in` and `/out` run the same commands on the `telegram` channel and reply with the session time (and the duration on `/out`), in the user's language.                                                                                                                                                                                                                                                                                                                                                                                                                                                | as TIM-AT-02/03                      |
| TIM-AT-05 | D14: an open session is closed at 23:59 Asia/Phnom_Penh on the day it started, or 12 h after it started, whichever is first, and flagged (`auto_closed`, `flag_reason = auto_closed`) for the weekly confirmation. The job `attendance.autoclose` runs as `job:time` (grant `time.jobs` only), is idempotent (SKIP LOCKED), and ends the session at the cutoff, not at the job's run time. A clock-out after the cutoff (job not yet run) also ends at the cutoff, flagged.                                                                                                                                    | `FORBIDDEN` (no grant)               |
| TIM-AT-06 | `attendance.status` shows my running session (with its auto-close time), today's and this week's attended minutes and today's sessions. A session counts on the business date it started; a running one counts up to now.                                                                                                                                                                                                                                                                                                                                                                                      | —                                    |
| TIM-AT-07 | I may correct one of my own closed sessions (start and end on the same business date, at most 12 h long (D14), end not in the future, a reason of ≥ 3 characters, `expectedVersion`) until its week is confirmed. The correction takes the week's row lock (the one `timesheet.confirm` takes) before checking the week, so a correction and a confirmation never interleave. DB CHECKs `attendance_sessions_cap` (no session over 12 h) and `attendance_sessions_corrected_same_day`. The corrected session is flagged (`flag_reason = corrected`) so my lead sees it; the old times stay in `audit_changes`. | `TIMESHEET_CONFIRMED`, `VALIDATION`  |

## Commands and queries

| Name                   | Permission             | exposeTo           | Risk   | Audit subject         |
| ---------------------- | ---------------------- | ------------------ | ------ | --------------------- |
| `attendance.clock_in`  | `attendance.clock_own` | web, telegram      | normal | attendance_session    |
| `attendance.clock_out` | `attendance.clock_own` | web, telegram      | normal | attendance_session    |
| `attendance.correct`   | `attendance.clock_own` | web                | normal | attendance_session    |
| `attendance.status`    | `attendance.clock_own` | web, telegram, mcp | query  | — (MCP reads audited) |
| `attendance.autoclose` | `time.jobs`            | job                | normal | —                     |

## Permission matrix delta

None (all keys were added with the S4 defaults).

## Data

`attendance_sessions(user_id, started_at, ended_at, channel, end_channel, auto_closed, flagged, flag_reason,
correction_reason, version)` — CHECKs: end after start, at most 24 h, at most 12 h (`attendance_sessions_cap`,
migration `20261130_0018`), auto-closed ⇒ closed and flagged, a correction carries a reason and ends on the business
date it started (`attendance_sessions_corrected_same_day`). Backstops as above, plus the INV-12 lock (see `time/timesheets`, TIM-TS-06). No DELETE for the app role.

## Events (outbox)

`attendance.clocked_in`, `attendance.clocked_out`, `attendance.auto_closed` (no delivery handler yet).

## UI

A clock button with the running time, today's and this week's totals; flagged sessions highlighted in the week view.
Telegram strings (EN + KM draft) live in `apps/api/src/adapters/telegram/time.ts`.

## Edge cases

- Clock-out less than a minute after clock-in → `VALIDATION` (a zero-length session is not attendance).
- A session started after 23:59 (e.g. 23:59:30) runs until 12 h later at most.
- Clock-in with a closed session that ends in the future (a correction) → `TIME_OVERLAP`.

## Open questions

- Should leads be able to correct someone else's session? Default: no — the person corrects their own (flagged) or the
  lead reopens the week.
