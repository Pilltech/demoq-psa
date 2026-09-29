// Influencer roster and assignments. Spec: specs/influencers/links.md (INF-RS-*)
import { z } from "zod";
import { expectedVersion, INFLUENCER_PLATFORMS, minorUnits, optionalText, requiredText, uuid } from "@demoq/shared";
import {
  assertVersion,
  can,
  defineCommand,
  defineQuery,
  DomainError,
  notFoundIfMissing,
  type Ctx,
  type ResourceScope,
} from "../kernel";
import { projectScope } from "../projects";

const Handle = z.object({ platform: z.enum(INFLUENCER_PLATFORMS), handle: requiredText(100) }).strict();

const who = (ctx: Ctx) => {
  if (ctx.actor.type !== "user") throw new DomainError("FORBIDDEN", { reason: "needs_a_person" });
  return ctx.actor;
};

/** Revoke every live link of the given assignments (deactivation, INF-RS-04). */
export async function revokeLinksOf(ctx: Ctx, assignmentIds: string[], reason: string): Promise<number> {
  if (!assignmentIds.length) return 0;
  const me = who(ctx);
  const rows = await ctx.tx
    .updateTable("work_log_links")
    .set((eb) => ({
      status: "revoked",
      revoked_at: ctx.now,
      revoked_by: me.id,
      revoke_reason: reason,
      version: eb("version", "+", 1),
    }))
    .where("assignment_id", "in", assignmentIds)
    .where("status", "=", "active")
    .returning("id")
    .execute();
  return rows.length;
}

// ---------------------------------------------------------------------------------------------------------------
// Roster (INF-RS-01)
// ---------------------------------------------------------------------------------------------------------------

export const influencerCreate = defineCommand({
  name: "influencer.create",
  summary: "Add an influencer to the roster (name, platform handles, optional phone/Telegram)",
  permission: "influencer.manage",
  input: z.object({
    displayName: requiredText(200),
    handles: z.array(Handle).max(10).default([]),
    phone: optionalText(40),
    telegram: optionalText(100),
    notes: optionalText(2000),
  }),
  exposeTo: ["web"],
  async run(ctx, i) {
    return ctx.tx
      .insertInto("influencers")
      .values({
        display_name: i.displayName,
        handles: JSON.stringify(i.handles),
        phone: i.phone ?? null,
        telegram: i.telegram ?? null,
        notes: i.notes ?? null,
      })
      .returning(["id", "version", "active"])
      .executeTakeFirstOrThrow();
  },
  subject: (_i, r) => ({ type: "influencer", id: r.id }),
});

export const influencerUpdate = defineCommand({
  name: "influencer.update",
  summary: "Edit an influencer; deactivating one revokes their live links",
  permission: "influencer.manage",
  input: z.object({
    id: uuid,
    expectedVersion,
    displayName: requiredText(200).optional(),
    handles: z.array(Handle).max(10).optional(),
    phone: optionalText(40),
    telegram: optionalText(100),
    notes: optionalText(2000),
    active: z.boolean().optional(),
  }),
  exposeTo: ["web"],
  async load(ctx, i) {
    return notFoundIfMissing(
      await ctx.tx.selectFrom("influencers").selectAll().where("id", "=", i.id).forUpdate().executeTakeFirst(),
    );
  },
  async run(ctx, i, inf) {
    assertVersion(inf.version, i.expectedVersion);
    const r = await ctx.tx
      .updateTable("influencers")
      .set((eb) => ({
        ...(i.displayName !== undefined && { display_name: i.displayName }),
        ...(i.handles !== undefined && { handles: JSON.stringify(i.handles) }),
        ...(i.phone !== undefined && { phone: i.phone }),
        ...(i.telegram !== undefined && { telegram: i.telegram }),
        ...(i.notes !== undefined && { notes: i.notes }),
        ...(i.active !== undefined && { active: i.active }),
        version: eb("version", "+", 1),
      }))
      .where("id", "=", inf.id)
      .returning(["id", "version", "active"])
      .executeTakeFirstOrThrow();
    let linksRevoked = 0;
    if (inf.active && i.active === false) {
      const ids = await ctx.tx.selectFrom("influencer_assignments").select("id").where("influencer_id", "=", inf.id).execute();
      linksRevoked = await revokeLinksOf(
        ctx,
        ids.map((a) => a.id),
        "influencer_deactivated",
      );
    }
    return { ...r, linksRevoked };
  },
  subject: (i) => ({ type: "influencer", id: i.id }),
});

/**
 * INF-RS-01: the roster is readable by whoever manages it or issues links (PMs pick influencers from it).
 * Contact details (phone, Telegram, notes) only for roster managers.
 */
