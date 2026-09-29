import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, makeTeam, makeUser, runAs, type TestDb } from "@demoq/testkit";
import { approvalDecide, approvalEscalateOverdue } from "../approvals";
import { DomainError, type JobActor, type OpDef, type UserActor } from "../kernel";
import { holidayList, holidayRemove, holidayUpsert, timeCalendar } from "./config";
import { leaveCancel, leaveMine, leaveRequest, leaveTypes } from "./leave";

let t: TestDb;
let lead: UserActor, otherLead: UserActor, ops: UserActor, ops2: UserActor, director: UserActor, admin: UserActor;
let staff: UserActor, viewer: UserActor;
let teamId: string;
const ESC: JobActor = { type: "job", name: "job:escalation", grants: ["approval.escalate"] };

const run = <T>(a: UserActor | JobActor, op: OpDef, input: unknown, channel?: "web" | "mcp" | "telegram" | "job") =>
  runAs<T>(t, a, op, input, channel);
const expectCode = (p: Promise<unknown>, code: string) =>
  expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);
const pp = (date: string, hhmm: string) => `${date}T${hhmm}:00+07:00`;
type Leave = { id: string; status: string; approvalId: string; assigneeId: string | null; version: number };

beforeAll(async () => {
  t = await createTestDb(pp("2026-10-19", "09:00"));
  const team = await makeTeam(t.db, "Creative");
  const other = await makeTeam(t.db, "Video");
  teamId = team.id;
  lead = await makeUser(t.db, { roles: ["team_lead"], teamId: team.id, name: "Aaa Lead" });
  otherLead = await makeUser(t.db, { roles: ["team_lead"], teamId: other.id, name: "Bbb Lead" });
  ops = await makeUser(t.db, { roles: ["ops_lead"], name: "Aaa Ops" });
  ops2 = await makeUser(t.db, { roles: ["ops_lead"], name: "Zzz Ops" });
  director = await makeUser(t.db, { roles: ["director"], name: "Dir" });
  admin = await makeUser(t.db, { roles: ["admin"] });
  staff = await makeUser(t.db, { roles: ["staff"], teamId: team.id, name: "Dara Staff" });
  viewer = await makeUser(t.db, { roles: ["viewer"] });
});
afterAll(() => t.destroy());

