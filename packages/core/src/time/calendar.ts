// Per-user working calendar: working days (users.working_days, D15) minus holidays minus approved leave.
// Spec: specs/time/leave-holidays.md (TIM-LV-07). Used by the timesheet pre-fill; exported for capacity (S5).
import type { Kysely } from "kysely";
import type { DB } from "@demoq/db";
import { addDays } from "../kernel";

type Q = Kysely<DB>;

/** ISO weekday of a YYYY-MM-DD date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: string): number {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** Monday of the ISO week containing `date` (D-TM-3: weeks run Monday–Sunday). */
export const weekStartOf = (date: string): string => addDays(date, 1 - isoWeekday(date));

export const weekDates = (weekStart: string): string[] => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));

/** Midnight at the start of a business date in Phnom Penh (UTC+7, no DST). */
export const phnomPenhMidnight = (date: string): Date => new Date(`${date}T00:00:00+07:00`);

export interface CalendarDay {
  date: string;
  weekday: number;
  /** In the user's working_days (D15). */
  scheduled: boolean;
  holiday: { nameEn: string; nameKm: string; verified: boolean } | null;
  leave: { id: string; leaveType: string; halfDay: "am" | "pm" | null } | null;
  /** scheduled, not a holiday and not a full day of approved leave. */
  workingDay: boolean;
  /** Capacity in minutes for a working day (weekly capacity / scheduled days; halved on a half day of leave). */
  capacityMinutes: number;
}

export interface CalendarUser {
  id: string;
  working_days: number[];
  weekly_capacity_minutes: number;
}

export async function loadCalendarUser(db: Q, userId: string): Promise<CalendarUser | undefined> {
  return db
    .selectFrom("users")
    .select(["id", "working_days", "weekly_capacity_minutes"])
    .where("id", "=", userId)
    .executeTakeFirst();
}

/** Daily capacity: the weekly capacity spread over the user's scheduled days. */
export const dailyCapacity = (u: CalendarUser): number =>
  u.working_days.length ? Math.round(u.weekly_capacity_minutes / u.working_days.length) : 0;

/** TIM-LV-07: the user's days from `from` to `to` inclusive, with holidays and approved leave. */
export async function workingCalendar(db: Q, u: CalendarUser, from: string, to: string): Promise<CalendarDay[]> {
  const holidays = await db
    .selectFrom("holidays")
    .select(["holiday_date", "name_en", "name_km", "verified"])
    .where("holiday_date", ">=", from)
    .where("holiday_date", "<=", to)
    .execute();
  const byDate = new Map(holidays.map((h) => [h.holiday_date, h]));
  const leave = await db
    .selectFrom("leave_requests")
    .select(["id", "leave_type", "start_date", "end_date", "half_day"])
    .where("user_id", "=", u.id)
    .where("status", "=", "approved")
    .where("start_date", "<=", to)
    .where("end_date", ">=", from)
    .execute();
  const capacity = dailyCapacity(u);
  const out: CalendarDay[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const weekday = isoWeekday(d);
    const scheduled = u.working_days.includes(weekday);
    const h = byDate.get(d);
    const l = leave.find((x) => x.start_date <= d && x.end_date >= d);
    const halfDay = (l?.half_day ?? null) as "am" | "pm" | null;
    const workingDay = scheduled && !h && (!l || halfDay !== null);
    out.push({
      date: d,
      weekday,
      scheduled,
      holiday: h ? { nameEn: h.name_en, nameKm: h.name_km, verified: h.verified } : null,
      leave: l ? { id: l.id, leaveType: l.leave_type, halfDay } : null,
      workingDay,
      capacityMinutes: workingDay ? (halfDay ? Math.round(capacity / 2) : capacity) : 0,
    });
  }
  return out;
}

/** Working days (dates) of a user between two dates: working_days − holidays − full days of approved leave. */
export async function workingDays(db: Q, userId: string, from: string, to: string): Promise<string[]> {
  const u = await loadCalendarUser(db, userId);
  if (!u) return [];
  return (await workingCalendar(db, u, from, to)).filter((d) => d.workingDay).map((d) => d.date);
}
