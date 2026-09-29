import { sql } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  acceptedProject,
  createTestDb,
  line,
  makeTeam,
  makeUser,
  runAs,
  type AcceptedProject,
  type TestDb,
} from "@demoq/testkit";
import { approvalDecide, approvalInbox } from "../approvals";
import { changeOrderAccept, changeOrderCreate, changeOrderSave, changeOrderSend, changeOrderSubmit } from "../commercial";
import { DomainError, type OpDef, type UserActor } from "../kernel";
import { gateSatisfy, projectActivate } from "../projects";
import { absorbedValueUsdMinor } from "../reporting";
import { taskClientAccept, taskMarkSent, taskRequestRevision, taskSubmitQc } from "./delivery";
import { taskBoard, taskCancel, taskCreate, taskGet, taskMine, taskMove, taskUpdate } from "./tasks";

let t: TestDb;
let lead: UserActor,
  pm: UserActor,
  otherPm: UserActor,
  teamLead: UserActor,
  otherTeamLead: UserActor,
  leadOwner: UserActor,
  designer: UserActor,
  outsider: UserActor,
  ops: UserActor;

beforeAll(async () => {
  t = await createTestDb();
  const design = await makeTeam(t.db, "Design");
  const video = await makeTeam(t.db, "Video");
  lead = await makeUser(t.db, { roles: ["account_lead"], name: "Sokha Lead" });
  pm = await makeUser(t.db, { roles: ["project_manager"], name: "Piseth PM" });
  otherPm = await makeUser(t.db, { roles: ["project_manager"], name: "Other PM" });
  teamLead = await makeUser(t.db, { roles: ["team_lead"], teamId: design.id, name: "Rith Lead" });
  otherTeamLead = await makeUser(t.db, { roles: ["team_lead"], teamId: video.id, name: "Bona Video Lead" });
  // A team lead who owns tasks: holds task.quality_approve for their team, and sorts first among candidates.
  leadOwner = await makeUser(t.db, { roles: ["team_lead"], teamId: design.id, name: "Aaa Lead Owner" });
  designer = await makeUser(t.db, { roles: ["staff"], teamId: design.id, name: "Designer" });
  outsider = await makeUser(t.db, { roles: ["staff"], teamId: video.id });
  ops = await makeUser(t.db, { roles: ["ops_lead"], name: "Vanna Ops" });
});
afterAll(() => t.destroy());

const run = <T>(a: UserActor, op: OpDef, input: unknown, channel?: "web" | "mcp") => runAs<T>(t, a, op, input, channel);
const expectCode = (p: Promise<unknown>, code: string) =>
  expect(p).rejects.toSatisfy((e: unknown) => e instanceof DomainError && e.code === code);

type Task = { id: string; version: number; status: string; revision_round?: number; oos_status?: string };
async function openProject(opts: Parameters<typeof acceptedProject>[2] = {}) {
  const p = await acceptedProject(t, lead, { pmId: pm.id, ...opts });
  for (const gate of ["contract", "purchase_order", "deposit_terms"])
    await run(pm, gateSatisfy, { projectId: p.projectId, gate, evidence: `REF-${gate}` });
  return p;
}
const feeItem = async (p: AcceptedProject, n = 0) =>
  (
    await t.db
      .selectFrom("scope_items")
      .select("id")
      .where("scope_id", "=", p.scopeId)
      .where("kind", "=", "fee")
      .orderBy("created_at")
      .orderBy("description_en")
      .offset(n)
      .limit(1)
      .executeTakeFirstOrThrow()
  ).id;
const newTask = async (p: AcceptedProject, extra: Record<string, unknown> = {}, owner: UserActor = designer) =>
  run<Task & { oosApprovalId: string | null }>(pm, taskCreate, {
    projectId: p.projectId,
    title: "Key visual",
    ownerId: owner.id,
    estimateMinutes: 240,
    dueDate: "2026-11-05",
    scopeItemId: await feeItem(p),
    clientFacing: true,
    ...extra,
  });
const row = (id: string) => t.db.selectFrom("tasks").selectAll().where("id", "=", id).executeTakeFirstOrThrow();
const v = async (id: string) => (await row(id)).version;
const approval = (id: string) => t.db.selectFrom("approvals").selectAll().where("id", "=", id).executeTakeFirstOrThrow();

async function start(id: string, owner: UserActor = designer) {
  return run<Task>(owner, taskMove, { id, expectedVersion: await v(id), to: "in_progress" });
}
async function submitQc(id: string, a: UserActor = designer) {
  return run<Task & { qualityApprovalId: string; assigneeId: string | null }>(a, taskSubmitQc, {
    id,
    expectedVersion: await v(id),
  });
}
const decide = (a: UserActor, id: string, decision: "approve" | "reject", extra: Record<string, unknown> = {}, ch?: "mcp") =>
  run<{ status: string }>(a, approvalDecide, { id, decision, ...extra }, ch);
