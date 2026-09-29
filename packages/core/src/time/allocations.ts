// Time allocations: minutes per (user, day, target) — task, project, deal or internal activity code (D-TM-1).
// INV-06 applies only to client-project targets. Spec: specs/time/timesheets.md (TIM-TS-01…03)
import { z } from "zod";
import { isoDate, optionalText, uuid } from "@demoq/shared";
import { businessDate, can, defineCommand, DomainError, type Ctx } from "../kernel";
import { assertWorkAllowed } from "../projects";
import { lockWeek, ownScope, selfId } from "./attendance";
import { weekStartOf } from "./calendar";
import { type DraftRow, type TargetRef, type TargetType } from "./prefill";

export const DAY_LIMIT_MINUTES = 24 * 60;
/** Shown instead of the title of a deal the viewer may not see (TIM-TS-13). */
export const WITHHELD_LABEL = "—";

export const TargetInput = z.object({
  targetType: z.enum(["task", "project", "deal", "internal"]),
  /** Task, project or deal id (omit for internal). */
  targetId: uuid.nullish(),
  /** Activity code for internal time (e.g. admin, training, pitch). */
  activityCode: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,39}$/)
    .nullish(),
});
export type TargetInputT = z.output<typeof TargetInput>;

/** The source recorded for a row the user typed, by channel (M2 #9 counts only untouched `prefill` rows). */
export const channelSource = (ctx: Ctx): DraftRow["source"] =>
  ctx.channel === "mcp" ? "mcp" : ctx.channel === "telegram" ? "telegram" : "manual";

export interface ResolvedTarget extends TargetRef {
  label: string;
  projectName: string | null;
}

/**
 * TIM-TS-13: may this actor see the deal (and so book time on it and read its title)? The CRM rule: `deal.view` in
 * scope of the deal's owner, or being its owner.
 */
export function canViewDeal(ctx: Ctx, ownerId: string): boolean {
  if (ctx.actor.type !== "user") return false;
  return ctx.actor.id === ownerId || can(ctx.actor, "deal.view", { ownerIds: [ownerId] });
}

/** The key a target input will have once stored (same as the DB's generated `target_key`). */
export const inputKey = (t: TargetInputT): string =>
  t.targetType === "internal" ? `code:${t.activityCode ?? ""}` : (t.targetId ?? "");

/**
 * Validate a target and resolve its project (TIM-TS-01, TIM-TS-03). `newTime` is true when the call adds time (a new
 * row or more minutes than already stored): then the task must not be cancelled, the activity code must be active,
 * the deal visible to me (TIM-TS-13), and a task or project on a client project needs the work gates
 * (assertWorkAllowed → GATE_BLOCKED; held or closed projects refuse). Keeping, lowering, confirming or removing time
 * already stored only needs the target to exist (TIM-TS-14): it was allowed when it was logged.
 */
export async function resolveTarget(ctx: Ctx, t: TargetInputT, opts: { newTime: boolean }): Promise<ResolvedTarget> {
  const bad = (path: string, message: string) => new DomainError("VALIDATION", { issues: [{ path, message }] });
  const type: TargetType = t.targetType;
  if (type === "internal") {
    if (!t.activityCode || t.targetId) throw bad("activityCode", "Internal time needs an activity code and no target id");
    const c = await ctx.tx
      .selectFrom("activity_codes")
      .select(["code", "label_en", "active"])
      .where("code", "=", t.activityCode)
      .executeTakeFirst();
    if (!c || (opts.newTime && !c.active)) throw bad("activityCode", "Unknown or inactive activity code");
    return {
      targetType: type,
      taskId: null,
      projectId: null,
      dealId: null,
      activityCode: c.code,
      label: c.label_en,
      projectName: null,
    };
  }
  if (!t.targetId || t.activityCode) throw bad("targetId", "Required (and no activity code)");
  if (type === "deal") {
    const d = await ctx.tx
      .selectFrom("deals")
      .select(["id", "title", "owner_id"])
      .where("id", "=", t.targetId)
      .executeTakeFirst();
    const visible = !!d && canViewDeal(ctx, d.owner_id);
    // TIM-TS-13: a deal I cannot see does not exist for new time, and its title is never returned to me.
    if (!d || (opts.newTime && !visible)) throw new DomainError("NOT_FOUND", { targetType: type });
    return {
      targetType: type,
      taskId: null,
      projectId: null,
      dealId: d.id,
      activityCode: null,
      label: visible ? d.title : WITHHELD_LABEL,
      projectName: null,
    };
  }
  if (type === "task") {
    const k = await ctx.tx
      .selectFrom("tasks as t")
      .innerJoin("projects as p", "p.id", "t.project_id")
      .select(["t.id", "t.title", "t.status", "t.project_id", "p.name"])
      .where("t.id", "=", t.targetId)
      .executeTakeFirst();
    if (!k) throw new DomainError("NOT_FOUND", { targetType: type });
    if (opts.newTime && k.status === "cancelled") throw new DomainError("INVALID_TRANSITION", { reason: "task_cancelled" });
    if (opts.newTime) await assertWorkAllowed(ctx, k.project_id);
    return {
      targetType: type,
      taskId: k.id,
      projectId: k.project_id,
      dealId: null,
      activityCode: null,
      label: k.title,
      projectName: k.name,
    };
  }
  const p = await ctx.tx.selectFrom("projects").select(["id", "name"]).where("id", "=", t.targetId).executeTakeFirst();
  if (!p) throw new DomainError("NOT_FOUND", { targetType: type });
  if (opts.newTime) await assertWorkAllowed(ctx, p.id);
  return {
    targetType: type,
    taskId: null,
    projectId: p.id,
    dealId: null,
    activityCode: null,
    label: p.name,
    projectName: p.name,
  };
}

