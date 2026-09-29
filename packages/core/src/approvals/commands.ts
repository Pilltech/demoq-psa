// Approval commands and queries: decide, inbox, get, escalate. Spec: specs/approvals/engine.md
import { ApprovalDecideInput, ApprovalInboxInput, ByIdInput } from "@demoq/shared";
import { z } from "zod";
import { can, defineCommand, defineQuery, DomainError, notFoundIfMissing, type Ctx, type UserActor } from "../kernel";
import {
  approvalPolicy,
  DECIDE_IN_APP_KINDS,
  decisionHandler,
  mayDecide,
  decidablePermissions,
  recordApprovalEvent,
  route,
  subjectLocker,
  type ApprovalKind,
  type ApprovalRow,
  type Outcome,
  type ApprovalSnapshot,
} from "./engine";

export const STEP_UP_WINDOW_MS = 15 * 60_000;
export const STEP_UP_GAP_BP = 1000; // D12: more than 10 points below the floor

const snap = (a: { snapshot: unknown }) => a.snapshot as ApprovalSnapshot;

export const approvalDecide = defineCommand({
  name: "approval.decide",
  summary: "Approve or reject a request in your inbox",
  permission: "approval.view",
  input: ApprovalDecideInput,
  exposeTo: ["web", "telegram", "mcp"],
  risk: "high",
  async load(ctx, i) {
    // Lock order matches quote commands (deal → quote → approval), so decide never deadlocks with save (see
    // lockQuoteForChange). Subject rows are locked by the kind's module via lockSubject.
    const peek = notFoundIfMissing(
      await ctx.tx
        .selectFrom("approvals")
        .select(["kind", "subject_type", "subject_id"])
        .where("id", "=", i.id)
        .executeTakeFirst(),
    );
    await subjectLocker(peek.kind, peek.subject_type)?.(ctx, peek.subject_id);
    return notFoundIfMissing(
      await ctx.tx.selectFrom("approvals").selectAll().where("id", "=", i.id).forUpdate().executeTakeFirst(),
    ) as ApprovalRow & {
      snapshot: unknown;
    };
  },
  async run(ctx, i, a) {
    if (ctx.actor.type !== "user") throw new DomainError("FORBIDDEN");
    const me: UserActor = ctx.actor;
    if (a.status !== "pending") throw new DomainError("ALREADY_DECIDED", { status: a.status });
    if (a.requested_by === me.id) throw new DomainError("SELF_APPROVAL");
    // APR-EN-04: people the request names as never deciding it (e.g. the task owner for a QC), even when reassigned.
    if (snap(a).excludeDeciders?.includes(me.id)) throw new DomainError("SELF_APPROVAL", { reason: "excluded_decider" });
    const policy = await approvalPolicy(ctx, a.kind);
    // APR-EN-13: out-of-scope decisions carry an outcome; approve = absorb, reject = change_order or reject.
    let outcome: Outcome | undefined;
    if (a.kind === "out_of_scope") {
      outcome = i.outcome ?? (i.decision === "approve" ? "absorb" : "reject");
      if ((outcome === "absorb") !== (i.decision === "approve"))
        throw new DomainError("VALIDATION", { reason: "outcome_mismatch", outcome, decision: i.decision });
    } else if (i.outcome) {
      throw new DomainError("VALIDATION", { reason: "outcome_not_allowed", kind: a.kind });
    }
    // APR-EN-09 / INV-19 (an out-of-scope "absorb" gives value away, so it is decided in the app too)
    if (ctx.channel === "mcp" && (DECIDE_IN_APP_KINDS.includes(a.kind as ApprovalKind) || outcome === "absorb"))
      throw new DomainError("DECIDE_IN_APP", { kind: a.kind, ...(outcome ? { outcome } : {}) });
    if (!policy.channels_allowed.includes(ctx.channel)) {
      throw new DomainError(ctx.channel === "mcp" ? "DECIDE_IN_APP" : "FORBIDDEN", { reason: "channel" });
    }
    // APR-EN-05: any active holder of the required permission, in scope.
    if (!mayDecide(me, a.required_permission, snap(a).scope)) throw new DomainError("FORBIDDEN", { reason: "not_an_approver" });
    // APR-EN-12: step-up on the web for approvals far below the floor (Telegram uses two taps instead).
    if (
      i.decision === "approve" &&
      ctx.channel === "web" &&
      (snap(a).floorGapBp ?? 0) > STEP_UP_GAP_BP &&
      !(ctx.stepUpAt && ctx.now.getTime() - ctx.stepUpAt.getTime() <= STEP_UP_WINDOW_MS)
    ) {
      throw new DomainError("STEP_UP_REQUIRED");
    }
    const status = i.decision === "approve" ? "approved" : "rejected";
    // APR-EN-06: single winner.
    const won = await ctx.tx
      .updateTable("approvals")
      .set((eb) => ({
        status,
        decided_by: me.id,
        decided_at: ctx.now,
        decided_channel: ctx.channel,
        decision_note: i.note ?? null,
        outcome: outcome ?? null,
        version: eb("version", "+", 1),
      }))
      .where("id", "=", a.id)
      .where("status", "=", "pending")
      .returning(["id", "status", "version"])
      .executeTakeFirst();
    if (!won) throw new DomainError("ALREADY_DECIDED");
    await recordApprovalEvent(ctx, a.id, status, null);
    await decisionHandler(a.kind, a.subject_type)?.(ctx, a, i.decision, outcome);
    ctx.emit("approval.decided", { approvalId: a.id, kind: a.kind, status, requestedBy: a.requested_by, outcome });
    return { id: a.id, status, kind: a.kind, ...(outcome ? { outcome } : {}) };
  },
  subject: (i) => ({ type: "approval", id: i.id }),
});

