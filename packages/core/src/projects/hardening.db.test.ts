// Regression tests for the independent review of the S3 backend.
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { acceptedProject, createTestDb, line, makeUser, runAs, type TestDb } from "@demoq/testkit";
import { approvalDecide } from "../approvals";
import { changeOrderCreate, changeOrderSave, changeOrderSubmit } from "../commercial";
import { DomainError, type OpDef, type UserActor } from "../kernel";
import { taskCancel, taskCreate, taskMove, taskSetDependency } from "../tasks";
import { bypassMonthlyReview, bypassRequest, monthSubjectId } from "./bypass";
import { gateSatisfy } from "./gates";
import { projectUpdate } from "./projects";

let t: TestDb;
let lead: UserActor, ops: UserActor, pm: UserActor, pm2: UserActor, director: UserActor, ceo: UserActor, staff: UserActor;
const job = { type: "job" as const, name: "test-job", grants: ["project.jobs" as const] };
const START = "2026-10-19T02:00:00Z";

beforeAll(async () => {
  t = await createTestDb(START);
  lead = await makeUser(t.db, { roles: ["account_lead"] });
  ops = await makeUser(t.db, { roles: ["ops_lead"] });
  pm = await makeUser(t.db, { roles: ["project_manager"] });
  pm2 = await makeUser(t.db, { roles: ["project_manager"] });
  director = await makeUser(t.db, { roles: ["director"] });
  ceo = await makeUser(t.db, { roles: ["ceo"] });
  staff = await makeUser(t.db, { roles: ["staff"] });
});
afterAll(() => t.destroy());
afterEach(() => t.clock.set(START));

const run = <T>(a: UserActor | typeof job, op: OpDef, input: unknown) => runAs<T>(t, a, op, input);
const expectCode = (p: Promise<unknown>, code: string) =>
  expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);
const pVersion = async (id: string) =>
  (await t.db.selectFrom("projects").select("version").where("id", "=", id).executeTakeFirstOrThrow()).version;
const tVersion = async (id: string) =>
  (await t.db.selectFrom("tasks").select("version").where("id", "=", id).executeTakeFirstOrThrow()).version;
const REASON = "Client launch date is fixed; contract is with their legal team.";

async function openProject() {
  const p = await acceptedProject(t, lead, { pmId: pm.id });
  for (const gate of ["contract", "purchase_order", "deposit_terms"])
    await run(pm, gateSatisfy, { projectId: p.projectId, gate, evidence: `REF-${gate}` });
  return p;
}
const task = (projectId: string, extra: Record<string, unknown> = {}) =>
  run<{ id: string; version: number; oosApprovalId: string | null }>(pm, taskCreate, {
    projectId,
    title: "Work",
    ownerId: staff.id,
    estimateMinutes: 60,
    dueDate: "2026-11-05",
    nonDeliverable: true,
    ...extra,
  });

