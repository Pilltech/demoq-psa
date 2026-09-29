// Delivery: internal QC, mark sent, client revision rounds and the round-4 out-of-scope decision.
// Spec: specs/tasks/delivery.md (TSK-DL-*) · INV-09, INV-10 · D1, D2, D-RV-1..3, D-QC-1
import { z } from "zod";
import { expectedVersion, optionalText, requiredText, uuid } from "@demoq/shared";
import { createApproval, lockSubjectWith, onApprovalDecided, type ApprovalRow, type ApprovalSnapshot } from "../approvals";
import { assertVersion, businessDate, can, defineCommand, DomainError, notFoundIfMissing, type Ctx } from "../kernel";
import { recordAbsorbedOutOfScope } from "../reporting";
import { lockTask, oosScope, pmIds, taskMachine, teamOf, type TaskStatus } from "./tasks";

/** D1 / INV-09: round 4 needs an out-of-scope decision; round 5 never exists. */
export const REVISION_FLAG_ROUND = 4;
export const REVISION_HARD_STOP = 5;

type Locked = Awaited<ReturnType<typeof lockTask>>;

/**
 * TSK-DL-02: the owner (task.move_own) or someone who manages the task (task.manage in scope). Every PM and team lead
 * holds task.move_own, so a manager passes the same check as the owner of the task.
 */
function deliveryScope(l: Locked, ctx: Ctx) {
  const manages = ctx.actor.type === "user" && can(ctx.actor, "task.manage", l.scope);
  return { ownerIds: [l.t.owner_id, ...(manages && ctx.actor.type === "user" ? [ctx.actor.id] : [])] };
}

const load = (ctx: Ctx, i: { id: string }) => lockTask(ctx, i.id);

async function moveTo(ctx: Ctx, id: string, set: Record<string, unknown>) {
  return ctx.tx
    .updateTable("tasks")
    .set((eb) => ({ ...set, version: eb("version", "+", 1) }))
    .where("id", "=", id)
    .returning(["id", "status", "version", "revision_round"])
    .executeTakeFirstOrThrow();
}

/** TSK-DL-03 (D-QC-1): ask for the internal quality check of the current round. */
export const taskSubmitQc = defineCommand({
  name: "task.submit_qc",
  summary: "Submit a task for internal quality check (the reviewer is never the owner)",
  permission: "task.move_own",
  input: z.object({ id: uuid, expectedVersion, note: optionalText(1000) }),
  exposeTo: ["web", "mcp"],
  load,
  scope: (l, _i, ctx) => deliveryScope(l, ctx),
  async run(ctx, i, { p, t }) {
    assertVersion(t.version, i.expectedVersion);
    taskMachine.assert(t.status as TaskStatus, "submit_qc");
    if (ctx.actor.type !== "user") throw new DomainError("FORBIDDEN");
    const round = t.revision_round;
    const snapshot: ApprovalSnapshot = {
      title: `${p.name}: ${t.title}${round ? ` (round ${round})` : ""}`,
      // The project's PMs (assigned) and the owner's team (team lead); ops_lead holds the permission with `any`.
      scope: { assigneeIds: await pmIds(ctx, p), teamIds: [await teamOf(ctx, t.owner_id)] },
      facts: { projectId: p.id, taskId: t.id, round, clientFacing: t.client_facing, note: i.note ?? null },
      excludeDeciders: [t.owner_id], // INV-10: never the owner, even when they hold task.quality_approve
    };
    const a = await createApproval(ctx, {
      kind: "quality_check",
      subject: { type: "task", id: t.id, version: round, hash: `${t.id}:r${round}:v${t.version + 1}` },
      snapshot,
    });
    await ctx.tx
      .insertInto("task_rounds")
      .values({
        task_id: t.id,
        round,
        kind: "internal",
        quality_approval_id: a.id,
        note: i.note ?? null,
        requested_by: ctx.actor.id,
        created_at: ctx.now,
      })
      .execute();
    const r = await moveTo(ctx, t.id, { status: "internal_review", quality_approval_id: a.id });
    ctx.emit("task.qc_submitted", { taskId: t.id, approvalId: a.id, round });
    return { ...r, qualityApprovalId: a.id, assigneeId: a.assigneeId };
  },
  subject: (i) => ({ type: "task", id: i.id }),
});

lockSubjectWith("quality_check", "task", async (ctx, id) => (await lockTask(ctx, id)).t);

/**
 * TSK-DL-04/05: approve → client_ready (client-facing) or done; reject → in_progress, same round (QC loops are not
 * revision rounds). The owner can never decide their own task's QC (SELF_APPROVAL), whatever roles they hold.
 */
