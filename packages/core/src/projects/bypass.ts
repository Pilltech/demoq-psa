// Gate bypasses: named, reasoned, reviewed monthly. Spec: specs/projects/bypass.md (PRJ-BP-*)
import { z } from "zod";
import { isoDate, requiredText, uuid } from "@demoq/shared";
import { createApproval, lockSubjectWith, onApprovalDecided } from "../approvals";
import { addDays, addMonths, businessDate, monthStart, defineCommand, defineQuery, DomainError, notFoundIfMissing, type Ctx } from "../kernel";
import { gateStatus, GATES, lockProject, projectScope } from "./gates";

export const BYPASS_MAX_DAYS = 30;
export const BYPASS_REASON_MIN = 30;

export const bypassRequest = defineCommand({
  name: "project.bypass.request",
  summary: "Ask to start work before some gates are met: named owner, reason (30+ characters), expiry within 30 days",
  permission: "project.bypass.request",
  input: z.object({
    projectId: uuid,
    gates: z.array(z.enum(GATES)).min(1),
    namedOwnerId: uuid,
    reason: requiredText(2000),
    expiresOn: isoDate,
  }),
  exposeTo: ["web", "mcp"],
  async load(ctx, i) {
    const p = await lockProject(ctx, i.projectId);
    return { p, scope: await projectScope(ctx, p) };
  },
  scope: (l) => l.scope,
  async run(ctx, i, { p }) {
    if (ctx.actor.type !== "user") throw new DomainError("FORBIDDEN");
    if (p.kind !== "client" || !["gated", "active"].includes(p.status)) throw new DomainError("INVALID_TRANSITION", { reason: "project_not_open" });
    const { missing } = await gateStatus(ctx, p.id);
    const gates = [...new Set(i.gates)];
    const invalid = (reason: string) => new DomainError("BYPASS_INVALID", { reason });
    if (gates.some((g) => !missing.includes(g))) throw invalid("gate_not_missing");
    if (i.reason.length < BYPASS_REASON_MIN) throw invalid("reason_too_short");
    const today = businessDate(ctx.now);
    if (i.expiresOn <= today || i.expiresOn > addDays(today, BYPASS_MAX_DAYS)) throw invalid("expiry_out_of_range");
    const owner = await ctx.tx.selectFrom("users").select("id").where("id", "=", i.namedOwnerId).where("active", "=", true).executeTakeFirst();
    if (!owner) throw invalid("named_owner_unknown");
    // Expires at the end of that day in Phnom Penh (UTC+7), never beyond created_at + 30 days (DB CHECK).
    const expiresAt = new Date(Math.min(new Date(`${i.expiresOn}T16:59:59Z`).getTime(), ctx.now.getTime() + BYPASS_MAX_DAYS * 86_400_000));
    const b = await ctx.tx
      .insertInto("gate_bypasses")
      .values({ project_id: p.id, gates, named_owner_id: i.namedOwnerId, reason: i.reason, requested_by: ctx.actor.id, expires_at: expiresAt, created_at: ctx.now })
      .returning("id")
      .executeTakeFirstOrThrow();
    const client = p.client_id ? await ctx.tx.selectFrom("clients").select("name").where("id", "=", p.client_id).executeTakeFirst() : undefined;
    const a = await createApproval(ctx, {
      kind: "gate_bypass",
      subject: { type: "gate_bypass", id: b.id, version: 1, hash: b.id },
      snapshot: {
        title: `${client?.name ?? ""} — ${p.name}: ${gates.join(", ")}`,
        scope: {},
        facts: { gates, reason: i.reason, expiresOn: i.expiresOn, projectId: p.id },
      },
    });
    await ctx.tx.updateTable("gate_bypasses").set({ approval_id: a.id }).where("id", "=", b.id).execute();
    return { id: b.id, approvalId: a.id };
  },
  subject: (i) => ({ type: "project", id: i.projectId }),
});

lockSubjectWith("gate_bypass", "gate_bypass", (ctx, id) =>
  ctx.tx.selectFrom("gate_bypasses").select("id").where("id", "=", id).forUpdate().executeTakeFirst(),
);

/** PRJ-BP-02: approval opens the bypass (the engine already refused self-approval and jobs). */
onApprovalDecided("gate_bypass", "gate_bypass", async (ctx, a, decision) => {
  if (ctx.actor.type !== "user") throw new DomainError("FORBIDDEN", { reason: "bypass_needs_a_person" });
  const b = notFoundIfMissing(await ctx.tx.selectFrom("gate_bypasses").selectAll().where("id", "=", a.subject_id).executeTakeFirst());
  if (b.status !== "requested") return;
  await ctx.tx
    .updateTable("gate_bypasses")
    .set(decision === "approve" ? { status: "open", approved_by: ctx.actor.id, approved_at: ctx.now } : { status: "rejected" })
    .where("id", "=", b.id)
    .execute();
  ctx.emit(decision === "approve" ? "bypass.opened" : "bypass.rejected", { bypassId: b.id, projectId: b.project_id });
});