describe("time/holidays and leave", () => {
  beforeEach(() => t.clock.set(pp("2026-10-19", "09:00")));

  it("[TIM-LV-01] 2026 and 2027 Cambodian holidays are seeded unverified with their source; everyone lists them", async () => {
    const y26 = await run<{ date: string; nameEn: string; verified: boolean; source: string }[]>(viewer, holidayList, {
      year: 2026,
    });
    expect(y26.length).toBe(21);
    expect(y26.map((h) => h.date)).toEqual(
      expect.arrayContaining(["2026-01-01", "2026-04-14", "2026-10-10", "2026-11-09", "2026-12-29"]),
    );
    expect(y26.every((h) => !h.verified && /sub-decree 167/.test(h.source))).toBe(true);
    const y27 = await run<{ source: string; verified: boolean }[]>(staff, holidayList, { year: 2027 }, "mcp");
    expect(y27.length).toBeGreaterThanOrEqual(18);
    expect(y27.every((h) => !h.verified && /estimate/.test(h.source))).toBe(true);
    const km = await run<{ nameKm: string }[]>(staff, holidayList, {});
    expect(km.every((h) => h.nameKm.length > 0)).toBe(true);
  });

  it("[TIM-LV-02] only admin adds, edits, verifies and removes holidays", async () => {
    const h = { date: "2026-12-31", nameEn: "Company day", nameKm: "ថ្ងៃក្រុមហ៊ុន", source: "DemoQ policy" };
    await expectCode(run(ops, holidayUpsert, h), "FORBIDDEN");
    const added = await run<{ verified: boolean; version: number }>(admin, holidayUpsert, h);
    expect(added.verified).toBe(false);
    await expectCode(run(admin, holidayUpsert, { ...h, verified: true }), "VALIDATION"); // update needs expectedVersion
    const v = await run<{ verified: boolean; verifiedAt: Date; version: number }>(admin, holidayUpsert, {
      ...h,
      verified: true,
      expectedVersion: added.version,
    });
    expect(v.verified).toBe(true);
    expect(v.verifiedAt).toEqual(t.clock.now);
    await expectCode(run(staff, holidayRemove, { date: h.date, expectedVersion: v.version }), "FORBIDDEN");
    await run(admin, holidayRemove, { date: h.date, expectedVersion: v.version });
    expect((await run<{ date: string }[]>(staff, holidayList, { year: 2026 })).map((x) => x.date)).not.toContain(h.date);
  });

  it("[TIM-LV-08] leave types are seeded (annual, sick, special, maternity, unpaid); half days only where allowed", async () => {
    const types = await run<{ code: string; halfDayAllowed: boolean; paid: boolean }[]>(viewer, leaveTypes, {});
    expect(types.map((x) => x.code)).toEqual(["annual", "sick", "special", "maternity", "unpaid"]);
    expect(types.find((x) => x.code === "unpaid")!.paid).toBe(false);
    await expectCode(
      run(staff, leaveRequest, { leaveType: "maternity", startDate: "2026-12-01", endDate: "2026-12-01", halfDay: "am" }),
      "VALIDATION",
    );
    await expectCode(
      run(staff, leaveRequest, { leaveType: "annual", startDate: "2026-12-01", endDate: "2026-12-02", halfDay: "am" }),
      "VALIDATION",
    );
    await expectCode(
      run(staff, leaveRequest, { leaveType: "golf", startDate: "2026-12-01", endDate: "2026-12-01" }),
      "VALIDATION",
    );
  });

  it("[TIM-LV-03] a leave request creates a `leave` approval for my team lead (or ops/director); the decision sets its status", async () => {
    const l = await run<Leave>(staff, leaveRequest, {
      leaveType: "annual",
      startDate: "2026-11-02",
      endDate: "2026-11-04",
      reason: "Family trip",
    });
    expect(l.status).toBe("requested");
    expect(l.assigneeId).toBe(lead.id);
    const a = await t.db.selectFrom("approvals").selectAll().where("id", "=", l.approvalId).executeTakeFirstOrThrow();
    expect(a).toMatchObject({
      kind: "leave",
      subject_type: "leave_request",
      subject_id: l.id,
      required_permission: "leave.approve",
    });
    await expectCode(run(otherLead, approvalDecide, { id: l.approvalId, decision: "approve" }), "FORBIDDEN");
    await expectCode(run(staff, approvalDecide, { id: l.approvalId, decision: "approve" }), "SELF_APPROVAL");
    await run(lead, approvalDecide, { id: l.approvalId, decision: "approve" }, "telegram");
    const row = await t.db.selectFrom("leave_requests").selectAll().where("id", "=", l.id).executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: "approved", decided_by: lead.id });
    // Rejection
    const r = await run<Leave>(staff, leaveRequest, {
      leaveType: "sick",
      startDate: "2026-10-20",
      endDate: "2026-10-20",
      halfDay: "pm",
    });
    await run(director, approvalDecide, { id: r.approvalId, decision: "reject" });
    expect(
      (await t.db.selectFrom("leave_requests").select("status").where("id", "=", r.id).executeTakeFirstOrThrow()).status,
    ).toBe("rejected");
    // DB backstop: leave is approved only through its approved approval.
    const p = await run<Leave>(staff, leaveRequest, { leaveType: "special", startDate: "2026-12-10", endDate: "2026-12-10" });
    await expect(
      t.db
        .updateTable("leave_requests")
        .set({ status: "approved", decided_by: lead.id, decided_at: new Date() })
        .where("id", "=", p.id)
        .execute(),
    ).rejects.toThrow(/no approved leave approval/);
    await expect(
      t.db.updateTable("leave_requests").set({ end_date: "2026-12-11" }).where("id", "=", p.id).execute(),
    ).rejects.toThrow(/dates are fixed/);
    await expectCode(
      run(viewer, leaveRequest, { leaveType: "annual", startDate: "2026-12-20", endDate: "2026-12-20" }),
      "FORBIDDEN",
    );
  });

  it("[TIM-LV-04] overlapping requested or approved leave is refused (LEAVE_OVERLAP, EXCLUDE backstop)", async () => {
    const u = await makeUser(t.db, { roles: ["staff"], teamId });
    await run<Leave>(u, leaveRequest, { leaveType: "annual", startDate: "2026-11-16", endDate: "2026-11-18" });
    await expectCode(
      run(u, leaveRequest, { leaveType: "sick", startDate: "2026-11-18", endDate: "2026-11-19" }),
      "LEAVE_OVERLAP",
    );
    await expect(
      t.db
        .insertInto("leave_requests")
        .values({ user_id: u.id, leave_type: "annual", start_date: "2026-11-17", end_date: "2026-11-17" })
        .execute(),
    ).rejects.toThrow(/leave_requests_no_overlap/);
    // Adjacent days are fine
    await run(u, leaveRequest, { leaveType: "sick", startDate: "2026-11-19", endDate: "2026-11-19" });
  });

  it("[TIM-LV-05] I cancel my own leave while pending (its approval is cancelled) or approved and not yet started", async () => {
    const u = await makeUser(t.db, { roles: ["staff"], teamId });
    const a = await run<Leave>(u, leaveRequest, { leaveType: "annual", startDate: "2026-11-23", endDate: "2026-11-23" });
    await expectCode(run(staff, leaveCancel, { id: a.id, expectedVersion: a.version }), "FORBIDDEN");
    const c = await run<{ status: string }>(u, leaveCancel, { id: a.id, expectedVersion: a.version });
    expect(c.status).toBe("cancelled");
    expect(
      (await t.db.selectFrom("approvals").select("status").where("id", "=", a.approvalId).executeTakeFirstOrThrow()).status,
    ).toBe("cancelled");
    // Cancelled leave no longer blocks the same days
    const b = await run<Leave>(u, leaveRequest, { leaveType: "annual", startDate: "2026-10-20", endDate: "2026-10-20" });
    await run(lead, approvalDecide, { id: b.approvalId, decision: "approve" });
    t.clock.set(pp("2026-10-20", "09:00")); // already started
    const cur = await t.db.selectFrom("leave_requests").select("version").where("id", "=", b.id).executeTakeFirstOrThrow();
    await expectCode(run(u, leaveCancel, { id: b.id, expectedVersion: cur.version }), "INVALID_TRANSITION");
    const mine = await run<{ status: string }[]>(u, leaveMine, {});
    expect(mine.map((x) => x.status)).toEqual(["approved", "cancelled"]);
  });

  it("[TIM-LV-06] routing and escalation skip an approver on approved leave that day; the next eligible one gets it (INV-18)", async () => {
    // Team without a lead: the leave chain starts at ops_lead. "Aaa Ops" is first alphabetically but on leave today.
    const t2 = await makeTeam(t.db, "Finance ops");
    const requester = await makeUser(t.db, { roles: ["staff"], teamId: t2.id });
    const out = await run<Leave>(ops, leaveRequest, { leaveType: "annual", startDate: "2026-10-26", endDate: "2026-10-27" });
    await run(director, approvalDecide, { id: out.approvalId, decision: "approve" });
    t.clock.set(pp("2026-10-26", "09:00"));
    const l = await run<Leave>(requester, leaveRequest, { leaveType: "sick", startDate: "2026-10-26", endDate: "2026-10-26" });
    expect(l.assigneeId).toBe(ops2.id);
    const ev = await t.db
      .selectFrom("approval_events")
      .select(["event", "assignee_id", "assignee_permission_ok"])
      .where("approval_id", "=", l.approvalId)
      .execute();
    expect(ev).toEqual([{ event: "created", assignee_id: ops2.id, assignee_permission_ok: true }]);
    // Escalation (overdue after 48 h) skips people on leave too: the director is away on the 28th, so nobody qualifies…
    const dl = await run<Leave>(director, leaveRequest, { leaveType: "annual", startDate: "2026-10-28", endDate: "2026-10-28" });
    await run(ops2, approvalDecide, { id: dl.approvalId, decision: "approve" });
    t.clock.set(pp("2026-10-28", "10:00"));
    await run(ESC, approvalEscalateOverdue, {});
    const held = await t.db
      .selectFrom("approvals")
      .select("assignee_id")
      .where("id", "=", l.approvalId)
      .executeTakeFirstOrThrow();
    expect(held.assignee_id).toBe(ops2.id);
    const events = await t.db
      .selectFrom("approval_events")
      .select("event")
      .where("approval_id", "=", l.approvalId)
      .orderBy("seq")
      .execute();
    expect(events.map((e) => e.event)).toEqual(["created", "no_eligible"]);
    // … and once the director is back, the next escalation reaches them.
    t.clock.set(pp("2026-10-30", "11:00"));
    await run(ESC, approvalEscalateOverdue, {});
    const a = await t.db.selectFrom("approvals").select("assignee_id").where("id", "=", l.approvalId).executeTakeFirstOrThrow();
    expect(a.assignee_id).toBe(director.id);
    // On a day with nobody on leave the first ops_lead is chosen again.
    t.clock.set(pp("2026-11-09", "09:00"));
    const again = await run<Leave>(requester, leaveRequest, {
      leaveType: "sick",
      startDate: "2026-11-10",
      endDate: "2026-11-10",
    });
    expect(again.assigneeId).toBe(ops.id);
  });

  it("[TIM-LV-07] my working calendar: working days minus holidays minus approved leave", async () => {
    const u = await makeUser(t.db, { roles: ["staff"], teamId });
    const l = await run<Leave>(u, leaveRequest, {
      leaveType: "annual",
      startDate: "2026-11-11",
      endDate: "2026-11-11",
      halfDay: "am",
    });
    await run(lead, approvalDecide, { id: l.approvalId, decision: "approve" });
    const c = await run<{
      workingDays: number;
      days: { date: string; workingDay: boolean; holiday: unknown; capacityMinutes: number }[];
    }>(u, timeCalendar, { from: "2026-11-09", to: "2026-11-15" });
    // Mon 9 Nov is Independence Day, Sun 15 is not a working day; Wed 11 is a half day.
    expect(c.workingDays).toBe(5);
    expect(c.days.find((d) => d.date === "2026-11-09")).toMatchObject({ workingDay: false, capacityMinutes: 0 });
    expect(c.days.find((d) => d.date === "2026-11-11")).toMatchObject({ workingDay: true, capacityMinutes: 240 });
    await expectCode(run(u, timeCalendar, { from: "2026-11-09", to: "2027-11-09" }), "VALIDATION");
  });
});
