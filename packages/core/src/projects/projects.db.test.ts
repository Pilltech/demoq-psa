import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { acceptedProject, createTestDb, makeUser, projectTypeId, runAs, type AcceptedProject, type TestDb } from "@demoq/testkit";
import { approvalDecide } from "../approvals";
import { DomainError, type OpDef, type UserActor } from "../kernel";
import { taskMove } from "../tasks";
import { bypassMonthlyReview, bypassRequest, bypassReviewReport, bypassSweep } from "./bypass";
import { clientGateExemption, gateSatisfy } from "./gates";
import {
  projectActivate,
  projectCancel,
  projectComplete,
  projectCreateInternal,
  projectGet,
  projectHold,
  projectList,
  projectResume,
  projectSetMember,
  projectUpdate,
} from "./projects";

let t: TestDb;
let lead: UserActor,
  ops: UserActor,
  pm: UserActor,
  otherPm: UserActor,
  director: UserActor,
  ceo: UserActor,
  finance: UserActor,
  staff: UserActor,
  admin: UserActor;
const job = { type: "job" as const, name: "test-job", grants: ["project.jobs" as const] };
const START = "2026-10-19T02:00:00Z";

beforeAll(async () => {
  t = await createTestDb(START);
  lead = await makeUser(t.db, { roles: ["account_lead"], name: "Sokha Lead" });
  ops = await makeUser(t.db, { roles: ["ops_lead"], name: "Vanna Ops" });
  pm = await makeUser(t.db, { roles: ["project_manager"], name: "Piseth PM" });
  otherPm = await makeUser(t.db, { roles: ["project_manager"] });
  director = await makeUser(t.db, { roles: ["director"], name: "Dina Director" });
  ceo = await makeUser(t.db, { roles: ["ceo"], name: "Chan CEO" });
  finance = await makeUser(t.db, { roles: ["finance"], name: "Sreymom Finance" });
  staff = await makeUser(t.db, { roles: ["staff"], name: "Bopha Staff" });
  admin = await makeUser(t.db, { roles: ["admin"] });
});
afterAll(() => t.destroy());
afterEach(() => t.clock.set(START));

const run = <T>(a: UserActor | typeof job, op: OpDef, input: unknown, channel?: "web" | "mcp" | "telegram") =>
  runAs<T>(t, a, op, input, channel);
const expectCode = (p: Promise<unknown>, code: string) =>
  expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);
const expectMissing = (p: Promise<unknown>, missing: string[]) =>
  expect(p).rejects.toSatisfy(
    (e: unknown) =>
      e instanceof DomainError && e.code === "GATE_BLOCKED" && JSON.stringify(e.params.missing) === JSON.stringify(missing),
  );

const project = () => acceptedProject(t, lead, { pmId: pm.id });
const version = async (id: string) =>
  (await t.db.selectFrom("projects").select("version").where("id", "=", id).executeTakeFirstOrThrow()).version;
async function satisfyAll(p: AcceptedProject, gates = ["contract", "purchase_order", "deposit_terms"]) {
  for (const gate of gates) await run(pm, gateSatisfy, { projectId: p.projectId, gate, evidence: `REF-${gate}` });
}
async function firstTask(projectId: string) {
  return t.db
    .selectFrom("tasks")
    .select(["id", "version", "owner_id"])
    .where("project_id", "=", projectId)
    .orderBy("rank")
    .executeTakeFirstOrThrow();
}
async function openBypass(p: AcceptedProject, gates = ["contract", "purchase_order", "deposit_terms"], expiresOn = "2026-11-10") {
  const b = await run<{ id: string; approvalId: string }>(pm, bypassRequest, {
    projectId: p.projectId,
    gates,
    namedOwnerId: pm.id,
    reason: "Client launch date is fixed; contract is with their legal team.",
    expiresOn,
  });
  await run(ops, approvalDecide, { id: b.approvalId, decision: "approve" });
  return b;
}