function toDto(
  ctx: Ctx,
  a: ApprovalRow & { due_at: Date; created_at: Date; decided_at: Date | null; decided_by: string | null },
  names: Map<string, string>,
) {
  const s = snap(a);
  const showCosts = can(ctx.actor, "finance.view_costs", s.scope);
  const me = ctx.actor.type === "user" ? ctx.actor : null;
  return {
    id: a.id,
    kind: a.kind,
    status: a.status,
    subjectType: a.subject_type,
    subjectId: a.subject_id,
    title: s.title,
    facts: s.facts ?? {},
    costs: showCosts ? (s.costs ?? null) : null,
    requestedBy: names.get(a.requested_by) ?? null,
    assignee: a.assignee_id ? (names.get(a.assignee_id) ?? null) : null,
    assignedToMe: !!me && a.assignee_id === me.id,
    canDecide:
      !!me &&
      a.status === "pending" &&
      a.requested_by !== me.id &&
      !s.excludeDeciders?.includes(me.id) &&
      mayDecide(me, a.required_permission, s.scope),
    mine: !!me && a.requested_by === me.id,
    dueAt: a.due_at,
    overdue: a.status === "pending" && a.due_at < ctx.now,
    escalationLevel: a.escalation_level,
    decidedBy: a.decided_by ? (names.get(a.decided_by) ?? null) : null,
    decidedAt: a.decided_at,
    /** APR-EN-13: the out-of-scope outcome (absorb, change_order, reject) once decided; null otherwise. */
    outcome: (a as { outcome?: string | null }).outcome ?? null,
    createdAt: a.created_at,
    version: a.version,
  };
}

async function nameMap(ctx: Ctx, ids: (string | null)[]) {
  const unique = [...new Set(ids.filter((x): x is string => !!x))];
  if (!unique.length) return new Map<string, string>();
  const rows = await ctx.tx.selectFrom("users").select(["id", "display_name"]).where("id", "in", unique).execute();
  return new Map(rows.map((r) => [r.id, r.display_name]));
}

export const approvalInbox = defineQuery({
  name: "approval.inbox",
  summary: "My approvals: what I can decide (assigned to me first) and what I asked for",
  permission: "approval.view",
  input: ApprovalInboxInput,
  exposeTo: ["web", "telegram", "mcp"],
  rowFiltered: true,
  async run(ctx, i) {
    if (ctx.actor.type !== "user") return [];
    const me = ctx.actor;
    const perms = decidablePermissions(me);
    // Filter in SQL first (APR-EN-11), then apply scopes in memory; the limit never hides my own rows.
    let q = ctx.tx
      .selectFrom("approvals")
      .selectAll()
      .where((eb) =>
        eb.or([
          eb("requested_by", "=", me.id),
          eb("assignee_id", "=", me.id),
          ...(perms.length ? [eb("required_permission", "in", perms)] : []),
        ]),
      );
    q =
      i.include === "pending"
        ? q.where("status", "=", "pending")
        : q.where("created_at", ">=", new Date(ctx.now.getTime() - 30 * 86_400_000));
    const rows = (await q.orderBy("due_at").limit(500).execute()) as unknown as (ApprovalRow & {
      due_at: Date;
      created_at: Date;
      decided_at: Date | null;
      decided_by: string | null;
    })[];
    // APR-EN-11: only rows I may decide, am assigned, or requested. Never other people's business.
    const visible = rows.filter(
      (a) => a.requested_by === me.id || a.assignee_id === me.id || mayDecide(me, a.required_permission, snap(a).scope),
    );
    const names = await nameMap(
      ctx,
      visible.flatMap((a) => [a.requested_by, a.assignee_id, a.decided_by]),
    );
    return visible
      .map((a) => toDto(ctx, a, names))
      .sort((x, y) => Number(y.assignedToMe) - Number(x.assignedToMe) || Number(y.canDecide) - Number(x.canDecide));
  },
});

