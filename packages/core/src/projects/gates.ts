// Gates: no work before scope, contract, quote, PO and deposit terms. Spec: specs/projects/gates.md (PRJ-GT-*)
import { z } from "zod";
import { requiredText, uuid } from "@demoq/shared";
import { defineCommand, DomainError, notFoundIfMissing, type Ctx } from "../kernel";

export const GATES = ["scope", "contract", "quote", "purchase_order", "deposit_terms"] as const;
export type Gate = (typeof GATES)[number];

export async function lockProject(ctx: Ctx, id: string) {
  return notFoundIfMissing(await ctx.tx.selectFrom("projects").selectAll().where("id", "=", id).forUpdate().executeTakeFirst());
}
export type ProjectRow = Awaited<ReturnType<typeof lockProject>>;

/** Who a project belongs to, for own/team/assigned grants: PM and PM-role members are "assigned". */
export async function projectScope(ctx: Ctx, p: { id: string; pm_id: string; client_id: string | null }) {
  const pms = await ctx.tx
    .selectFrom("project_members")
    .select("user_id")
    .where("project_id", "=", p.id)
    .where("project_role", "=", "pm")
    .execute();
  const lead = p.client_id
    ? (await ctx.tx.selectFrom("clients").select("account_lead_id").where("id", "=", p.client_id).executeTakeFirst())
        ?.account_lead_id
    : undefined;
  return { assigneeIds: [p.pm_id, ...pms.map((m) => m.user_id)], ownerIds: lead ? [lead] : [] };
}

/** Creates the five gates of a new client project; scope and quote are satisfied by the acceptance (PRJ-GT-01). */
export async function createGates(ctx: Ctx, projectId: string, clientId: string, acceptedRef: string) {
  const exemption = await ctx.tx
    .selectFrom("client_gate_exemptions")
    .select("id")
    .where("client_id", "=", clientId)
    .where("gate", "=", "purchase_order")
    .where("revoked_at", "is", null)
    .executeTakeFirst();
  const who = ctx.actor.type === "user" ? ctx.actor.id : null;
  await ctx.tx
    .insertInto("project_gates")
    .values(
      GATES.map((gate) => {
        if (gate === "scope" || gate === "quote") {
          return {
            project_id: projectId,
            gate,
            status: "satisfied",
            evidence: acceptedRef,
            satisfied_by: who,
            satisfied_at: ctx.now,
          };
        }
        if (gate === "purchase_order" && exemption) {
          return { project_id: projectId, gate, status: "not_applicable", exemption_id: exemption.id };
        }
        return { project_id: projectId, gate, status: "missing" };
      }),
    )
    .execute();
}

/** Missing gates of a project, and those still missing after open, unexpired bypasses. */
export async function gateStatus(ctx: Ctx, projectId: string) {
  const missing = (
    await ctx.tx
      .selectFrom("project_gates")
      .select("gate")
      .where("project_id", "=", projectId)
      .where("status", "=", "missing")
      .orderBy("gate")
      .execute()
  ).map((g) => g.gate as Gate);
  const bypasses = await ctx.tx
    .selectFrom("gate_bypasses")
    .select(["gates"])
    .where("project_id", "=", projectId)
    .where("status", "=", "open")
    .where("expires_at", ">", ctx.now)
    .execute();
  const covered = new Set(bypasses.flatMap((b) => b.gates));
  return { missing, uncovered: missing.filter((g) => !covered.has(g)) };
}

/**
 * PRJ-GT-04 / INV-06: work on a client project needs every gate met or covered by an open bypass.
 * Internal projects have no gates. Closed/held projects never take new work.
 */
export async function assertWorkAllowed(ctx: Ctx, projectId: string) {
  const p = notFoundIfMissing(
    await ctx.tx.selectFrom("projects").select(["kind", "status"]).where("id", "=", projectId).executeTakeFirst(),
  );
  if (p.status === "on_hold" || p.status === "completed" || p.status === "cancelled") {
    throw new DomainError("INVALID_TRANSITION", { reason: "project_not_open", status: p.status });
  }
  if (p.kind === "internal") return;
  const { uncovered } = await gateStatus(ctx, projectId);
  if (uncovered.length) throw new DomainError("GATE_BLOCKED", { missing: uncovered });
}

export const gateSatisfy = defineCommand({
  name: "gate.satisfy",
  summary: "Mark a project gate as met, with evidence (e.g. signed contract reference)",
  permission: "gate.satisfy",
  input: z.object({
    projectId: uuid,
    gate: z.enum(["contract", "purchase_order", "deposit_terms"]),
    evidence: requiredText(500),
  }),
  exposeTo: ["web", "mcp"],
  async load(ctx, i) {
    const p = await lockProject(ctx, i.projectId);
    return { p, scope: await projectScope(ctx, p) };
  },
  scope: (l) => l.scope,
  async run(ctx, i, { p }) {
    if (p.kind !== "client") throw new DomainError("VALIDATION", { reason: "internal_project_has_no_gates" });
    if (i.evidence.length < 3)
      throw new DomainError("VALIDATION", { issues: [{ path: "evidence", message: "At least 3 characters" }] });
    const r = await ctx.tx
      .updateTable("project_gates")
      .set({
        status: "satisfied",
        evidence: i.evidence,
        satisfied_by: ctx.actor.type === "user" ? ctx.actor.id : null,
        satisfied_at: ctx.now,
      })
      .where("project_id", "=", p.id)
      .where("gate", "=", i.gate)
      .returning(["gate", "status"])
      .executeTakeFirstOrThrow();
    ctx.emit("gate.satisfied", { projectId: p.id, gate: i.gate });
    return { ...r, ...(await gateStatus(ctx, p.id)) };
  },
  subject: (i) => ({ type: "project", id: i.projectId }),
});

/** PRJ-GT-03: Finance/Ops waive a client's PO gate with a reason; open projects of that client update too. */
export const clientGateExemption = defineCommand({
  name: "client.gate_exemption",
  summary: "Record that a client does not issue purchase orders (Finance or Ops), with a reason",
  permission: "client.gate_exemption",
  input: z.object({ clientId: uuid, reason: requiredText(500) }),
  exposeTo: ["web"],
  async run(ctx, i) {
    if (i.reason.length < 10)
      throw new DomainError("VALIDATION", { issues: [{ path: "reason", message: "At least 10 characters" }] });
    if (ctx.actor.type !== "user") throw new DomainError("FORBIDDEN");
    notFoundIfMissing(
      await ctx.tx.selectFrom("clients").select("id").where("id", "=", i.clientId).forUpdate().executeTakeFirst(),
    );
    const ex = await ctx.tx
      .insertInto("client_gate_exemptions")
      .values({ client_id: i.clientId, gate: "purchase_order", reason: i.reason, decided_by: ctx.actor.id, decided_at: ctx.now })
      .returning("id")
      .executeTakeFirstOrThrow();
    await ctx.tx
      .updateTable("project_gates")
      .set({ status: "not_applicable", exemption_id: ex.id })
      .where("gate", "=", "purchase_order")
      .where("status", "=", "missing")
      .where("project_id", "in", (eb) =>
        eb
          .selectFrom("projects")
          .select("id")
          .where("client_id", "=", i.clientId)
          .where("status", "in", ["gated", "active", "on_hold"]),
      )
      .execute();
    ctx.emit("client.gate_exemption", { clientId: i.clientId, exemptionId: ex.id });
    return { id: ex.id };
  },
  subject: (i) => ({ type: "client", id: i.clientId }),
});
