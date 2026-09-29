import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { projects, time } from "@demoq/core";
import { createTestDb, makeUser, type TestDb } from "@demoq/testkit";
import { firstWorkingDay, newScheduleState, runSchedule } from "./schedule";

let t: TestDb;
beforeAll(async () => {
  t = await createTestDb("2026-10-30T02:00:00Z");
});
afterAll(() => t.destroy());

describe("worker schedule", () => {
  it("[PRJ-BP-05] the monthly review runs on the first working day of the month, once; sweep hourly; retainer tick daily", async () => {
    expect(firstWorkingDay("2026-11-17")).toBe("2026-11-02"); // Nov 1 2026 is a Sunday
    expect(firstWorkingDay("2026-12-09")).toBe("2026-12-01");
    const ceo = await makeUser(t.db, { roles: ["ceo"] });
    await makeUser(t.db, { roles: ["director"] });
    const logged: string[] = [];
    const state = newScheduleState();
    const tick = () => runSchedule(t.kernel, state, { reviewRequesterId: ceo.id, log: (m) => logged.push(m) });
    await tick();
    // After the first working day, a missed review is caught up (September's here), once.
    expect(logged).toEqual(["bypass_sweep", "retainer_tick", "bypass_monthly_review"]);
    t.clock.advance(10 * 60_000);
    await tick();
    expect(logged).toHaveLength(3); // same hour, same day, same month
    t.clock.set("2026-11-02T01:00:00Z"); // 08:00 Monday in Phnom Penh
    await tick();
    await tick();
    expect(logged.filter((m) => m === "bypass_monthly_review")).toHaveLength(2); // September (caught up), then October
    const reviews = await t.db.selectFrom("approvals").select("subject_hash").where("kind", "=", "bypass_review").execute();
    expect(reviews.map((r) => r.subject_hash).sort()).toEqual(["2026-09-01", "2026-10-01"]);
  });

  it("[TIM-TS-15] a job that throws is logged and never keeps the other jobs of the tick from running", async () => {
    const u = await makeUser(t.db, { roles: ["staff"], name: "Needs A Reminder" });
    t.clock.set("2026-11-07T07:05:00Z"); // Saturday 14:05 in Phnom Penh: the reminder is due
    const failSweep = vi.spyOn(projects.bypassSweep, "run").mockRejectedValue(new Error("sweep down"));
    const failClose = vi.spyOn(time.attendanceAutoclose, "run").mockRejectedValue(new Error("autoclose down"));
    const logged: { msg: string; extra?: Record<string, unknown> }[] = [];
    const did: { reminded: number }[] = [];
    try {
      await runSchedule(t.kernel, newScheduleState(), {
        log: (msg, extra) => logged.push({ msg, extra }),
        onTimeJobs: (r) => did.push(r),
      });
    } finally {
      failSweep.mockRestore();
      failClose.mockRestore();
    }
    expect(logged.filter((l) => l.msg === "job_failed").map((l) => l.extra)).toEqual([
      { job: "bypass_sweep", error: "sweep down" },
      { job: "attendance_autoclose", error: "autoclose down" },
    ]);
    expect(logged.map((l) => l.msg)).toContain("retainer_tick"); // after the failed sweep
    expect(did[0]!.reminded).toBeGreaterThan(0); // after the failed auto-close
    const reminders = await t.db.selectFrom("outbox").select("payload").where("event", "=", "timesheet.reminder").execute();
    expect(reminders.some((r) => (r.payload as { userId: string }).userId === u.id)).toBe(true);
  });
});
