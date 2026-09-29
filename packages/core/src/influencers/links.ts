// Expiring work-log links (D13), the public link surface (no account), submissions and their approvals.
// Spec: specs/influencers/links.md (INF-LK-*). Invariants: INV-06 (gates), INV-13 (nothing counts until approved).
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  LINK_DEFAULT_EXPIRES_DAYS,
  LINK_DEFAULT_MAX_SUBMISSIONS,
  LINK_MAX_EXPIRES_DAYS,
  LINK_MAX_PROOF_URLS,
  LINK_MAX_SUBMISSIONS,
  LINK_METRIC_KEYS,
  LINK_NOTE_MAX,
  LINK_TOKEN,
  LINK_URL_MAX,
  LinkSubmissionInput,
  linkTexts,
  optionalText,
  uuid,
  type OosOutcome,
} from "@demoq/shared";
import { createApproval, lockSubjectWith, onApprovalDecided, recordApprovalEvent } from "../approvals";
import {
  businessDate,
  defineCommand,
  defineQuery,
  DomainError,
  monthStart,
  notFoundIfMissing,
  randomToken,
  sha256,
  type Ctx,
  type Kernel,
  type LinkActor,
  type Permission,
} from "../kernel";
import { assertWorkAllowed, projectScope } from "../projects";
import { toUsdMinor } from "../reporting";
import { influencerProjectScope, lockAssignment } from "./roster";

/** INF-LK-06: all a link may do. No role holds this permission; only a link pseudo-actor does. */
export const LINK_GRANTS: readonly Permission[] = ["influencer.link.use"];
export const LINK_TOKEN_BYTES = 32; // 256 bits (INF-LK-01)
export type LinkState = "active" | "expired" | "revoked" | "exhausted";

/**
 * Resolve a link token to its pseudo-actor, by SHA-256 only (INF-LK-01/06). Unknown or malformed → null (the adapter
 * answers 404 without saying why). Not a command: there is no actor yet. Expiry is checked by the ops themselves.
 */
export async function resolveLinkActor(kernel: Kernel, token: string): Promise<LinkActor | null> {
  if (!LINK_TOKEN.test(token)) return null;
  const row = await kernel.db
    .selectFrom("work_log_links")
    .select(["id", "assignment_id"])
    .where("token_hash", "=", sha256(token))
    .executeTakeFirst();
  if (!row) return null;
  return {
    type: "influencer_link",
    name: `link:${row.assignment_id}`,
    linkId: row.id,
    assignmentId: row.assignment_id,
    grants: LINK_GRANTS,
  };
}

/** INF-LK-04: the per-request state is authoritative; the hourly job only tidies `status`. */
export function linkState(l: { status: string; expires_at: Date; max_submissions: number }, used: number, now: Date): LinkState {
  if (l.status === "revoked") return "revoked";
  if (l.status === "exhausted" || used >= l.max_submissions) return "exhausted";
  if (l.status === "expired" || l.expires_at.getTime() <= now.getTime()) return "expired";
  return "active";
}

