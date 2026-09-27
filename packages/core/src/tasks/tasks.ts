// Tasks: one owner, estimate, due date, dependencies; Kanban per project and per person.
// Spec: specs/tasks/tasks.md (TSK-TK-*)
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { z } from "zod";
import { ByIdInput, expectedVersion, isoDate, optionalText, requiredText, uuid } from "@demoq/shared";
import { createApproval, lockSubjectWith, onApprovalDecided } from "../approvals";
import { assertVersion, can, defineCommand, defineMachine, defineQuery, DomainError, notFoundIfMissing, type Ctx, type ResourceScope } from "../kernel";
import { assertWorkAllowed } from "../projects/gates";

export const taskMachine = defineMachine({
  name: "task",
  states: ["todo", "in_progress", "done", "cancelled"] as const,
  transitions: {
    start: { from: ["todo"], to: "in_progress" },
    finish: { from: ["in_progress"], to: "done" },
    stop: { from: ["in_progress"], to: "todo" },
    cancel: { from: ["todo", "in_progress"], to: "cancelled" },
  },
});
type TaskStatus = (typeof taskMachine.states)[number];

async function lockProjectShared(ctx: Ctx, projectId: string) {
  return notFoundIfMissing(await ctx.tx.selectFrom("projects").selectAll().where("id", "=", projectId).forShare().executeTakeFirst());
}
type ProjectRow = Awaited<ReturnType<typeof lockProjectShared>>;

async function pmIds(ctx: Ctx, p: { id: string; pm_id: string }) {
  const pms = await ctx.tx.selectFrom("project_members").select("user_id").where("project_id", "=", p.id).where("project_role", "=", "pm").execute();
  return [p.pm_id, ...pms.map((m) => m.user_id)];
}

async function teamOf(ctx: Ctx, userId: string) {
  return (await ctx.tx.selectFrom("users").select("team_id").where("id", "=", userId).executeTakeFirst())?.team_id ?? null;
}

/**
 * TSK-TK-06: the project's PMs are "assigned" (task.manage), a team lead covers tasks owned by their team,
 * and the owner is "own" (task.move_own).
 */
async function taskScope(ctx: Ctx, p: ProjectRow, ownerId: string): Promise<ResourceScope> {
  return { assigneeIds: await pmIds(ctx, p), teamIds: [await teamOf(ctx, ownerId)], ownerIds: [ownerId] };
}

/** Lock order: project (share) → task. */
async function lockTask(ctx: Ctx, id: string) {
  const ref = notFoundIfMissing(await ctx.tx.selectFrom("tasks").select("project_id").where("id", "=", id).executeTakeFirst());
  const p = await lockProjectShared(ctx, ref.project_id);
  const t = notFoundIfMissing(await ctx.tx.selectFrom("tasks").selectAll().where("id", "=", id).forUpdate().executeTakeFirst());
  return { p, t, scope: await taskScope(ctx, p, t.owner_id) };
}

async function assertActiveUser(ctx: Ctx, userId: string) {
  const u = await ctx.tx.selectFrom("users").select("id").where("id", "=", userId).where("active", "=", true).executeTakeFirst();
  if (!u) throw new DomainError("TASK_INCOMPLETE", { missing: ["ownerId"], reason: "owner_inactive" });
}

async function assertScopeItem(ctx: Ctx, p: ProjectRow, scopeItemId: string) {
  const s = await ctx.tx.selectFrom("scope_items").select("scope_id").where("id", "=", scopeItemId).executeTakeFirst();
  if (!s || s.scope_id !== p.scope_id) throw new DomainError("VALIDATION", { issues: [{ path: "scopeItemId", message: "Not a scope item of this project" }] });
}

const assertOpenProject = (p: ProjectRow) => {
  if (!["gated", "active", "on_hold"].includes(p.status)) throw new DomainError("INVALID_TRANSITION", { reason: "project_closed", status: p.status });
};

