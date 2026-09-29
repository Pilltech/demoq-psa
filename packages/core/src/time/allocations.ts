// Time allocations: minutes per (user, day, target) — task, project, deal or internal activity code (D-TM-1).
// INV-06 applies only to client-project targets. Spec: specs/time/timesheets.md (TIM-TS-01…03)
import { z } from "zod";
import { isoDate, optionalText, uuid } from "@demoq/shared";
import { businessDate, defineCommand, DomainError, type Ctx } from "../kernel";
import { assertWorkAllowed } from "../projects";
import { ownScope, selfId } from "./attendance";
import { weekStartOf } from "./calendar";
import { targetKey, type DraftRow, type TargetRef, type TargetType } from "./prefill";

export const DAY_LIMIT_MINUTES = 24 * 60;

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
 * Validate a target and resolve its project (TIM-TS-01, TIM-TS-03). Allocating to a task or project on a client
 * project needs the work gates (assertWorkAllowed → GATE_BLOCKED); deal and internal targets never do.
 */
export async function resolveTarget(ctx: Ctx, t: TargetInputT, opts: { checkWork: boolean }): Promise<ResolvedTarget> {
  const bad = (path: string, message: string) => new DomainError("VALIDATION", { issues: [{ path, message }] });
  const type: TargetType = t.targetType;
  if (type === "internal") {
    if (!t.activityCode || t.targetId) throw bad("activityCode", "Internal time needs an activity code and no target id");
    const c = await ctx.tx
      .selectFrom("activity_codes")
      .select(["code", "label_en", "active"])
      .where("code", "=", t.activityCode)
      .executeTakeFirst();
    if (!c?.active) throw bad("activityCode", "Unknown or inactive activity code");
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
    const d = await ctx.tx.selectFrom("deals").select(["id", "title"]).where("id", "=", t.targetId).executeTakeFirst();
    if (!d) throw new DomainError("NOT_FOUND", { targetType: type });
    return {
      targetType: type,
      taskId: null,
      projectId: null,
      dealId: d.id,
      activityCode: null,
      label: d.title,
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
    if (k.status === "cancelled") throw new DomainError("INVALID_TRANSITION", { reason: "task_cancelled" });
    if (opts.checkWork) await assertWorkAllowed(ctx, k.project_id);
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
  if (opts.checkWork) await assertWorkAllowed(ctx, p.id);
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

/** Create-if-missing and lock the user's week row (all allocation writes serialise on it). */
export async function lockWeek(ctx: Ctx, userId: string, weekStart: string) {
  await ctx.tx
    .insertInto("timesheet_weeks")
    .values({ user_id: userId, week_start: weekStart })
    .onConflict((oc) => oc.columns(["user_id", "week_start"]).doNothing())
    .execute();
  return ctx.tx
    .selectFrom("timesheet_weeks")
    .selectAll()
    .where("user_id", "=", userId)
    .where("week_start", "=", weekStart)
    .forUpdate()
    .executeTakeFirstOrThrow();
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
    const target = await resolveTarget(ctx, i, { checkWork: i.minutes > 0 });
    const key = targetKey(target);
    const existing = await ctx.tx
      .selectFrom("time_allocations")
      .select(["id", "minutes"])
      .where("user_id", "=", me)
      .where("work_date", "=", i.date)
      .where("target_type", "=", target.targetType)
      .where("target_key", "=", key)
      .executeTakeFirst();
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
