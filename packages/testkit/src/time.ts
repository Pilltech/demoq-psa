// Sprint 4 time fixtures. Synthetic data only.
//
// F-01 (plan §7.4 M2 #9–10): one team, 5 champions, one week (Mon 19 – Sun 25 Oct 2026, no public holidays).
//  - c1: confirmed last week on a task and a deal (→ pre-fill in the same proportions); attends 08:00–17:00.
//  - c2: no history, two started tasks (→ pre-fill evenly across them); attends 08:00–16:30.
//  - c3: no history, no started tasks (→ pre-fill to `admin`); no attendance (→ daily capacity); approved leave Wednesday.
//  - c4: Monday–Friday worker; half-day leave Tuesday afternoon; attends 08:00–17:00.
//  - c5: confirmed last week on a task and `training`; attends 08:00–17:00.
// Saturday sessions run 08:00–12:00. The clock is left at Saturday 24 Oct 14:00 (the reminder time).
import { approvals, execute, projects, tasks, time, type UserActor } from "@demoq/core";
import type { TestDb } from "./db";
import { makeClient, makeDeal, makeTeam, makeUser, meta } from "./factories";
import { projectTypeId, runAs } from "./s3";

export const F01_WEEK = "2026-10-19";
export const F01_CONFIRM_AT = "2026-10-24T07:00:00Z"; // Saturday 14:00 in Phnom Penh

export interface F01 {
  weekStart: string;
  lead: UserActor;
  ops: UserActor;
  pm: UserActor;
  champions: [UserActor, UserActor, UserActor, UserActor, UserActor];
  projectId: string;
  taskIds: { c1: string; c2a: string; c2b: string; c5: string };
  dealId: string;
}

const at = (date: string, hhmm: string) => `${date}T${hhmm}:00+07:00`;

async function attend(t: TestDb, who: UserActor, date: string, from: string, to: string) {
  t.clock.set(at(date, from));
  await runAs(t, who, time.attendanceClockIn, {});
  t.clock.set(at(date, to));
  await runAs(t, who, time.attendanceClockOut, {});
}

async function approvedLeave(t: TestDb, who: UserActor, lead: UserActor, date: string, halfDay: "am" | "pm" | null) {
  const l = await runAs<{ approvalId: string }>(t, who, time.leaveRequest, {
    leaveType: "annual",
    startDate: date,
    endDate: date,
    halfDay,
  });
  await execute(t.kernel, meta(lead), approvals.approvalDecide, { id: l.approvalId, decision: "approve" });
}

export async function fixtureF01(t: TestDb): Promise<F01> {
  t.clock.set(at("2026-10-12", "08:00"));
  const team = await makeTeam(t.db, `F-01 team ${Math.random().toString(36).slice(2, 7)}`);
  const lead = await makeUser(t.db, { roles: ["team_lead"], teamId: team.id, name: "F01 Lead" });
  const ops = await makeUser(t.db, { roles: ["ops_lead"], name: "F01 Ops" });
  const pm = await makeUser(t.db, { roles: ["project_manager"], name: "F01 PM" });
  const al = await makeUser(t.db, { roles: ["account_lead"], name: "F01 Account" });
  const champions = [] as unknown as F01["champions"];
  for (let n = 1; n <= 5; n++)
    champions.push(await makeUser(t.db, { roles: ["staff"], teamId: team.id, name: `F01 Champion ${n}` }));
  const [c1, c2, c3, c4, c5] = champions;
  await t.db
    .updateTable("users")
    .set({ working_days: [1, 2, 3, 4, 5], weekly_capacity_minutes: 2400 })
    .where("id", "=", c4.id)
    .execute();

  const p = await runAs<{ id: string }>(t, ops, projects.projectCreateInternal, {
    name: "F-01 agency brand refresh",
    projectTypeId: await projectTypeId(t),
    plannedStart: "2026-10-01",
    projectManagerId: pm.id,
  });
  const task = async (owner: UserActor, title: string, start = true) => {
    const k = await runAs<{ id: string; version: number }>(t, pm, tasks.taskCreate, {
      projectId: p.id,
      title,
      ownerId: owner.id,
      estimateMinutes: 2400,
      dueDate: "2026-11-30",
    });
    if (start) await runAs(t, owner, tasks.taskMove, { id: k.id, expectedVersion: k.version, to: "in_progress" });
    return k.id;
  };
  const taskIds = {
    c1: await task(c1, "Brand audit"),
    c2a: await task(c2, "Logo options"),
    c2b: await task(c2, "Guideline draft"),
    c5: await task(c5, "Website copy"),
  };
  await task(c3, "Not started yet", false);
  const client = await makeClient(t.db, al.id, "F-01 prospect");
  const deal = await makeDeal(t.db, client.id, al.id, "F-01 pitch");

  // Leave, requested and approved the week before.
  await approvedLeave(t, c3, lead, "2026-10-21", null);
  await approvedLeave(t, c4, lead, "2026-10-20", "pm");

  // Last week (12 Oct and 15 Oct are public holidays): c1 and c5 confirmed their own pattern.
  t.clock.set(at("2026-10-17", "15:00"));
  const lastWeekDays = ["2026-10-13", "2026-10-14", "2026-10-16", "2026-10-17"];
  await runAs(t, c1, time.timesheetConfirm, {
    weekStart: "2026-10-12",
    rows: lastWeekDays.flatMap((date) => [
      { date, targetType: "task", targetId: taskIds.c1, minutes: 300 },
      { date, targetType: "deal", targetId: deal.id, minutes: 180 },
    ]),
  });
  await runAs(t, c5, time.timesheetConfirm, {
    weekStart: "2026-10-12",
    rows: lastWeekDays.flatMap((date) => [
      { date, targetType: "task", targetId: taskIds.c5, minutes: 360 },
      { date, targetType: "internal", activityCode: "training", minutes: 120 },
    ]),
  });

  // F-01 week attendance.
  const weekdays = ["2026-10-19", "2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23"];
  for (const d of weekdays) {
    await attend(t, c1, d, "08:00", "17:00");
    await attend(t, c2, d, "08:00", "16:30");
    if (d === "2026-10-20") await attend(t, c4, d, "08:00", "12:00");
    else await attend(t, c4, d, "08:00", "17:00");
    await attend(t, c5, d, "08:00", "17:00");
  }
  for (const c of [c1, c2, c5]) await attend(t, c, "2026-10-24", "08:00", "12:00");

  t.clock.set(F01_CONFIRM_AT);
  return { weekStart: F01_WEEK, lead, ops, pm, champions, projectId: p.id, taskIds, dealId: deal.id };
}