/** Account lead of the project's client: decides out-of-scope requests with `own` (scope.oos.decide). */
async function oosScope(ctx: Ctx, p: ProjectRow): Promise<ResourceScope> {
  const lead = p.client_id ? (await ctx.tx.selectFrom("clients").select("account_lead_id").where("id", "=", p.client_id).executeTakeFirst())?.account_lead_id : null;
  return { ownerIds: lead ? [lead] : [] };
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
    await assertActiveUser(ctx, i.ownerId!);
    if (i.scopeItemId) await assertScopeItem(ctx, p, i.scopeItemId);
    const wantsOos = !!i.outOfScopeReason && !i.scopeItemId && !i.nonDeliverable;
    if (p.kind === "client" && !i.scopeItemId && !i.nonDeliverable && !wantsOos) throw new DomainError("OUT_OF_SCOPE_REQUIRED");
    const id = randomUUID();
    let oosApprovalId: string | null = null;
    if (p.kind === "client" && wantsOos) {
      const a = await createApproval(ctx, {
        kind: "out_of_scope",
        subject: { type: "task", id, version: 1, hash: id },
        snapshot: {
          title: `${p.name}: ${i.title}`,
          scope: await oosScope(ctx, p),
          facts: { projectId: p.id, reason: i.outOfScopeReason, estimateMinutes: i.estimateMinutes },
        },
      });
      oosApprovalId = a.id;
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

/** TSK-TK-02: the decision unblocks (or keeps blocked) the task. */
onApprovalDecided("out_of_scope", "task", async (ctx, a, decision) => {
  const t = notFoundIfMissing(await ctx.tx.selectFrom("tasks").select(["id", "oos_status", "project_id"]).where("id", "=", a.subject_id).executeTakeFirst());
  if (t.oos_status !== "pending") return;
  await ctx.tx
    .updateTable("tasks")
    .set((eb) => ({ oos_status: decision === "approve" ? "approved" : "rejected", version: eb("version", "+", 1) }))
    .where("id", "=", t.id)
    .execute();
  ctx.emit(decision === "approve" ? "task.oos_approved" : "task.oos_rejected", { taskId: t.id, projectId: t.project_id });
});

export const taskUpdate = defineCommand({
  name: "task.update",
  summary: "Edit a task: title, description, owner, estimate, due date, scope link",
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
  }),
  exposeTo: ["web", "mcp"],
  load: (ctx, i) => lockTask(ctx, i.id),
  scope: (l) => l.scope,
  async run(ctx, i, { p, t }) {
    assertVersion(t.version, i.expectedVersion);
    if (t.status === "done" || t.status === "cancelled") throw new DomainError("INVALID_TRANSITION", { reason: "task_closed", status: t.status });
    if (i.ownerId && i.ownerId !== t.owner_id) {
      await assertActiveUser(ctx, i.ownerId);
      // Reassigning to another team needs the grant over the new owner too.
      if (!can(ctx.actor, "task.manage", await taskScope(ctx, p, i.ownerId))) throw new DomainError("FORBIDDEN", { permission: "task.manage" });
    }
    if (i.scopeItemId) await assertScopeItem(ctx, p, i.scopeItemId);
    const scopeItemId = i.scopeItemId !== undefined ? i.scopeItemId : t.scope_item_id;
    const nonDeliverable = scopeItemId ? false : (i.nonDeliverable ?? t.non_deliverable);
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
    if (event === "start") {
      await assertWorkAllowed(ctx, p.id);
      if (t.oos_approval_id && t.oos_status !== "approved") throw new DomainError("OUT_OF_SCOPE_REQUIRED", { oosStatus: t.oos_status });
      const open = await ctx.tx
        .selectFrom("task_dependencies as d")
        .innerJoin("tasks as x", "x.id", "d.depends_on_id")
        .select(["x.id", "x.title"])
        .where("d.task_id", "=", t.id)
        .where("x.status", "<>", "done")
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
  if (!other || other.project_id !== projectId) throw new DomainError("VALIDATION", { issues: [{ path: "dependsOnId", message: "Not a task of this project" }] });
  const cycle = await sql<{ hit: number }>`
    WITH RECURSIVE up(id) AS (
      SELECT depends_on_id FROM task_dependencies WHERE task_id = ${dependsOnId}
      UNION
      SELECT d.depends_on_id FROM task_dependencies d JOIN up ON d.task_id = up.id
    )
    SELECT 1 AS hit FROM up WHERE id = ${taskId} LIMIT 1`.execute(ctx.tx);
  if (cycle.rows.length) throw new DomainError("DEPENDENCY_CYCLE");
  await ctx.tx.insertInto("task_dependencies").values({ task_id: taskId, depends_on_id: dependsOnId }).onConflict((oc) => oc.doNothing()).execute();
}

export const taskSetDependency = defineCommand({
  name: "task.set_dependency",
  summary: "Make a task wait for another task of the same project, or remove that dependency",
  permission: "task.manage",
  input: z.object({ taskId: uuid, dependsOnId: uuid, remove: z.boolean().default(false) }),
  exposeTo: ["web", "mcp"],
  load: (ctx, i) => lockTask(ctx, i.taskId),
  scope: (l) => l.scope,
  async run(ctx, i, { p, t }) {
    // Serialise dependency edits per project so two concurrent edges cannot close a cycle together.
    await ctx.tx.selectFrom("projects").select("id").where("id", "=", p.id).forNoKeyUpdate().execute();
    if (i.remove) {
      await ctx.tx.deleteFrom("task_dependencies").where("task_id", "=", t.id).where("depends_on_id", "=", i.dependsOnId).execute();
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
  "t.title",
  "t.owner_id",
  "u.display_name as owner_name",
  "t.estimate_minutes",
  "t.due_date",
  "t.status",
  "t.scope_item_id",
  "t.non_deliverable",
  "t.oos_status",
  "t.client_facing",
  "t.rank",
  "t.version",
] as const;

async function withDeps<T extends { id: string }>(ctx: Ctx, rows: T[]) {
  if (!rows.length) return [];
  const deps = await ctx.tx
    .selectFrom("task_dependencies as d")
    .innerJoin("tasks as x", "x.id", "d.depends_on_id")
    .select(["d.task_id", "d.depends_on_id", "x.status"])
    .where("d.task_id", "in", rows.map((r) => r.id))
    .execute();
  return rows.map((r) => {
    const mine = deps.filter((d) => d.task_id === r.id);
    return { ...r, dependsOn: mine.map((d) => d.depends_on_id), blockedByDependencies: mine.some((d) => d.status !== "done") };
  });
}

/** TSK-TK-07: Kanban for one project (every task by state). */
export const taskBoard = defineQuery({
  name: "task.board",
  summary: "A project's tasks by state (Kanban), with what blocks each one",
  permission: "project.view",
  input: z.object({ projectId: uuid, includeCancelled: z.boolean().default(false) }),
  exposeTo: ["web", "mcp"],
  async run(ctx, i) {
    const p = notFoundIfMissing(await ctx.tx.selectFrom("projects").select(["id", "pm_id", "kind", "status", "name"]).where("id", "=", i.projectId).executeTakeFirst());
    let q = ctx.tx
      .selectFrom("tasks as t")
      .innerJoin("projects as p", "p.id", "t.project_id")
      .innerJoin("users as u", "u.id", "t.owner_id")
      .select([...taskColumns])
      .where("t.project_id", "=", p.id);
    if (!i.includeCancelled) q = q.where("t.status", "<>", "cancelled");
    const rows = await withDeps(ctx, await q.orderBy("t.rank").orderBy("t.due_date").orderBy("t.created_at").execute());
    const pms = await pmIds(ctx, p);
    const me = ctx.actor.type === "user" ? ctx.actor.id : null;
    return {
      project: p,
      canManage: can(ctx.actor, "task.manage", { assigneeIds: pms }),
      tasks: rows.map((r) => ({ ...r, canMove: !!me && r.owner_id === me && can(ctx.actor, "task.move_own", { ownerIds: [r.owner_id] }) })),
    };
  },
  subject: (i) => ({ type: "project", id: i.projectId }),
});

/** TSK-TK-07: Kanban for one person (their open tasks across projects; mine by default). */
export const taskMine = defineQuery({
  name: "task.mine",
  summary: "My open tasks across all projects (or another person's, for PMs and leads)",
  permission: "project.view",
  input: z.object({ ownerId: uuid.optional(), includeDone: z.boolean().default(false) }).default({}),
  exposeTo: ["web", "mcp"],
  async run(ctx, i) {
    const ownerId = i.ownerId ?? (ctx.actor.type === "user" ? ctx.actor.id : null);
    if (!ownerId) throw new DomainError("VALIDATION", { issues: [{ path: "ownerId", message: "Required" }] });
    const statuses = i.includeDone ? ["todo", "in_progress", "done"] : ["todo", "in_progress"];
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
    return withDeps(ctx, rows);
  },
});

export const taskGet = defineQuery({
  name: "task.get",
  summary: "One task with its dependencies",
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
    return (await withDeps(ctx, [t]))[0]!;
  },
  subject: (i) => ({ type: "task", id: i.id }),
});