async function markSent(id: string, a: UserActor = designer) {
  return run<Task>(a, taskMarkSent, { id, expectedVersion: await v(id), sentReference: "KV_v3.pdf via Telegram" });
}
async function revise(id: string, extra: Record<string, unknown> = {}, a: UserActor = pm, ch?: "mcp") {
  return run<Task & { outOfScopeApprovalId: string | null }>(
    a,
    taskRequestRevision,
    { id, expectedVersion: await v(id), note: "Client wants a warmer palette", ...extra },
    ch,
  );
}
/** in_progress → QC approved by the team lead → sent: the task waits in client_review. */
async function deliver(id: string) {
  const q = await submitQc(id);
  await decide(teamLead, q.qualityApprovalId, "approve");
  return markSent(id);
}
/** A client-facing task in client_review at round 3 (three normal rounds used). */
async function atRound3(p?: AcceptedProject) {
  const x = await newTask(p ?? (await openProject()));
  await start(x.id);
  await deliver(x.id);
  for (let r = 1; r <= 3; r++) {
    await revise(x.id);
    await deliver(x.id);
  }
  expect(await row(x.id)).toMatchObject({ status: "client_review", revision_round: 3 });
  return x;
}
async function round4Request(id: string, reworkMinutes = 120) {
  const r = await revise(id, { reworkMinutes, note: "Client wants a completely new concept" });
  return r.outOfScopeApprovalId!;
}

