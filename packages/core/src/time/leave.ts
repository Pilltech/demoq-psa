// Leave requests: whole or half days, approved through a `leave` approval (INV-18, D-LV-1).
// Spec: specs/time/leave-holidays.md (TIM-LV-*)
import { z } from "zod";
import { expectedVersion, isoDate, optionalText, uuid } from "@demoq/shared";
import { createApproval, lockSubjectWith, onApprovalDecided, recordApprovalEvent } from "../approvals";
import { assertVersion, businessDate, defineCommand, defineQuery, DomainError, notFoundIfMissing, type Ctx } from "../kernel";
import { ownScope, selfId } from "./attendance";

async function lockLeave(ctx: Ctx, id: string) {
  return notFoundIfMissing(
    await ctx.tx.selectFrom("leave_requests").selectAll().where("id", "=", id).forUpdate().executeTakeFirst(),
  );
}

const leaveDto = (l: {
  id: string;
  leave_type: string;
  start_date: string;
  end_date: string;
  half_day: string | null;
  reason: string | null;
  status: string;
  approval_id: string | null;
  version: number;
}) => ({
  id: l.id,
  leaveType: l.leave_type,
  startDate: l.start_date,
  endDate: l.end_date,
  halfDay: l.half_day as "am" | "pm" | null,
  reason: l.reason,
  status: l.status,
  approvalId: l.approval_id,
  version: l.version,
});