describe("projects/projects", () => {
  it("[PRJ-PJ-01] a project has a client or is internal, a type, a planned start, a PM and members with project roles", async () => {
    const p = await project();
    await run(pm, projectSetMember, { projectId: p.projectId, userId: staff.id, projectRole: "designer" });
    const g = await run<{
      kind: string;
      client_id: string;
      planned_start: string;
      pm_id: string;
      members: { user_id: string; project_role: string }[];
    }>(staff, projectGet, { id: p.projectId });
    expect(g).toMatchObject({ kind: "client", client_id: p.clientId, planned_start: "2026-11-02", pm_id: pm.id });
    expect(g.members.map((m) => [m.user_id, m.project_role]).sort()).toEqual(
      [
        [pm.id, "pm"],
        [staff.id, "designer"],
      ].sort(),
    );
    await expectCode(run(pm, projectSetMember, { projectId: p.projectId, userId: pm.id, projectRole: null }), "VALIDATION");
    await expectCode(
      run(pm, projectSetMember, { projectId: p.projectId, userId: staff.id, projectRole: "Bad Role" }),
      "VALIDATION",
    );
    const internal = await run<{ id: string }>(ops, projectCreateInternal, {
      name: "Agency website",
      projectTypeId: await projectTypeId(t),
      plannedStart: "2026-10-20",
      projectManagerId: pm.id,
    });
    expect((await run<{ kind: string; status: string }>(staff, projectGet, { id: internal.id })).status).toBe("active");
    // DB: a client project needs client, scope and engagement type.
    await expect(
      sql`INSERT INTO projects (kind, name, project_type_id, planned_start, pm_id, status) VALUES ('client', 'x', ${await projectTypeId(t)}, '2026-10-20', ${pm.id}, 'gated')`.execute(
        t.db,
      ),
    ).rejects.toThrow(/check/i);
  });

  it("[PRJ-PJ-02] gated → active only with every gate met (bypasses do not count); hold/resume; complete; cancel", async () => {
    const p = await project();
    await expectMissing(run(pm, projectActivate, { id: p.projectId, expectedVersion: await version(p.projectId) }), [
      "contract",
      "deposit_terms",
      "purchase_order",
    ]);
    await openBypass(p);
    await expectCode(run(pm, projectActivate, { id: p.projectId, expectedVersion: await version(p.projectId) }), "GATE_BLOCKED");
    await satisfyAll(p);
    const a = await run<{ status: string; version: number }>(pm, projectActivate, {
      id: p.projectId,
      expectedVersion: await version(p.projectId),
    });
    expect(a.status).toBe("active");
    const h = await run<{ status: string; version: number }>(pm, projectHold, { id: p.projectId, expectedVersion: a.version });
    expect(h.status).toBe("on_hold");
    await expectCode(run(pm, projectActivate, { id: p.projectId, expectedVersion: h.version }), "INVALID_TRANSITION");
    const r = await run<{ status: string; version: number }>(pm, projectResume, { id: p.projectId, expectedVersion: h.version });
    const c = await run<{ status: string; version: number }>(pm, projectComplete, {
      id: p.projectId,
      expectedVersion: r.version,
    });
    expect(c.status).toBe("completed");
    await expectCode(run(pm, projectCancel, { id: p.projectId, expectedVersion: c.version }), "INVALID_TRANSITION");
    const q = await project();
    expect(
      (await run<{ status: string }>(pm, projectCancel, { id: q.projectId, expectedVersion: await version(q.projectId) })).status,
    ).toBe("cancelled");
  });

  it("[PRJ-PJ-03] moving the planned start before activation moves template task due dates by the same days", async () => {
    const p = await project();
    const before = await t.db
      .selectFrom("tasks")
      .select(["id", "due_date"])
      .where("project_id", "=", p.projectId)
      .orderBy("rank")
      .execute();
    await run(pm, projectUpdate, { id: p.projectId, expectedVersion: await version(p.projectId), plannedStart: "2026-11-09" });
    const after = await t.db
      .selectFrom("tasks")
      .select(["id", "due_date"])
      .where("project_id", "=", p.projectId)
      .orderBy("rank")
      .execute();
    expect(after.map((x) => x.due_date)).toEqual(
      before.map((x) => {
        const d = new Date(`${x.due_date}T00:00:00Z`);
        d.setUTCDate(d.getUTCDate() + 7);
        return d.toISOString().slice(0, 10);
      }),
    );
    await satisfyAll(p);
    await run(pm, projectActivate, { id: p.projectId, expectedVersion: await version(p.projectId) });
    await expectCode(
      run(pm, projectUpdate, { id: p.projectId, expectedVersion: await version(p.projectId), plannedStart: "2026-11-16" }),
      "INVALID_TRANSITION",
    );
  });

  it("[PRJ-PJ-04] the project's PM or ops_lead manages it; every internal role views; others are refused", async () => {
    const p = await project();
    for (const a of [otherPm, staff, lead, admin])
      await expectCode(
        run(a, projectSetMember, { projectId: p.projectId, userId: staff.id, projectRole: "editor" }),
        "FORBIDDEN",
      );
    await run(ops, projectSetMember, { projectId: p.projectId, userId: staff.id, projectRole: "editor" });
    for (const a of [staff, finance, director, lead])
      expect((await run<{ id: string }>(a, projectGet, { id: p.projectId })).id).toBe(p.projectId);
    const mine = await run<{ id: string }[]>(staff, projectList, { mine: true });
    expect(mine.map((x) => x.id)).toContain(p.projectId);
    await expectCode(
      run(pm, projectCreateInternal, {
        name: "Mine",
        projectTypeId: await projectTypeId(t),
        plannedStart: "2026-10-20",
        projectManagerId: pm.id,
      }),
      "FORBIDDEN",
    );
  });
});

