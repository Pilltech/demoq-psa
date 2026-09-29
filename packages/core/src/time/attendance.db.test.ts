import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, makeUser, runAs, type TestDb } from "@demoq/testkit";
import { DomainError, type JobActor, type OpDef, type UserActor } from "../kernel";
import { attendanceAutoclose, attendanceClockIn, attendanceClockOut, attendanceCorrect, attendanceStatus } from "./attendance";
import { timesheetConfirm } from "./timesheets";

let t: TestDb;
let other: UserActor, viewer: UserActor;
const JOB: JobActor = { type: "job", name: "job:time", grants: ["time.jobs"] };

beforeAll(async () => {
  t = await createTestDb();
  other = await makeUser(t.db, { roles: ["staff"], name: "Other Staff" });
  viewer = await makeUser(t.db, { roles: ["viewer"] });
});
afterAll(() => t.destroy());

const run = <T>(a: UserActor | JobActor, op: OpDef, input: unknown, channel?: "web" | "mcp" | "telegram" | "job") =>
  runAs<T>(t, a, op, input, channel);
const expectCode = (p: Promise<unknown>, code: string) =>
  expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);
const pp = (date: string, hhmm: string) => `${date}T${hhmm}:00+07:00`;
type Clock = { id: string; startedAt: Date; endedAt: Date; minutes: number; autoClosed: boolean };

async function freshUser() {
  return makeUser(t.db, { roles: ["staff"] });
}

