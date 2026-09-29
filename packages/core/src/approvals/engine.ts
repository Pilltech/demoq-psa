// Approval engine: routing (INV-18), creation, superseding, decision handlers.
// Spec: specs/approvals/engine.md (APR-EN-*)
import type { Role } from "@demoq/shared";
import {
  can,
  DomainError,
  PERMISSIONS,
  type Ctx,
  type Kernel,
  type Permission,
  type ResourceScope,
  type Scope,
  type UserActor,
} from "../kernel";

export type ApprovalKind =
  "margin_floor" | "out_of_scope" | "quality_check" | "gate_bypass" | "bypass_review" | "influencer_work" | "leave";

/** INV-19: these kinds are never decided from chat. */
export const DECIDE_IN_APP_KINDS: readonly ApprovalKind[] = ["margin_floor", "gate_bypass", "bypass_review", "influencer_work"];

export interface ApprovalRow {
  id: string;
  kind: string;
  subject_type: string;
  subject_id: string;
  subject_version: number;
  subject_hash: string;
  requested_by: string;
  required_permission: string;
  assignee_id: string | null;
  escalation_level: number;
  status: string;
  snapshot: unknown;
  on_approve: unknown;
  version: number;
}

export interface ApprovalSnapshot {
  title: string;
  /** Who the subject belongs to, for own/team/assigned grants of the required permission. */
  scope: ResourceScope;
  /** Shown only to holders of finance.view_costs (INV-16). */
  costs?: Record<string, unknown>;
  facts?: Record<string, unknown>;
  /** e.g. how far below the floor, for step-up (APR-EN-12). */
  floorGapBp?: number;
}

type Decision = "approve" | "reject";
/** Out-of-scope outcome (APR-EN-13); undefined for other kinds. */
export type Outcome = "absorb" | "change_order" | "reject";
type Handler = (ctx: Ctx, approval: ApprovalRow, decision: Decision, outcome?: Outcome) => Promise<void>;
const handlers = new Map<string, Handler>();
type Locker = (ctx: Ctx, subjectId: string) => Promise<unknown>;
const lockers = new Map<string, Locker>();

/** Modules register how to lock their subject rows before the approval row (consistent lock order). */
export function lockSubjectWith(kind: ApprovalKind, subjectType: string, locker: Locker): void {
  lockers.set(`${kind}:${subjectType}`, locker);
}
export function subjectLocker(kind: string, subjectType: string): Locker | undefined {
  return lockers.get(`${kind}:${subjectType}`);
}

/**
 * Modules register what happens when their kind is decided (runs inside the decision transaction, APR-EN-10).
 * Keyed by kind and subject type: e.g. margin_floor on a quote vs on a change order.
 */
export function onApprovalDecided(kind: ApprovalKind, subjectType: string, handler: Handler): void {
  handlers.set(`${kind}:${subjectType}`, handler);
}
export function decisionHandler(kind: string, subjectType: string): Handler | undefined {
  return handlers.get(`${kind}:${subjectType}`);
}

const actorName = (ctx: Ctx) => ctx.actor.name;

async function policyFor(ctx: Ctx, kind: string) {
  const p = await ctx.tx.selectFrom("approval_policies").selectAll().where("kind", "=", kind).executeTakeFirst();
  if (!p) throw new DomainError("VALIDATION", { reason: "unknown_approval_kind", kind });
  return p;
}

interface Candidate {
  id: string;
  name: string;
  roles: Role[];
  teamId: string | null;
}

async function loadCandidates(ctx: Ctx, role: string, excludeId: string): Promise<Candidate[]> {
  const rows = await ctx.tx
    .selectFrom("users as u")
    .innerJoin("user_roles as r", "r.user_id", "u.id")
    .select(["u.id", "u.display_name", "u.team_id"])
    .where("r.role", "=", role)
    .where("u.active", "=", true)
    .where("u.id", "<>", excludeId)
    .where((eb) =>
      eb.not(
        eb.exists(
          eb.selectFrom("user_roles as a").select("a.user_id").whereRef("a.user_id", "=", "u.id").where("a.role", "=", "admin"),
        ),
      ),
    )
    .orderBy("u.display_name")
    .execute();
  const out: Candidate[] = [];
  for (const r of rows) {
    const roles = (await ctx.tx.selectFrom("user_roles").select("role").where("user_id", "=", r.id).execute()).map(
      (x) => x.role as Role,
    );
    out.push({ id: r.id, name: r.display_name, roles, teamId: r.team_id });
  }
  return out;
}

export const asActor = (c: Candidate): UserActor => ({ type: "user", id: c.id, name: c.name, roles: c.roles, teamId: c.teamId });

/** Does this user hold the permission with a scope that covers the subject? */
export function mayDecide(user: UserActor, permission: string, scope: ResourceScope): boolean {
  // Segregation of duties: an admin account never makes business approvals, whatever other roles it holds.
  if (user.roles.includes("admin")) return false;
  return permission in PERMISSIONS && can(user, permission as Permission, scope);
}

/** Permissions this user could decide approvals for (for filtering the inbox in SQL). */
export function decidablePermissions(user: UserActor): string[] {
  if (user.roles.includes("admin")) return [];
  return (Object.keys(PERMISSIONS) as Permission[]).filter((p) => {
    const grants = PERMISSIONS[p].grants as Partial<Record<Role, Scope>>;
    return user.roles.some((r) => grants[r]);
  });
}

