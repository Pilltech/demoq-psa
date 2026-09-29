// Fixture week F-01 (plan §7.4 M2 #9–10): pre-fill per D-TM-2 and the pilot metrics, measured from stored data.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, F01_CONFIRM_AT, fixtureF01, runAs, type F01, type TestDb } from "@demoq/testkit";
import type { UserActor } from "../kernel";
import { timesheetConfirm, timesheetOpen, timesheetTeam, timesheetWeek, weekMetrics, type WeekView } from "./timesheets";

let t: TestDb;
let f: F01;

beforeAll(async () => {
  t = await createTestDb();
  f = await fixtureF01(t);
}, 60_000);
afterAll(() => t.destroy());

const week = (u: UserActor) => runAs<WeekView>(t, u, timesheetWeek, { weekStart: f.weekStart });
const dayRows = (v: WeekView, date: string) =>
  v.rows.filter((r) => r.date === date).map((r) => [r.targetType, r.taskId ?? r.dealId ?? r.activityCode, r.minutes, r.source]);

describe("time/timesheets F-01", () => {
  it("[TIM-TS-04] pre-fill: last week's proportions, else open tasks evenly, else admin; 15-minute rounding", async () => {
    const [c1, c2, c3] = f.champions;
    const v1 = await week(c1);
    expect(v1.prefillBasis).toBe("last_week");
    // 540 attended minutes split 1200 : 720 (last week) → 345 / 195
    expect(dayRows(v1, "2026-10-19")).toEqual([
      ["deal", f.dealId, 195, "prefill"],
      ["task", f.taskIds.c1, 345, "prefill"],
    ]);
    expect(dayRows(v1, "2026-10-24").map((r) => r[2])).toEqual([90, 150]); // Saturday 08:00–12:00
    expect(dayRows(v1, "2026-10-25")).toEqual([]); // Sunday is not a working day
    const v2 = await week(c2);
    expect(v2.prefillBasis).toBe("open_tasks");
    expect(dayRows(v2, "2026-10-19").map((r) => r[2])).toEqual([255, 255]); // 510 evenly across two started tasks
    const v3 = await week(c3);
    expect(v3.prefillBasis).toBe("admin");
    // No attendance → daily capacity (2880 / 6 = 480) on admin.
    expect(dayRows(v3, "2026-10-19")).toEqual([["internal", "admin", 480, "prefill"]]);
    expect(v3.totals).toMatchObject({ attendedMinutes: 0, allocatedMinutes: 2400, prefillMinutes: 2400 });
  });

  it("[TIM-LV-07] approved leave and non-working days are skipped; a half day of leave halves the capacity", async () => {
    const [, , c3, c4] = f.champions;
    const v3 = await week(c3);
    const wed = v3.days.find((d) => d.date === "2026-10-21")!;
    expect(wed).toMatchObject({ workingDay: false, leave: { leaveType: "annual", halfDay: null }, allocatedMinutes: 0 });
    const v4 = await week(c4);
    const tue = v4.days.find((d) => d.date === "2026-10-20")!;
    expect(tue).toMatchObject({ workingDay: true, capacityMinutes: 240, attendedMinutes: 240, allocatedMinutes: 240 });
    expect(tue.leave).toMatchObject({ halfDay: "pm" });
    const sat = v4.days.find((d) => d.date === "2026-10-24")!;
    expect(sat).toMatchObject({ scheduled: false, workingDay: false, allocatedMinutes: 0 }); // Monday–Friday worker
    expect(v4.totals.allocatedMinutes).toBe(540 * 4 + 240);
  });

  it("[TIM-TS-10] on F-01, ≥ 90 % of confirmed minutes come from the pre-fill unchanged and the median confirmation is < 120 s", async () => {
    const thinking = [45, 60, 75, 90, 150]; // seconds between opening the week and confirming it
    for (const [n, c] of f.champions.entries()) {
      t.clock.set(new Date(new Date(F01_CONFIRM_AT).getTime() + n * 600_000));
      const v = await runAs<WeekView>(t, c, timesheetOpen, { weekStart: f.weekStart });
      t.clock.advance(thinking[n]! * 1000);
      if (n < 4) {
        await runAs(t, c, timesheetConfirm, { weekStart: f.weekStart, draftHash: v.draftHash }); // one tap
      } else {
        // c5 changes one cell (Monday's training 135 → 180 minutes) and confirms the rest as pre-filled.
        const rows = v.rows.map((r) => ({
          date: r.date,
          targetType: r.targetType,
          targetId: r.targetType === "internal" ? null : r.targetId,
          activityCode: r.activityCode,
          minutes: r.date === "2026-10-19" && r.activityCode === "training" ? 180 : r.minutes,
        }));
        const r = await runAs<{ confirmedMinutes: number; prefillKeptMinutes: number }>(t, c, timesheetConfirm, {
          weekStart: f.weekStart,
          draftHash: v.draftHash,
          rows,
        });
        expect(r.confirmedMinutes - r.prefillKeptMinutes).toBe(180);
      }
    }
    const sources = await t.db
      .selectFrom("time_allocations")
      .select(["source", "status"])
      .where(
        "user_id",
        "in",
        f.champions.map((c) => c.id),
      )
      .where("work_date", ">=", f.weekStart)
      .execute();
    expect(new Set(sources.map((s) => s.status))).toEqual(new Set(["confirmed"]));
    expect(sources.filter((s) => s.source === "manual")).toHaveLength(1);
    const m = await weekMetrics(
      t.db,
      f.weekStart,
      f.champions.map((c) => c.id),
    );
    expect(m.prefillKeptRatio!).toBeGreaterThanOrEqual(0.9);
    expect(m.medianConfirmSeconds).toBe(75);
    expect(m.medianConfirmSeconds!).toBeLessThan(120);
    // The team lead sees the same figures in the team view.
    const team = await runAs<{ confirmedCount: number; metrics: typeof m }>(t, f.lead, timesheetTeam, { weekStart: f.weekStart });
    expect(team.confirmedCount).toBe(5);
    expect(team.metrics).toEqual(m);
  });
});