async function usedCount(ctx: Ctx, linkId: string): Promise<number> {
  const r = await ctx.tx
    .selectFrom("influencer_work_logs")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("link_id", "=", linkId)
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

const who = (ctx: Ctx) => {
  if (ctx.actor.type !== "user") throw new DomainError("FORBIDDEN", { reason: "needs_a_person" });
  return ctx.actor;
};

// ---------------------------------------------------------------------------------------------------------------
// Staff: issue, revoke, list (INF-LK-01…05)
// ---------------------------------------------------------------------------------------------------------------

export const linkIssue = defineCommand({
  name: "influencer.link.issue",
  summary: "Issue an expiring work-log link for an influencer assignment (the link is shown once)",
  permission: "influencer.link.issue",
  input: z.object({
    assignmentId: uuid,
    expiresInDays: z.number().int().min(1).max(LINK_MAX_EXPIRES_DAYS).default(LINK_DEFAULT_EXPIRES_DAYS),
    maxSubmissions: z.number().int().min(1).max(LINK_MAX_SUBMISSIONS).default(LINK_DEFAULT_MAX_SUBMISSIONS),
  }),
  // Web only: the token must not land in a chat or an MCP transcript.
  exposeTo: ["web"],
  load: (ctx, i) => lockAssignment(ctx, i.assignmentId),
  scope: (l) => l.scope,
  async run(ctx, i, { p, a }) {
    const me = who(ctx);
    const inf = await ctx.tx.selectFrom("influencers").select("active").where("id", "=", a.influencer_id).executeTakeFirst();
    if (!a.active || !inf?.active) throw new DomainError("INVALID_TRANSITION", { reason: "assignment_inactive" });
    await assertWorkAllowed(ctx, p.id); // INF-LK-02 / INV-06
    const token = randomToken(LINK_TOKEN_BYTES);
    const expiresAt = new Date(ctx.now.getTime() + i.expiresInDays * 86_400_000);
    const l = await ctx.tx
      .insertInto("work_log_links")
      .values({
        assignment_id: a.id,
        token_hash: sha256(token),
        issued_by: me.id,
        issued_at: ctx.now,
        expires_at: expiresAt,
        max_submissions: i.maxSubmissions,
      })
      .returning(["id", "status", "expires_at", "max_submissions"])
      .executeTakeFirstOrThrow();
    ctx.emit("influencer.link_issued", { linkId: l.id, assignmentId: a.id, projectId: p.id });
    // The only time the token leaves the server. The page lives at /l/<token> in the PWA.
    return { id: l.id, token, path: `/l/${token}`, status: l.status, expiresAt: l.expires_at, maxSubmissions: l.max_submissions };
  },
  subject: (_i, r) => ({ type: "work_log_link", id: r.id }),
});

async function lockLinkForStaff(ctx: Ctx, id: string) {
  const ref = notFoundIfMissing(
    await ctx.tx.selectFrom("work_log_links").select("assignment_id").where("id", "=", id).executeTakeFirst(),
  );
  const locked = await lockAssignment(ctx, ref.assignment_id);
  const link = notFoundIfMissing(
    await ctx.tx.selectFrom("work_log_links").selectAll().where("id", "=", id).forUpdate().executeTakeFirst(),
  );
  return { ...locked, link };
}

export const linkRevoke = defineCommand({
  name: "influencer.link.revoke",
  summary: "Revoke a work-log link at once (it answers 410 from then on)",
  permission: "influencer.link.issue",
  input: z.object({ id: uuid, reason: optionalText(500) }),
  exposeTo: ["web", "mcp"],
  load: (ctx, i) => lockLinkForStaff(ctx, i.id),
  scope: (l) => l.scope,
  async run(ctx, i, { link }) {
    const me = who(ctx);
    if (link.status !== "active") throw new DomainError("INVALID_TRANSITION", { reason: "link_not_active", status: link.status });
    const r = await ctx.tx
      .updateTable("work_log_links")
      .set((eb) => ({
        status: "revoked",
        revoked_at: ctx.now,
        revoked_by: me.id,
        revoke_reason: i.reason ?? null,
        version: eb("version", "+", 1),
      }))
      .where("id", "=", link.id)
      .returning(["id", "status", "version"])
      .executeTakeFirstOrThrow();
    ctx.emit("influencer.link_revoked", { linkId: link.id, assignmentId: link.assignment_id });
    return r;
  },
  subject: (i) => ({ type: "work_log_link", id: i.id }),
});

async function assignmentWithScope(ctx: Ctx, assignmentId: string) {
  const a = notFoundIfMissing(
    await ctx.tx.selectFrom("influencer_assignments").selectAll().where("id", "=", assignmentId).executeTakeFirst(),
  );
  const p = notFoundIfMissing(await ctx.tx.selectFrom("projects").selectAll().where("id", "=", a.project_id).executeTakeFirst());
  return { a, p, scope: await influencerProjectScope(ctx, p) };
}

/** INF-LK-05: staff see a link's state and use, never its token (only the hash is stored). */
export const linkList = defineQuery({
  name: "influencer.link.list",
  summary: "Work-log links of an assignment: state, submissions used, expiry (never the token)",
  permission: "influencer.link.issue",
  input: z.object({ assignmentId: uuid }),
  exposeTo: ["web", "mcp"],
  load: (ctx, i) => assignmentWithScope(ctx, i.assignmentId),
  scope: (l) => l.scope,
  async run(ctx, i) {
    const rows = await ctx.tx
      .selectFrom("work_log_links as l")
      .innerJoin("users as u", "u.id", "l.issued_by")
      .select([
        "l.id",
        "l.status",
        "l.issued_at",
        "l.expires_at",
        "l.max_submissions",
        "l.revoked_at",
        "l.revoke_reason",
        "u.display_name as issued_by",
      ])
      .select((eb) =>
        eb
          .selectFrom("influencer_work_logs as w")
          .select((e) => e.fn.countAll<string>().as("n"))
          .whereRef("w.link_id", "=", "l.id")
          .as("used"),
      )
      .where("l.assignment_id", "=", i.assignmentId)
      .orderBy("l.issued_at", "desc")
      .execute();
    return rows.map((r) => {
      const used = Number(r.used ?? 0);
      return {
        id: r.id,
        state: linkState(r, used, ctx.now),
        issuedBy: r.issued_by,
        issuedAt: r.issued_at,
        expiresAt: r.expires_at,
        maxSubmissions: r.max_submissions,
        used,
        remaining: Math.max(r.max_submissions - used, 0),
        revokedAt: r.revoked_at,
        revokeReason: r.revoke_reason,
      };
    });
  },
});

// ---------------------------------------------------------------------------------------------------------------
// Public link surface (channel `link`, pseudo-actor `link:<assignment>`): INF-LK-06…09
// ---------------------------------------------------------------------------------------------------------------

const TokenInput = z.object({ token: z.string().max(100) });

/** The link named by the token, and only if it is the one the actor was resolved from (INF-LK-06). */
async function ownLink(ctx: Ctx, token: string) {
  const actor = ctx.actor;
  if (actor.type !== "influencer_link") throw new DomainError("FORBIDDEN", { reason: "link_only" });
  if (!LINK_TOKEN.test(token)) throw new DomainError("NOT_FOUND");
  const l = await ctx.tx
    .selectFrom("work_log_links")
    .select(["id", "assignment_id"])
    .where("token_hash", "=", sha256(token))
    .executeTakeFirst();
  if (!l || l.id !== actor.linkId || l.assignment_id !== actor.assignmentId) throw new DomainError("NOT_FOUND");
  return l;
}

async function linkContext(ctx: Ctx, assignmentId: string) {
  return ctx.tx
    .selectFrom("influencer_assignments as a")
    .innerJoin("influencers as i", "i.id", "a.influencer_id")
    .innerJoin("projects as p", "p.id", "a.project_id")
    .innerJoin("scope_items as s", "s.id", "a.scope_item_id")
    .select([
      "a.id",
      "a.project_id",
      "a.contracted_posts",
      "a.active",
      "i.display_name as influencer",
      "i.active as influencer_active",
      "p.name as project",
      "s.description_en",
      "s.description_km",
    ])
    .where("a.id", "=", assignmentId)
    .executeTakeFirstOrThrow();
}

function assertLive(state: LinkState, a: { active: boolean; influencer_active: boolean }) {
  if (state !== "active") throw new DomainError("LINK_EXPIRED", { reason: state });
  if (!a.active || !a.influencer_active) throw new DomainError("LINK_EXPIRED", { reason: "revoked" });
}

export const linkView = defineQuery({
  name: "link.view",
  summary: "What a work-log link is for: influencer, deliverable, submissions left, expiry, EN/KM page texts",
  permission: "influencer.link.use",
  input: TokenInput,
  exposeTo: ["link"],
  auditOn: ["link"],
  async run(ctx, i) {
    const own = await ownLink(ctx, i.token);
    const link = await ctx.tx.selectFrom("work_log_links").selectAll().where("id", "=", own.id).executeTakeFirstOrThrow();
    const used = await usedCount(ctx, link.id);
    const a = await linkContext(ctx, link.assignment_id);
    assertLive(linkState(link, used, ctx.now), a);
    const mine = await ctx.tx
      .selectFrom("influencer_work_logs")
      .select(["post_url", "posted_on", "status", "submitted_at"])
      .where("link_id", "=", link.id)
      .orderBy("submitted_at", "desc")
      .execute();
    return {
      locale: ctx.locale,
      state: "active" as const,
      influencer: { displayName: a.influencer },
      project: { name: a.project },
      deliverable: { en: a.description_en, km: a.description_km ?? a.description_en },
      contractedPosts: a.contracted_posts,
      submissions: { used, max: link.max_submissions, remaining: Math.max(link.max_submissions - used, 0) },
      expiresAt: link.expires_at,
      accepts: {
        metrics: LINK_METRIC_KEYS,
        maxProofUrls: LINK_MAX_PROOF_URLS,
        noteMaxLength: LINK_NOTE_MAX,
        urlMaxLength: LINK_URL_MAX,
      },
      mine: mine.map((m) => ({ postUrl: m.post_url, postedOn: m.posted_on, status: m.status, submittedAt: m.submitted_at })),
      texts: linkTexts(),
    };
  },
});

/** Content hash of a submission (the approvals are bound to it). */
const contentHash = (s: { postUrl: string; postedOn: string; metrics: unknown; proofUrls: string[]; note?: string | null }) =>
  sha256(JSON.stringify([s.postUrl, s.postedOn, s.metrics, s.proofUrls, s.note ?? null]));

export const linkSubmit = defineCommand({
  name: "link.submit",
  summary: "Submit a published post through a work-log link (waits for DemoQ's approval)",
  permission: "influencer.link.use",
  input: LinkSubmissionInput.extend(TokenInput.shape),
  exposeTo: ["link"],
  async load(ctx, i) {
    const own = await ownLink(ctx, i.token);
    const locked = await lockAssignment(ctx, own.assignment_id); // project (share) → assignment
    const link = await ctx.tx
      .selectFrom("work_log_links")
      .selectAll()
      .where("id", "=", own.id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    return { ...locked, link };
  },
  async run(ctx, i, { p, a, link }) {
    if (ctx.actor.type !== "influencer_link") throw new DomainError("FORBIDDEN");
    const linkActor = ctx.actor;
    const used = await usedCount(ctx, link.id);
    const info = await linkContext(ctx, a.id);
    assertLive(linkState(link, used, ctx.now), info); // INF-LK-04 / INF-LK-07
    await assertWorkAllowed(ctx, p.id); // INF-LK-09 / INV-06
    if (i.postedOn > businessDate(ctx.now))
      throw new DomainError("VALIDATION", { issues: [{ path: "postedOn", message: "Cannot be in the future" }] });
    // INF-LK-11 / D-IN-2: beyond the contracted posts (counting everything not rejected) is over quantity.
    const counted = Number(
      (
        await ctx.tx
          .selectFrom("influencer_work_logs")
          .select((eb) => eb.fn.countAll<string>().as("n"))
          .where("assignment_id", "=", a.id)
          .where("status", "<>", "rejected")
          .executeTakeFirstOrThrow()
      ).n,
    );
    const overQuantity = counted >= a.contracted_posts;
    const dup = await ctx.tx
      .selectFrom("influencer_work_logs")
      .select("id")
      .where("assignment_id", "=", a.id)
      .where("post_url", "=", i.postUrl)
      .where("status", "<>", "rejected")
      .executeTakeFirst();
    if (dup) throw new DomainError("CONFLICT", { reason: "post_already_submitted" });

    // The influencer has no account: the approvals are requested in the name of the staff member who issued the link
    // (so that person cannot also approve them), and their history shows the link as the actor.
    const issuer = notFoundIfMissing(
      await ctx.tx.selectFrom("users").select(["id", "team_id"]).where("id", "=", link.issued_by).executeTakeFirst(),
    );
    const roles = (await ctx.tx.selectFrom("user_roles").select("role").where("user_id", "=", issuer.id).execute()).map(
      (r) => r.role as never,
    );
    const asRequester: Ctx = {
      ...ctx,
      actor: { type: "user", id: issuer.id, name: linkActor.name, roles, teamId: issuer.team_id },
    };
    const id = randomUUID();
    const hash = contentHash(i);
    const facts = {
      via: "link",
      projectId: p.id,
      project: p.name,
      assignmentId: a.id,
      influencer: info.influencer,
      deliverable: info.description_en,
      postUrl: i.postUrl,
      postedOn: i.postedOn,
      proofUrls: i.proofUrls,
      metrics: i.metrics,
      note: i.note ?? null,
      contractedPosts: a.contracted_posts,
      submittedCount: counted + 1,
      overQuantity,
    };
    const work = await createApproval(asRequester, {
      kind: "influencer_work",
      subject: { type: "influencer_work_log", id, version: 1, hash },
      snapshot: {
        title: `${info.influencer}: ${info.description_en} (${p.name})`,
        scope: await influencerProjectScope(ctx, p),
        facts,
      },
    });
    let oosApprovalId: string | null = null;
    if (overQuantity) {
      const owners = (await projectScope(ctx, p)).ownerIds;
      const oos = await createApproval(asRequester, {
        kind: "out_of_scope",
        // A separate subject type, so the out-of-scope approval does not supersede the influencer_work one.
        subject: { type: "influencer_extra_post", id, version: 1, hash },
        snapshot: {
          title: `${info.influencer}: post ${counted + 1} of ${a.contracted_posts} contracted (${p.name})`,
          scope: { ownerIds: owners },
          facts: { ...facts, reason: "influencer_over_quantity" },
          ...(a.per_post_passthrough_minor !== null && {
            costs: { perPostPassthroughMinor: a.per_post_passthrough_minor.toString(), currency: a.currency },
          }),
        },
      });
      oosApprovalId = oos.id;
    }
    await ctx.tx
      .insertInto("influencer_work_logs")
      .values({
        id,
        assignment_id: a.id,
        link_id: link.id,
        post_url: i.postUrl,
        posted_on: i.postedOn,
        metrics: JSON.stringify(i.metrics),
        proof_urls: i.proofUrls,
        note: i.note ?? null,
        over_quantity: overQuantity,
        approval_id: work.id,
        oos_approval_id: oosApprovalId,
        ip: ctx.ip ?? null,
        user_agent: ctx.userAgent?.slice(0, 400) ?? null,
        submitted_at: ctx.now,
      })
      .execute();
    if (used + 1 >= link.max_submissions) {
      await ctx.tx
        .updateTable("work_log_links")
        .set((eb) => ({ status: "exhausted", version: eb("version", "+", 1) }))
        .where("id", "=", link.id)
        .execute();
    }
    ctx.emit("influencer.work_submitted", { logId: id, assignmentId: a.id, projectId: p.id, overQuantity });
    // What the influencer sees: pending review, and how many submissions are left. Nothing about approvals.
    return {
      id,
      status: "submitted" as const,
      submissions: { used: used + 1, max: link.max_submissions, remaining: Math.max(link.max_submissions - used - 1, 0) },
    };
  },
  subject: (_i, r) => ({ type: "influencer_work_log", id: r.id }),
});

// ---------------------------------------------------------------------------------------------------------------
// Job: tidy expired links (INF-LK-05). The per-request check stays authoritative.
// ---------------------------------------------------------------------------------------------------------------

export const linkExpireDue = defineCommand({
  name: "influencer.link.expire_due",
  summary: "Mark work-log links past their expiry as expired (hourly job)",
  permission: "influencer.jobs",
  input: z.object({}).default({}),
  exposeTo: ["job"],
  async run(ctx) {
    const rows = await ctx.tx
      .updateTable("work_log_links")
      .set((eb) => ({ status: "expired", version: eb("version", "+", 1) }))
      .where("status", "=", "active")
      .where("expires_at", "<=", ctx.now)
      .returning("id")
      .execute();
    return { expired: rows.length };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// Staff: submissions and approved counts (INF-LK-10, INV-13)
// ---------------------------------------------------------------------------------------------------------------

async function projectWithScope(ctx: Ctx, projectId: string) {
  const p = notFoundIfMissing(await ctx.tx.selectFrom("projects").selectAll().where("id", "=", projectId).executeTakeFirst());
  return { p, scope: await influencerProjectScope(ctx, p) };
}

export const workList = defineQuery({
  name: "influencer.work.list",
  summary: "Influencer submissions of a project with their review status (content is influencer-supplied)",
  permission: "influencer.work.approve",
  input: z.object({
    projectId: uuid,
    assignmentId: uuid.optional(),
    status: z.enum(["submitted", "approved", "rejected"]).optional(),
  }),
  exposeTo: ["web", "mcp"],
  load: (ctx, i) => projectWithScope(ctx, i.projectId),
  scope: (l) => l.scope,
  async run(ctx, i) {
    let q = ctx.tx
      .selectFrom("influencer_work_logs as w")
      .innerJoin("influencer_assignments as a", "a.id", "w.assignment_id")
      .innerJoin("influencers as i", "i.id", "a.influencer_id")
      .select([
        "w.id",
        "w.assignment_id",
        "i.display_name as influencer",
        "w.post_url",
        "w.posted_on",
        "w.metrics",
        "w.proof_urls",
        "w.note",
        "w.status",
        "w.over_quantity",
        "w.oos_outcome",
        "w.approval_id",
        "w.oos_approval_id",
        "w.submitted_at",
        "w.decided_at",
      ])
      .where("a.project_id", "=", i.projectId);
    if (i.assignmentId) q = q.where("w.assignment_id", "=", i.assignmentId);
    if (i.status) q = q.where("w.status", "=", i.status);
    const rows = await q.orderBy("w.submitted_at", "desc").limit(500).execute();
    return rows.map((r) => ({
      id: r.id,
      assignmentId: r.assignment_id,
      influencer: r.influencer,
      postUrl: r.post_url,
      postedOn: r.posted_on,
      metrics: r.metrics,
      proofUrls: r.proof_urls,
      note: r.note,
      status: r.status,
      overQuantity: r.over_quantity,
      oosOutcome: r.oos_outcome,
      approvalId: r.approval_id,
      oosApprovalId: r.oos_approval_id,
      submittedAt: r.submitted_at,
      decidedAt: r.decided_at,
    }));
  },
});

/** INF-LK-10 / INV-13: approved counts (from the approved-only view) against contracted posts, per assignment. */
export const workSummary = defineQuery({
  name: "influencer.work.summary",
  summary: "Approved influencer posts vs contracted, per assignment of a project (pending ones do not count)",
  permission: "project.view",
  input: z.object({ projectId: uuid }),
  exposeTo: ["web", "mcp"],
  async run(ctx, i) {
    notFoundIfMissing(await ctx.tx.selectFrom("projects").select("id").where("id", "=", i.projectId).executeTakeFirst());
    const rows = await ctx.tx
      .selectFrom("influencer_assignments as a")
      .innerJoin("influencers as i", "i.id", "a.influencer_id")
      .innerJoin("scope_items as s", "s.id", "a.scope_item_id")
      .select(["a.id", "i.display_name as influencer", "s.description_en", "s.description_km", "a.contracted_posts", "a.active"])
      .select((eb) => [
        eb
          .selectFrom("v_influencer_work_approved as v")
          .select((e) => e.fn.countAll<string>().as("n"))
          .whereRef("v.assignment_id", "=", "a.id")
          .as("approved"),
        eb
          .selectFrom("v_influencer_work_approved as v")
          .select((e) => e.fn.countAll<string>().as("n"))
          .whereRef("v.assignment_id", "=", "a.id")
          .where("v.over_quantity", "=", true)
          .as("approved_over"),
        eb
          .selectFrom("influencer_work_logs as w")
          .select((e) => e.fn.countAll<string>().as("n"))
          .whereRef("w.assignment_id", "=", "a.id")
          .where("w.status", "=", "submitted")
          .as("pending"),
        eb
          .selectFrom("influencer_work_logs as w")
          .select((e) => e.fn.countAll<string>().as("n"))
          .whereRef("w.assignment_id", "=", "a.id")
          .where("w.status", "=", "rejected")
          .as("rejected"),
      ])
      .where("a.project_id", "=", i.projectId)
      .orderBy("i.display_name")
      .execute();
    return rows.map((r) => {
      const approved = Number(r.approved ?? 0);
      return {
        assignmentId: r.id,
        influencer: r.influencer,
        deliverable: { en: r.description_en, km: r.description_km },
        active: r.active,
        contractedPosts: r.contracted_posts,
        approved,
        approvedOverQuantity: Number(r.approved_over ?? 0),
        pending: Number(r.pending ?? 0),
        rejected: Number(r.rejected ?? 0),
        outstanding: Math.max(r.contracted_posts - approved, 0),
      };
    });
  },
});

// ---------------------------------------------------------------------------------------------------------------
// Decisions (INF-LK-10…12): influencer_work sets the submission's status; out_of_scope records the outcome and, on
// "absorb", writes the value given away (D-IN-2).
// ---------------------------------------------------------------------------------------------------------------

async function lockLog(ctx: Ctx, logId: string) {
  const ref = await ctx.tx.selectFrom("influencer_work_logs").select("assignment_id").where("id", "=", logId).executeTakeFirst();
  if (!ref) return undefined;
  await lockAssignment(ctx, ref.assignment_id);
  return ctx.tx.selectFrom("influencer_work_logs").selectAll().where("id", "=", logId).forUpdate().executeTakeFirst();
}
lockSubjectWith("influencer_work", "influencer_work_log", lockLog);
lockSubjectWith("out_of_scope", "influencer_extra_post", lockLog);

export const EXTRA_POST_SOURCE = "influencer_work_log";

/** D-IN-2: the assignment's per-post pass-through in USD at the scope's frozen rate; else 0 with `valuation_pending`. */
async function recordExtraGiveaway(ctx: Ctx, logId: string, assignmentId: string) {
  const a = await ctx.tx
    .selectFrom("influencer_assignments as a")
    .innerJoin("projects as p", "p.id", "a.project_id")
    .leftJoin("scopes as s", "s.id", "p.scope_id")
    .select(["a.per_post_passthrough_minor", "a.currency", "p.id as project_id", "p.client_id", "s.fx_rate_micros"])
    .where("a.id", "=", assignmentId)
    .executeTakeFirstOrThrow();
  if (!a.client_id) return;
  let amount = 0n;
  let fx = 1_000_000n;
  let note: string | null = "valuation_pending";
  if (a.per_post_passthrough_minor !== null && a.currency) {
    if (a.currency !== "USD") fx = a.fx_rate_micros ?? 0n;
    if (fx > 0n) {
      amount = toUsdMinor(a.per_post_passthrough_minor, a.currency, fx);
      note = null;
    } else fx = 1_000_000n;
  }
  const today = businessDate(ctx.now);
  await ctx.tx
    .insertInto("giveaway_entries")
    .values({
      attributed_month: monthStart(today),
      occurred_on: today,
      client_id: a.client_id,
      project_id: a.project_id,
      kind: "influencer_extra_unbilled",
      amount_usd_minor: amount,
      fx_rate_micros: fx,
      source_type: EXTRA_POST_SOURCE,
      source_id: logId,
      note,
    })
    .execute();
}

/** An absorbed extra post whose work is then rejected: a correcting row (REP-GV-01: corrections are new rows). */
async function reverseExtraGiveaway(ctx: Ctx, logId: string) {
  const orig = await ctx.tx
    .selectFrom("giveaway_entries")
    .selectAll()
    .where("source_type", "=", EXTRA_POST_SOURCE)
    .where("source_id", "=", logId)
    .where("kind", "=", "influencer_extra_unbilled")
    .where("adjusts_entry_id", "is", null)
    .executeTakeFirst();
  if (!orig) return;
  const today = businessDate(ctx.now);
  await ctx.tx
    .insertInto("giveaway_entries")
    .values({
      attributed_month: monthStart(today),
      occurred_on: today,
      client_id: orig.client_id,
      project_id: orig.project_id,
      kind: "influencer_extra_unbilled",
      amount_usd_minor: -orig.amount_usd_minor,
      fx_rate_micros: orig.fx_rate_micros,
      source_type: EXTRA_POST_SOURCE,
      source_id: logId,
      adjusts_entry_id: orig.id,
      note: "work_rejected",
    })
    .execute();
}

onApprovalDecided("influencer_work", "influencer_work_log", async (ctx, approval, decision) => {
  const me = who(ctx);
  const log = await ctx.tx
    .selectFrom("influencer_work_logs")
    .selectAll()
    .where("id", "=", approval.subject_id)
    .executeTakeFirst();
  if (!log || log.status !== "submitted") return;
  const status = decision === "approve" ? "approved" : "rejected";
  await ctx.tx
    .updateTable("influencer_work_logs")
    .set((eb) => ({ status, decided_by: me.id, decided_at: ctx.now, version: eb("version", "+", 1) }))
    .where("id", "=", log.id)
    .execute();
  if (status === "rejected" && log.oos_approval_id) {
    // Nothing extra to absorb or bill for a post DemoQ did not accept.
    const cancelled = await ctx.tx
      .updateTable("approvals")
      .set((eb) => ({ status: "cancelled", version: eb("version", "+", 1) }))
      .where("id", "=", log.oos_approval_id)
      .where("status", "=", "pending")
      .returning("id")
      .execute();
    for (const c of cancelled) await recordApprovalEvent(ctx, c.id, "cancelled", null);
    if (log.oos_outcome === "absorb") await reverseExtraGiveaway(ctx, log.id);
  }
  ctx.emit(`influencer.work_${status}`, { logId: log.id, assignmentId: log.assignment_id });
});

onApprovalDecided("out_of_scope", "influencer_extra_post", async (ctx, approval, decision, outcome) => {
  const log = await ctx.tx
    .selectFrom("influencer_work_logs")
    .selectAll()
    .where("id", "=", approval.subject_id)
    .executeTakeFirst();
  if (!log || log.oos_outcome) return;
  const o: OosOutcome = outcome ?? (decision === "approve" ? "absorb" : "reject");
  await ctx.tx
    .updateTable("influencer_work_logs")
    .set((eb) => ({ oos_outcome: o, version: eb("version", "+", 1) }))
    .where("id", "=", log.id)
    .execute();
  if (o === "absorb" && log.status !== "rejected") await recordExtraGiveaway(ctx, log.id, log.assignment_id);
  ctx.emit("influencer.extra_post_decided", { logId: log.id, assignmentId: log.assignment_id, outcome: o });
});