onApprovalDecided("quality_check", "task", async (ctx, a, decision) => {
  const t = notFoundIfMissing(await ctx.tx.selectFrom("tasks").selectAll().where("id", "=", a.subject_id).executeTakeFirst());
  if (ctx.actor.type === "user" && ctx.actor.id === t.owner_id) throw new DomainError("SELF_APPROVAL", { reason: "task_owner" });
  if (t.status !== "internal_review" || t.quality_approval_id !== a.id) return;
  const event = decision === "approve" ? "qc_approve" : "qc_reject";
  taskMachine.assert(t.status as TaskStatus, event);
  const to = decision === "reject" ? "in_progress" : t.client_facing ? "client_ready" : "done";
  await moveTo(ctx, t.id, { status: to, ...(to === "done" && { done_at: ctx.now }) });
  ctx.emit(decision === "approve" ? "task.qc_approved" : "task.qc_rejected", {
    taskId: t.id,
    approvalId: a.id,
    round: t.revision_round,
    ownerId: t.owner_id,
  });
});

/** TSK-DL-06 (INV-10): only after an approved QC for the current round, decided by someone other than the owner. */
export const taskMarkSent = defineCommand({
  name: "task.mark_sent",
  summary: "Record that the deliverable was sent to the client (needs an approved QC for this round)",
  permission: "task.move_own",
  input: z.object({ id: uuid, expectedVersion, sentReference: requiredText(500) }),
  exposeTo: ["web", "mcp"],
  load,
  scope: (l, _i, ctx) => deliveryScope(l, ctx),
  async run(ctx, i, { t }) {
    assertVersion(t.version, i.expectedVersion);
    taskMachine.assert(t.status as TaskStatus, "mark_sent");
    const qc = t.quality_approval_id
      ? await ctx.tx
          .selectFrom("approvals")
          .select(["status", "subject_version", "decided_by"])
          .where("id", "=", t.quality_approval_id)
          .executeTakeFirst()
      : undefined;
    if (!qc || qc.status !== "approved" || qc.subject_version !== t.revision_round)
      throw new DomainError("QC_REQUIRED", { round: t.revision_round });
    if (qc.decided_by === t.owner_id) throw new DomainError("SELF_APPROVAL", { reason: "approved_by_owner" });
    const r = await moveTo(ctx, t.id, { status: "client_review", sent_to_client_at: ctx.now, sent_reference: i.sentReference });
    ctx.emit("task.sent_to_client", { taskId: t.id, round: t.revision_round });
    return { ...r, sentToClientAt: ctx.now };
  },
  subject: (i) => ({ type: "task", id: i.id }),
});

const RevisionInput = z.object({
  id: uuid,
  expectedVersion,
  /** What the client asked for (required for a round-4 request, D-RV-2). */
  note: optionalText(2000),
  /** D-RV-2: the rework estimate that values the round if it is absorbed (required for round 4). */
  reworkMinutes: z.number().int().min(1).max(100_000).optional(),
});

/**
 * TSK-DL-07: rounds 1–3 start at once (client_review → in_progress, round + 1). A request for round 4 creates an
 * out_of_scope approval and the task waits in client_review (D2). Round 5 is REVISION_HARD_STOP (D1).
 */
export const taskRequestRevision = defineCommand({
  name: "task.request_revision",
  summary:
    "Record the client's revision request: rounds 1–3 start now, round 4 needs an out-of-scope decision, round 5 is refused",
  permission: "task.move_own",
  input: RevisionInput,
  exposeTo: ["web", "mcp"],
  load,
  scope: (l, _i, ctx) => deliveryScope(l, ctx),
  async run(ctx, i, { p, t }) {
    assertVersion(t.version, i.expectedVersion);
    const next = t.revision_round + 1;
    if (next >= REVISION_HARD_STOP) throw new DomainError("REVISION_HARD_STOP", { round: next });
    taskMachine.assert(t.status as TaskStatus, "request_revision");
    if (ctx.actor.type !== "user") throw new DomainError("FORBIDDEN");
    if (next < REVISION_FLAG_ROUND) {
      await ctx.tx
        .insertInto("task_rounds")
        .values({
          task_id: t.id,
          round: next,
          kind: "client",
          note: i.note ?? null,
          requested_by: ctx.actor.id,
          created_at: ctx.now,
        })
        .execute();
      const r = await moveTo(ctx, t.id, { status: "in_progress", revision_round: next });
      ctx.emit("task.revision_started", { taskId: t.id, round: next });
      return { ...r, outOfScopeApprovalId: null };
    }
    // Round 4 (D2): nothing starts until an out-of-scope decision.
    if (t.revision_oos_approval_id) {
      const prev = await ctx.tx
        .selectFrom("approvals")
        .select("status")
        .where("id", "=", t.revision_oos_approval_id)
        .executeTakeFirst();
      if (prev?.status === "pending")
        throw new DomainError("OOS_DECISION_REQUIRED", { round: next, approvalId: t.revision_oos_approval_id });
    }
    const issues = [
      !i.reworkMinutes && { path: "reworkMinutes", message: "A rework estimate in minutes is required for round 4" },
      !i.note && { path: "note", message: "A note is required for round 4" },
    ].filter(Boolean);
    if (issues.length) throw new DomainError("VALIDATION", { reason: "round_4_request", issues });
    const a = await createApproval(ctx, {
      kind: "out_of_scope",
      subject: { type: "task_revision", id: t.id, version: next, hash: `${t.id}:r${next}:v${t.version + 1}` },
      snapshot: {
        title: `${p.name}: ${t.title} (revision round ${next})`,
        scope: await oosScope(ctx, p),
        facts: {
          projectId: p.id,
          taskId: t.id,
          round: next,
          reason: i.note,
          reworkMinutes: i.reworkMinutes,
          estimateMinutes: i.reworkMinutes,
        },
      },
    });
    const r = await moveTo(ctx, t.id, { revision_oos_approval_id: a.id, oos_decision: null });
    ctx.emit("task.revision_oos_requested", { taskId: t.id, round: next, approvalId: a.id });
    return { ...r, outOfScopeApprovalId: a.id };
  },
  subject: (i) => ({ type: "task", id: i.id }),
});

