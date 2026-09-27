// Projects. Spec: specs/projects/projects.md (PRJ-PJ-*)
import { sql } from "kysely";
import { z } from "zod";
import { ByIdInput, expectedVersion, isoDate, requiredText, uuid } from "@demoq/shared";
import {
  assertVersion,
  can,
  defineCommand,
  defineMachine,
  defineQuery,
  DomainError,
  notFoundIfMissing,
  rowFilter,
  type Ctx,
} from "../kernel";
import { createGates, gateStatus, lockProject, projectScope } from "./gates";

export const projectMachine = defineMachine({
  name: "project",
  states: ["gated", "active", "on_hold", "completed", "cancelled"] as const,
  transitions: {
    activate: { from: ["gated"], to: "active" },
    hold: { from: ["active"], to: "on_hold" },
    resume: { from: ["on_hold"], to: "active" },
    complete: { from: ["active", "on_hold"], to: "completed" },
    cancel: { from: ["gated", "active", "on_hold"], to: "cancelled" },
  },
});

async function assertActiveUser(ctx: Ctx, userId: string, path: string) {
  const u = await ctx.tx.selectFrom("users").select("id").where("id", "=", userId).where("active", "=", true).executeTakeFirst();
  if (!u) throw new DomainError("VALIDATION", { issues: [{ path, message: "Unknown or inactive user" }] });
}