export const influencerList = defineQuery({
  name: "influencer.list",
  summary: "The influencer roster (contact details for roster managers only)",
  permission: "influencer.link.issue",
  input: z.object({ includeInactive: z.boolean().default(false), q: optionalText(100) }),
  exposeTo: ["web", "mcp"],
  rowFiltered: true, // the roster is not project-scoped: any grant of influencer.link.issue may pick from it
  async run(ctx, i) {
    let q = ctx.tx.selectFrom("influencers").selectAll().orderBy("display_name").limit(500);
    if (!i.includeInactive) q = q.where("active", "=", true);
    if (i.q) q = q.where("display_name", "ilike", `%${i.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    const contacts = can(ctx.actor, "influencer.manage");
    return (await q.execute()).map((r) => ({
      id: r.id,
      displayName: r.display_name,
      handles: r.handles as { platform: string; handle: string }[],
      active: r.active,
      version: r.version,
      ...(contacts ? { phone: r.phone, telegram: r.telegram, notes: r.notes } : {}),
    }));
  },
});

// ---------------------------------------------------------------------------------------------------------------
// Assignments (INF-RS-02, INF-RS-03)
// ---------------------------------------------------------------------------------------------------------------

async function lockProjectShared(ctx: Ctx, id: string) {
  return notFoundIfMissing(await ctx.tx.selectFrom("projects").selectAll().where("id", "=", id).forShare().executeTakeFirst());
}

/** Influencer managers act on any project; a project's PMs are "assigned" (influencer.link.issue). */
export async function influencerProjectScope(ctx: Ctx, p: { id: string; pm_id: string; client_id: string | null }) {
  const s = await projectScope(ctx, p);
  return { assigneeIds: s.assigneeIds } satisfies ResourceScope;
}

async function assertDeliverable(ctx: Ctx, p: { scope_id: string | null }, scopeItemId: string) {
  const s = await ctx.tx.selectFrom("scope_items").select("scope_id").where("id", "=", scopeItemId).executeTakeFirst();
  if (!s || !p.scope_id || s.scope_id !== p.scope_id)
    throw new DomainError("VALIDATION", { issues: [{ path: "scopeItemId", message: "Not a deliverable of this project" }] });
}

async function scopeCurrency(ctx: Ctx, scopeId: string | null) {
  if (!scopeId) return null;
  return (await ctx.tx.selectFrom("scopes").select("currency").where("id", "=", scopeId).executeTakeFirst())?.currency ?? null;
}

export const assignmentCreate = defineCommand({
  name: "influencer.assignment.create",
  summary: "Assign an influencer to a deliverable of a project, with the contracted number of posts",
  permission: "influencer.link.issue",
  input: z.object({
    projectId: uuid,
    scopeItemId: uuid,
    influencerId: uuid,
    contractedPosts: z.number().int().min(1).max(1000),
    /** D-IN-2: what one post costs in pass-through, in the project's scope currency (minor units). */
    perPostPassthroughMinor: minorUnits.nullish(),
    notes: optionalText(2000),
  }),
  exposeTo: ["web"],
  async load(ctx, i) {
    const p = await lockProjectShared(ctx, i.projectId);
    return { p, scope: await influencerProjectScope(ctx, p) };
  },
  scope: (l) => l.scope,
  async run(ctx, i, { p }) {
    const me = who(ctx);
    if (!["gated", "active", "on_hold"].includes(p.status))
      throw new DomainError("INVALID_TRANSITION", { reason: "project_closed", status: p.status });
    await assertDeliverable(ctx, p, i.scopeItemId);
    const inf = await ctx.tx
      .selectFrom("influencers")
      .select(["id", "active"])
      .where("id", "=", i.influencerId)
      .executeTakeFirst();
    if (!inf?.active)
      throw new DomainError("VALIDATION", { issues: [{ path: "influencerId", message: "Not an active influencer" }] });
    const hasValue = i.perPostPassthroughMinor !== undefined && i.perPostPassthroughMinor !== null;
    return ctx.tx
      .insertInto("influencer_assignments")
      .values({
        project_id: p.id,
        scope_item_id: i.scopeItemId,
        influencer_id: i.influencerId,
        contracted_posts: i.contractedPosts,
        per_post_passthrough_minor: hasValue ? i.perPostPassthroughMinor! : null,
        currency: hasValue ? await scopeCurrency(ctx, p.scope_id) : null,
        notes: i.notes ?? null,
        created_by: me.id,
      })
      .returning(["id", "version", "active"])
      .executeTakeFirstOrThrow();
  },
  subject: (_i, r) => ({ type: "influencer_assignment", id: r.id }),
});

/** Lock order used by every influencer write: project (share) → assignment → link → submission. */
export async function lockAssignment(ctx: Ctx, id: string) {
  const ref = notFoundIfMissing(
    await ctx.tx.selectFrom("influencer_assignments").select("project_id").where("id", "=", id).executeTakeFirst(),
  );
  const p = await lockProjectShared(ctx, ref.project_id);
  const a = notFoundIfMissing(
    await ctx.tx.selectFrom("influencer_assignments").selectAll().where("id", "=", id).forUpdate().executeTakeFirst(),
  );
  return { p, a, scope: await influencerProjectScope(ctx, p) };
}

export const assignmentUpdate = defineCommand({
  name: "influencer.assignment.update",
  summary: "Change an assignment's contracted posts, per-post pass-through or notes; deactivating revokes its links",
  permission: "influencer.link.issue",
  input: z.object({
    id: uuid,
    expectedVersion,
    contractedPosts: z.number().int().min(1).max(1000).optional(),
    perPostPassthroughMinor: minorUnits.nullish(),
    notes: optionalText(2000),
    active: z.boolean().optional(),
  }),
  exposeTo: ["web"],
  load: (ctx, i) => lockAssignment(ctx, i.id),
  scope: (l) => l.scope,
  async run(ctx, i, { p, a }) {
    assertVersion(a.version, i.expectedVersion);
    const value =
      i.perPostPassthroughMinor === undefined
        ? {}
        : i.perPostPassthroughMinor === null
          ? { per_post_passthrough_minor: null, currency: null }
          : { per_post_passthrough_minor: i.perPostPassthroughMinor, currency: await scopeCurrency(ctx, p.scope_id) };
    const r = await ctx.tx
      .updateTable("influencer_assignments")
      .set((eb) => ({
        ...(i.contractedPosts !== undefined && { contracted_posts: i.contractedPosts }),
        ...value,
        ...(i.notes !== undefined && { notes: i.notes }),
        ...(i.active !== undefined && { active: i.active }),
        version: eb("version", "+", 1),
      }))
      .where("id", "=", a.id)
      .returning(["id", "version", "active", "contracted_posts"])
      .executeTakeFirstOrThrow();
    const linksRevoked = a.active && i.active === false ? await revokeLinksOf(ctx, [a.id], "assignment_deactivated") : 0;
    return { id: r.id, version: r.version, active: r.active, contractedPosts: r.contracted_posts, linksRevoked };
  },
  subject: (i) => ({ type: "influencer_assignment", id: i.id }),
});

export const assignmentList = defineQuery({
  name: "influencer.assignment.list",
  summary: "Influencer assignments of a project: deliverable, contracted posts (per-post pass-through for cost viewers)",
  permission: "influencer.link.issue",
  input: z.object({ projectId: uuid }),
  exposeTo: ["web", "mcp"],
  async load(ctx, i) {
    const p = notFoundIfMissing(await ctx.tx.selectFrom("projects").selectAll().where("id", "=", i.projectId).executeTakeFirst());
    return { p, scope: await influencerProjectScope(ctx, p) };
  },
  scope: (l) => l.scope,
  async run(ctx, i, { p }) {
    // INF-RS-05 / INV-16: the per-post pass-through is a cost; only finance.view_costs holders (in scope) see it.
    const showCosts = can(ctx.actor, "finance.view_costs", await projectScope(ctx, p));
    const rows = await ctx.tx
      .selectFrom("influencer_assignments as a")
      .innerJoin("influencers as i", "i.id", "a.influencer_id")
      .innerJoin("scope_items as s", "s.id", "a.scope_item_id")
      .select([
        "a.id",
        "a.influencer_id",
        "i.display_name",
        "a.scope_item_id",
        "s.description_en",
        "s.description_km",
        "a.contracted_posts",
        "a.per_post_passthrough_minor",
        "a.currency",
        "a.notes",
        "a.active",
        "a.version",
      ])
      .where("a.project_id", "=", i.projectId)
      .orderBy("i.display_name")
      .execute();
    return rows.map((r) => ({
      id: r.id,
      influencerId: r.influencer_id,
      influencer: r.display_name,
      scopeItemId: r.scope_item_id,
      deliverable: { en: r.description_en, km: r.description_km },
      contractedPosts: r.contracted_posts,
      perPostPassthroughMinor: showCosts ? r.per_post_passthrough_minor : null,
      currency: showCosts ? r.currency : null,
      costsHidden: !showCosts,
      notes: r.notes,
      active: r.active,
      version: r.version,
    }));
  },
});