describe("tasks/delivery", () => {
  it("[TSK-DL-01] client-facing work goes through review, sent and client review; non-client-facing may finish directly", async () => {
    const p = await openProject();
    const x = await newTask(p);
    await start(x.id);
    await expectCode(run(designer, taskMove, { id: x.id, expectedVersion: await v(x.id), to: "done" }), "QC_REQUIRED");
    await expectCode(markSent(x.id), "INVALID_TRANSITION");
    const q = await submitQc(x.id);
    expect(q.status).toBe("internal_review");
    await expectCode(run(designer, taskMove, { id: x.id, expectedVersion: await v(x.id), to: "done" }), "INVALID_TRANSITION");
    await decide(teamLead, q.qualityApprovalId, "approve");
    expect((await row(x.id)).status).toBe("client_ready");
    await expectCode(run(pm, taskClientAccept, { id: x.id, expectedVersion: await v(x.id) }), "INVALID_TRANSITION");
    expect((await markSent(x.id)).status).toBe("client_review");
    const done = await run<Task>(pm, taskClientAccept, { id: x.id, expectedVersion: await v(x.id) });
    expect(done.status).toBe("done");
    expect((await row(x.id)).done_at).not.toBeNull();

    // Not client-facing: straight to done, or through internal review to done (never to client_ready).
    const internal = await newTask(p, { clientFacing: false, title: "Moodboard" });
    await start(internal.id);
    expect(
      (await run<Task>(designer, taskMove, { id: internal.id, expectedVersion: await v(internal.id), to: "done" })).status,
    ).toBe("done");
    const reviewed = await newTask(p, { clientFacing: false, title: "Brief check" });
    await start(reviewed.id);
    const q2 = await submitQc(reviewed.id);
    await decide(pm, q2.qualityApprovalId, "approve");
    expect((await row(reviewed.id)).status).toBe("done");
    await expect(sql`UPDATE tasks SET status = 'client_ready' WHERE id = ${internal.id}`.execute(t.db)).rejects.toThrow(
      /tasks_client_states/,
    );

    // Cancel from a review state takes the pending QC out of the inbox.
    const c = await newTask(p, { title: "Banner" });
    await start(c.id);
    const q3 = await submitQc(c.id);
    expect((await run<Task>(pm, taskCancel, { id: c.id, expectedVersion: await v(c.id) })).status).toBe("cancelled");
    expect((await approval(q3.qualityApprovalId)).status).toBe("superseded");
  });

  it("[TSK-DL-02] the owner or a task manager delivers; others are refused; versions are checked", async () => {
    const p = await openProject();
    const x = await newTask(p);
    await start(x.id);
    for (const a of [outsider, otherPm, otherTeamLead, ops, lead])
      await expectCode(run(a, taskSubmitQc, { id: x.id, expectedVersion: await v(x.id) }), "FORBIDDEN");
    await expectCode(run(designer, taskSubmitQc, { id: x.id, expectedVersion: 1 }), "STALE_VERSION");
    const q = await submitQc(x.id, pm); // the PM submits for the owner
    await decide(teamLead, q.qualityApprovalId, "approve");
    await expectCode(markSent(x.id, outsider), "FORBIDDEN");
    expect((await markSent(x.id, teamLead)).status).toBe("client_review"); // the owner's team lead
    await expectCode(revise(x.id, {}, otherPm), "FORBIDDEN");
    expect((await revise(x.id, {}, designer)).status).toBe("in_progress"); // the owner records it
  });

  it("[TSK-DL-03] submitting for QC creates a quality_check for the current round, never routed to the owner", async () => {
    const p = await openProject();
    const x = await newTask(p);
    await start(x.id);
    const q = await submitQc(x.id);
    const a = await approval(q.qualityApprovalId);
    expect(a).toMatchObject({
      kind: "quality_check",
      subject_type: "task",
      subject_id: x.id,
      subject_version: 0,
      required_permission: "task.quality_approve",
      requested_by: designer.id,
      status: "pending",
    });
    expect(a.assignee_id).not.toBe(designer.id);
    expect(await t.db.selectFrom("task_rounds").selectAll().where("task_id", "=", x.id).execute()).toEqual([
      expect.objectContaining({ round: 0, kind: "internal", quality_approval_id: a.id, requested_by: designer.id }),
    ]);
    expect((await row(x.id)).quality_approval_id).toBe(a.id);

    // The owner is a team lead holding task.quality_approve for their team: never assigned, never offered it.
    const y = await newTask(p, { title: "Lead's own visual" }, leadOwner);
    await start(y.id, leadOwner);
    const qy = await submitQc(y.id, pm);
    expect(qy.assigneeId).not.toBe(leadOwner.id);
    expect(qy.assigneeId).toBe(teamLead.id);
    const inbox = await run<{ id: string; canDecide: boolean }[]>(leadOwner, approvalInbox, {});
    expect(inbox.find((i) => i.id === qy.qualityApprovalId)?.canDecide ?? false).toBe(false);
    expect(
      (await run<{ id: string; canDecide: boolean }[]>(teamLead, approvalInbox, {})).find((i) => i.id === qy.qualityApprovalId),
    ).toMatchObject({ canDecide: true });
  });

  it("[TSK-DL-04] the owner can never approve their own QC (SELF_APPROVAL); PM, owner's team lead or ops decide", async () => {
    const p = await openProject();
    const y = await newTask(p, { title: "Lead's own visual" }, leadOwner);
    await start(y.id, leadOwner);
    const q = await submitQc(y.id, pm);
    await expectCode(decide(leadOwner, q.qualityApprovalId, "approve"), "SELF_APPROVAL");
    await expectCode(decide(leadOwner, q.qualityApprovalId, "reject"), "SELF_APPROVAL");
    await expectCode(decide(pm, q.qualityApprovalId, "approve"), "SELF_APPROVAL"); // the requester (APR-EN-04)
    await expectCode(decide(otherTeamLead, q.qualityApprovalId, "approve"), "FORBIDDEN"); // another team
    await expectCode(decide(otherPm, q.qualityApprovalId, "approve"), "FORBIDDEN"); // not this project's PM
    await decide(ops, q.qualityApprovalId, "approve");
    expect(await approval(q.qualityApprovalId)).toMatchObject({ status: "approved", decided_by: ops.id });
    expect((await row(y.id)).status).toBe("client_ready");
    // The owner's own submission: the owner is also the requester.
    const x = await newTask(p);
    await start(x.id);
    const qx = await submitQc(x.id);
    await expectCode(decide(designer, qx.qualityApprovalId, "approve"), "SELF_APPROVAL"); // owner and requester
    await decide(pm, qx.qualityApprovalId, "approve");
    expect((await row(x.id)).status).toBe("client_ready");
  });

  it("[TSK-DL-05] M2 #3: a QC rejection returns the task to in_progress and never increments revision_round", async () => {
    const p = await openProject();
    const x = await newTask(p);
    await start(x.id);
    for (let loop = 0; loop < 3; loop++) {
      const q = await submitQc(x.id);
      await decide(teamLead, q.qualityApprovalId, "reject", { note: "Logo too small" });
      expect(await row(x.id)).toMatchObject({ status: "in_progress", revision_round: 0 });
    }
    await deliver(x.id);
    await revise(x.id);
    const q = await submitQc(x.id);
    expect((await approval(q.qualityApprovalId)).subject_version).toBe(1);
    await decide(teamLead, q.qualityApprovalId, "reject");
    expect(await row(x.id)).toMatchObject({ status: "in_progress", revision_round: 1 });
    const rounds = await t.db.selectFrom("task_rounds").select(["round", "kind"]).where("task_id", "=", x.id).execute();
    expect(rounds.filter((r) => r.kind === "client").map((r) => r.round)).toEqual([1]);
    expect(rounds.filter((r) => r.kind === "internal")).toHaveLength(5); // 3 rejected + 1 approved (round 0) + 1 (round 1)
  });

  it("[TSK-DL-06] M2 #4: mark sent needs an approved QC for the current round by a non-owner (app and DB)", async () => {
    const p = await openProject();
    const x = await newTask(p);
    await start(x.id);
    // DB backstop as the app role: no QC at all.
    await expect(
      sql`UPDATE tasks SET status = 'client_review', sent_to_client_at = now(), sent_reference = 'x' WHERE id = ${x.id}`.execute(
        t.db,
      ),
    ).rejects.toThrow(/QC_REQUIRED/);
    const q = await submitQc(x.id);
    await decide(teamLead, q.qualityApprovalId, "approve");
    await expectCode(run(designer, taskMarkSent, { id: x.id, expectedVersion: await v(x.id) }), "VALIDATION");
    const sent = await markSent(x.id);
    expect(sent.status).toBe("client_review");
    expect(await row(x.id)).toMatchObject({ sent_reference: "KV_v3.pdf via Telegram", sent_to_client_at: t.clock.now });
    // Round 1: the round-0 QC no longer counts.
    await revise(x.id);
    await expect(
      sql`UPDATE tasks SET status = 'client_review', sent_to_client_at = now(), sent_reference = 'x' WHERE id = ${x.id}`.execute(
        t.db,
      ),
    ).rejects.toThrow(/QC_REQUIRED/);
    const q1 = await submitQc(x.id);
    await decide(teamLead, q1.qualityApprovalId, "approve");
    // The QC approver becomes the owner: it no longer counts as a non-owner approval.
    await run(pm, taskUpdate, { id: x.id, expectedVersion: await v(x.id), ownerId: teamLead.id });
    await expectCode(markSent(x.id, teamLead), "SELF_APPROVAL");
    await expect(
      sql`UPDATE tasks SET status = 'client_review', sent_to_client_at = now(), sent_reference = 'x' WHERE id = ${x.id}`.execute(
        t.db,
      ),
    ).rejects.toThrow(/QC_REQUIRED/);
    await run(pm, taskUpdate, { id: x.id, expectedVersion: await v(x.id), ownerId: designer.id });
    expect((await markSent(x.id)).status).toBe("client_review");
    await expect(sql`UPDATE tasks SET sent_reference = NULL WHERE id = ${x.id}`.execute(t.db)).rejects.toThrow(
      /tasks_sent_recorded/,
    );
  });

  it("[TSK-DL-07] M2 #1: rounds 1–3 start at once; a round-4 request creates an out_of_scope approval before the round starts", async () => {
    const p = await openProject();
    const x = await newTask(p);
    await start(x.id);
    await deliver(x.id);
    for (let r = 1; r <= 3; r++) {
      const res = await revise(x.id);
      expect(res).toMatchObject({ status: "in_progress", revision_round: r, outOfScopeApprovalId: null });
      await deliver(x.id);
    }
    const clientRounds = await t.db
      .selectFrom("task_rounds")
      .select(["round", "note", "requested_by"])
      .where("task_id", "=", x.id)
      .where("kind", "=", "client")
      .orderBy("round")
      .execute();
    expect(clientRounds.map((r) => r.round)).toEqual([1, 2, 3]);
    expect(clientRounds[0]).toMatchObject({ note: "Client wants a warmer palette", requested_by: pm.id });
    // Round 4 needs a rework estimate and a note (D-RV-2).
    await expectCode(revise(x.id, { reworkMinutes: undefined }), "VALIDATION");
    await expectCode(revise(x.id, { reworkMinutes: 120, note: null }), "VALIDATION");
    const res = await revise(x.id, { reworkMinutes: 120 });
    expect(res).toMatchObject({ status: "client_review", revision_round: 3 });
    const a = await approval(res.outOfScopeApprovalId!);
    expect(a).toMatchObject({
      kind: "out_of_scope",
      subject_type: "task_revision",
      subject_id: x.id,
      subject_version: 4,
      required_permission: "scope.oos.decide",
      status: "pending",
    });
    expect((a.snapshot as { facts: { reworkMinutes: number } }).facts.reworkMinutes).toBe(120);
    expect(await row(x.id)).toMatchObject({ status: "client_review", revision_round: 3, revision_oos_approval_id: a.id });
    await expectCode(revise(x.id, { reworkMinutes: 60 }), "OOS_DECISION_REQUIRED");
    // Nothing started: no round-4 row, the task cannot be worked on.
    expect(
      await t.db.selectFrom("task_rounds").select("id").where("task_id", "=", x.id).where("round", "=", 4).execute(),
    ).toHaveLength(0);
  });

  it("[TSK-DL-08] M2 #1: absorb starts round 4; change order and reject keep the task in client_review with the note", async () => {
    const x = await atRound3();
    const a = await round4Request(x.id);
    await expectCode(decide(ops, a, "approve", {}, "mcp"), "DECIDE_IN_APP"); // INV-19
    await decide(lead, a, "approve", { outcome: "absorb" }); // the client's account lead
    expect(await row(x.id)).toMatchObject({ status: "in_progress", revision_round: 4, oos_decision: "absorb" });
    expect(
      await t.db
        .selectFrom("task_rounds")
        .selectAll()
        .where("task_id", "=", x.id)
        .where("round", "=", 4)
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ kind: "client", oos_approval_id: a, rework_minutes: 120, requested_by: pm.id });

    const y = await atRound3();
    const b = await round4Request(y.id);
    await decide(ops, b, "reject", { note: "Round 4 is outside the quotation; we can quote it as a change order." });
    expect(await row(y.id)).toMatchObject({ status: "client_review", revision_round: 3, oos_decision: "reject" });
    const view = await run<{ revisionRequest: { status: string; outcome: string; note: string }; nextRevision: string }>(
      pm,
      taskGet,
      { id: y.id },
    );
    expect(view.revisionRequest).toMatchObject({
      status: "rejected",
      outcome: "reject",
      note: "Round 4 is outside the quotation; we can quote it as a change order.",
    });
    expect(view.nextRevision).toBe("out_of_scope");
    // Asked again later: a new decision, still no round 4 without absorb.
    const b2 = await round4Request(y.id);
    await decide(ops, b2, "reject", { outcome: "change_order" }, "mcp"); // change order is allowed over MCP
    expect(await row(y.id)).toMatchObject({ status: "client_review", revision_round: 3, oos_decision: "change_order" });
    expect(await t.db.selectFrom("giveaway_entries").select("id").where("source_id", "in", [b, b2]).execute()).toHaveLength(0);
  });

  it("[TSK-DL-09] absorbing writes one absorbed_out_of_scope row: rework × unit price ÷ quoted minutes, month of decision", async () => {
    const p = await openProject(); // fee line: unit 5000 US cents, 600 quoted minutes
    const x = await atRound3(p);
    const a = await round4Request(x.id, 120);
    t.clock.set("2026-10-31T18:30:00Z"); // 1 Nov 01:30 in Phnom Penh
    await decide(ops, a, "approve");
    t.clock.set("2026-10-19T02:00:00Z");
    const g = await t.db.selectFrom("giveaway_entries").selectAll().where("source_id", "=", a).execute();
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({
      kind: "absorbed_out_of_scope",
      amount_usd_minor: 1000n, // 120 × 5000 ÷ 600
      fx_rate_micros: 1_000_000n,
      attributed_month: "2026-11-01",
      occurred_on: "2026-11-01",
      client_id: p.clientId,
      project_id: p.projectId,
      source_type: "approval",
      note: null,
    });
    await expect(sql`UPDATE giveaway_entries SET amount_usd_minor = 0 WHERE source_id = ${a}`.execute(t.db)).rejects.toThrow();

    // No quoted minutes on the scope item: written at 0, flagged for Finance.
    const q = await openProject({ lines: [line("fee", 2, 5000, 3000)] });
    const y = await atRound3(q);
    const b = await round4Request(y.id, 90);
    await decide(ops, b, "approve");
    expect(
      await t.db
        .selectFrom("giveaway_entries")
        .select(["amount_usd_minor", "note"])
        .where("source_id", "=", b)
        .executeTakeFirstOrThrow(),
    ).toEqual({ amount_usd_minor: 0n, note: "valuation_pending" });

    // An absorbed out-of-scope task: its estimate, valued the same way when it is linked (over-quantity), else pending.
    const one = await openProject({ lines: [line("fee", 1, 30_000, 20_000, { quotedMinutes: 300 })] });
    await newTask(one, { estimateMinutes: 60 });
    const extra = await newTask(one, { estimateMinutes: 60, outOfScopeReason: "One more key visual" });
    await decide(lead, extra.oosApprovalId!, "approve");
    expect(
      await t.db
        .selectFrom("giveaway_entries")
        .select(["amount_usd_minor", "kind"])
        .where("source_id", "=", extra.oosApprovalId!)
        .executeTakeFirstOrThrow(),
    ).toEqual({ amount_usd_minor: 6000n, kind: "absorbed_out_of_scope" }); // 60 × 30000 ÷ 300
    const unscoped = await newTask(one, { scopeItemId: null, outOfScopeReason: "Extra banner", estimateMinutes: 90 });
    await decide(lead, unscoped.oosApprovalId!, "approve");
    expect(
      await t.db
        .selectFrom("giveaway_entries")
        .select(["amount_usd_minor", "note"])
        .where("source_id", "=", unscoped.oosApprovalId!)
        .executeTakeFirstOrThrow(),
    ).toEqual({ amount_usd_minor: 0n, note: "valuation_pending" });
    const rejected = await newTask(one, { scopeItemId: null, outOfScopeReason: "Another banner" });
    await decide(lead, rejected.oosApprovalId!, "reject");
    expect(
      await t.db.selectFrom("giveaway_entries").select("id").where("source_id", "=", rejected.oosApprovalId!).execute(),
    ).toHaveLength(0);

    // KHR scopes convert at the frozen rate, rounded once: 60 × 400000 riel ÷ 120 = 200000 riel = $50.00.
    expect(
      absorbedValueUsdMinor({
        minutes: 60,
        unitPriceMinor: 400_000n,
        quotedMinutes: 120,
        currency: "KHR",
        fxRateMicros: 4_000_000_000n,
      }),
    ).toBe(5000n);
    expect(
      absorbedValueUsdMinor({ minutes: 1, unitPriceMinor: 5000n, quotedMinutes: 600, currency: "USD", fxRateMicros: 1n }),
    ).toBe(8n);
    expect(
      absorbedValueUsdMinor({ minutes: 60, unitPriceMinor: 5000n, quotedMinutes: 0, currency: "USD", fxRateMicros: 1n }),
    ).toBeNull();
  });

  it("[TSK-DL-10] M2 #2: round 5 returns 409 on web and MCP; more work comes only from an accepted change order", async () => {
    const p = await openProject();
    const x = await atRound3(p);
    const a = await round4Request(x.id);
    await decide(ops, a, "approve");
    await deliver(x.id);
    expect(await row(x.id)).toMatchObject({ status: "client_review", revision_round: 4 });
    await expect(revise(x.id, { reworkMinutes: 60 })).rejects.toSatisfy(
      (e: unknown) => e instanceof DomainError && e.code === "REVISION_HARD_STOP" && e.status === 409,
    );
    await expectCode(revise(x.id, { reworkMinutes: 60 }, pm, "mcp"), "REVISION_HARD_STOP");
    await expectCode(revise(x.id, {}, designer, "mcp"), "REVISION_HARD_STOP");
    expect((await run<{ nextRevision: string; actions: string[] }>(pm, taskGet, { id: x.id })).nextRevision).toBe("hard_stop");

    // DB backstops as the app role (INV-09).
    await expect(
      sql`UPDATE tasks SET revision_round = 5, status = 'in_progress' WHERE id = ${x.id}`.execute(t.db),
    ).rejects.toThrow(/tasks_revision_round_max/);
    const y = await atRound3(p);
    await expect(
      sql`UPDATE tasks SET revision_round = 4, status = 'in_progress' WHERE id = ${y.id}`.execute(t.db),
    ).rejects.toThrow(/tasks_revision_round_absorb/);
    await expect(
      sql`UPDATE tasks SET revision_round = 1, status = 'in_progress' WHERE id = ${y.id}`.execute(t.db),
    ).rejects.toThrow(/INVALID_TRANSITION: (round|a new task)/);
    const z = await newTask(p, { title: "Poster" });
    await start(z.id);
    await expect(sql`UPDATE tasks SET revision_round = 1 WHERE id = ${z.id}`.execute(t.db)).rejects.toThrow(
      /INVALID_TRANSITION: (round|a new task)/,
    );

    // The more-work path: an accepted change order spawns a new task with its own rounds.
    const co = await run<{ id: string; version: number }>(lead, changeOrderCreate, {
      projectId: p.projectId,
      title: "Round 5 concept",
    });
    const saved = await run<{ version: number }>(lead, changeOrderSave, {
      id: co.id,
      expectedVersion: co.version,
      lines: [{ ...line("fee", 1, 20_000, 10_000, { quotedMinutes: 240 }), descriptionEn: "New concept (CO)" }],
    });
    const sub = await run<{ version: number }>(lead, changeOrderSubmit, { id: co.id, expectedVersion: saved.version });
    const sent = await run<{ version: number }>(lead, changeOrderSend, { id: co.id, expectedVersion: sub.version });
    await run(lead, changeOrderAccept, { id: co.id, expectedVersion: sent.version });
    const spawned = await t.db
      .selectFrom("tasks")
      .select(["revision_round", "status", "estimate_minutes"])
      .where("project_id", "=", p.projectId)
      .where("title", "=", "New concept (CO)")
      .executeTakeFirstOrThrow();
    expect(spawned).toEqual({ revision_round: 0, status: "todo", estimate_minutes: 240 });
  });

  it("[TSK-DL-11] over quantity: a client-facing task beyond the scope item's quantity needs an out-of-scope approval", async () => {
    const p = await openProject({
      lines: [line("fee", 1, 30_000, 20_000, { quotedMinutes: 300 }), line("fee", 1.5, 10_000, 5_000, { quotedMinutes: 120 })],
    });
    const item1 = await feeItem(p, 0);
    const item2 = await feeItem(p, 1);
    const first = await newTask(p, { scopeItemId: item1 });
    expect(first.oos_status).toBe("none");
    await expect(newTask(p, { scopeItemId: item1, title: "Second visual" })).rejects.toSatisfy(
      (e: unknown) =>
        e instanceof DomainError &&
        e.code === "OUT_OF_SCOPE_REQUIRED" &&
        e.params.reason === "over_quantity" &&
        e.params.quantity === 1 &&
        e.params.existing === 1,
    );
    const over = await newTask(p, { scopeItemId: item1, title: "Second visual", outOfScopeReason: "Client asked for a variant" });
    expect(over.oos_status).toBe("pending");
    const a = await approval(over.oosApprovalId!);
    expect(a).toMatchObject({
      kind: "out_of_scope",
      subject_type: "task",
      subject_id: over.id,
      required_permission: "scope.oos.decide",
    });
    expect((a.snapshot as { facts: { overQuantity: { quantity: number } } }).facts.overQuantity.quantity).toBe(1);
    expect((await row(over.id)).scope_item_id).toBe(item1); // keeps its link (valuation)
    await expectCode(start(over.id), "OUT_OF_SCOPE_REQUIRED");
    // Not client-facing, or a freed slot: no approval.
    expect((await newTask(p, { scopeItemId: item1, clientFacing: false, title: "Internal copy" })).oos_status).toBe("none");
    // Quantity 1.5 rounds up to 2.
    await newTask(p, { scopeItemId: item2, title: "Story 1" });
    const s2 = await newTask(p, { scopeItemId: item2, title: "Story 2" });
    expect(s2.oos_status).toBe("none");
    await expectCode(newTask(p, { scopeItemId: item2, title: "Story 3" }), "OUT_OF_SCOPE_REQUIRED");
    await run(pm, taskCancel, { id: s2.id, expectedVersion: await v(s2.id) });
    const s3 = await newTask(p, { scopeItemId: item2, title: "Story 3" });
    expect(s3.oos_status).toBe("none");
    // Re-linking to a full item asks the same question, and only before work starts.
    await expectCode(
      run(pm, taskUpdate, { id: s3.id, expectedVersion: await v(s3.id), scopeItemId: item1 }),
      "OUT_OF_SCOPE_REQUIRED",
    );
    const relinked = await run<{ id: string }>(pm, taskUpdate, {
      id: s3.id,
      expectedVersion: await v(s3.id),
      scopeItemId: item1,
      outOfScopeReason: "Moved to the key visual line at the client's request",
    });
    expect(await row(relinked.id)).toMatchObject({ scope_item_id: item1, oos_status: "pending" });
    await start(first.id);
    const story1 = await t.db
      .selectFrom("tasks")
      .select("id")
      .where("project_id", "=", p.projectId)
      .where("title", "=", "Story 1")
      .executeTakeFirstOrThrow();
    await start(story1.id);
    await expectCode(
      run(pm, taskUpdate, {
        id: story1.id,
        expectedVersion: await v(story1.id),
        scopeItemId: item1,
        outOfScopeReason: "Late move",
      }),
      "INVALID_TRANSITION",
    );
  });

  it("[TSK-TK-02] M2 #5: an unscoped, non-non_deliverable task on an active client project creates an out-of-scope approval", async () => {
    const p = await openProject();
    const before = await t.db.selectFrom("projects").select("version").where("id", "=", p.projectId).executeTakeFirstOrThrow();
    expect(
      (await run<{ status: string }>(pm, projectActivate, { id: p.projectId, expectedVersion: before.version })).status,
    ).toBe("active");
    await expectCode(newTask(p, { scopeItemId: null, title: "Unscoped" }), "OUT_OF_SCOPE_REQUIRED");
    const x = await newTask(p, { scopeItemId: null, title: "Unscoped", outOfScopeReason: "Asked on the call" });
    expect(await approval(x.oosApprovalId!)).toMatchObject({ kind: "out_of_scope", subject_id: x.id, status: "pending" });
    await expectCode(start(x.id), "OUT_OF_SCOPE_REQUIRED");
  });

  it("[TSK-DL-12] the board, my tasks and the task view show states, round, QC and allowed actions; the client accepts → done", async () => {
    const p = await openProject();
    const x = await newTask(p, { title: "Board visual" });
    await start(x.id);
    type Dto = {
      id: string;
      status: string;
      revision_round: number;
      qcStatus: string;
      qc: { approvalId: string; status: string; canDecide: boolean } | null;
      actions: string[];
    };
    const find = async (a: UserActor) =>
      (await run<{ tasks: Dto[]; states: string[] }>(a, taskBoard, { projectId: p.projectId })).tasks.find((y) => y.id === x.id)!;
    expect((await run<{ states: string[] }>(pm, taskBoard, { projectId: p.projectId })).states).toEqual([
      "todo",
      "in_progress",
      "internal_review",
      "client_ready",
      "client_review",
      "done",
      "cancelled",
    ]);
    expect((await find(designer)).actions).toEqual(["stop", "submit_qc"]); // no finish: client-facing
    expect((await find(pm)).actions).toEqual(["submit_qc", "cancel"]);
    expect((await find(outsider)).actions).toEqual([]);
    const q = await submitQc(x.id);
    expect(await find(designer)).toMatchObject({ status: "internal_review", qcStatus: "pending", qc: { canDecide: false } });
    expect((await find(teamLead)).qc).toMatchObject({ approvalId: q.qualityApprovalId, status: "pending", canDecide: true });
    await decide(teamLead, q.qualityApprovalId, "approve");
    expect(await find(designer)).toMatchObject({ status: "client_ready", qcStatus: "approved", actions: ["mark_sent"] });
    await markSent(x.id);
    expect((await find(pm)).actions).toEqual(["request_revision", "client_accept", "cancel"]);
    await revise(x.id);
    expect(await find(designer)).toMatchObject({ status: "in_progress", revision_round: 1, qcStatus: "none", qc: null });
    const mine = await run<Dto[]>(designer, taskMine, {});
    expect(mine.find((y) => y.id === x.id)).toMatchObject({ status: "in_progress", revision_round: 1 });
    await deliver(x.id);
    expect((await run<Dto[]>(designer, taskMine, {}, "mcp")).find((y) => y.id === x.id)?.status).toBe("client_review");
    const view = await run<{ rounds: { round: number; kind: string; approval_status: string | null }[]; nextRevision: string }>(
      pm,
      taskGet,
      { id: x.id },
    );
    expect(view.nextRevision).toBe("normal");
    expect(view.rounds.map((r) => `${r.kind}:${r.round}:${r.approval_status}`)).toEqual([
      "internal:0:approved",
      "client:1:null",
      "internal:1:approved",
    ]);
    const done = await run<Task>(designer, taskClientAccept, { id: x.id, expectedVersion: await v(x.id) });
    expect(done.status).toBe("done");
    expect((await run<Dto[]>(designer, taskMine, {})).find((y) => y.id === x.id)).toBeUndefined();
    expect((await run<Dto[]>(designer, taskMine, { includeDone: true })).find((y) => y.id === x.id)?.status).toBe("done");
  });

  it("[TSK-DL-14] every delivery command is audited by name; task_rounds is insert-only", async () => {
    const x = await atRound3();
    await round4Request(x.id);
    const x2 = await newTask(await openProject());
    await start(x2.id);
    await deliver(x2.id);
    await run(pm, taskClientAccept, { id: x2.id, expectedVersion: await v(x2.id) });
    const actions = async (id: string) =>
      (
        await t.db
          .selectFrom("audit_events")
          .select(["action", "subject_type", "outcome"])
          .where("subject_id", "=", id)
          .where("action", "like", "task.%")
          .execute()
      ).map((a) => `${a.action}:${a.subject_type}:${a.outcome}`);
    expect(await actions(x.id)).toEqual(
      expect.arrayContaining(["task.submit_qc:task:ok", "task.mark_sent:task:ok", "task.request_revision:task:ok"]),
    );
    expect(await actions(x2.id)).toEqual(expect.arrayContaining(["task.client_accept:task:ok"]));
    const roundIds = (await t.db.selectFrom("task_rounds").select("id").where("task_id", "=", x.id).execute()).map((r) => r.id);
    const changes = await t.db
      .selectFrom("audit_changes")
      .select("op")
      .where("table_name", "=", "task_rounds")
      .where("row_id", "in", roundIds)
      .execute();
    expect(changes.length).toBeGreaterThanOrEqual(7);
    expect(changes.every((c) => c.op === "INSERT")).toBe(true);
    await expect(sql`UPDATE task_rounds SET round = 0 WHERE task_id = ${x.id}`.execute(t.db)).rejects.toThrow();
    await expect(sql`DELETE FROM task_rounds WHERE task_id = ${x.id}`.execute(t.db)).rejects.toThrow();
  });
});