/** Used by quote.accept (COM-AC-04): a gated client project with its five gates. */
export async function createClientProject(
  ctx: Ctx,
  a: {
    name: string;
    clientId: string;
    dealId: string;
    quoteId: string;
    scopeId: string;
    projectTypeId: string;
    engagementTypeId: string;
    plannedStart: string;
    pmId: string;
    acceptedRef: string;
  },
) {
  await assertActiveUser(ctx, a.pmId, "projectManagerId");
  const p = await ctx.tx
    .insertInto("projects")
    .values({
      kind: "client",
      name: a.name,
      client_id: a.clientId,
      deal_id: a.dealId,
      quote_id: a.quoteId,
      scope_id: a.scopeId,
      project_type_id: a.projectTypeId,
      engagement_type_id: a.engagementTypeId,
      planned_start: a.plannedStart,
      pm_id: a.pmId,
      status: "gated",
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await ctx.tx.insertInto("project_members").values({ project_id: p.id, user_id: a.pmId, project_role: "pm" }).execute();
  await createGates(ctx, p.id, a.clientId, a.acceptedRef);
  ctx.emit("project.created", { projectId: p.id });
  return p;
}

export const projectCreateInternal = defineCommand({
  name: "project.create_internal",
  summary: "Create an internal project (no client, no gates)",
  permission: "project.manage",
  input: z.object({ name: requiredText(200), projectTypeId: uuid, plannedStart: isoDate, projectManagerId: uuid }),
  exposeTo: ["web"],
  async run(ctx, i) {
    // Internal projects are ops business: needs the `any` grant (a PM cannot be "assigned" to a project that does not exist yet).
    if (rowFilter(ctx.actor, "project.manage")?.kind !== "any") throw new DomainError("FORBIDDEN");
    await assertActiveUser(ctx, i.projectManagerId, "projectManagerId");
    const p = await ctx.tx
      .insertInto("projects")
      .values({
        kind: "internal",
        name: i.name,
        project_type_id: i.projectTypeId,
        planned_start: i.plannedStart,
        pm_id: i.projectManagerId,
        status: "active",
        activated_at: ctx.now,
      })
      .returning(["id", "version"])
      .executeTakeFirstOrThrow();
    await ctx.tx
      .insertInto("project_members")
      .values({ project_id: p.id, user_id: i.projectManagerId, project_role: "pm" })
      .execute();
    return p;
  },
  subject: (_i, r) => ({ type: "project", id: r.id }),
});

async function loadForChange(ctx: Ctx, id: string) {
  const p = await lockProject(ctx, id);
  return { p, scope: await projectScope(ctx, p) };
}

export const projectUpdate = defineCommand({
  name: "project.update",
  summary: "Change a project's name, PM or planned start (before activation, template due dates move too)",
  permission: "project.manage",
  input: z.object({
    id: uuid,
    expectedVersion,
    name: requiredText(200).optional(),
    projectManagerId: uuid.optional(),
    plannedStart: isoDate.optional(),
  }),
  exposeTo: ["web", "mcp"],
  load: (ctx, i) => loadForChange(ctx, i.id),
  scope: (l) => l.scope,
  async run(ctx, i, { p }) {
    assertVersion(p.version, i.expectedVersion);
    if (i.projectManagerId) await assertActiveUser(ctx, i.projectManagerId, "projectManagerId");
    if (i.plannedStart && i.plannedStart !== p.planned_start) {
      if (p.status !== "gated") throw new DomainError("INVALID_TRANSITION", { reason: "planned_start_fixed_after_activation" });
      // A retainer's periods are calendar months from the accepted start (D-RT-1): the start may move within that month only.
      if (p.scope_id && i.plannedStart.slice(0, 7) !== p.planned_start.slice(0, 7)) {
        const sc = await ctx.tx
          .selectFrom("scopes")
          .select("billing_model")
          .where("id", "=", p.scope_id)
          .executeTakeFirstOrThrow();
        if (sc.billing_model === "retainer")
          throw new DomainError("VALIDATION", {
            issues: [{ path: "plannedStart", message: "A retainer's start can move only within its first month" }],
          });
      }
      // PRJ-PJ-03: template tasks keep their offset from the planned start.
      await sql`UPDATE tasks SET due_date = due_date + (${i.plannedStart}::date - ${p.planned_start}::date), version = version + 1
                WHERE project_id = ${p.id} AND template_item_id IS NOT NULL AND status IN ('todo', 'in_progress')`.execute(
        ctx.tx,
      );
    }
    if (i.projectManagerId && i.projectManagerId !== p.pm_id) {
      // The replaced PM stays a member but loses the PM role (and with it every "assigned" right on the project).
      await ctx.tx
        .updateTable("project_members")
        .set({ project_role: "member" })
        .where("project_id", "=", p.id)
        .where("user_id", "=", p.pm_id)
        .where("project_role", "=", "pm")
        .execute();
      await ctx.tx
        .insertInto("project_members")
        .values({ project_id: p.id, user_id: i.projectManagerId, project_role: "pm" })
        .onConflict((oc) => oc.columns(["project_id", "user_id"]).doUpdateSet({ project_role: "pm" }))
        .execute();
    }
    return ctx.tx
      .updateTable("projects")
      .set((eb) => ({
        version: eb("version", "+", 1),
        ...(i.name && { name: i.name }),
        ...(i.projectManagerId && { pm_id: i.projectManagerId }),
        ...(i.plannedStart && { planned_start: i.plannedStart }),
      }))
      .where("id", "=", p.id)
      .returning(["id", "version", "planned_start"])
      .executeTakeFirstOrThrow();
  },
  subject: (i) => ({ type: "project", id: i.id }),
});

export const projectSetMember = defineCommand({
  name: "project.set_member",
  summary: "Add a member to a project with a project role (designer, editor, …), or remove them",
  permission: "project.manage",
  input: z.object({
    projectId: uuid,
    userId: uuid,
    projectRole: z
      .string()
      .regex(/^[a-z][a-z_]*$/)
      .max(40)
      .nullable(),
  }),
  exposeTo: ["web", "mcp"],
  load: (ctx, i) => loadForChange(ctx, i.projectId),
  scope: (l) => l.scope,
  async run(ctx, i, { p }) {
    if (i.projectRole === null) {
      if (i.userId === p.pm_id) throw new DomainError("VALIDATION", { reason: "cannot_remove_pm" });
      await ctx.tx.deleteFrom("project_members").where("project_id", "=", p.id).where("user_id", "=", i.userId).execute();
      return { removed: true };
    }
    await assertActiveUser(ctx, i.userId, "userId");
    await ctx.tx
      .insertInto("project_members")
      .values({ project_id: p.id, user_id: i.userId, project_role: i.projectRole })
      .onConflict((oc) => oc.columns(["project_id", "user_id"]).doUpdateSet({ project_role: i.projectRole! }))
      .execute();
    return { removed: false };
  },
  subject: (i) => ({ type: "project", id: i.projectId }),
});

const transition = (event: "activate" | "hold" | "resume" | "complete" | "cancel", summary: string) =>
  defineCommand({
    name: `project.${event}`,
    summary,
    permission: event === "activate" ? "project.activate" : "project.manage",
    input: z.object({ id: uuid, expectedVersion }),
    exposeTo: ["web", "mcp"],
    load: (ctx, i) => loadForChange(ctx, i.id),
    scope: (l) => l.scope,
    async run(ctx, i, { p }) {
      assertVersion(p.version, i.expectedVersion);
      const to = projectMachine.assert(p.status as never, event);
      if (event === "activate") {
        const { missing } = await gateStatus(ctx, p.id); // bypasses allow work, not activation (PRJ-PJ-02)
        if (missing.length) throw new DomainError("GATE_BLOCKED", { missing });
      }
      const r = await ctx.tx
        .updateTable("projects")
        .set((eb) => ({ status: to, version: eb("version", "+", 1), ...(event === "activate" && { activated_at: ctx.now }) }))
        .where("id", "=", p.id)
        .returning(["id", "status", "version"])
        .executeTakeFirstOrThrow();
      ctx.emit(`project.${event}`, { projectId: p.id });
      return r;
    },
    subject: (i) => ({ type: "project", id: i.id }),
  });

export const projectActivate = transition("activate", "Activate a gated project once every gate is met");
export const projectHold = transition("hold", "Put an active project on hold");
export const projectResume = transition("resume", "Resume a project on hold");
export const projectComplete = transition("complete", "Complete a project");
export const projectCancel = transition("cancel", "Cancel a project");

export const projectList = defineQuery({
  name: "project.list",
  summary: "Projects (mine by default: where I am PM or member), with status and missing gates",
  permission: "project.view",
  input: z
    .object({ mine: z.boolean().default(true), clientId: uuid.optional(), includeClosed: z.boolean().default(false) })
    .default({}),
  exposeTo: ["web", "mcp"],
  async run(ctx, i) {
    let q = ctx.tx
      .selectFrom("projects as p")
      .leftJoin("clients as c", "c.id", "p.client_id")
      .innerJoin("users as u", "u.id", "p.pm_id")
      .select([
        "p.id",
        "p.name",
        "p.kind",
        "p.status",
        "p.planned_start",
        "p.client_id",
        "c.name as client_name",
        "p.pm_id",
        "u.display_name as pm_name",
        "p.version",
      ]);
    if (i.mine && ctx.actor.type === "user") {
      const me = ctx.actor.id;
      q = q.where((eb) =>
        eb.or([
          eb("p.pm_id", "=", me),
          eb.exists(
            eb
              .selectFrom("project_members as m")
              .select("m.user_id")
              .whereRef("m.project_id", "=", "p.id")
              .where("m.user_id", "=", me),
          ),
        ]),
      );
    }
    if (i.clientId) q = q.where("p.client_id", "=", i.clientId);
    if (!i.includeClosed) q = q.where("p.status", "in", ["gated", "active", "on_hold"]);
    const rows = await q.orderBy("p.planned_start", "desc").limit(300).execute();
    const out = [];
    for (const r of rows) out.push({ ...r, missingGates: r.kind === "client" ? (await gateStatus(ctx, r.id)).uncovered : [] });
    return out;
  },
});

export const projectGet = defineQuery({
  name: "project.get",
  summary: "One project: gates, bypasses, members, scope items and task counts",
  permission: "project.view",
  input: ByIdInput,
  exposeTo: ["web", "mcp"],
  async run(ctx, i) {
    const p = notFoundIfMissing(
      await ctx.tx
        .selectFrom("projects as p")
        .leftJoin("clients as c", "c.id", "p.client_id")
        .innerJoin("users as u", "u.id", "p.pm_id")
        .innerJoin("project_types as t", "t.id", "p.project_type_id")
        .selectAll("p")
        .select([
          "c.name as client_name",
          "u.display_name as pm_name",
          "t.label_en as project_type_en",
          "t.label_km as project_type_km",
        ])
        .where("p.id", "=", i.id)
        .executeTakeFirst(),
    );
    const scope = await projectScope(ctx, p);
    const gates = await ctx.tx
      .selectFrom("project_gates as g")
      .leftJoin("users as u", "u.id", "g.satisfied_by")
      .select(["g.gate", "g.status", "g.evidence", "g.satisfied_at", "u.display_name as satisfied_by_name"])
      .where("g.project_id", "=", p.id)
      .execute();
    const members = await ctx.tx
      .selectFrom("project_members as m")
      .innerJoin("users as u", "u.id", "m.user_id")
      .select(["m.user_id", "m.project_role", "u.display_name"])
      .where("m.project_id", "=", p.id)
      .orderBy("u.display_name")
      .execute();
    const bypasses = await ctx.tx
      .selectFrom("gate_bypasses as b")
      .innerJoin("users as o", "o.id", "b.named_owner_id")
      .select([
        "b.id",
        "b.gates",
        "b.status",
        "b.reason",
        "b.expires_at",
        "b.close_cause",
        "o.display_name as owner_name",
        "b.created_at",
      ])
      .where("b.project_id", "=", p.id)
      .orderBy("b.created_at", "desc")
      .execute();
    const items = p.scope_id
      ? await ctx.tx
          .selectFrom("scope_items")
          .select([
            "id",
            "kind",
            "service_code",
            "description_en",
            "description_km",
            "qty_milli",
            "line_price_minor",
            "quoted_minutes",
            "scope_period_id",
            "source_type",
          ])
          .where("scope_id", "=", p.scope_id)
          .orderBy("created_at")
          .execute()
      : [];
    const tasks = await ctx.tx
      .selectFrom("tasks")
      .select(["status", (eb) => eb.fn.countAll<string>().as("n")])
      .where("project_id", "=", p.id)
      .groupBy("status")
      .execute();
    return {
      ...p,
      gates,
      gateStatus: p.kind === "client" ? await gateStatus(ctx, p.id) : { missing: [], uncovered: [] },
      members,
      bypasses,
      scopeItems: items.map((s) => ({ ...s, line_price_minor: s.line_price_minor.toString() })),
      taskCounts: Object.fromEntries(tasks.map((t) => [t.status, Number(t.n)])),
      canManage: can(ctx.actor, "project.manage", scope),
      canSatisfyGates: can(ctx.actor, "gate.satisfy", scope),
      canActivate: can(ctx.actor, "project.activate", scope),
      canRequestBypass: can(ctx.actor, "project.bypass.request", scope),
    };
  },
  subject: (i) => ({ type: "project", id: i.id }),
});
