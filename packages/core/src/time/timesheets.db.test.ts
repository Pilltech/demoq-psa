import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { acceptedProject, createTestDb, makeClient, makeDeal, makeTeam, makeUser, runAs, type TestDb } from "@demoq/testkit";
import { DomainError, type JobActor, type OpDef, type UserActor } from "../kernel";
import { gateSatisfy, projectCreateInternal } from "../projects";
import { taskCreate } from "../tasks";
import { timeAllocate } from "./allocations";
import { attendanceClockIn, attendanceClockOut } from "./attendance";
import { activityCodeList, activityCodeUpsert } from "./config";
import {
  timesheetConfirm,
  timesheetDueEscalate,
  timesheetOpen,
  timesheetRemind,
  timesheetReopen,
  timesheetTeam,
  timesheetWeek,
  type WeekView,
} from "./timesheets";

let t: TestDb;
let lead: UserActor, otherLead: UserActor, ops: UserActor, pm: UserActor, admin: UserActor, account: UserActor;
let staff: UserActor, mate: UserActor, outsider: UserActor, viewer: UserActor;
let internalProjectId: string, internalTaskId: string, dealId: string;
const JOB: JobActor = { type: "job", name: "job:time", grants: ["time.jobs"] };
const WEEK = "2026-10-19";

const run = <T>(a: UserActor | JobActor, op: OpDef, input: unknown, channel?: "web" | "mcp" | "telegram" | "job") =>
  runAs<T>(t, a, op, input, channel);
const expectCode = (p: Promise<unknown>, code: string) =>
  expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);
const pp = (date: string, hhmm: string) => `${date}T${hhmm}:00+07:00`;
const fresh = (teamId: string | null = null) => makeUser(t.db, { roles: ["staff"], teamId });
let teamId: string;

beforeAll(async () => {
  t = await createTestDb(pp("2026-10-19", "09:00"));
  const team = await makeTeam(t.db, "Creative");
  const other = await makeTeam(t.db, "Video");
  teamId = team.id;
  lead = await makeUser(t.db, { roles: ["team_lead"], teamId: team.id, name: "Rith Lead" });
  otherLead = await makeUser(t.db, { roles: ["team_lead"], teamId: other.id });
  ops = await makeUser(t.db, { roles: ["ops_lead"], name: "Vanna Ops" });
  pm = await makeUser(t.db, { roles: ["project_manager"], name: "Piseth PM" });
  admin = await makeUser(t.db, { roles: ["admin"] });
  account = await makeUser(t.db, { roles: ["account_lead"], name: "Sokha Lead" });
  staff = await makeUser(t.db, { roles: ["staff"], teamId: team.id, name: "Dara Staff" });
  mate = await makeUser(t.db, { roles: ["staff"], teamId: team.id, name: "Mate Staff" });
  outsider = await makeUser(t.db, { roles: ["staff"], teamId: other.id });
  viewer = await makeUser(t.db, { roles: ["viewer"] });
  const p = await run<{ id: string }>(ops, projectCreateInternal, {
    name: "Agency website",
    projectTypeId: (await t.db.selectFrom("project_types").select("id").executeTakeFirstOrThrow()).id,
    plannedStart: "2026-10-01",
    projectManagerId: pm.id,
  });
  internalProjectId = p.id;
  internalTaskId = (
    await run<{ id: string }>(pm, taskCreate, {
      projectId: p.id,
      title: "Homepage",
      ownerId: staff.id,
      estimateMinutes: 600,
      dueDate: "2026-11-30",
    })
  ).id;
  const client = await makeClient(t.db, account.id);
  dealId = (await makeDeal(t.db, client.id, account.id, "Pitch for Angkor Beer")).id;
}, 60_000);
afterAll(() => t.destroy());

