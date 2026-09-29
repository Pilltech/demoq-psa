// Attendance: clock in/out for oneself on web and Telegram; no gate check (INV-11, D14).
// Spec: specs/time/attendance.md (TIM-AT-*)
import { z } from "zod";
import { expectedVersion, requiredText, uuid } from "@demoq/shared";
import {
  addDays,
  assertVersion,
  businessDate,
  defineCommand,
  defineQuery,
  DomainError,
  notFoundIfMissing,
  type Channel,
  type Ctx,
} from "../kernel";
import { phnomPenhMidnight, weekStartOf } from "./calendar";

export const SESSION_CAP_MS = 12 * 3600_000;
const instant = z
  .string()
  .datetime({ offset: true })
  .transform((s) => new Date(s));

/** The acting user's id; attendance and timesheets are always one's own. */
export function selfId(ctx: Ctx): string {
  if (ctx.actor.type !== "user") throw new DomainError("FORBIDDEN", { reason: "people_only" });
  return ctx.actor.id;
}
export const ownScope = (_l: unknown, _i: unknown, ctx: Ctx) => ({
  ownerIds: [ctx.actor.type === "user" ? ctx.actor.id : null],
});

/**
 * TIM-AT-05 (D14): an open session closes at 23:59 Phnom Penh time on the day it started, or 12 h after it started,
 * whichever comes first.
 */
export function autoCloseAt(startedAt: Date): Date {
  const day = businessDate(startedAt);
  let cap = new Date(`${day}T23:59:00+07:00`);
  if (cap <= startedAt) cap = new Date(`${addDays(day, 1)}T23:59:00+07:00`);
  const twelve = new Date(startedAt.getTime() + SESSION_CAP_MS);
  return cap < twelve ? cap : twelve;
}

export interface SessionRow {
  id: string;
  started_at: Date;
  ended_at: Date | null;
  channel: string;
  auto_closed: boolean;
  flagged: boolean;
  flag_reason: string | null;
  version: number;
}

export const sessionMinutes = (s: Pick<SessionRow, "started_at" | "ended_at">, now: Date): number =>
  Math.max(0, Math.floor(((s.ended_at ?? now).getTime() - s.started_at.getTime()) / 60_000));

/** Sessions that started on business dates from..to (inclusive). */
export async function sessionsBetween(ctx: Ctx, userId: string, from: string, to: string): Promise<SessionRow[]> {
  return ctx.tx
    .selectFrom("attendance_sessions")
    .select(["id", "started_at", "ended_at", "channel", "auto_closed", "flagged", "flag_reason", "version"])
    .where("user_id", "=", userId)
    .where("started_at", ">=", phnomPenhMidnight(from))
    .where("started_at", "<", phnomPenhMidnight(addDays(to, 1)))
    .orderBy("started_at")
    .execute();
}

/** Attended minutes per business date (a session counts on the day it started; a running one up to now). */
export function minutesByDate(sessions: readonly SessionRow[], now: Date): Map<string, number> {
  const out = new Map<string, number>();
  for (const s of sessions) {
    const d = businessDate(s.started_at);
    out.set(d, (out.get(d) ?? 0) + sessionMinutes(s, now));
  }
  return out;
}

const sessionDto = (s: SessionRow, now: Date) => ({
  id: s.id,
  startedAt: s.started_at,
  endedAt: s.ended_at,
  minutes: sessionMinutes(s, now),
  channel: s.channel,
  autoClosed: s.auto_closed,
  flagged: s.flagged,
  flagReason: s.flag_reason,
  version: s.version,
});

/**
 * TIM-AT-07 / INV-12: lock the week (the same row lock `timesheet.confirm` takes first) and refuse a confirmed one, so
 * a correction and a confirmation of the same week never interleave.
 */
async function assertWeekOpen(ctx: Ctx, userId: string, date: string) {
  const w = await lockWeek(ctx, userId, weekStartOf(date));
  if (w.status === "confirmed") throw new DomainError("TIMESHEET_CONFIRMED", { weekStart: w.week_start });
}

/** Create-if-missing and lock the user's week row (all allocation writes serialise on it). */
export async function lockWeek(ctx: Ctx, userId: string, weekStart: string) {
  await ctx.tx
    .insertInto("timesheet_weeks")
    .values({ user_id: userId, week_start: weekStart })
    .onConflict((oc) => oc.columns(["user_id", "week_start"]).doNothing())
    .execute();
  return ctx.tx
    .selectFrom("timesheet_weeks")
    .selectAll()
    .where("user_id", "=", userId)
    .where("week_start", "=", weekStart)
    .forUpdate()
    .executeTakeFirstOrThrow();
}