/** TIM-TS-01 (MCP `log_time`): set my minutes on one target for one day; 0 removes the row. */
export const timeAllocate = defineCommand({
  name: "time.allocate",
  summary: "Log my time: minutes on a task, project, deal or internal activity for one day (0 removes it)",
  permission: "time.allocate_own",
  input: TargetInput.extend({
    date: isoDate,
    minutes: z.number().int().min(0).max(DAY_LIMIT_MINUTES),
    note: optionalText(500),
  }),
  exposeTo: ["web", "mcp"],
  scope: ownScope,
  async run(ctx, i) {
    const me = selfId(ctx);
    if (i.date > businessDate(ctx.now))
      throw new DomainError("VALIDATION", { issues: [{ path: "date", message: "Not in the future" }] });
    const week = await lockWeek(ctx, me, weekStartOf(i.date));
    if (week.status === "confirmed") throw new DomainError("TIMESHEET_CONFIRMED", { weekStart: week.week_start });
    const existing = await ctx.tx
      .selectFrom("time_allocations")
      .select(["id", "minutes"])
      .where("user_id", "=", me)
      .where("work_date", "=", i.date)
      .where("target_type", "=", i.targetType)
      .where("target_key", "=", inputKey(i))
      .executeTakeFirst();
    // TIM-TS-14: only added time is checked; lowering or removing a stored row always works.
    const target = await resolveTarget(ctx, i, { newTime: i.minutes > (existing?.minutes ?? 0) });
    const others = await ctx.tx
      .selectFrom("time_allocations")
      .select((eb) => eb.fn.coalesce(eb.fn.sum<number>("minutes"), eb.lit(0)).as("m"))
      .where("user_id", "=", me)
      .where("work_date", "=", i.date)
      .$if(!!existing, (q) => q.where("id", "<>", existing!.id))
      .executeTakeFirstOrThrow();
    const dayOthers = Number(others.m);
    if (i.minutes === 0) {
      if (existing) await ctx.tx.deleteFrom("time_allocations").where("id", "=", existing.id).execute();
      return { id: existing?.id ?? null, date: i.date, minutes: 0, dayTotalMinutes: dayOthers, removed: true };
    }
    // TIM-TS-02: a day's allocations never exceed 24 h (trigger backstop).
    if (dayOthers + i.minutes > DAY_LIMIT_MINUTES)
      throw new DomainError("VALIDATION", { reason: "day_over_24h", date: i.date, limit: DAY_LIMIT_MINUTES });
    const values = { minutes: i.minutes, source: channelSource(ctx), status: "draft", note: i.note ?? null };
    const row = existing
      ? await ctx.tx
          .updateTable("time_allocations")
          .set((eb) => ({ ...values, version: eb("version", "+", 1) }))
          .where("id", "=", existing.id)
          .returning(["id"])
          .executeTakeFirstOrThrow()
      : await ctx.tx
          .insertInto("time_allocations")
          .values({
            ...values,
            user_id: me,
            work_date: i.date,
            target_type: target.targetType,
            task_id: target.taskId,
            project_id: target.projectId,
            deal_id: target.dealId,
            activity_code: target.activityCode,
          })
          .returning(["id"])
          .executeTakeFirstOrThrow();
    return { id: row.id, date: i.date, minutes: i.minutes, dayTotalMinutes: dayOthers + i.minutes, removed: false };
  },
  subject: (_i, r) => (r.id ? { type: "time_allocation", id: r.id } : undefined),
});
