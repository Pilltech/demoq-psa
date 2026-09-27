import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, engagementTypeId, line, makeClient, makeDeal, makeUser, meta, type TestDb } from "@demoq/testkit";
import { quoteCreate, quoteSave, quoteSubmit } from "../commercial";
import { DomainError, execute, type OpDef, type RequestMeta, type UserActor } from "../kernel";
import { approvalDecide, approvalEscalateOverdue, approvalGet, approvalInbox } from "./commands";

let t: TestDb;
let lead: UserActor,
  finance: UserActor,
  finance2: UserActor,
  ops: UserActor,
  director: UserActor,
  staff: UserActor,
  viewer: UserActor;
let campaign: string;
const job = { type: "job" as const, name: "job:escalation", grants: ["approval.escalate"] as const };

beforeAll(async () => {
  t = await createTestDb();
  ops = await makeUser(t.db, { roles: ["ops_lead"], name: "Vanna Ops" });
  finance = await makeUser(t.db, { roles: ["finance"], name: "Aaa Finance" });
  finance2 = await makeUser(t.db, { roles: ["finance"], name: "Zzz Finance" });
  director = await makeUser(t.db, { roles: ["director"], name: "Dir" });
  lead = await makeUser(t.db, { roles: ["account_lead"], name: "Sokha Lead" });
  staff = await makeUser(t.db, { roles: ["staff"] });
  viewer = await makeUser(t.db, { roles: ["viewer"] });
  campaign = await engagementTypeId(t.db, "campaign");
});
afterAll(() => t.destroy());

const run = <T>(a: UserActor | typeof job, op: OpDef, input: unknown, extra: Partial<RequestMeta> = {}) =>
  execute(t.kernel, meta(a as UserActor, extra.channel ?? "web", extra), op, input) as Promise<T>;
const expectCode = (p: Promise<unknown>, code: string) =>
  expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);

/** A below-floor quote from `who`, submitted → returns the margin_floor approval id. */
async function belowFloor(who: UserActor = lead, unitCost = 4100) {
  const client = await makeClient(t.db, who.id);
  const deal = await makeDeal(t.db, client.id, who.id);
  const q = await run<{ id: string; version: number }>(who, quoteCreate, {
    dealId: deal.id,
    title: "Low margin",
    engagementTypeId: campaign,
  });
  const s = await run<{ version: number }>(who, quoteSave, {
    id: q.id,
    expectedVersion: q.version,
    lines: [line("fee", 10, 5000, unitCost)],
  });
  const r = await run<{ approvalId: string }>(who, quoteSubmit, { id: q.id, expectedVersion: s.version });
  return { approvalId: r.approvalId, quoteId: q.id };
}
const approval = (id: string) => t.db.selectFrom("approvals").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