describe("projects/gates", () => {
  it("[PRJ-GT-01] every client project has five gates; scope and quote are satisfied by the acceptance", async () => {
    const p = await project();
    const g = await run<{ gates: { gate: string; status: string; evidence: string | null }[] }>(staff, projectGet, {
      id: p.projectId,
    });
    expect(g.gates).toHaveLength(5);
    expect(
      g.gates
        .filter((x) => x.status === "satisfied")
        .map((x) => x.gate)
        .sort(),
    ).toEqual(["quote", "scope"]);
    expect(g.gates.find((x) => x.gate === "quote")?.evidence).toMatch(/accepted/);
  });

  it("[PRJ-GT-02] PM or ops satisfies a gate with evidence (3+ characters); who and when are recorded", async () => {
    const p = await project();
    await expectCode(run(pm, gateSatisfy, { projectId: p.projectId, gate: "contract", evidence: "ab" }), "VALIDATION");
    for (const a of [otherPm, staff, lead])
      await expectCode(
        run(a, gateSatisfy, { projectId: p.projectId, gate: "contract", evidence: "Signed MSA #12" }),
        "FORBIDDEN",
      );
    await expectCode(run(pm, gateSatisfy, { projectId: p.projectId, gate: "scope", evidence: "nope" }), "VALIDATION");
    const r = await run<{ missing: string[] }>(pm, gateSatisfy, {
      projectId: p.projectId,
      gate: "contract",
      evidence: "Signed MSA #12",
    });
    expect(r.missing).toEqual(["deposit_terms", "purchase_order"]);
    await run(ops, gateSatisfy, {
      projectId: p.projectId,
      gate: "deposit_terms",
      evidence: "50% on signature, email 2026-10-18",
    });
    const row = await t.db
      .selectFrom("project_gates")
      .selectAll()
      .where("project_id", "=", p.projectId)
      .where("gate", "=", "contract")
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ status: "satisfied", evidence: "Signed MSA #12", satisfied_by: pm.id });
    expect(row.satisfied_at).toBeTruthy();
  });

  it("[PRJ-GT-03] the PO gate is waived only by a Finance/Ops client exemption with a reason; the DB refuses otherwise", async () => {
    const p = await project();
    await expectCode(run(pm, clientGateExemption, { clientId: p.clientId, reason: "Client never issues POs" }), "FORBIDDEN");
    await expectCode(run(finance, clientGateExemption, { clientId: p.clientId, reason: "short" }), "VALIDATION");
    await expect(
      sql`UPDATE project_gates SET status = 'not_applicable' WHERE project_id = ${p.projectId} AND gate = 'contract'`.execute(
        t.db,
      ),
    ).rejects.toThrow(/project_gates_exemption_required/);
    await expect(
      sql`UPDATE project_gates SET status = 'not_applicable' WHERE project_id = ${p.projectId} AND gate = 'purchase_order'`.execute(
        t.db,
      ),
    ).rejects.toThrow(/project_gates_exemption_required/);
    await run(finance, clientGateExemption, {
      clientId: p.clientId,
      reason: "Government client: pays on invoice, never issues POs",
    });
    const po = await t.db
      .selectFrom("project_gates")
      .select(["status", "exemption_id"])
      .where("project_id", "=", p.projectId)
      .where("gate", "=", "purchase_order")
      .executeTakeFirstOrThrow();
    expect(po.status).toBe("not_applicable");
    expect(po.exemption_id).toBeTruthy();
    // New projects of the same client start with the PO gate not applicable.
    const again = await t.db.selectFrom("projects").select("client_id").where("id", "=", p.projectId).executeTakeFirstOrThrow();
    expect(again.client_id).toBe(p.clientId);
  });

  it("[PRJ-GT-04] no work before the gates: starting a task lists the missing gates; an open bypass covering them allows it", async () => {
    const p = await project();
    const task = await firstTask(p.projectId);
    for (const channel of ["web", "mcp"] as const) {
      await expectMissing(run(pm, taskMove, { id: task.id, expectedVersion: task.version, to: "in_progress" }, channel), [
        "contract",
        "deposit_terms",
        "purchase_order",
      ]);
    }
    await run(pm, gateSatisfy, { projectId: p.projectId, gate: "contract", evidence: "MSA-7" });
    await expectMissing(run(pm, taskMove, { id: task.id, expectedVersion: task.version, to: "in_progress" }), [
      "deposit_terms",
      "purchase_order",
    ]);
    await openBypass(p, ["deposit_terms", "purchase_order"]);
    const r = await run<{ status: string }>(pm, taskMove, { id: task.id, expectedVersion: task.version, to: "in_progress" });
    expect(r.status).toBe("in_progress");
  });

  it("[PRJ-GT-05] DB backstop: a client task cannot enter in_progress while a gate is missing and uncovered", async () => {
    const p = await project();
    const task = await firstTask(p.projectId);
    await expect(sql`UPDATE tasks SET status = 'in_progress' WHERE id = ${task.id}`.execute(t.db)).rejects.toThrow(
      /tasks_gate_blocked|GATE_BLOCKED/,
    );
    await satisfyAll(p);
    await sql`UPDATE tasks SET status = 'in_progress' WHERE id = ${task.id}`.execute(t.db);
  });
});