/** TIM-LV-03: request leave for myself; creates a `leave` approval routed to my team lead, ops_lead or director. */
export const leaveRequest = defineCommand({
  name: "leave.request",
  summary: "Request leave (whole days or a half day); goes to an eligible manager for approval",
  permission: "leave.request_own",
  input: z.object({
    leaveType: z.string().max(40),
    startDate: isoDate,
    endDate: isoDate,
    halfDay: z.enum(["am", "pm"]).nullish(),
    reason: optionalText(1000),
  }),
  exposeTo: ["web"],
  scope: ownScope,
  async run(ctx, i) {
    const me = selfId(ctx);
    const bad = (path: string, message: string) => new DomainError("VALIDATION", { issues: [{ path, message }] });
    const type = await ctx.tx
      .selectFrom("leave_types")
      .select(["code", "label_en", "half_day_allowed", "active"])
      .where("code", "=", i.leaveType)
      .executeTakeFirst();
    if (!type?.active) throw bad("leaveType", "Unknown leave type");
    if (i.endDate < i.startDate) throw bad("endDate", "On or after the start date");
    if (i.halfDay && (i.startDate !== i.endDate || !type.half_day_allowed)) throw bad("halfDay", "A half day is one day");
    // TIM-LV-04: no overlap with my requested or approved leave (EXCLUDE backstop).
    const clash = await ctx.tx
      .selectFrom("leave_requests")
      .select(["id", "start_date", "end_date"])
      .where("user_id", "=", me)
      .where("status", "in", ["requested", "approved"])
      .where("start_date", "<=", i.endDate)
      .where("end_date", ">=", i.startDate)
      .executeTakeFirst();
    if (clash)
      throw new DomainError("LEAVE_OVERLAP", { leaveId: clash.id, startDate: clash.start_date, endDate: clash.end_date });
    const who = await ctx.tx
      .selectFrom("users")
      .select(["display_name", "team_id"])
      .where("id", "=", me)
      .executeTakeFirstOrThrow();
    const row = await ctx.tx
      .insertInto("leave_requests")
      .values({
        user_id: me,
        leave_type: type.code,
        start_date: i.startDate,
        end_date: i.endDate,
        half_day: i.halfDay ?? null,
        reason: i.reason ?? null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    const span = i.startDate === i.endDate ? i.startDate : `${i.startDate} → ${i.endDate}`;
    const a = await createApproval(ctx, {
      kind: "leave",
      subject: { type: "leave_request", id: row.id, version: 1, hash: row.id },
      snapshot: {
        title: `${who.display_name}: ${type.label_en} ${span}${i.halfDay ? ` (${i.halfDay.toUpperCase()})` : ""}`,
        // leave.approve: team_lead:team (the requester's team), ops_lead:any, director:any.
        scope: { teamIds: [who.team_id] },
        facts: {
          leaveType: type.code,
          startDate: i.startDate,
          endDate: i.endDate,
          halfDay: i.halfDay ?? null,
          reason: i.reason ?? null,
        },
      },
    });
    const l = await ctx.tx
      .updateTable("leave_requests")
      .set({ approval_id: a.id })
      .where("id", "=", row.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    ctx.emit("leave.requested", { leaveId: l.id, userId: me, approvalId: a.id });
    return { ...leaveDto(l), assigneeId: a.assigneeId };
  },
  subject: (_i, r) => ({ type: "leave_request", id: r.id }),
});

lockSubjectWith("leave", "leave_request", (ctx, id) => lockLeave(ctx, id));

/** TIM-LV-03: the approval decides the request (same transaction). */
onApprovalDecided("leave", "leave_request", async (ctx, a, decision) => {
  const l = await lockLeave(ctx, a.subject_id);
  if (l.status !== "requested" || ctx.actor.type !== "user") return;
  await ctx.tx
    .updateTable("leave_requests")
    .set((eb) => ({
      status: decision === "approve" ? "approved" : "rejected",
      decided_by: (ctx.actor as { id: string }).id,
      decided_at: ctx.now,
      version: eb("version", "+", 1),
    }))
    .where("id", "=", l.id)
    .execute();
  ctx.emit(decision === "approve" ? "leave.approved" : "leave.rejected", { leaveId: l.id, userId: l.user_id });
});

/** TIM-LV-05: cancel my own leave while it is requested, or approved and not yet started. */
export const leaveCancel = defineCommand({
  name: "leave.cancel",
  summary: "Cancel my leave request (pending, or approved and not yet started)",
  permission: "leave.request_own",
  input: z.object({ id: uuid, expectedVersion }),
  exposeTo: ["web"],
  load: (ctx, i) => lockLeave(ctx, i.id),
  scope: (l) => ({ ownerIds: [l.user_id] }),
  async run(ctx, i, l) {
    if (ctx.actor.type !== "user" || ctx.actor.id !== l.user_id) throw new DomainError("FORBIDDEN", { reason: "not_own" });
    assertVersion(l.version, i.expectedVersion);
    const today = businessDate(ctx.now);
    if (!(l.status === "requested" || (l.status === "approved" && l.start_date > today)))
      throw new DomainError("INVALID_TRANSITION", { from: l.status, to: "cancelled" });
    if (l.status === "requested" && l.approval_id) {
      const c = await ctx.tx
        .updateTable("approvals")
        .set((eb) => ({ status: "cancelled", version: eb("version", "+", 1) }))
        .where("id", "=", l.approval_id)
        .where("status", "=", "pending")
        .returning("id")
        .executeTakeFirst();
      if (c) await recordApprovalEvent(ctx, c.id, "cancelled", null);
    }
    const r = await ctx.tx
      .updateTable("leave_requests")
      .set((eb) => ({ status: "cancelled", cancelled_at: ctx.now, version: eb("version", "+", 1) }))
      .where("id", "=", l.id)
      .returningAll()
      .executeTakeFirstOrThrow();
    ctx.emit("leave.cancelled", { leaveId: l.id, userId: l.user_id });
    return leaveDto(r);
  },
  subject: (i) => ({ type: "leave_request", id: i.id }),
});

export const leaveMine = defineQuery({
  name: "leave.mine",
  summary: "My leave requests (this year and later)",
  permission: "leave.request_own",
  input: z.object({ from: isoDate.optional() }),
  exposeTo: ["web", "mcp"],
  scope: ownScope,
  async run(ctx, i) {
    const me = selfId(ctx);
    const from = i.from ?? `${businessDate(ctx.now).slice(0, 4)}-01-01`;
    const rows = await ctx.tx
      .selectFrom("leave_requests")
      .selectAll()
      .where("user_id", "=", me)
      .where("end_date", ">=", from)
      .orderBy("start_date")
      .execute();
    return rows.map(leaveDto);
  },
});

export const leaveTypes = defineQuery({
  name: "leave.types",
  summary: "Leave types (annual, sick, special, maternity, unpaid)",
  permission: "user.directory",
  input: z.object({}).default({}),
  exposeTo: ["web", "mcp"],
  async run(ctx) {
    const rows = await ctx.tx.selectFrom("leave_types").selectAll().where("active", "=", true).orderBy("position").execute();
    return rows.map((t) => ({
      code: t.code,
      labelEn: t.label_en,
      labelKm: t.label_km,
      paid: t.paid,
      halfDayAllowed: t.half_day_allowed,
    }));
  },
});