/** PRJ-BP-04: hourly — close expired bypasses and those whose gates are now all met. */
export const bypassSweep = defineCommand({
  name: "project.bypass.sweep",
  summary: "Close expired bypasses and those whose gates are all met",
  permission: "project.jobs",
  input: z.object({}).default({}),
  exposeTo: ["job"],
  async run(ctx) {
    const open = await ctx.tx.selectFrom("gate_bypasses").selectAll().where("status", "=", "open").forUpdate().skipLocked().execute();
    let expired = 0,
      met = 0;
    for (const b of open) {
      const { missing } = await gateStatus(ctx, b.project_id);
      const cause = b.expires_at <= ctx.now ? "expired" : b.gates.every((g) => !missing.includes(g as never)) ? "gates_met" : null;
      if (!cause) continue;
      await ctx.tx.updateTable("gate_bypasses").set({ status: "closed", close_cause: cause, closed_at: ctx.now }).where("id", "=", b.id).execute();
      ctx.emit("bypass.closed", { bypassId: b.id, cause });
      if (cause === "expired") expired++;
      else met++;
    }
    return { expired, met };
  },
});

const prevMonthStart = (d: string) => addMonths(d, -1);

async function reviewItems(ctx: Ctx, month: string) {
  const next = new Date(`${month}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const from = new Date(`${month}T00:00:00+07:00`);
  const to = new Date(`${next.toISOString().slice(0, 10)}T00:00:00+07:00`);
  const bypasses = await ctx.tx
    .selectFrom("gate_bypasses as b")
    .innerJoin("projects as p", "p.id", "b.project_id")
    .innerJoin("users as o", "o.id", "b.named_owner_id")
    .leftJoin("users as ap", "ap.id", "b.approved_by")
    .select(["b.id", "p.name as project_name", "b.gates", "b.reason", "b.status", "b.close_cause", "o.display_name as owner_name", "ap.display_name as approved_by_name", "b.created_at", "b.expires_at", "b.review_outcome"])
    .where("b.created_at", ">=", from)
    .where("b.created_at", "<", to)
    .where("b.status", "in", ["open", "closed"])
    .orderBy("b.created_at")
    .execute();
  const exemptions = await ctx.tx
    .selectFrom("client_gate_exemptions as e")
    .innerJoin("clients as c", "c.id", "e.client_id")
    .innerJoin("users as u", "u.id", "e.decided_by")
    .select(["e.id", "c.name as client_name", "e.gate", "e.reason", "u.display_name as decided_by_name", "e.decided_at"])
    .where("e.decided_at", ">=", from)
    .where("e.decided_at", "<", to)
    .orderBy("e.decided_at")
    .execute();
  return { bypasses, exemptions };
}

/** PRJ-BP-05: the monthly review report (web; directors and CEO via project.bypass.review). */
export const bypassReviewReport = defineQuery({
  name: "project.bypass.report",
  summary: "Bypasses and PO exemptions of a month, for the monthly review",
  permission: "project.bypass.review",
  input: z.object({ month: isoDate }),
  exposeTo: ["web", "mcp"],
  run: (ctx, i) => reviewItems(ctx, monthStart(i.month)),
});

/**
 * PRJ-BP-05: on the first working day of a month, one bypass_review approval for the previous month.
 * The approval is requested by the job's configured requester (a person is required by the engine): the CEO or ops lead
 * who set it up is recorded as `requested_by`; directors decide.
 */
export const bypassMonthlyReview = defineCommand({
  name: "project.bypass.monthly_review",
  summary: "Create the monthly bypass review for directors (first working day of the month)",
  permission: "project.jobs",
  input: z.object({ requesterId: uuid }),
  exposeTo: ["job"],
  async run(ctx, i) {
    const month = prevMonthStart(businessDate(ctx.now));
    const existing = await ctx.tx
      .selectFrom("approvals")
      .select("id")
      .where("kind", "=", "bypass_review")
      .where("subject_type", "=", "bypass_month")
      .where("subject_hash", "=", month)
      .executeTakeFirst();
    if (existing) return { created: false, approvalId: existing.id };
    const items = await reviewItems(ctx, month);
    const requester = notFoundIfMissing(await ctx.tx.selectFrom("users").select(["id", "display_name", "team_id"]).where("id", "=", i.requesterId).executeTakeFirst());
    const roles = (await ctx.tx.selectFrom("user_roles").select("role").where("user_id", "=", requester.id).execute()).map((r) => r.role as never);
    // The engine needs a human requester; the review runs in that person's name, still audited as the job.
    const asRequester: Ctx = { ...ctx, actor: { type: "user", id: requester.id, name: requester.display_name, roles, teamId: requester.team_id } };
    const a = await createApproval(asRequester, {
      kind: "bypass_review",
      subject: { type: "bypass_month", id: requester.id, version: 1, hash: month },
      snapshot: {
        title: `Bypass review ${month.slice(0, 7)}: ${items.bypasses.length} bypasses, ${items.exemptions.length} PO exemptions`,
        scope: {},
        facts: { month, bypasses: items.bypasses.length, exemptions: items.exemptions.length },
      },
    });
    await ctx.tx.updateTable("gate_bypasses").set({ review_month: month }).where("id", "in", items.bypasses.length ? items.bypasses.map((b) => b.id) : ["00000000-0000-0000-0000-000000000000"]).execute();
    return { created: true, approvalId: a.id, month };
  },
});

onApprovalDecided("bypass_review", "bypass_month", async (ctx, a, decision) => {
  const outcome = `${decision === "approve" ? "accepted" : "challenged"} by ${ctx.actor.name}`;
  await ctx.tx.updateTable("gate_bypasses").set({ review_outcome: outcome }).where("review_month", "=", a.subject_hash).execute();
});