describe("projects/bypass", () => {
  it("[PRJ-BP-01] a bypass names missing gates, an active owner, a 30+ character reason and an expiry within 30 days; it creates a gate_bypass approval", async () => {
    const p = await project();
    const base = {
      projectId: p.projectId,
      gates: ["contract"],
      namedOwnerId: pm.id,
      reason: "Client launch date is fixed; contract is with legal.",
      expiresOn: "2026-11-10",
    };
    await expectCode(run(pm, bypassRequest, { ...base, reason: "Too short a reason" }), "BYPASS_INVALID");
    await expectCode(run(pm, bypassRequest, { ...base, expiresOn: "2026-11-19" }), "BYPASS_INVALID"); // 31 days
    await expectCode(run(pm, bypassRequest, { ...base, expiresOn: "2026-10-19" }), "BYPASS_INVALID"); // today
    await expectCode(run(pm, bypassRequest, { ...base, gates: ["scope"] }), "BYPASS_INVALID"); // not missing
    const inactive = await makeUser(t.db, { roles: ["staff"] });
    await t.migrator.updateTable("users").set({ active: false }).where("id", "=", inactive.id).execute();
    await expectCode(run(pm, bypassRequest, { ...base, namedOwnerId: inactive.id }), "BYPASS_INVALID");
    await expectCode(run(staff, bypassRequest, base), "FORBIDDEN");
    const b = await run<{ id: string; approvalId: string }>(pm, bypassRequest, { ...base, expiresOn: "2026-11-18" });
    const a = await t.db.selectFrom("approvals").selectAll().where("id", "=", b.approvalId).executeTakeFirstOrThrow();
    expect(a).toMatchObject({
      kind: "gate_bypass",
      subject_type: "gate_bypass",
      subject_id: b.id,
      required_permission: "project.bypass.approve",
      assignee_id: ops.id,
      status: "pending",
    });
  });

  it("[PRJ-BP-02] an eligible person decides (not the requester, not in MCP); approval opens it, rejection closes it", async () => {
    const p = await project();
    const b = await run<{ id: string; approvalId: string }>(pm, bypassRequest, {
      projectId: p.projectId,
      gates: ["contract"],
      namedOwnerId: pm.id,
      reason: "Client launch date is fixed; contract is with legal.",
      expiresOn: "2026-11-10",
    });
    await expectCode(run(pm, approvalDecide, { id: b.approvalId, decision: "approve" }), "SELF_APPROVAL");
    await expectCode(run(staff, approvalDecide, { id: b.approvalId, decision: "approve" }), "FORBIDDEN");
    await expectCode(run(director, approvalDecide, { id: b.approvalId, decision: "approve" }, "mcp"), "DECIDE_IN_APP");
    await run(director, approvalDecide, { id: b.approvalId, decision: "approve" });
    expect(
      await t.db.selectFrom("gate_bypasses").select(["status", "approved_by"]).where("id", "=", b.id).executeTakeFirstOrThrow(),
    ).toEqual({ status: "open", approved_by: director.id });
    const b2 = await run<{ id: string; approvalId: string }>(pm, bypassRequest, {
      projectId: p.projectId,
      gates: ["deposit_terms"],
      namedOwnerId: pm.id,
      reason: "Deposit terms are agreed verbally, paperwork this week.",
      expiresOn: "2026-11-10",
    });
    await run(ops, approvalDecide, { id: b2.approvalId, decision: "reject" });
    expect(
      (await t.db.selectFrom("gate_bypasses").select("status").where("id", "=", b2.id).executeTakeFirstOrThrow()).status,
    ).toBe("rejected");
  });

  it("[PRJ-BP-03] an open bypass lets work start on the gates it covers, until it expires", async () => {
    const p = await project();
    await openBypass(p, ["contract", "purchase_order", "deposit_terms"], "2026-10-25");
    const [t1, t2] = await t.db
      .selectFrom("tasks")
      .select(["id", "version"])
      .where("project_id", "=", p.projectId)
      .orderBy("rank")
      .limit(2)
      .execute();
    expect(
      (await run<{ status: string }>(pm, taskMove, { id: t1!.id, expectedVersion: t1!.version, to: "in_progress" })).status,
    ).toBe("in_progress");
    t.clock.set("2026-10-26T02:00:00Z"); // past expiry (end of 25 Oct in Phnom Penh)
    await expectCode(run(pm, taskMove, { id: t2!.id, expectedVersion: t2!.version, to: "in_progress" }), "GATE_BLOCKED");
  });

  it("[PRJ-BP-04] the hourly job closes expired bypasses and those whose gates are all met", async () => {
    const p1 = await project();
    const b1 = await openBypass(p1, ["contract"], "2026-10-21");
    const p2 = await project();
    const b2 = await openBypass(p2, ["contract"], "2026-11-10");
    await run(pm, gateSatisfy, { projectId: p2.projectId, gate: "contract", evidence: "MSA-9" });
    t.clock.set("2026-10-22T02:00:00Z");
    await run(job, bypassSweep, {});
    const rows = await t.db
      .selectFrom("gate_bypasses")
      .select(["id", "status", "close_cause"])
      .where("id", "in", [b1.id, b2.id])
      .execute();
    expect(rows.find((r) => r.id === b1.id)).toMatchObject({ status: "closed", close_cause: "expired" });
    expect(rows.find((r) => r.id === b2.id)).toMatchObject({ status: "closed", close_cause: "gates_met" });
    await expectCode(run(ops, bypassSweep, {}), "FORBIDDEN");
  });

  it("[PRJ-BP-05] monthly: one bypass_review approval per month for directors; the report lists bypasses and exemptions; the decision records the outcome", async () => {
    const p = await project();
    const b = await openBypass(p, ["contract"], "2026-11-10");
    await run(finance, clientGateExemption, { clientId: p.clientId, reason: "Client never issues purchase orders" });
    const report = await run<{ bypasses: { id: string }[]; exemptions: { client_name: string }[] }>(
      director,
      bypassReviewReport,
      { month: "2026-10-01" },
    );
    expect(report.bypasses.map((x) => x.id)).toContain(b.id);
    expect(report.exemptions.length).toBeGreaterThan(0);
    await expectCode(run(pm, bypassReviewReport, { month: "2026-10-01" }), "FORBIDDEN");
    t.clock.set("2026-11-02T01:00:00Z");
    const r1 = await run<{ created: boolean; approvalId: string }>(job, bypassMonthlyReview, { requesterId: ceo.id });
    const r2 = await run<{ created: boolean; approvalId: string }>(job, bypassMonthlyReview, { requesterId: ceo.id });
    expect(r1.created).toBe(true);
    expect(r2).toEqual({ created: false, approvalId: r1.approvalId });
    const a = await t.db.selectFrom("approvals").selectAll().where("id", "=", r1.approvalId).executeTakeFirstOrThrow();
    expect(a).toMatchObject({ kind: "bypass_review", requested_by: ceo.id, subject_hash: "2026-10-01" });
    await run(director, approvalDecide, { id: a.id, decision: "approve" });
    const row = await t.db
      .selectFrom("gate_bypasses")
      .select(["review_month", "review_outcome"])
      .where("id", "=", b.id)
      .executeTakeFirstOrThrow();
    expect(row).toEqual({ review_month: "2026-10-01", review_outcome: "accepted by Dina Director" });
  });

  it("[PRJ-BP-06] DB backstop: reason length, expiry window and a human approver other than the requester", async () => {
    const p = await project();
    const ins = (over: string) =>
      sql.raw(`INSERT INTO gate_bypasses (project_id, gates, named_owner_id, reason, requested_by, expires_at, created_at, status, approved_by)
               VALUES ('${p.projectId}', '{contract}', '${pm.id}', ${over})`);
    const good = "'A reason that is certainly longer than thirty chars'";
    await expect(ins(`'short', '${pm.id}', now() + interval '1 day', now(), 'requested', NULL`).execute(t.db)).rejects.toThrow(
      /gate_bypasses_reason/,
    );
    await expect(ins(`${good}, '${pm.id}', now() + interval '31 days', now(), 'requested', NULL`).execute(t.db)).rejects.toThrow(
      /gate_bypasses_expiry/,
    );
    await expect(ins(`${good}, '${pm.id}', now() + interval '1 day', now(), 'open', NULL`).execute(t.db)).rejects.toThrow(
      /gate_bypasses_approved_by_human/,
    );
    await expect(ins(`${good}, '${pm.id}', now() + interval '1 day', now(), 'open', '${pm.id}'`).execute(t.db)).rejects.toThrow(
      /gate_bypasses_approved_by_human/,
    );
    await ins(`${good}, '${pm.id}', now() + interval '1 day', now(), 'open', '${ops.id}'`).execute(t.db);
  });
});