describe("time/attendance", () => {
  beforeEach(() => t.clock.set(pp("2026-10-19", "08:00")));

  it("[TIM-AT-01] I clock in and out for myself on web and Telegram, with no gate check; viewers and MCP cannot", async () => {
    const u = await freshUser();
    const a = await run<{ id: string; startedAt: Date; channel: string }>(u, attendanceClockIn, {});
    expect(a.startedAt.toISOString()).toBe("2026-10-19T01:00:00.000Z");
    expect(a.channel).toBe("web");
    t.clock.set(pp("2026-10-19", "12:00"));
    const b = await run<Clock>(u, attendanceClockOut, {});
    expect(b).toMatchObject({ id: a.id, minutes: 240, autoClosed: false });
    t.clock.set(pp("2026-10-19", "13:00"));
    const c = await run<{ channel: string }>(u, attendanceClockIn, {}, "telegram");
    expect(c.channel).toBe("telegram");
    await expectCode(run(viewer, attendanceClockIn, {}), "FORBIDDEN");
    await expectCode(run(other, attendanceClockIn, {}, "mcp"), "FORBIDDEN");
    const audit = await t.db
      .selectFrom("audit_events")
      .select(["action", "channel", "actor_id"])
      .where("subject_id", "=", a.id)
      .orderBy("id")
      .execute();
    expect(audit.map((x) => x.action)).toEqual(["attendance.clock_in", "attendance.clock_out"]);
    expect(audit.every((x) => x.actor_id === u.id)).toBe(true);
  });

  it("[TIM-AT-02] one open session per person (CLOCK_RUNNING / CLOCK_NOT_RUNNING); the DB refuses a second open one", async () => {
    const u = await freshUser();
    await expectCode(run(u, attendanceClockOut, {}), "CLOCK_NOT_RUNNING");
    await run(u, attendanceClockIn, {});
    t.clock.advance(60_000);
    await expectCode(run(u, attendanceClockIn, {}, "telegram"), "CLOCK_RUNNING");
    // Backstop as the app role
    await expect(
      t.db
        .insertInto("attendance_sessions")
        .values({ user_id: u.id, started_at: new Date(pp("2026-10-20", "08:00")), channel: "web" })
        .execute(),
    ).rejects.toThrow(/attendance_sessions_one_open|attendance_sessions_no_overlap/);
    // Someone else can clock in at the same time.
    await run(other, attendanceClockIn, {});
    t.clock.advance(3600_000);
    await run(other, attendanceClockOut, {});
  });

  it("[TIM-AT-03] sessions never overlap: TIME_OVERLAP from the command and an EXCLUDE constraint in the DB", async () => {
    const u = await freshUser();
    await t.db
      .insertInto("attendance_sessions")
      .values({
        user_id: u.id,
        started_at: new Date(pp("2026-10-19", "07:00")),
        ended_at: new Date(pp("2026-10-19", "09:00")),
        channel: "web",
      })
      .execute();
    await expectCode(run(u, attendanceClockIn, {}), "TIME_OVERLAP"); // 08:00 falls inside 07:00–09:00
    await expect(
      t.db
        .insertInto("attendance_sessions")
        .values({
          user_id: u.id,
          started_at: new Date(pp("2026-10-19", "08:30")),
          ended_at: new Date(pp("2026-10-19", "10:00")),
          channel: "web",
        })
        .execute(),
    ).rejects.toThrow(/attendance_sessions_no_overlap/);
    // Touching sessions are fine: 09:00 → 10:00
    t.clock.set(pp("2026-10-19", "09:00"));
    await run(u, attendanceClockIn, {});
    t.clock.set(pp("2026-10-19", "10:00"));
    const s = await run<Clock>(u, attendanceClockOut, {});
    // Correcting a session into another one is refused too.
    await expectCode(
      run(u, attendanceCorrect, {
        id: s.id,
        expectedVersion: 2,
        startedAt: pp("2026-10-19", "08:30"),
        endedAt: pp("2026-10-19", "10:00"),
        reason: "forgot to clock in",
      }),
      "TIME_OVERLAP",
    );
  });

  it("[TIM-AT-05] the job closes sessions at 23:59 or after 12 h, flags them, and needs the time.jobs grant", async () => {
    const early = await freshUser();
    const late = await freshUser();
    const night = await freshUser();
    await run(early, attendanceClockIn, {}); // 08:00
    t.clock.set(pp("2026-10-19", "18:00"));
    await run(late, attendanceClockIn, {});
    t.clock.set(pp("2026-10-19", "23:59"));
    await expectCode(run(early, attendanceAutoclose, {}), "FORBIDDEN"); // users cannot run it (job channel only)
    await expectCode(run({ type: "job", name: "job:other", grants: [] }, attendanceAutoclose, {}), "FORBIDDEN");
    const r = await run<{ closed: number }>(JOB, attendanceAutoclose, {});
    expect(r.closed).toBeGreaterThanOrEqual(2);
    const rows = await t.db
      .selectFrom("attendance_sessions")
      .select(["user_id", "ended_at", "auto_closed", "flagged", "flag_reason", "end_channel"])
      .where("user_id", "in", [early.id, late.id])
      .execute();
    const by = new Map(rows.map((x) => [x.user_id, x]));
    expect(by.get(early.id)).toMatchObject({ auto_closed: true, flagged: true, flag_reason: "auto_closed", end_channel: "job" });
    expect(by.get(early.id)!.ended_at!.toISOString()).toBe("2026-10-19T13:00:00.000Z"); // 20:00, 12 h cap
    expect(by.get(late.id)!.ended_at!.toISOString()).toBe("2026-10-19T16:59:00.000Z"); // 23:59
    // Idempotent: a second run closes nothing more
    expect((await run<{ closed: number }>(JOB, attendanceAutoclose, {})).closed).toBe(0);
    // A session started after 23:59 runs for at most 12 h; one under its cap is left alone.
    t.clock.set("2026-10-19T16:59:30Z");
    await run(night, attendanceClockIn, {});
    t.clock.set(pp("2026-10-20", "06:00"));
    await run(JOB, attendanceAutoclose, {});
    const open = await t.db
      .selectFrom("attendance_sessions")
      .select("ended_at")
      .where("user_id", "=", night.id)
      .executeTakeFirstOrThrow();
    expect(open.ended_at).toBeNull();
    // Clock-out after the cutoff (job not run yet) closes at the cutoff, flagged.
    t.clock.set(pp("2026-10-20", "13:00"));
    const out = await run<Clock>(night, attendanceClockOut, {});
    expect(out.autoClosed).toBe(true);
    expect(out.endedAt.toISOString()).toBe("2026-10-20T04:59:30.000Z");
  });

  it("[TIM-AT-06] my status: the running session and today's and this week's totals", async () => {
    const u = await freshUser();
    t.clock.set(pp("2026-10-20", "08:00")); // Tuesday
    await run(u, attendanceClockIn, {});
    t.clock.set(pp("2026-10-20", "12:00"));
    await run(u, attendanceClockOut, {});
    t.clock.set(pp("2026-10-21", "08:00"));
    await run(u, attendanceClockIn, {});
    t.clock.set(pp("2026-10-21", "09:30"));
    const s = await run<{
      today: string;
      weekStart: string;
      running: { minutes: number } | null;
      todayMinutes: number;
      weekMinutes: number;
      sessionsToday: unknown[];
    }>(u, attendanceStatus, {}, "telegram");
    expect(s).toMatchObject({ today: "2026-10-21", weekStart: "2026-10-19", todayMinutes: 90, weekMinutes: 330 });
    expect(s.running!.minutes).toBe(90);
    expect(s.sessionsToday).toHaveLength(1);
    const mcp = await run<{ todayMinutes: number }>(u, attendanceStatus, {}, "mcp");
    expect(mcp.todayMinutes).toBe(90);
  });

  it("[TIM-AT-07] I correct my own closed session (flagged, with a reason) until the week is confirmed", async () => {
    const u = await freshUser();
    t.clock.set(pp("2026-10-20", "09:15"));
    await run(u, attendanceClockIn, {});
    const running = await t.db
      .selectFrom("attendance_sessions")
      .select(["id", "version"])
      .where("user_id", "=", u.id)
      .executeTakeFirstOrThrow();
    const fix = {
      id: running.id,
      startedAt: pp("2026-10-20", "08:00"),
      endedAt: pp("2026-10-20", "17:00"),
      reason: "Forgot to clock in",
    };
    await expectCode(run(u, attendanceCorrect, { ...fix, expectedVersion: running.version }), "CLOCK_RUNNING");
    t.clock.set(pp("2026-10-20", "17:30"));
    await run(u, attendanceClockOut, {});
    await expectCode(run(other, attendanceCorrect, { ...fix, expectedVersion: 2 }), "FORBIDDEN");
    await expectCode(
      run(u, attendanceCorrect, { ...fix, startedAt: pp("2026-10-19", "08:00"), expectedVersion: 2 }),
      "VALIDATION",
    );
    await expectCode(run(u, attendanceCorrect, { ...fix, endedAt: pp("2026-10-20", "18:00"), expectedVersion: 2 }), "VALIDATION");
    const r = await run<{ minutes: number; flagged: boolean; flagReason: string }>(u, attendanceCorrect, {
      ...fix,
      expectedVersion: 2,
    });
    expect(r).toMatchObject({ minutes: 540, flagged: true, flagReason: "corrected" });
    await expectCode(run(u, attendanceCorrect, { ...fix, expectedVersion: 2 }), "STALE_VERSION");
    // Once the week is confirmed, the session is locked.
    t.clock.set(pp("2026-10-24", "15:00"));
    await run(u, timesheetConfirm, { weekStart: "2026-10-19" });
    await expectCode(
      run(u, attendanceCorrect, { ...fix, endedAt: pp("2026-10-20", "16:00"), expectedVersion: 3 }),
      "TIMESHEET_CONFIRMED",
    );
  });
});