async function managerLine(ctx: Ctx, userId: string): Promise<string[]> {
  const line: string[] = [];
  let cur: string | null = userId;
  for (let i = 0; i < 10 && cur; i++) {
    const row: { manager_id: string | null } | undefined = await ctx.tx
      .selectFrom("users")
      .select("manager_id")
      .where("id", "=", cur)
      .executeTakeFirst();
    cur = row?.manager_id ?? null;
    if (cur) line.push(cur);
  }
  return line;
}

export interface RouteResult {
  assigneeId: string | null;
  level: number;
  event: "created" | "escalated" | "fallback" | "no_eligible";
}

/**
 * APR-EN-03 / INV-18: walk the chain from `fromLevel`; each step's role must actually grant the permission,
 * and every candidate must hold it in scope and not be the requester. Prefer the requester's manager line.
 */
export async function route(
  ctx: Ctx,
  policy: { chain: string[]; required_permission: string; fallback_approver_id: string | null },
  requesterId: string,
  scope: ResourceScope,
  fromLevel: number,
): Promise<Omit<RouteResult, "event"> & { fallback: boolean }> {
  const perm = policy.required_permission as Permission;
  const grants = (PERMISSIONS[perm]?.grants ?? {}) as Partial<Record<Role, Scope>>;
  const managers = await managerLine(ctx, requesterId);
  for (let level = fromLevel; level < policy.chain.length; level++) {
    const role = policy.chain[level] as Role;
    if (!grants[role]) continue; // a chain step whose role lacks the permission is skipped, never assigned
    const eligible = (await loadCandidates(ctx, role, requesterId)).filter((c) => mayDecide(asActor(c), perm, scope));
    if (!eligible.length) continue;
    const preferred = managers.map((m) => eligible.find((c) => c.id === m)).find(Boolean);
    return { assigneeId: (preferred ?? eligible[0]!).id, level, fallback: false };
  }
  if (policy.fallback_approver_id && policy.fallback_approver_id !== requesterId) {
    const fb = await ctx.tx
      .selectFrom("users")
      .select(["id", "display_name", "team_id", "active"])
      .where("id", "=", policy.fallback_approver_id)
      .executeTakeFirst();
    if (fb?.active) {
      const roles = (await ctx.tx.selectFrom("user_roles").select("role").where("user_id", "=", fb.id).execute()).map(
        (x) => x.role as Role,
      );
      if (mayDecide({ type: "user", id: fb.id, name: fb.display_name, roles, teamId: fb.team_id }, perm, scope)) {
        return { assigneeId: fb.id, level: policy.chain.length, fallback: true };
      }
    }
  }
  return { assigneeId: null, level: Math.max(fromLevel, policy.chain.length), fallback: false };
}

async function recordEvent(ctx: Ctx, approvalId: string, event: string, assigneeId: string | null) {
  await ctx.tx
    .insertInto("approval_events")
    .values({
      approval_id: approvalId,
      event,
      assignee_id: assigneeId,
      assignee_permission_ok: assigneeId ? true : null,
      actor_name: actorName(ctx),
      channel: ctx.channel,
      at: ctx.now,
    })
    .execute();
}

/** Supersede any pending approval for this subject (APR-EN-07). */
export async function supersedePending(ctx: Ctx, subjectType: string, subjectId: string): Promise<number> {
  const rows = await ctx.tx
    .updateTable("approvals")
    .set((eb) => ({ status: "superseded", version: eb("version", "+", 1) }))
    .where("subject_type", "=", subjectType)
    .where("subject_id", "=", subjectId)
    .where("status", "=", "pending")
    .returning("id")
    .execute();
  for (const r of rows) await recordEvent(ctx, r.id, "superseded", null);
  return rows.length;
}

export async function createApproval(
  ctx: Ctx,
  a: {
    kind: ApprovalKind;
    subject: { type: string; id: string; version: number; hash: string };
    snapshot: ApprovalSnapshot;
    onApprove?: Record<string, unknown>;
  },
): Promise<{ id: string; assigneeId: string | null }> {
  if (ctx.actor.type !== "user") throw new DomainError("FORBIDDEN", { reason: "approvals_need_a_person" });
  const policy = await policyFor(ctx, a.kind);
  await supersedePending(ctx, a.subject.type, a.subject.id);
  const r = await route(ctx, policy, ctx.actor.id, a.snapshot.scope, 0);
  const row = await ctx.tx
    .insertInto("approvals")
    .values({
      kind: a.kind,
      subject_type: a.subject.type,
      subject_id: a.subject.id,
      subject_version: a.subject.version,
      subject_hash: a.subject.hash,
      requested_by: ctx.actor.id,
      required_permission: policy.required_permission,
      assignee_id: r.assigneeId,
      escalation_level: r.level,
      due_at: new Date(ctx.now.getTime() + policy.sla_minutes * 60_000),
      snapshot: JSON.stringify(a.snapshot),
      on_approve: JSON.stringify(a.onApprove ?? {}),
      created_at: ctx.now,
    })
    .returning("id")
    .executeTakeFirstOrThrow();
  await recordEvent(ctx, row.id, r.assigneeId ? (r.fallback ? "fallback" : "created") : "no_eligible", r.assigneeId);
  ctx.emit(r.assigneeId ? "approval.assigned" : "approval.no_eligible_approver", {
    approvalId: row.id,
    kind: a.kind,
    assigneeId: r.assigneeId,
  });
  return { id: row.id, assigneeId: r.assigneeId };
}

export { recordEvent as recordApprovalEvent, policyFor as approvalPolicy };

/** Status and bound hash of an approval, for the worker's re-checks. */
export async function approvalState(kernel: Kernel, id: string) {
  return kernel.db.selectFrom("approvals").select(["status", "subject_hash", "kind"]).where("id", "=", id).executeTakeFirst();
}
