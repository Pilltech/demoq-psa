// Tasks: one owner, estimate, due date, dependencies; Kanban per project and per person.
// Spec: specs/tasks/tasks.md (TSK-TK-*)
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod";
import { ByIdInput, expectedVersion, isoDate, optionalText, requiredText, uuid } from "@demoq/shared";
import { createApproval, lockSubjectWith, mayDecide, onApprovalDecided, supersedePending } from "../approvals";
import {
  assertVersion,
  businessDate,
  can,
  defineCommand,
  defineMachine,
  defineQuery,
  DomainError,
  notFoundIfMissing,
  type Ctx,
  type ResourceScope,
} from "../kernel";
import { assertWorkAllowed } from "../projects";
import { recordAbsorbedOutOfScope } from "../reporting";

/**
 * TSK-TK-03 / TSK-DL-01. Client-facing: in_progress → internal_review → client_ready → client_review → done.
 * Non-client-facing: in_progress → done, or through internal_review → done. QC approval lands on client_ready or done.
 */
export const taskMachine = defineMachine({
  name: "task",
  states: ["todo", "in_progress", "internal_review", "client_ready", "client_review", "done", "cancelled"] as const,
  transitions: {
    start: { from: ["todo"], to: "in_progress" },
    finish: { from: ["in_progress"], to: "done" },
    stop: { from: ["in_progress"], to: "todo" },
    submit_qc: { from: ["in_progress"], to: "internal_review" },
    qc_approve: { from: ["internal_review"], to: "client_ready" }, // or done when not client-facing
    qc_reject: { from: ["internal_review"], to: "in_progress" },
    mark_sent: { from: ["client_ready"], to: "client_review" },
    request_revision: { from: ["client_review"], to: "in_progress" },
    client_accept: { from: ["client_review"], to: "done" },
    cancel: { from: ["todo", "in_progress", "internal_review", "client_ready", "client_review"], to: "cancelled" },
  },
});
export type TaskStatus = (typeof taskMachine.states)[number];
export const OPEN_TASK_STATES = ["todo", "in_progress", "internal_review", "client_ready", "client_review"] as const;

export async function lockProjectShared(ctx: Ctx, projectId: string, mode: "share" | "update" = "share") {
  const q = ctx.tx.selectFrom("projects").selectAll().where("id", "=", projectId);
  return notFoundIfMissing(await (mode === "share" ? q.forShare() : q.forNoKeyUpdate()).executeTakeFirst());
}
export type ProjectRow = Awaited<ReturnType<typeof lockProjectShared>>;

export async function pmIds(ctx: Ctx, p: { id: string; pm_id: string }) {
  const pms = await ctx.tx
    .selectFrom("project_members")
    .select("user_id")
    .where("project_id", "=", p.id)
    .where("project_role", "=", "pm")
    .execute();
  return [p.pm_id, ...pms.map((m) => m.user_id)];
}

export async function teamOf(ctx: Ctx, userId: string) {
  return (await ctx.tx.selectFrom("users").select("team_id").where("id", "=", userId).executeTakeFirst())?.team_id ?? null;
}

/**
 * TSK-TK-06: the project's PMs are "assigned" (task.manage), a team lead covers tasks owned by their team,
 * and the owner is "own" (task.move_own).
 */
export async function taskScope(ctx: Ctx, p: ProjectRow, ownerId: string): Promise<ResourceScope> {
  return { assigneeIds: await pmIds(ctx, p), teamIds: [await teamOf(ctx, ownerId)], ownerIds: [ownerId] };
}

/**
 * Lock order: project → task. Dependency edits take the project exclusively up front (never upgrading a share lock,
 * which deadlocks), so two edges cannot close a cycle together.
 */
export async function lockTask(ctx: Ctx, id: string, projectLock: "share" | "update" = "share") {
  const ref = notFoundIfMissing(await ctx.tx.selectFrom("tasks").select("project_id").where("id", "=", id).executeTakeFirst());
  const p = await lockProjectShared(ctx, ref.project_id, projectLock);
  const t = notFoundIfMissing(await ctx.tx.selectFrom("tasks").selectAll().where("id", "=", id).forUpdate().executeTakeFirst());
  return { p, t, scope: await taskScope(ctx, p, t.owner_id) };
}