lockSubjectWith("out_of_scope", "task_revision", async (ctx, id) => (await lockTask(ctx, id)).t);

/**
 * TSK-DL-08: absorb → round 4 begins and a giveaway row is written (D-RV-3); change_order → the task stays in
 * client_review (an accepted CO creates the new task); reject → stays in client_review, the note is kept for the client.
 */
onApprovalDecided("out_of_scope", "task_revision", async (ctx, a: ApprovalRow, decision, outcome) => {
  const t = notFoundIfMissing(
    await ctx.tx
      .selectFrom("tasks as t")
      .innerJoin("projects as p", "p.id", "t.project_id")
      .select([
        "t.id",
        "t.status",
        "t.revision_round",
        "t.revision_oos_approval_id",
        "t.scope_item_id",
        "t.project_id",
        "p.client_id",
      ])
      .where("t.id", "=", a.subject_id)
      .executeTakeFirst(),
  );
  if (t.revision_oos_approval_id !== a.id || t.status !== "client_review" || t.revision_round !== REVISION_FLAG_ROUND - 1) return;
  const o = outcome ?? (decision === "approve" ? "absorb" : "reject");
  const facts = ((a.snapshot as { facts?: { reworkMinutes?: number; reason?: string } }).facts ?? {}) as {
    reworkMinutes?: number;
    reason?: string;
  };
  if (o === "absorb") {
    await ctx.tx
      .insertInto("task_rounds")
      .values({
        task_id: t.id,
        round: REVISION_FLAG_ROUND,
        kind: "client",
        oos_approval_id: a.id,
        rework_minutes: facts.reworkMinutes ?? null,
        note: facts.reason ?? null,
        requested_by: a.requested_by,
        created_at: ctx.now,
      })
      .execute();
    await moveTo(ctx, t.id, { status: "in_progress", revision_round: REVISION_FLAG_ROUND, oos_decision: "absorb" });
    if (t.client_id && facts.reworkMinutes) {
      await recordAbsorbedOutOfScope(ctx, {
        clientId: t.client_id,
        projectId: t.project_id,
        scopeItemId: t.scope_item_id,
        minutes: facts.reworkMinutes,
        occurredOn: businessDate(ctx.now),
        sourceType: "approval",
        sourceId: a.id,
      });
    }
  } else {
    await moveTo(ctx, t.id, { oos_decision: o });
  }
  ctx.emit("task.revision_oos_decided", { taskId: t.id, approvalId: a.id, outcome: o });
});

/** TSK-DL-10: the client accepts the deliverable → done. */
export const taskClientAccept = defineCommand({
  name: "task.client_accept",
  summary: "Record that the client accepted the deliverable (task done)",
  permission: "task.move_own",
  input: z.object({ id: uuid, expectedVersion }),
  exposeTo: ["web", "mcp"],
  load,
  scope: (l, _i, ctx) => deliveryScope(l, ctx),
  async run(ctx, i, { t }) {
    assertVersion(t.version, i.expectedVersion);
    taskMachine.assert(t.status as TaskStatus, "client_accept");
    const r = await moveTo(ctx, t.id, { status: "done", done_at: ctx.now });
    ctx.emit("task.client_accepted", { taskId: t.id, round: t.revision_round });
    return r;
  },
  subject: (i) => ({ type: "task", id: i.id }),
});