describe("S3 review regressions", () => {
  it("[PRJ-BP-05] a new month's review never supersedes an undecided earlier one; two runs create one; late approvals are reviewed next month", async () => {
    const p = await acceptedProject(t, lead, { pmId: pm.id });
    const b = await run<{ id: string; approvalId: string }>(pm, bypassRequest, {
      projectId: p.projectId,
      gates: ["contract"],
      namedOwnerId: pm.id,
      reason: REASON,
      expiresOn: "2026-11-15",
    });
    t.clock.set("2026-11-02T01:00:00Z");
    const [a, bRun] = await Promise.all([
      run<{ approvalId: string }>(job, bypassMonthlyReview, { requesterId: ceo.id }),
      run<{ approvalId: string }>(job, bypassMonthlyReview, { requesterId: ceo.id }),
    ]);
    expect(a.approvalId).toBe(bRun.approvalId);
    // Approved on 3 Nov, after October's review ran: it belongs to November's review.
    t.clock.set("2026-11-03T03:00:00Z");
    await run(ops, approvalDecide, { id: b.approvalId, decision: "approve" });
    t.clock.set("2026-12-01T01:00:00Z");
    const dec = await run<{ approvalId: string }>(job, bypassMonthlyReview, { requesterId: ceo.id });
    const rows = await t.db
      .selectFrom("approvals")
      .select(["id", "status", "subject_id", "subject_hash"])
      .where("kind", "=", "bypass_review")
      .orderBy("subject_hash")
      .execute();
    expect(rows.map((r) => [r.subject_hash, r.status])).toEqual([
      ["2026-10-01", "pending"],
      ["2026-11-01", "pending"],
    ]);
    expect(rows[0]!.subject_id).toBe(monthSubjectId("2026-10-01"));
    await run(director, approvalDecide, { id: a.approvalId, decision: "approve" }); // October's can still be decided
    await run(director, approvalDecide, { id: dec.approvalId, decision: "reject" });
    expect(
      (
        await t.db
          .selectFrom("gate_bypasses")
          .select(["review_month", "review_outcome"])
          .where("id", "=", b.id)
          .executeTakeFirstOrThrow()
      ).review_month,
    ).toBe("2026-11-01");
  });

  it("[PRJ-PJ-04] a replaced PM loses every assigned right on the project", async () => {
    const p = await acceptedProject(t, lead, { pmId: pm.id });
    await run(ops, projectUpdate, { id: p.projectId, expectedVersion: await pVersion(p.projectId), projectManagerId: pm2.id });
    await expectCode(run(pm, gateSatisfy, { projectId: p.projectId, gate: "contract", evidence: "MSA-1" }), "FORBIDDEN");
    await expectCode(run(pm, changeOrderCreate, { projectId: p.projectId, title: "x" }), "FORBIDDEN");
    await run(pm2, gateSatisfy, { projectId: p.projectId, gate: "contract", evidence: "MSA-1" });
    const m = await t.db
      .selectFrom("project_members")
      .select(["user_id", "project_role"])
      .where("project_id", "=", p.projectId)
      .execute();
    expect(m.find((x) => x.user_id === pm.id)?.project_role).toBe("member");
  });

  it("[TSK-TK-05] concurrent dependency edits on one project do not deadlock", async () => {
    const p = await acceptedProject(t, lead, { pmId: pm.id });
    const ts: { id: string }[] = [];
    for (let n = 0; n < 8; n++) ts.push(await task(p.projectId, { title: `T${n}` }));
    const edges = [0, 2, 4, 6].map((n) => run(pm, taskSetDependency, { taskId: ts[n + 1]!.id, dependsOnId: ts[n]!.id }));
    const moves = [1, 3].map(async (n) => run(pm, taskCancel, { id: ts[n]!.id, expectedVersion: await tVersion(ts[n]!.id) }));
    const r = await Promise.allSettled([...edges, ...moves]);
    expect(r.filter((x) => x.status === "rejected")).toEqual([]);
  });

  it("[COM-CO-02] submitting below the floor does not reveal it to someone without cost access", async () => {
    const p = await acceptedProject(t, lead, { pmId: pm.id });
    const c = await run<{ id: string; version: number }>(lead, changeOrderCreate, { projectId: p.projectId, title: "Cheap" });
    const s = await run<{ version: number }>(lead, changeOrderSave, {
      id: c.id,
      expectedVersion: c.version,
      lines: [line("fee", 1, 10_000, 8_000)],
    });
    const r = await run<{ status: string; approvalId: string | null }>(pm, changeOrderSubmit, {
      id: c.id,
      expectedVersion: s.version,
    });
    expect(r).toMatchObject({ status: "submitted", approvalId: null });
    expect(
      (await t.db.selectFrom("change_orders").select("status").where("id", "=", c.id).executeTakeFirstOrThrow()).status,
    ).toBe("margin_review");
  });

  it("[PRJ-GT-05] DB backstop: a gated client task cannot go straight to done either", async () => {
    const p = await acceptedProject(t, lead, { pmId: pm.id });
    const x = await task(p.projectId);
    await expect(sql`UPDATE tasks SET status = 'done' WHERE id = ${x.id}`.execute(t.db)).rejects.toThrow(/GATE_BLOCKED/);
  });

  it("[PRJ-BP-06] DB backstop: created_at and expiry are fixed; a bypass opens only with its approved approval", async () => {
    const p = await acceptedProject(t, lead, { pmId: pm.id });
    const b = await run<{ id: string; approvalId: string }>(pm, bypassRequest, {
      projectId: p.projectId,
      gates: ["contract"],
      namedOwnerId: pm.id,
      reason: REASON,
      expiresOn: "2026-11-15",
    });
    await expect(
      sql`UPDATE gate_bypasses SET created_at = created_at + interval '20 days' WHERE id = ${b.id}`.execute(t.db),
    ).rejects.toThrow(/BYPASS_INVALID/);
    await expect(
      sql`UPDATE gate_bypasses SET status = 'open', approved_by = ${ops.id}, approved_at = now() WHERE id = ${b.id}`.execute(
        t.db,
      ),
    ).rejects.toThrow(/BYPASS_INVALID/);
    await run(ops, approvalDecide, { id: b.approvalId, decision: "approve" });
    await expect(
      sql`UPDATE gate_bypasses SET expires_at = expires_at + interval '1 day' WHERE id = ${b.id}`.execute(t.db),
    ).rejects.toThrow(/BYPASS_INVALID/);
  });

  it("[COM-CO-03] DB backstop: a change order is accepted only from sent", async () => {
    const p = await acceptedProject(t, lead, { pmId: pm.id });
    const c = await run<{ id: string }>(lead, changeOrderCreate, { projectId: p.projectId, title: "x" });
    await expect(sql`UPDATE change_orders SET status = 'accepted' WHERE id = ${c.id}`.execute(t.db)).rejects.toThrow(
      /QUOTE_LOCKED/,
    );
  });

  it("[TSK-TK-04] a cancelled prerequisite no longer blocks; [TSK-TK-02] cancelling a task withdraws its out-of-scope request", async () => {
    const p = await openProject();
    const a = await task(p.projectId, { title: "A" });
    const b = await task(p.projectId, { title: "B", dependsOn: [a.id] });
    await run(pm, taskCancel, { id: a.id, expectedVersion: await tVersion(a.id) });
    expect(
      (await run<{ status: string }>(staff, taskMove, { id: b.id, expectedVersion: await tVersion(b.id), to: "in_progress" }))
        .status,
    ).toBe("in_progress");
    const o = await task(p.projectId, { nonDeliverable: false, outOfScopeReason: "Client asked for an extra banner" });
    await run(pm, taskCancel, { id: o.id, expectedVersion: await tVersion(o.id) });
    expect(
      (await t.db.selectFrom("approvals").select("status").where("id", "=", o.oosApprovalId!).executeTakeFirstOrThrow()).status,
    ).toBe("superseded");
  });

  it("[COM-RT-01] a retainer's planned start moves only within its first month (periods are anchored to it)", async () => {
    const p = await acceptedProject(t, lead, {
      pmId: pm.id,
      billingModel: "retainer",
      periodMonths: 3,
      lines: [line("fee", 1, 200_000, 100_000, { perPeriod: true })],
      plannedStart: "2026-11-02",
    });
    await expectCode(
      run(pm, projectUpdate, { id: p.projectId, expectedVersion: await pVersion(p.projectId), plannedStart: "2026-12-01" }),
      "VALIDATION",
    );
    await run(pm, projectUpdate, { id: p.projectId, expectedVersion: await pVersion(p.projectId), plannedStart: "2026-11-09" });
  });
});