async function assertActiveUser(ctx: Ctx, userId: string) {
  const u = await ctx.tx.selectFrom("users").select("id").where("id", "=", userId).where("active", "=", true).executeTakeFirst();
  if (!u) throw new DomainError("TASK_INCOMPLETE", { missing: ["ownerId"], reason: "owner_inactive" });
}

async function assertScopeItem(ctx: Ctx, p: ProjectRow, scopeItemId: string) {
  const s = await ctx.tx.selectFrom("scope_items").select("scope_id").where("id", "=", scopeItemId).executeTakeFirst();
  if (!s || s.scope_id !== p.scope_id)
    throw new DomainError("VALIDATION", { issues: [{ path: "scopeItemId", message: "Not a scope item of this project" }] });
}

const assertOpenProject = (p: ProjectRow) => {
  if (!["gated", "active", "on_hold"].includes(p.status))
    throw new DomainError("INVALID_TRANSITION", { reason: "project_closed", status: p.status });
};

/** Account lead of the project's client: decides out-of-scope requests with `own` (scope.oos.decide). */
export async function oosScope(ctx: Ctx, p: ProjectRow): Promise<ResourceScope> {
  const lead = p.client_id
    ? (await ctx.tx.selectFrom("clients").select("account_lead_id").where("id", "=", p.client_id).executeTakeFirst())
        ?.account_lead_id
    : null;
  return { ownerIds: lead ? [lead] : [] };
}

/**
 * TSK-DL-11 (D-OS-1): a scope item already covered by as many client-facing, non-cancelled tasks as its quantity
 * (rounded up). Serialised per scope item so two creates cannot both take the last slot.
 */