export const attendanceClockIn = defineCommand({
  name: "attendance.clock_in",
  summary: "Clock in (start an attendance session now)",
  permission: "attendance.clock_own",
  input: z.object({}).default({}),
  exposeTo: ["web", "telegram"],
  scope: ownScope,
  async run(ctx) {
    const me = selfId(ctx);
    // TIM-AT-02: one open session per user (partial unique index backstop).
    const open = await ctx.tx
      .selectFrom("attendance_sessions")
      .select(["id", "started_at"])
      .where("user_id", "=", me)
      .where("ended_at", "is", null)
      .executeTakeFirst();
    if (open) throw new DomainError("CLOCK_RUNNING", { sessionId: open.id, startedAt: open.started_at });
    // TIM-AT-03: never overlapping an earlier session (EXCLUDE backstop).
    const later = await ctx.tx
      .selectFrom("attendance_sessions")
      .select("id")
      .where("user_id", "=", me)
      .where("ended_at", ">", ctx.now)
      .executeTakeFirst();
    if (later) throw new DomainError("TIME_OVERLAP", { sessionId: later.id });
    const s = await ctx.tx
      .insertInto("attendance_sessions")
      .values({ user_id: me, started_at: ctx.now, channel: ctx.channel as Channel })
      .returning(["id", "started_at", "channel"])
      .executeTakeFirstOrThrow();
    ctx.emit("attendance.clocked_in", { userId: me, sessionId: s.id });
    return { id: s.id, startedAt: s.started_at, channel: s.channel };
  },
  subject: (_i, r) => ({ type: "attendance_session", id: r.id }),
});

export const attendanceClockOut = defineCommand({
  name: "attendance.clock_out",
  summary: "Clock out (close my running attendance session)",
  permission: "attendance.clock_own",
  input: z.object({}).default({}),
  exposeTo: ["web", "telegram"],
  scope: ownScope,
  async run(ctx) {
    const me = selfId(ctx);
    const s = await ctx.tx
      .selectFrom("attendance_sessions")
      .select(["id", "started_at"])
      .where("user_id", "=", me)
      .where("ended_at", "is", null)
      .forUpdate()
      .executeTakeFirst();
    if (!s) throw new DomainError("CLOCK_NOT_RUNNING");
    // A session past its auto-close time (the job has not run yet) closes at that time, flagged (TIM-AT-05).
    const cutoff = autoCloseAt(s.started_at);
    const capped = ctx.now > cutoff;
    const end = capped ? cutoff : ctx.now;
    if (end.getTime() - s.started_at.getTime() < 60_000)
      throw new DomainError("VALIDATION", { reason: "session_too_short", minMinutes: 1 });
    const r = await ctx.tx
      .updateTable("attendance_sessions")
      .set((eb) => ({
        ended_at: end,
        end_channel: ctx.channel as Channel,
        auto_closed: capped,
        flagged: capped,
        flag_reason: capped ? "auto_closed" : null,
        version: eb("version", "+", 1),
      }))
      .where("id", "=", s.id)
      .returning(["id", "started_at", "ended_at", "auto_closed"])
      .executeTakeFirstOrThrow();
    ctx.emit("attendance.clocked_out", { userId: me, sessionId: s.id });
    return {
      id: r.id,
      startedAt: r.started_at,
      endedAt: r.ended_at!,
      minutes: sessionMinutes(r, ctx.now),
      autoClosed: r.auto_closed,
    };
  },
  subject: (_i, r) => ({ type: "attendance_session", id: r.id }),
});