describe("approvals/engine", () => {
  beforeEach(() => t.clock.set("2026-11-02T02:00:00Z"));

  it("[APR-EN-01] one pending approval per kind and subject, with a snapshot", async () => {
    const { approvalId, quoteId } = await belowFloor();
    const a = await approval(approvalId);
    expect(a).toMatchObject({ status: "pending", subject_type: "quote", subject_id: quoteId, escalation_level: 0 });
    expect((a.snapshot as { title: string }).title).toMatch(/Low margin/);
    await expect(
      t.db
        .insertInto("approvals")
        .values({ ...a, id: undefined, created_at: undefined, updated_at: undefined } as never)
        .execute(),
    ).rejects.toThrow(/approvals_one_pending/);
  });

  it("[APR-EN-02] margin_floor policy: quote.approve_below_floor, chain finance → ops_lead, 24 h", async () => {
    const p = await t.db.selectFrom("approval_policies").selectAll().where("kind", "=", "margin_floor").executeTakeFirstOrThrow();
    expect(p).toMatchObject({
      required_permission: "quote.approve_below_floor",
      chain: ["finance", "ops_lead"],
      sla_minutes: 1440,
    });
    const { approvalId } = await belowFloor();
    const a = await approval(approvalId);
    expect(a.due_at.getTime() - t.clock.now.getTime()).toBe(24 * 3600_000);
  });

  it("[APR-EN-03] the assignee holds the permission; the requester's manager is preferred; no one eligible → fallback, else alert", async () => {
    // Manager-line preference: finance2 is Sokha's manager.
    await t.migrator.updateTable("users").set({ manager_id: finance2.id }).where("id", "=", lead.id).execute();
    const a1 = await approval((await belowFloor()).approvalId);
    expect(a1.assignee_id).toBe(finance2.id);
    await t.migrator.updateTable("users").set({ manager_id: null }).where("id", "=", lead.id).execute();
    const a2 = await approval((await belowFloor()).approvalId);
    expect(a2.assignee_id).toBe(finance.id); // alphabetical among finance
    const ev = await t.db.selectFrom("approval_events").selectAll().where("approval_id", "=", a2.id).executeTakeFirstOrThrow();
    expect(ev).toMatchObject({ event: "created", assignee_permission_ok: true });

    // Nobody in the chain is active: fallback approver, and if none, an alert.
    await t.migrator.updateTable("users").set({ active: false }).where("id", "in", [finance.id, finance2.id, ops.id]).execute();
    const none = await approval((await belowFloor()).approvalId);
    expect(none.assignee_id).toBeNull();
    const alert = await t.db.selectFrom("outbox").select("event").where("event", "=", "approval.no_eligible_approver").execute();
    expect(alert.length).toBeGreaterThan(0);
    await t.migrator.updateTable("users").set({ active: true }).where("id", "in", [finance.id, finance2.id, ops.id]).execute();
  });

  it("[APR-EN-03] a chain step whose role lacks the permission is skipped (director never gets margin_floor)", async () => {
    await t.migrator
      .updateTable("approval_policies")
      .set({ chain: ["director", "ops_lead"] })
      .where("kind", "=", "margin_floor")
      .execute();
    const a = await approval((await belowFloor()).approvalId);
    expect(a.assignee_id).toBe(ops.id);
    await t.migrator
      .updateTable("approval_policies")
      .set({ chain: ["finance", "ops_lead"] })
      .where("kind", "=", "margin_floor")
      .execute();
  });

  it("[APR-EN-04] the requester can never decide, even when they hold the permission; the DB refuses too", async () => {
    const { approvalId } = await belowFloor(ops); // ops requests: ops holds quote.approve_below_floor
    await expectCode(run(ops, approvalDecide, { id: approvalId, decision: "approve" }), "SELF_APPROVAL");
    await expect(
      t.db
        .updateTable("approvals")
        .set({ status: "approved", decided_by: ops.id, decided_at: t.clock.now })
        .where("id", "=", approvalId)
        .execute(),
    ).rejects.toThrow(/approvals_no_self_approval/);
    const a = await approval(approvalId);
    expect(a.assignee_id).not.toBe(ops.id);
  });

  it("[APR-EN-05] any active holder decides, including a non-assignee; others are refused", async () => {
    const { approvalId } = await belowFloor();
    await expectCode(run(director, approvalDecide, { id: approvalId, decision: "approve" }), "FORBIDDEN");
    await expectCode(run(staff, approvalDecide, { id: approvalId, decision: "approve" }), "FORBIDDEN");
    const r = await run<{ status: string }>(finance2, approvalDecide, {
      id: approvalId,
      decision: "reject",
      note: "Rework the fee",
    });
    expect(r.status).toBe("rejected");
    const q = await t.db
      .selectFrom("quotes")
      .select("status")
      .where("id", "=", (await approval(approvalId)).subject_id)
      .executeTakeFirstOrThrow();
    expect(q.status).toBe("draft");
  });

  it("[APR-EN-06] two approvers at the same moment: exactly one wins", async () => {
    const { approvalId } = await belowFloor();
    const results = await Promise.allSettled([
      run(finance, approvalDecide, { id: approvalId, decision: "approve" }),
      run(ops, approvalDecide, { id: approvalId, decision: "reject" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const loser = results.find((r): r is PromiseRejectedResult => r.status === "rejected")!;
    expect((loser.reason as DomainError).code).toBe("ALREADY_DECIDED");
    const events = await t.db
      .selectFrom("approval_events")
      .select("event")
      .where("approval_id", "=", approvalId)
      .where("event", "in", ["approved", "rejected"])
      .execute();
    expect(events).toHaveLength(1);
  });

  it("[APR-EN-07] a superseded approval cannot be decided", async () => {
    const { approvalId, quoteId } = await belowFloor();
    const q = await t.db.selectFrom("quotes").select("version").where("id", "=", quoteId).executeTakeFirstOrThrow();
    await run(lead, quoteSave, { id: quoteId, expectedVersion: q.version, title: "Changed after submit" });
    expect((await approval(approvalId)).status).toBe("superseded");
    await expectCode(run(finance, approvalDecide, { id: approvalId, decision: "approve" }), "ALREADY_DECIDED");
  });

  it("[APR-EN-08] overdue approvals move up the chain once, even when the job runs twice at the same time", async () => {
    const { approvalId } = await belowFloor();
    const before = await approval(approvalId);
    expect(before.assignee_id).toBe(finance.id);
    t.clock.advance(25 * 3600_000);
    const [r1, r2] = await Promise.all([
      run<{ moved: number }>(job, approvalEscalateOverdue, {}, { channel: "job" }),
      run<{ moved: number }>(job, approvalEscalateOverdue, {}, { channel: "job" }),
    ]);
    const after = await approval(approvalId);
    expect(after).toMatchObject({ assignee_id: ops.id, escalation_level: 1 });
    expect(r1.moved + r2.moved).toBeGreaterThanOrEqual(1);
    const hops = await t.db
      .selectFrom("approval_events")
      .select("event")
      .where("approval_id", "=", approvalId)
      .where("event", "=", "escalated")
      .execute();
    expect(hops).toHaveLength(1);
    // Earlier assignee may still decide (APR-EN-05).
    await run(finance, approvalDecide, { id: approvalId, decision: "approve" });
    // Only jobs escalate.
    await expectCode(run(ops, approvalEscalateOverdue, {}), "FORBIDDEN");
  });

  it("[APR-EN-09] margin_floor cannot be decided over MCP", async () => {
    const { approvalId } = await belowFloor();
    await expectCode(run(finance, approvalDecide, { id: approvalId, decision: "approve" }, { channel: "mcp" }), "DECIDE_IN_APP");
    expect((await approval(approvalId)).status).toBe("pending");
  });

  it("[APR-EN-10] the decision handler runs in the same transaction (approve → quote ready)", async () => {
    const { approvalId, quoteId } = await belowFloor();
    await run(finance, approvalDecide, { id: approvalId, decision: "approve" });
    const q = await t.db.selectFrom("quotes").select("status").where("id", "=", quoteId).executeTakeFirstOrThrow();
    expect(q.status).toBe("ready");
  });

  it("[APR-EN-11] the inbox shows what I may decide and what I asked for; costs only to cost-holders", async () => {
    const { approvalId } = await belowFloor();
    type Row = { id: string; canDecide: boolean; mine: boolean; costs: unknown; assignedToMe: boolean };
    const fin = await run<Row[]>(finance, approvalInbox, {});
    const mineF = fin.find((r) => r.id === approvalId)!;
    expect(mineF).toMatchObject({ canDecide: true, assignedToMe: true });
    expect(mineF.costs).toMatchObject({ feeFloorBp: 2500 });
    const own = (await run<Row[]>(lead, approvalInbox, {})).find((r) => r.id === approvalId)!;
    expect(own).toMatchObject({ mine: true, canDecide: false });
    expect((await run<Row[]>(staff, approvalInbox, {})).find((r) => r.id === approvalId)).toBeUndefined();
    expect((await run<Row[]>(viewer, approvalInbox, {})).find((r) => r.id === approvalId)).toBeUndefined();
    await expectCode(run(staff, approvalGet, { id: approvalId }), "NOT_FOUND");
    const detail = await run<{ events: { event: string }[] }>(finance, approvalGet, { id: approvalId });
    expect(detail.events.map((e) => e.event)).toEqual(["created"]);
  });

  it("[APR-EN-12] approving far below the floor on the web needs a recent TOTP step-up", async () => {
    const { approvalId } = await belowFloor(lead, 4600); // 8% margin: 17 points under 25%
    await expectCode(run(finance, approvalDecide, { id: approvalId, decision: "approve" }), "STEP_UP_REQUIRED");
    await expectCode(
      run(
        finance,
        approvalDecide,
        { id: approvalId, decision: "approve" },
        { stepUpAt: new Date(t.clock.now.getTime() - 20 * 60_000) },
      ),
      "STEP_UP_REQUIRED",
    );
    // Rejecting never needs step-up; approving with a fresh step-up works.
    const r = await run<{ status: string }>(
      finance,
      approvalDecide,
      { id: approvalId, decision: "approve" },
      { stepUpAt: t.clock.now },
    );
    expect(r.status).toBe("approved");
  });
});