export const approvalGet = defineQuery({
  name: "approval.get",
  summary: "One approval with its history",
  permission: "approval.view",
  input: ByIdInput,
  exposeTo: ["web", "telegram", "mcp"],
  rowFiltered: true,
  async run(ctx, i) {
    const a = notFoundIfMissing(
      await ctx.tx.selectFrom("approvals").selectAll().where("id", "=", i.id).executeTakeFirst(),
    ) as unknown as ApprovalRow & {
      due_at: Date;
      created_at: Date;
      decided_at: Date | null;
      decided_by: string | null;
    };
    const me = ctx.actor.type === "user" ? ctx.actor : null;
    if (!me || !(a.requested_by === me.id || a.assignee_id === me.id || mayDecide(me, a.required_permission, snap(a).scope))) {
      throw new DomainError("NOT_FOUND");
    }
    const events = await ctx.tx
      .selectFrom("approval_events as e")
      .leftJoin("users as u", "u.id", "e.assignee_id")
      .select(["e.event", "e.actor_name", "e.channel", "e.at", "u.display_name as assignee_name"])
      .where("e.approval_id", "=", a.id)
      .orderBy("e.seq")
      .execute();
    const names = await nameMap(ctx, [a.requested_by, a.assignee_id, a.decided_by]);
    return { ...toDto(ctx, a, names), events };
  },
  subject: (i) => ({ type: "approval", id: i.id }),
});

/** APR-EN-08: move overdue approvals one step up. Jobs only; SKIP LOCKED makes concurrent runs safe. */
export const approvalEscalateOverdue = defineCommand({
  name: "approval.escalate_overdue",
  summary: "Escalate overdue approvals to the next eligible approver",
  permission: "approval.escalate",
  input: z.object({}).default({}),
  exposeTo: ["job"],
  async run(ctx) {
    const overdue = await ctx.tx
      .selectFrom("approvals")
      .selectAll()
      .where("status", "=", "pending")
      .where("due_at", "<", ctx.now)
      .orderBy("due_at")
      .limit(200)
      .forUpdate()
      .skipLocked()
      .execute();
    let moved = 0;
    for (const a of overdue as unknown as ApprovalRow[]) {
      const policy = await approvalPolicy(ctx, a.kind);
      const r = await route(ctx, policy, a.requested_by, snap(a).scope, a.escalation_level + 1, snap(a).excludeDeciders);
      const due = new Date(ctx.now.getTime() + policy.sla_minutes * 60_000);
      if (!r.assigneeId) {
        // Nobody left: keep the current assignee, push the due date out, alert ops.
        await ctx.tx
          .updateTable("approvals")
          .set((eb) => ({ due_at: due, version: eb("version", "+", 1) }))
          .where("id", "=", a.id)
          .execute();
        await recordApprovalEvent(ctx, a.id, "no_eligible", null);
        ctx.emit("approval.no_eligible_approver", { approvalId: a.id, kind: a.kind });
        continue;
      }
      await ctx.tx
        .updateTable("approvals")
        .set((eb) => ({ assignee_id: r.assigneeId, escalation_level: r.level, due_at: due, version: eb("version", "+", 1) }))
        .where("id", "=", a.id)
        .execute();
      await recordApprovalEvent(ctx, a.id, r.fallback ? "fallback" : "escalated", r.assigneeId);
      ctx.emit("approval.escalated", { approvalId: a.id, kind: a.kind, assigneeId: r.assigneeId });
      moved++;
    }
    return { checked: overdue.length, moved };
  },
});