/** TIM-AT-07: correct one of my closed sessions before its week is confirmed; the session is flagged. */
export const attendanceCorrect = defineCommand({
  name: "attendance.correct",
  summary: "Correct the start and end of one of my attendance sessions (flagged for my lead)",
  permission: "attendance.clock_own",
  input: z.object({
    id: uuid,
    expectedVersion,
    startedAt: instant,
    endedAt: instant,
    reason: requiredText(500),
  }),
  exposeTo: ["web"],
  async load(ctx, i) {
    return notFoundIfMissing(
      await ctx.tx
        .selectFrom("attendance_sessions")
        .select(["id", "user_id", "started_at", "ended_at", "version"])
        .where("id", "=", i.id)
        .forUpdate()
        .executeTakeFirst(),
    );
  },
  scope: (s) => ({ ownerIds: [s.user_id] }),
  async run(ctx, i, s) {
    if (ctx.actor.type !== "user" || ctx.actor.id !== s.user_id) throw new DomainError("FORBIDDEN", { reason: "not_own" });
    assertVersion(s.version, i.expectedVersion);
    if (!s.ended_at) throw new DomainError("CLOCK_RUNNING", { reason: "clock_out_first" });
    if (i.reason.length < 3)
      throw new DomainError("VALIDATION", { issues: [{ path: "reason", message: "At least 3 characters" }] });
    const day = businessDate(s.started_at);
    if (businessDate(i.startedAt) !== day)
      throw new DomainError("VALIDATION", { issues: [{ path: "startedAt", message: "Stay on the same day" }] });
    if (i.endedAt <= i.startedAt || i.endedAt > ctx.now)
      throw new DomainError("VALIDATION", { issues: [{ path: "endedAt", message: "After the start, not in the future" }] });
    // D14: the same business day, and no longer than the 12 h cap (DB CHECKs attendance_sessions_cap / _same_day).
    if (i.endedAt > autoCloseAt(i.startedAt) || businessDate(i.endedAt) !== day)
      throw new DomainError("VALIDATION", {
        issues: [{ path: "endedAt", message: "On the same day, at most 12 hours after the start" }],
      });
    await assertWeekOpen(ctx, s.user_id, day);
    const r = await ctx.tx
      .updateTable("attendance_sessions")
      .set((eb) => ({
        started_at: i.startedAt,
        ended_at: i.endedAt,
        flagged: true,
        flag_reason: "corrected",
        correction_reason: i.reason,
        version: eb("version", "+", 1),
      }))
      .where("id", "=", s.id)
      .returning(["id", "started_at", "ended_at", "channel", "auto_closed", "flagged", "flag_reason", "version"])
      .executeTakeFirstOrThrow();
    return sessionDto(r, ctx.now);
  },
  subject: (i) => ({ type: "attendance_session", id: i.id }),
});

/** TIM-AT-06: am I clocked in, and my totals today and this week. */
export const attendanceStatus = defineQuery({
  name: "attendance.status",
  summary: "My attendance now: running session, today's and this week's totals",
  permission: "attendance.clock_own",
  input: z.object({}).default({}),
  exposeTo: ["web", "telegram", "mcp"],
  scope: ownScope,
  async run(ctx) {
    const me = selfId(ctx);
    const today = businessDate(ctx.now);
    const weekStart = weekStartOf(today);
    const sessions = await sessionsBetween(ctx, me, weekStart, addDays(weekStart, 6));
    const byDate = minutesByDate(sessions, ctx.now);
    const running = await ctx.tx
      .selectFrom("attendance_sessions")
      .select(["id", "started_at", "ended_at", "channel", "auto_closed", "flagged", "flag_reason", "version"])
      .where("user_id", "=", me)
      .where("ended_at", "is", null)
      .executeTakeFirst();
    return {
      today,
      weekStart,
      running: running ? { ...sessionDto(running, ctx.now), autoCloseAt: autoCloseAt(running.started_at) } : null,
      todayMinutes: byDate.get(today) ?? 0,
      weekMinutes: [...byDate.values()].reduce((a, b) => a + b, 0),
      flaggedThisWeek: sessions.filter((s) => s.flagged).length,
      sessionsToday: sessions.filter((s) => businessDate(s.started_at) === today).map((s) => sessionDto(s, ctx.now)),
    };
  },
});

/** TIM-AT-05: close and flag sessions past 23:59 or 12 h. Jobs only; SKIP LOCKED makes concurrent runs safe. */
export const attendanceAutoclose = defineCommand({
  name: "attendance.autoclose",
  summary: "Close and flag attendance sessions left open past 23:59 or 12 hours",
  permission: "time.jobs",
  input: z.object({}).default({}),
  exposeTo: ["job"],
  async run(ctx) {
    const open = await ctx.tx
      .selectFrom("attendance_sessions")
      .select(["id", "user_id", "started_at"])
      .where("ended_at", "is", null)
      .where("started_at", "<=", ctx.now)
      .orderBy("started_at")
      .limit(500)
      .forUpdate()
      .skipLocked()
      .execute();
    let closed = 0;
    for (const s of open) {
      const cutoff = autoCloseAt(s.started_at);
      if (cutoff > ctx.now) continue;
      await ctx.tx
        .updateTable("attendance_sessions")
        .set((eb) => ({
          ended_at: cutoff,
          end_channel: "job",
          auto_closed: true,
          flagged: true,
          flag_reason: "auto_closed",
          version: eb("version", "+", 1),
        }))
        .where("id", "=", s.id)
        .where("ended_at", "is", null)
        .execute();
      ctx.emit("attendance.auto_closed", { userId: s.user_id, sessionId: s.id, endedAt: cutoff.toISOString() });
      closed++;
    }
    return { checked: open.length, closed };
  },
});