async function overQuantity(ctx: Ctx, scopeItemId: string, excludeTaskId?: string) {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`scope_item:${scopeItemId}`}, 0))`.execute(ctx.tx);
  const item = await ctx.tx.selectFrom("scope_items").select("qty_milli").where("id", "=", scopeItemId).executeTakeFirstOrThrow();
  let q = ctx.tx
    .selectFrom("tasks")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("scope_item_id", "=", scopeItemId)
    .where("client_facing", "=", true)
    .where("status", "<>", "cancelled");
  if (excludeTaskId) q = q.where("id", "<>", excludeTaskId);
  const existing = Number((await q.executeTakeFirstOrThrow()).n);
  const quantity = Math.ceil(item.qty_milli / 1000);
  return existing >= quantity ? { scopeItemId, quantity, existing } : null;
}

/** TSK-TK-02 / TSK-DL-11: the out_of_scope approval a task waits for before it can start. */
async function requestTaskOos(
  ctx: Ctx,
  p: ProjectRow,
  task: { id: string; version: number; title: string; estimateMinutes: number },
  reason: string,
  over: Awaited<ReturnType<typeof overQuantity>>,
) {
  return createApproval(ctx, {
    kind: "out_of_scope",
    subject: { type: "task", id: task.id, version: task.version, hash: over ? `${task.id}:${over.scopeItemId}` : task.id },
    snapshot: {
      title: `${p.name}: ${task.title}`,
      scope: await oosScope(ctx, p),
      facts: {
        projectId: p.id,
        taskId: task.id,
        reason,
        estimateMinutes: task.estimateMinutes,
        ...(over && { overQuantity: over }),
      },
    },
  });
}

const CreateInput = z.object({
  projectId: uuid,
  title: requiredText(300),
  description: optionalText(4000),
  // Optional in the contract so a missing one gets TASK_INCOMPLETE (TSK-TK-01), not a generic validation error.
  ownerId: uuid.nullish(),
  estimateMinutes: z.number().int().min(1).max(100_000).nullish(),
  dueDate: isoDate.nullish(),
  scopeItemId: uuid.nullish(),
  nonDeliverable: z.boolean().default(false),
  /** TSK-TK-02: work outside the scope — creates an out_of_scope approval; the task cannot start until granted. */
  outOfScopeReason: optionalText(1000),
  dependsOn: z.array(uuid).max(20).default([]),
  clientFacing: z.boolean().default(false),
});

export const taskCreate = defineCommand({
  name: "task.create",
  summary: "Create a task with one owner, an estimate and a due date (client work links a scope item or asks out-of-scope)",
  permission: "task.manage",
  input: CreateInput,
  exposeTo: ["web", "mcp"],
  async load(ctx, i) {
    const p = await lockProjectShared(ctx, i.projectId);
    return { p, scope: await taskScope(ctx, p, i.ownerId ?? p.pm_id) };
  },
  scope: (l) => l.scope,
  async run(ctx, i, { p }) {
    const missing = [!i.ownerId && "ownerId", !i.estimateMinutes && "estimateMinutes", !i.dueDate && "dueDate"].filter(Boolean);
    if (missing.length) throw new DomainError("TASK_INCOMPLETE", { missing });
    assertOpenProject(p);
    // INV-20 / D-OS-1: a non-deliverable task never goes to the client (DB CHECK tasks_non_deliverable_internal).
    if (i.clientFacing && i.nonDeliverable && !i.scopeItemId)
      throw new DomainError("OUT_OF_SCOPE_REQUIRED", { reason: "client_facing_non_deliverable" });
    await assertActiveUser(ctx, i.ownerId!);
    if (i.scopeItemId) await assertScopeItem(ctx, p, i.scopeItemId);
    const over = p.kind === "client" && i.clientFacing && i.scopeItemId ? await overQuantity(ctx, i.scopeItemId) : null;
    if (over && !i.outOfScopeReason) throw new DomainError("OUT_OF_SCOPE_REQUIRED", { reason: "over_quantity", ...over });
    const wantsOos = !!i.outOfScopeReason && ((!i.scopeItemId && !i.nonDeliverable) || !!over);
    if (p.kind === "client" && !i.scopeItemId && !i.nonDeliverable && !wantsOos) throw new DomainError("OUT_OF_SCOPE_REQUIRED");
    const id = randomUUID();
    let oosApprovalId: string | null = null;
    if (p.kind === "client" && wantsOos) {
      const task = { id, version: 1, title: i.title, estimateMinutes: i.estimateMinutes! };
      oosApprovalId = (await requestTaskOos(ctx, p, task, i.outOfScopeReason!, over)).id;
    }
    const t = await ctx.tx
      .insertInto("tasks")
      .values({
        id,
        project_id: p.id,
        title: i.title,
        description: i.description ?? null,
        owner_id: i.ownerId!,
        estimate_minutes: i.estimateMinutes!,
        due_date: i.dueDate!,
        scope_item_id: i.scopeItemId ?? null,
        non_deliverable: !i.scopeItemId && i.nonDeliverable,
        oos_approval_id: oosApprovalId,
        oos_status: oosApprovalId ? "pending" : "none",
        client_facing: i.clientFacing,
      })
      .returning(["id", "version", "status", "oos_status"])
      .executeTakeFirstOrThrow();
    for (const d of i.dependsOn) await addDependency(ctx, p.id, t.id, d);
    ctx.emit("task.created", { taskId: t.id, projectId: p.id, ownerId: i.ownerId });
    return { ...t, oosApprovalId };
  },
  subject: (_i, r) => ({ type: "task", id: r.id }),
});

lockSubjectWith("out_of_scope", "task", async (ctx, id) => (await lockTask(ctx, id)).t);

/** TSK-TK-02: the decision unblocks (or keeps blocked) the task. TSK-DL-09: absorbing it writes a giveaway row. */
onApprovalDecided("out_of_scope", "task", async (ctx, a, decision) => {
  const t = notFoundIfMissing(
    await ctx.tx
      .selectFrom("tasks as t")
      .innerJoin("projects as p", "p.id", "t.project_id")
      .select([
        "t.id",
        "t.oos_status",
        "t.oos_approval_id",
        "t.project_id",
        "t.estimate_minutes",
        "t.scope_item_id",
        "p.client_id",
      ])
      .where("t.id", "=", a.subject_id)
      .executeTakeFirst(),
  );
  if (t.oos_status !== "pending" || t.oos_approval_id !== a.id) return;
  await ctx.tx
    .updateTable("tasks")
    .set((eb) => ({ oos_status: decision === "approve" ? "approved" : "rejected", version: eb("version", "+", 1) }))
    .where("id", "=", t.id)
    .execute();
  if (decision === "approve" && t.client_id) {
    await recordAbsorbedOutOfScope(ctx, {
      clientId: t.client_id,
      projectId: t.project_id,
      scopeItemId: t.scope_item_id,
      minutes: t.estimate_minutes,
      occurredOn: businessDate(ctx.now),
      sourceType: "approval",
      sourceId: a.id,
    });
  }
  ctx.emit(decision === "approve" ? "task.oos_approved" : "task.oos_rejected", { taskId: t.id, projectId: t.project_id });
});

export const taskUpdate = defineCommand({
  name: "task.update",
  summary: "Edit a task: title, description, owner, estimate, due date, scope link, client-facing",
  permission: "task.manage",
  input: z.object({
    id: uuid,
    expectedVersion,
    title: requiredText(300).optional(),
    description: optionalText(4000),
    ownerId: uuid.optional(),
    estimateMinutes: z.number().int().min(1).max(100_000).optional(),
    dueDate: isoDate.optional(),
    scopeItemId: uuid.nullish(),
    nonDeliverable: z.boolean().optional(),
    /** TSK-TK-08: only a task linked to a scope item (or with an out-of-scope request) may be client-facing. */
    clientFacing: z.boolean().optional(),
    /** TSK-DL-11: re-linking a client-facing task to a fully used scope item asks out-of-scope. */
    outOfScopeReason: optionalText(1000),
  }),
  exposeTo: ["web", "mcp"],
  load: (ctx, i) => lockTask(ctx, i.id),
  scope: (l) => l.scope,
  async run(ctx, i, { p, t }) {
    assertVersion(t.version, i.expectedVersion);
    if (t.status === "done" || t.status === "cancelled")
      throw new DomainError("INVALID_TRANSITION", { reason: "task_closed", status: t.status });
    if (i.ownerId && i.ownerId !== t.owner_id) {
      await assertActiveUser(ctx, i.ownerId);
      // Reassigning to another team needs the grant over the new owner too.
      if (!can(ctx.actor, "task.manage", await taskScope(ctx, p, i.ownerId)))
        throw new DomainError("FORBIDDEN", { permission: "task.manage" });
    }
    if (i.scopeItemId) await assertScopeItem(ctx, p, i.scopeItemId);
    const scopeItemId = i.scopeItemId !== undefined ? i.scopeItemId : t.scope_item_id;
    const nonDeliverable = scopeItemId ? false : (i.nonDeliverable ?? t.non_deliverable);
    const clientFacing = i.clientFacing ?? t.client_facing;
    // INV-20 / D-OS-1: a non-deliverable task is never client-facing (DB CHECK tasks_non_deliverable_internal).
    if (clientFacing && nonDeliverable)
      throw new DomainError("OUT_OF_SCOPE_REQUIRED", { reason: "client_facing_non_deliverable" });
    // TSK-TK-08: client-facing changes only before delivery starts (review states belong to the delivery flow).
    if (clientFacing !== t.client_facing && t.status !== "todo" && t.status !== "in_progress")
      throw new DomainError("INVALID_TRANSITION", { reason: "task_in_delivery", status: t.status });
    const relinked = !!i.scopeItemId && i.scopeItemId !== t.scope_item_id;
    const becomesClientFacing = clientFacing && !t.client_facing;
    const over =
      p.kind === "client" && clientFacing && scopeItemId && (relinked || becomesClientFacing)
        ? await overQuantity(ctx, scopeItemId, t.id)
        : null;
    let oosApprovalId: string | null = null;
    if (over) {
      if (!i.outOfScopeReason) throw new DomainError("OUT_OF_SCOPE_REQUIRED", { reason: "over_quantity", ...over });
      // Like a new task: the request must be granted before work starts, so only a task not yet started can take it.
      if (t.status !== "todo") throw new DomainError("INVALID_TRANSITION", { reason: "task_started", status: t.status });
      const task = {
        id: t.id,
        version: t.version + 1,
        title: i.title ?? t.title,
        estimateMinutes: i.estimateMinutes ?? t.estimate_minutes,
      };
      oosApprovalId = (await requestTaskOos(ctx, p, task, i.outOfScopeReason, over)).id;
    }
    const r = await ctx.tx
      .updateTable("tasks")
      .set((eb) => ({
        version: eb("version", "+", 1),
        ...(i.title !== undefined && { title: i.title }),
        ...(i.description !== undefined && { description: i.description ?? null }),
        ...(i.ownerId !== undefined && { owner_id: i.ownerId }),
        ...(i.estimateMinutes !== undefined && { estimate_minutes: i.estimateMinutes, estimate_source: "manual" }),
        ...(i.dueDate !== undefined && { due_date: i.dueDate }),
        scope_item_id: scopeItemId,
        non_deliverable: nonDeliverable,
        client_facing: clientFacing,
        ...(oosApprovalId && { oos_approval_id: oosApprovalId, oos_status: "pending" }),
      }))
      .where("id", "=", t.id)
      .returning(["id", "version", "owner_id"])
      .executeTakeFirstOrThrow();
    if (i.ownerId && i.ownerId !== t.owner_id) ctx.emit("task.reassigned", { taskId: t.id, from: t.owner_id, to: i.ownerId });
    return r;
  },
  subject: (i) => ({ type: "task", id: i.id }),
});

/** TSK-TK-03/04: the owner moves their own task; starting needs the gates, the dependencies and any OOS approval. */
export const taskMove = defineCommand({
  name: "task.move",
  summary: "Move your task: start it, finish it, or put it back to do",
  permission: "task.move_own",
  input: z.object({ id: uuid, expectedVersion, to: z.enum(["todo", "in_progress", "done"]) }),
  exposeTo: ["web", "mcp"],
  load: (ctx, i) => lockTask(ctx, i.id),
  scope: (l) => l.scope,
  async run(ctx, i, { p, t }) {
    assertVersion(t.version, i.expectedVersion);
    const from = t.status as TaskStatus;
    const event = i.to === "in_progress" ? "start" : i.to === "done" ? "finish" : "stop";
    taskMachine.assert(from, event);
    // TSK-DL-01 / INV-10: client-facing work reaches done only through QC, mark sent and client acceptance.
    if (event === "finish" && t.client_facing) throw new DomainError("QC_REQUIRED", { reason: "client_facing" });
    if (event === "start") {
      await assertWorkAllowed(ctx, p.id);
      if (t.oos_approval_id && t.oos_status !== "approved")
        throw new DomainError("OUT_OF_SCOPE_REQUIRED", { oosStatus: t.oos_status });
      const open = await ctx.tx
        .selectFrom("task_dependencies as d")
        .innerJoin("tasks as x", "x.id", "d.depends_on_id")
        .select(["x.id", "x.title"])
        .where("d.task_id", "=", t.id)
        .where("x.status", "not in", ["done", "cancelled"]) // a cancelled prerequisite no longer blocks
        .execute();
      if (open.length) throw new DomainError("DEPENDENCY_OPEN", { openDependencies: open.map((o) => o.title) });
    }
    const r = await ctx.tx
      .updateTable("tasks")
      .set((eb) => ({
        status: i.to,
        version: eb("version", "+", 1),
        ...(event === "start" && !t.started_at && { started_at: ctx.now }),
        ...(event === "finish" && { done_at: ctx.now }),
      }))
      .where("id", "=", t.id)
      .returning(["id", "status", "version"])
      .executeTakeFirstOrThrow();
    ctx.emit("task.moved", { taskId: t.id, from, to: i.to });
    return r;
  },
  subject: (i) => ({ type: "task", id: i.id }),
});

export const taskCancel = defineCommand({
  name: "task.cancel",
  summary: "Cancel an open task",
  permission: "task.manage",
  input: z.object({ id: uuid, expectedVersion }),
  exposeTo: ["web", "mcp"],
  load: (ctx, i) => lockTask(ctx, i.id),
  scope: (l) => l.scope,
  async run(ctx, i, { t }) {
    assertVersion(t.version, i.expectedVersion);
    taskMachine.assert(t.status as TaskStatus, "cancel");
    await supersedePending(ctx, "task", t.id); // a pending out-of-scope request or QC leaves the inbox
    await supersedePending(ctx, "task_revision", t.id); // and a pending round-4 request
    return ctx.tx
      .updateTable("tasks")
      .set((eb) => ({ status: "cancelled", version: eb("version", "+", 1) }))
      .where("id", "=", t.id)
      .returning(["id", "status", "version"])
      .executeTakeFirstOrThrow();
  },
  subject: (i) => ({ type: "task", id: i.id }),
});

/** TSK-TK-05: same project, no cycles (recursive walk from the new prerequisite back to the task). */
async function addDependency(ctx: Ctx, projectId: string, taskId: string, dependsOnId: string) {
  if (taskId === dependsOnId) throw new DomainError("DEPENDENCY_CYCLE", { reason: "self" });
  const other = await ctx.tx.selectFrom("tasks").select("project_id").where("id", "=", dependsOnId).executeTakeFirst();
  if (!other || other.project_id !== projectId)
    throw new DomainError("VALIDATION", { issues: [{ path: "dependsOnId", message: "Not a task of this project" }] });
  const cycle = await sql<{ hit: number }>`
    WITH RECURSIVE up(id) AS (
      SELECT depends_on_id FROM task_dependencies WHERE task_id = ${dependsOnId}
      UNION
      SELECT d.depends_on_id FROM task_dependencies d JOIN up ON d.task_id = up.id
    )
    SELECT 1 AS hit FROM up WHERE id = ${taskId} LIMIT 1`.execute(ctx.tx);
  if (cycle.rows.length) throw new DomainError("DEPENDENCY_CYCLE");
  await ctx.tx
    .insertInto("task_dependencies")
    .values({ task_id: taskId, depends_on_id: dependsOnId })
    .onConflict((oc) => oc.doNothing())
    .execute();
}

export const taskSetDependency = defineCommand({
  name: "task.set_dependency",
  summary: "Make a task wait for another task of the same project, or remove that dependency",
  permission: "task.manage",
  input: z.object({ taskId: uuid, dependsOnId: uuid, remove: z.boolean().default(false) }),
  exposeTo: ["web", "mcp"],
  load: (ctx, i) => lockTask(ctx, i.taskId, "update"),
  scope: (l) => l.scope,
  async run(ctx, i, { p, t }) {
    if (i.remove) {
      await ctx.tx
        .deleteFrom("task_dependencies")
        .where("task_id", "=", t.id)
        .where("depends_on_id", "=", i.dependsOnId)
        .execute();
    } else {
      await addDependency(ctx, p.id, t.id, i.dependsOnId);
    }
    return { taskId: t.id, dependsOnId: i.dependsOnId, removed: i.remove };
  },
  subject: (i) => ({ type: "task", id: i.taskId }),
});

const taskColumns = [
  "t.id",
  "t.project_id",
  "p.name as project_name",
  "p.pm_id as project_pm_id",
  "t.title",
  "t.owner_id",
  "u.display_name as owner_name",
  "u.team_id as owner_team_id",
  "t.estimate_minutes",
  "t.due_date",
  "t.status",
  "t.scope_item_id",
  "t.non_deliverable",
  "t.oos_status",
  "t.client_facing",
  "t.revision_round",
  "t.oos_decision",
  "t.quality_approval_id",
  "t.revision_oos_approval_id",
  "t.sent_to_client_at",
  "t.sent_reference",
  "t.rank",
  "t.version",
] as const;

/** What the viewer may do next with a task (TSK-DL-12): the board shows these buttons and nothing else. */
export type TaskAction =
  "start" | "stop" | "finish" | "submit_qc" | "mark_sent" | "request_revision" | "client_accept" | "cancel";

interface TaskRowBase {
  id: string;
  project_id: string;
  project_pm_id: string;
  owner_id: string;
  owner_team_id: string | null;
  status: string;
  client_facing: boolean;
  revision_round: number;
  quality_approval_id: string | null;
  revision_oos_approval_id: string | null;
}

/** Dependencies, the current round's QC, the latest round-4 request, and the viewer's allowed actions. */
async function enrich<T extends TaskRowBase>(ctx: Ctx, rows: T[]) {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const deps = await ctx.tx
    .selectFrom("task_dependencies as d")
    .innerJoin("tasks as x", "x.id", "d.depends_on_id")
    .select(["d.task_id", "d.depends_on_id", "x.status"])
    .where("d.task_id", "in", ids)
    .execute();
  const approvalIds = rows.flatMap((r) => [r.quality_approval_id, r.revision_oos_approval_id]).filter((x): x is string => !!x);
  const approvals = new Map(
    (approvalIds.length
      ? await ctx.tx
          .selectFrom("approvals")
          .select([
            "id",
            "status",
            "subject_version",
            "requested_by",
            "required_permission",
            "snapshot",
            "outcome",
            "decision_note",
          ])
          .where("id", "in", approvalIds)
          .execute()
      : []
    ).map((a) => [a.id, a]),
  );
  const projectIds = [...new Set(rows.map((r) => r.project_id))];
  const members = await ctx.tx
    .selectFrom("project_members")
    .select(["project_id", "user_id"])
    .where("project_id", "in", projectIds)
    .where("project_role", "=", "pm")
    .execute();
  const me = ctx.actor.type === "user" ? ctx.actor : null;
  return rows.map((r) => {
    const mine = deps.filter((d) => d.task_id === r.id);
    const qa = r.quality_approval_id ? approvals.get(r.quality_approval_id) : undefined;
    const qcApproval = qa && qa.subject_version === r.revision_round ? qa : undefined;
    const ra = r.revision_oos_approval_id ? approvals.get(r.revision_oos_approval_id) : undefined;
    const raFacts = ((ra?.snapshot as unknown as { facts?: Record<string, unknown> } | undefined)?.facts ?? {}) as {
      reworkMinutes?: number;
    };
    const pms = [r.project_pm_id, ...members.filter((m) => m.project_id === r.project_id).map((m) => m.user_id)];
    const isOwner = !!me && r.owner_id === me.id && can(ctx.actor, "task.move_own", { ownerIds: [r.owner_id] });
    const manages = can(ctx.actor, "task.manage", { assigneeIds: pms, teamIds: [r.owner_team_id] });
    const delivers = isOwner || (!!me && manages && can(ctx.actor, "task.move_own", { ownerIds: [me.id] }));
    const revisionPending = ra?.status === "pending";
    const actions: TaskAction[] = [];
    const add = (ok: boolean, a: TaskAction) => ok && actions.push(a);
    switch (r.status) {
      case "todo":
        add(isOwner, "start");
        break;
      case "in_progress":
        add(isOwner, "stop");
        add(isOwner && !r.client_facing, "finish");
        add(delivers, "submit_qc");
        break;
      case "client_ready":
        add(delivers, "mark_sent");
        break;
      case "client_review":
        add(delivers && r.revision_round < 4 && !revisionPending, "request_revision");
        add(delivers, "client_accept");
        break;
    }
    add(manages && taskMachine.can(r.status as TaskStatus, "cancel"), "cancel");
    return {
      ...r,
      dependsOn: mine.map((d) => d.depends_on_id),
      blockedByDependencies: mine.some((d) => d.status !== "done" && d.status !== "cancelled"),
      /** The quality check for the current round (TSK-DL-03), if one was requested. */
      qc: qcApproval
        ? {
            approvalId: qcApproval.id,
            status: qcApproval.status,
            canDecide:
              !!me &&
              qcApproval.status === "pending" &&
              qcApproval.requested_by !== me.id &&
              r.owner_id !== me.id &&
              mayDecide(me, qcApproval.required_permission, (qcApproval.snapshot as unknown as { scope: ResourceScope }).scope),
          }
        : null,
      qcStatus: (qcApproval?.status ?? "none") as string,
      /** The latest round-4 request (TSK-DL-07/08): pending, or its outcome and the decision note for the client. */
      revisionRequest: ra
        ? {
            approvalId: ra.id,
            status: ra.status,
            outcome: ra.outcome,
            note: ra.decision_note,
            reworkMinutes: raFacts.reworkMinutes ?? null,
          }
        : null,
      /** What a client revision request would do now: start a normal round, ask out-of-scope, or be refused. */
      nextRevision:
        r.status !== "client_review"
          ? null
          : r.revision_round >= 4
            ? ("hard_stop" as const)
            : r.revision_round === 3
              ? ("out_of_scope" as const)
              : ("normal" as const),
      actions,
    };
  });
}

/** TSK-TK-07: Kanban for one project (every task by state). */
export const taskBoard = defineQuery({
  name: "task.board",
  summary: "A project's tasks by state (Kanban), with what blocks each one, the current round and QC, and allowed actions",
  permission: "project.view",
  input: z.object({ projectId: uuid, includeCancelled: z.boolean().default(false) }),
  exposeTo: ["web", "mcp"],
  async run(ctx, i) {
    const p = notFoundIfMissing(
      await ctx.tx
        .selectFrom("projects")
        .select(["id", "pm_id", "kind", "status", "name"])
        .where("id", "=", i.projectId)
        .executeTakeFirst(),
    );
    let q = ctx.tx
      .selectFrom("tasks as t")
      .innerJoin("projects as p", "p.id", "t.project_id")
      .innerJoin("users as u", "u.id", "t.owner_id")
      .select([...taskColumns])
      .where("t.project_id", "=", p.id);
    if (!i.includeCancelled) q = q.where("t.status", "<>", "cancelled");
    const rows = await enrich(ctx, await q.orderBy("t.rank").orderBy("t.due_date").orderBy("t.created_at").execute());
    const pms = await pmIds(ctx, p);
    const me = ctx.actor.type === "user" ? ctx.actor.id : null;
    return {
      project: p,
      states: taskMachine.states,
      canManage: can(ctx.actor, "task.manage", { assigneeIds: pms }),
      tasks: rows.map((r) => ({
        ...r,
        canMove: !!me && r.owner_id === me && can(ctx.actor, "task.move_own", { ownerIds: [r.owner_id] }),
      })),
    };
  },
  subject: (i) => ({ type: "project", id: i.projectId }),
});

/** TSK-TK-07: Kanban for one person (their open tasks across projects; mine by default). */
export const taskMine = defineQuery({
  name: "task.mine",
  summary: "My open tasks across all projects (or another person's: every internal role can view project work)",
  permission: "project.view",
  input: z.object({ ownerId: uuid.optional(), includeDone: z.boolean().default(false) }).default({}),
  exposeTo: ["web", "mcp"],
  async run(ctx, i) {
    const ownerId = i.ownerId ?? (ctx.actor.type === "user" ? ctx.actor.id : null);
    if (!ownerId) throw new DomainError("VALIDATION", { issues: [{ path: "ownerId", message: "Required" }] });
    const statuses: string[] = i.includeDone ? [...OPEN_TASK_STATES, "done"] : [...OPEN_TASK_STATES];
    const rows = await ctx.tx
      .selectFrom("tasks as t")
      .innerJoin("projects as p", "p.id", "t.project_id")
      .innerJoin("users as u", "u.id", "t.owner_id")
      .select([...taskColumns])
      .where("t.owner_id", "=", ownerId)
      .where("t.status", "in", statuses)
      .orderBy("t.due_date")
      .limit(500)
      .execute();
    return enrich(ctx, rows);
  },
});

export const taskGet = defineQuery({
  name: "task.get",
  summary: "One task with its dependencies, revision rounds and quality checks",
  permission: "project.view",
  input: ByIdInput,
  exposeTo: ["web", "mcp"],
  async run(ctx, i) {
    const t = notFoundIfMissing(
      await ctx.tx
        .selectFrom("tasks as t")
        .innerJoin("projects as p", "p.id", "t.project_id")
        .innerJoin("users as u", "u.id", "t.owner_id")
        .select([...taskColumns, "t.description", "t.oos_approval_id", "t.started_at", "t.done_at"])
        .where("t.id", "=", i.id)
        .executeTakeFirst(),
    );
    const rounds = await ctx.tx
      .selectFrom("task_rounds as r")
      .innerJoin("users as u", "u.id", "r.requested_by")
      .leftJoin("approvals as a", (j) =>
        j.on((eb) => eb.or([eb("a.id", "=", eb.ref("r.quality_approval_id")), eb("a.id", "=", eb.ref("r.oos_approval_id"))])),
      )
      .select([
        "r.round",
        "r.kind",
        "r.quality_approval_id",
        "r.oos_approval_id",
        "r.rework_minutes",
        "r.note",
        "u.display_name as requested_by_name",
        "r.created_at",
        "a.status as approval_status",
      ])
      .where("r.task_id", "=", t.id)
      .orderBy("r.created_at")
      .orderBy("r.round")
      .execute();
    return { ...(await enrich(ctx, [t]))[0]!, rounds };
  },
  subject: (i) => ({ type: "task", id: i.id }),
});