describe("time/allocations and timesheets", () => {
  beforeEach(() => t.clock.set(pp("2026-10-21", "15:00"))); // Wednesday of WEEK

  it("[TIM-TS-01] I log minutes per day on a task, project, deal or activity code; 0 removes; the source follows the channel", async () => {
    const u = await fresh();
    const a = await run<{ id: string; dayTotalMinutes: number }>(u, timeAllocate, {
      date: "2026-10-19",
      targetType: "task",
      targetId: internalTaskId,
      minutes: 120,
    });
    await run(u, timeAllocate, { date: "2026-10-19", targetType: "project", targetId: internalProjectId, minutes: 60 });
    await run(u, timeAllocate, { date: "2026-10-19", targetType: "deal", targetId: dealId, minutes: 30 }, "mcp");
    const last = await run<{ dayTotalMinutes: number }>(u, timeAllocate, {
      date: "2026-10-19",
      targetType: "internal",
      activityCode: "training",
      minutes: 45,
    });
    expect(last.dayTotalMinutes).toBe(255);
    // Same target again updates the row
    const again = await run<{ id: string }>(u, timeAllocate, {
      date: "2026-10-19",
      targetType: "task",
      targetId: internalTaskId,
      minutes: 90,
    });
    expect(again.id).toBe(a.id);
    const rows = await t.db
      .selectFrom("time_allocations")
      .select(["target_type", "minutes", "source", "status", "project_id"])
      .where("user_id", "=", u.id)
      .orderBy("target_type")
      .execute();
    expect(rows).toEqual([
      { target_type: "deal", minutes: 30, source: "mcp", status: "draft", project_id: null },
      { target_type: "internal", minutes: 45, source: "manual", status: "draft", project_id: null },
      { target_type: "project", minutes: 60, source: "manual", status: "draft", project_id: internalProjectId },
      { target_type: "task", minutes: 90, source: "manual", status: "draft", project_id: internalProjectId },
    ]);
    const removed = await run<{ removed: boolean; dayTotalMinutes: number }>(u, timeAllocate, {
      date: "2026-10-19",
      targetType: "deal",
      targetId: dealId,
      minutes: 0,
    });
    expect(removed).toMatchObject({ removed: true, dayTotalMinutes: 195 });
    await expectCode(
      run(u, timeAllocate, { date: "2026-10-22", targetType: "deal", targetId: dealId, minutes: 30 }),
      "VALIDATION",
    );
    await expectCode(
      run(u, timeAllocate, { date: "2026-10-19", targetType: "internal", activityCode: "golf", minutes: 30 }),
      "VALIDATION",
    );
    await expectCode(run(u, timeAllocate, { date: "2026-10-19", targetType: "deal", minutes: 30 }), "VALIDATION");
    await expectCode(
      run(viewer, timeAllocate, { date: "2026-10-19", targetType: "deal", targetId: dealId, minutes: 30 }),
      "FORBIDDEN",
    );
    await expectCode(
      run(u, timeAllocate, { date: "2026-10-19", targetType: "deal", targetId: dealId, minutes: 30 }, "telegram"),
      "FORBIDDEN",
    );
  });

  it("[TIM-TS-01] activity codes: everyone lists them, admin edits them (admin.config)", async () => {
    const list = await run<{ code: string }[]>(viewer, activityCodeList, {});
    expect(list.map((c) => c.code)).toEqual(["admin", "internal_meeting", "training", "pitch", "recruitment", "leave_admin"]);
    await expectCode(run(ops, activityCodeUpsert, { code: "coffee", labelEn: "Coffee", labelKm: "កាហ្វេ" }), "FORBIDDEN");
    await run(admin, activityCodeUpsert, { code: "events", labelEn: "Events", labelKm: "ព្រឹត្តិការណ៍", position: 70 });
    await expectCode(
      run(admin, activityCodeUpsert, { code: "events", labelEn: "Events", labelKm: "ព្រឹត្តិការណ៍" }),
      "VALIDATION",
    );
    await run(admin, activityCodeUpsert, {
      code: "events",
      labelEn: "Events",
      labelKm: "ព្រឹត្តិការណ៍",
      active: false,
      expectedVersion: 1,
    });
    const u = await fresh();
    await expectCode(
      run(u, timeAllocate, { date: "2026-10-19", targetType: "internal", activityCode: "events", minutes: 30 }),
      "VALIDATION",
    );
  });

  it("[TIM-TS-02] a day's allocations never exceed 24 h (command and DB trigger)", async () => {
    const u = await fresh();
    await run(u, timeAllocate, { date: "2026-10-20", targetType: "deal", targetId: dealId, minutes: 1000 });
    await expectCode(
      run(u, timeAllocate, { date: "2026-10-20", targetType: "internal", activityCode: "admin", minutes: 441 }),
      "VALIDATION",
    );
    await run(u, timeAllocate, { date: "2026-10-20", targetType: "internal", activityCode: "admin", minutes: 440 });
    await expect(
      t.db
        .insertInto("time_allocations")
        .values({
          user_id: u.id,
          work_date: "2026-10-20",
          minutes: 5,
          target_type: "internal",
          activity_code: "training",
          source: "manual",
        })
        .execute(),
    ).rejects.toThrow(/exceed 24 h/);
  });

  it("[TIM-TS-03] allocating to a gated client project or its task returns 409 GATE_BLOCKED (web and MCP, DB trigger); deals and internal codes succeed", async () => {
    const u = await fresh();
    const p = await acceptedProject(t, account, { pmId: pm.id });
    const task = await t.db.selectFrom("tasks").select("id").where("project_id", "=", p.projectId).executeTakeFirstOrThrow();
    const base = { date: "2026-10-21", minutes: 60 };
    await expectCode(run(u, timeAllocate, { ...base, targetType: "project", targetId: p.projectId }), "GATE_BLOCKED");
    await expectCode(run(u, timeAllocate, { ...base, targetType: "task", targetId: task.id }, "mcp"), "GATE_BLOCKED");
    await run(u, timeAllocate, { ...base, targetType: "deal", targetId: p.dealId });
    await run(u, timeAllocate, { ...base, targetType: "internal", activityCode: "pitch" }, "mcp");
    await expect(
      t.db
        .insertInto("time_allocations")
        .values({
          user_id: u.id,
          work_date: "2026-10-21",
          minutes: 30,
          target_type: "project",
          project_id: p.projectId,
          source: "manual",
        })
        .execute(),
    ).rejects.toThrow(/GATE_BLOCKED/);
    for (const gate of ["contract", "purchase_order", "deposit_terms"])
      await run(pm, gateSatisfy, { projectId: p.projectId, gate, evidence: `REF-${gate}` });
    await run(u, timeAllocate, { ...base, targetType: "task", targetId: task.id });
  });

  it("[TIM-TS-05] the week view pre-fills; confirm as-is (one tap) or with edits; stale drafts and future weeks are refused", async () => {
    const u = await fresh(teamId);
    await expectCode(run(u, timesheetWeek, { weekStart: "2026-10-26" }), "VALIDATION"); // future
    await expectCode(run(u, timesheetWeek, { weekStart: "2026-10-20" }), "VALIDATION"); // not a Monday
    t.clock.set(pp("2026-10-19", "08:00"));
    await run(u, attendanceClockIn, {});
    t.clock.set(pp("2026-10-19", "17:10"));
    await run(u, attendanceClockOut, {});
    t.clock.set(pp("2026-10-21", "15:00"));
    await run(u, timeAllocate, { date: "2026-10-20", targetType: "deal", targetId: dealId, minutes: 120 });
    const v = await run<WeekView>(u, timesheetWeek, {});
    expect(v).toMatchObject({ weekStart: WEEK, weekEnd: "2026-10-25", status: "open", prefillBasis: "admin" });
    expect(v.days).toHaveLength(7);
    const mon = v.days.find((d) => d.date === WEEK)!;
    expect(mon).toMatchObject({ attendedMinutes: 550, baseMinutes: 555, allocatedMinutes: 555 }); // 9 h 10 → 9 h 15
    // Tuesday: my 2 h on the deal stay, the rest of the capacity (480 − 120) is pre-filled
    expect(v.rows.filter((r) => r.date === "2026-10-20").map((r) => [r.targetType, r.minutes, r.source, r.status])).toEqual([
      ["deal", 120, "manual", "draft"],
      ["internal", 360, "prefill", "proposed"],
    ]);
    expect(v.targets.map((x) => x.label).sort()).toEqual(["Administration", "Pitch for Angkor Beer"]);
    // Stale: the draft changes when attendance changes
    t.clock.set(pp("2026-10-21", "16:00"));
    await run(u, attendanceClockIn, {});
    t.clock.set(pp("2026-10-21", "16:30"));
    await run(u, attendanceClockOut, {});
    await expectCode(run(u, timesheetConfirm, { draftHash: v.draftHash }), "STALE_VERSION");
    // With edits: the full week as the user wants it (Mon–Wed; later days are in the future)
    const now = await run<WeekView>(u, timesheetWeek, {});
    const rows = now.rows.map((r) => ({
      date: r.date,
      targetType: r.targetType,
      targetId: r.targetType === "internal" ? null : r.targetId,
      activityCode: r.activityCode,
      minutes: r.date === "2026-10-21" ? 60 : r.minutes,
    }));
    await expectCode(
      run(u, timesheetConfirm, { rows: [...rows, { date: "2026-10-23", targetType: "deal", targetId: dealId, minutes: 60 }] }),
      "VALIDATION",
    );
    await expectCode(run(u, timesheetConfirm, { rows: [rows[0], rows[0]] }), "VALIDATION");
    const c = await run<{ status: string; confirmedMinutes: number; prefillKeptMinutes: number }>(u, timesheetConfirm, {
      draftHash: now.draftHash,
      rows: rows.filter((r) => r.date <= "2026-10-21"),
    });
    expect(c.status).toBe("confirmed");
    const stored = await t.db
      .selectFrom("time_allocations")
      .select(["work_date", "source", "status", "minutes"])
      .where("user_id", "=", u.id)
      .orderBy("work_date")
      .orderBy("source")
      .execute();
    expect(stored).toEqual([
      { work_date: "2026-10-19", source: "prefill", status: "confirmed", minutes: 555 },
      { work_date: "2026-10-20", source: "manual", status: "confirmed", minutes: 120 },
      { work_date: "2026-10-20", source: "prefill", status: "confirmed", minutes: 360 },
      { work_date: "2026-10-21", source: "manual", status: "confirmed", minutes: 60 },
    ]);
    expect(c.prefillKeptMinutes).toBe(915);
    await expectCode(run(u, timesheetConfirm, {}), "TIMESHEET_CONFIRMED");
    const w = await t.db.selectFrom("timesheet_weeks").selectAll().where("user_id", "=", u.id).executeTakeFirstOrThrow();
    expect(w).toMatchObject({ status: "confirmed", confirmed_channel: "web", draft_hash: now.draftHash });
    expect(w.first_confirmed_at).toEqual(w.confirmed_at);
  });

  it("[TIM-TS-06] a confirmed week locks its allocations and attendance sessions (app role, raw SQL)", async () => {
    const u = await fresh(teamId);
    t.clock.set(pp("2026-10-20", "08:00"));
    await run(u, attendanceClockIn, {});
    t.clock.set(pp("2026-10-20", "17:00"));
    await run(u, attendanceClockOut, {});
    t.clock.set(pp("2026-10-24", "08:00"));
    await run(u, attendanceClockIn, {}); // still running when the week is confirmed
    t.clock.set(pp("2026-10-24", "14:00"));
    await run(u, timesheetConfirm, { weekStart: WEEK });
    await expectCode(
      run(u, timeAllocate, { date: "2026-10-20", targetType: "deal", targetId: dealId, minutes: 15 }),
      "TIMESHEET_CONFIRMED",
    );
    const lockErr = /TIMESHEET_CONFIRMED/;
    await expect(t.db.updateTable("time_allocations").set({ minutes: 1 }).where("user_id", "=", u.id).execute()).rejects.toThrow(
      lockErr,
    );
    await expect(t.db.deleteFrom("time_allocations").where("user_id", "=", u.id).execute()).rejects.toThrow(lockErr);
    await expect(
      t.db
        .insertInto("time_allocations")
        .values({
          user_id: u.id,
          work_date: "2026-10-22",
          minutes: 30,
          target_type: "internal",
          activity_code: "admin",
          source: "manual",
        })
        .execute(),
    ).rejects.toThrow(lockErr);
    await expect(
      t.db
        .updateTable("attendance_sessions")
        .set({ started_at: new Date(pp("2026-10-20", "07:00")) })
        .where("user_id", "=", u.id)
        .where("ended_at", "is not", null)
        .execute(),
    ).rejects.toThrow(lockErr);
    await expect(
      t.db
        .insertInto("attendance_sessions")
        .values({
          user_id: u.id,
          started_at: new Date(pp("2026-10-22", "08:00")),
          ended_at: new Date(pp("2026-10-22", "09:00")),
          channel: "web",
        })
        .execute(),
    ).rejects.toThrow(lockErr);
    await expect(sql`DELETE FROM attendance_sessions WHERE user_id = ${u.id}`.execute(t.db)).rejects.toThrow(
      /permission denied|TIMESHEET/,
    );
    // The session running at confirmation may still be closed; a new session afterwards is new attendance.
    t.clock.set(pp("2026-10-24", "17:00"));
    await run(u, attendanceClockOut, {});
    t.clock.set(pp("2026-10-24", "18:00"));
    await run(u, attendanceClockIn, {});
  });

  it("[TIM-TS-07] the user's team lead or ops_lead reopens a confirmed week with a reason; the allocations become drafts again", async () => {
    const u = await fresh(teamId);
    t.clock.set(pp("2026-10-24", "14:00"));
    await run(u, timesheetConfirm, { weekStart: WEEK });
    const first = await t.db
      .selectFrom("timesheet_weeks")
      .select("first_confirmed_at")
      .where("user_id", "=", u.id)
      .executeTakeFirstOrThrow();
    const input = { userId: u.id, weekStart: WEEK, reason: "Wrong project on Tuesday" };
    await expectCode(run(otherLead, timesheetReopen, input), "FORBIDDEN");
    await expectCode(run(mate, timesheetReopen, input), "FORBIDDEN");
    await expectCode(run(lead, timesheetReopen, { ...input, reason: "" }), "VALIDATION");
    await expectCode(run(lead, timesheetReopen, { ...input, weekStart: "2026-10-12" }), "NOT_FOUND");
    const r = await run<{ status: string }>(lead, timesheetReopen, input);
    expect(r.status).toBe("open");
    await expectCode(run(lead, timesheetReopen, input), "INVALID_TRANSITION");
    expect(
      new Set(
        (await t.db.selectFrom("time_allocations").select("status").where("user_id", "=", u.id).execute()).map((x) => x.status),
      ),
    ).toEqual(new Set(["draft"]));
    await run(u, timeAllocate, { date: "2026-10-20", targetType: "deal", targetId: dealId, minutes: 60 });
    t.clock.advance(3600_000);
    await run(u, timesheetConfirm, { weekStart: WEEK });
    await run(ops, timesheetReopen, { ...input, reason: "Ops check" });
    const w = await t.db.selectFrom("timesheet_weeks").selectAll().where("user_id", "=", u.id).executeTakeFirstOrThrow();
    expect(w).toMatchObject({ status: "open", reopened_by: ops.id, reopen_reason: "Ops check", reopen_count: 2 });
    expect(w.first_confirmed_at).toEqual(first.first_confirmed_at);
    // A lead cannot reopen their own week.
    await run(lead, timesheetConfirm, { weekStart: WEEK });
    await expectCode(run(lead, timesheetReopen, { userId: lead.id, weekStart: WEEK, reason: "Mine" }), "FORBIDDEN");
    await expect(
      t.db
        .updateTable("timesheet_weeks")
        .set({ reopened_at: new Date(), reopen_reason: "" })
        .where("user_id", "=", u.id)
        .execute(),
    ).rejects.toThrow(/timesheet_weeks_reopen_reason/);
  });

  it("[TIM-TS-08] the team view shows who has confirmed: a lead sees their team, ops everyone, staff nothing", async () => {
    t.clock.set(pp("2026-10-24", "15:00"));
    const v = await run<{ people: { userId: string; status: string }[] }>(lead, timesheetTeam, { weekStart: WEEK });
    const ids = v.people.map((p) => p.userId);
    expect(ids).toContain(staff.id);
    expect(ids).toContain(mate.id);
    expect(ids).not.toContain(outsider.id);
    const other = await run<{ people: unknown[] }>(lead, timesheetTeam, {
      weekStart: WEEK,
      teamId: (await t.db.selectFrom("users").select("team_id").where("id", "=", outsider.id).executeTakeFirstOrThrow()).team_id!,
    });
    expect(other.people).toEqual([]);
    const all = await run<{ people: { userId: string }[] }>(ops, timesheetTeam, { weekStart: WEEK });
    expect(all.people.map((p) => p.userId)).toContain(outsider.id);
    expect(all.people.map((p) => p.userId)).not.toContain(viewer.id);
    await expectCode(run(staff, timesheetTeam, { weekStart: WEEK }), "FORBIDDEN");
  });

  it("[TIM-TS-10] opening the week records when the draft was first seen (once), for the confirmation-time metric", async () => {
    const u = await fresh();
    t.clock.set(pp("2026-10-24", "14:00"));
    await run(u, timesheetOpen, {}, "telegram");
    t.clock.advance(30_000);
    await run(u, timesheetOpen, {});
    t.clock.advance(30_000);
    await run(u, timesheetConfirm, {});
    const w = await t.db.selectFrom("timesheet_weeks").selectAll().where("user_id", "=", u.id).executeTakeFirstOrThrow();
    expect((w.first_confirmed_at!.getTime() - w.opened_at!.getTime()) / 1000).toBe(60);
  });

  it("[TIM-TS-11] the reminder goes out from 14:00 on each person's last working day, once, and never for a confirmed week", async () => {
    const u = await fresh();
    await t.db
      .updateTable("users")
      .set({ working_days: [1, 2, 3, 4, 5] })
      .where("id", "=", u.id)
      .execute();
    const events = async () =>
      (await t.db.selectFrom("outbox").select(["event", "payload"]).where("event", "=", "timesheet.reminder").execute())
        .map((e) => e.payload as { userId: string; weekStart: string })
        .filter((p) => p.userId === u.id);
    t.clock.set(pp("2026-10-23", "13:59")); // Friday, u's last working day
    await run(JOB, timesheetRemind, {});
    expect(await events()).toHaveLength(0);
    t.clock.set(pp("2026-10-23", "14:00"));
    await run(JOB, timesheetRemind, {});
    await run(JOB, timesheetRemind, {});
    expect(await events()).toEqual([{ userId: u.id, weekStart: WEEK }]);
    await expectCode(run(ops, timesheetRemind, {}), "FORBIDDEN");
    // Staff with Mon–Sat get it on Saturday, unless they have confirmed already.
    const early = await fresh();
    t.clock.set(pp("2026-10-24", "11:00"));
    await run(early, timesheetConfirm, {});
    t.clock.set(pp("2026-10-24", "14:05"));
    const r = await run<{ reminded: number }>(JOB, timesheetRemind, {});
    expect(r.reminded).toBeGreaterThan(0);
    const all = await t.db.selectFrom("outbox").select("payload").where("event", "=", "timesheet.reminder").execute();
    expect(all.some((e) => (e.payload as { userId: string }).userId === early.id)).toBe(false);
  });

  it("[TIM-TS-12] unconfirmed weeks escalate to the team lead at 12:00 on the first working day of the next week", async () => {
    const u = await fresh(teamId);
    t.clock.set(pp("2026-10-26", "11:59")); // Monday of the next week
    await run(JOB, timesheetDueEscalate, {});
    const mine = async () =>
      (await t.db.selectFrom("outbox").select("payload").where("event", "=", "timesheet.overdue").execute())
        .map((e) => e.payload as { userId: string; weekStart: string; leadIds: string[] })
        .filter((p) => p.userId === u.id);
    expect(await mine()).toHaveLength(0);
    t.clock.set(pp("2026-10-26", "12:00"));
    await run(JOB, timesheetDueEscalate, {});
    await run(JOB, timesheetDueEscalate, {});
    expect(await mine()).toEqual([{ userId: u.id, name: u.name, weekStart: WEEK, leadIds: [lead.id] }]);
    const confirmed = await t.db.selectFrom("outbox").select("payload").where("event", "=", "timesheet.overdue").execute();
    // Staff who confirmed last week are not escalated.
    expect(confirmed.some((e) => (e.payload as { userId: string }).userId === lead.id)).toBe(false);
  });
});
